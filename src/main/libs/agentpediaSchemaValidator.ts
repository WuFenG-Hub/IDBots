/**
 * Minimal JSON Schema draft-07 validator covering exactly the keyword subset used
 * by the Agentpedia composite schemas (see agentpediaSchemas.ts):
 * type / required / properties / additionalProperties:false / enum / const /
 * pattern / minLength / maxLength / minimum / maximum / minItems / maxItems /
 * items / allOf / anyOf / if-then-else.
 *
 * Zero-dependency by design (ajv is not a direct dependency of this repo). This
 * validator is the pre-write gate for Agentpedia tool payloads; the offline G1
 * mechanical verification independently re-checks payloads against the same
 * schemas with ajv, so any divergence here is a bug to be caught twice.
 */

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  ok: boolean;
  errors: SchemaValidationIssue[];
}

type Schema = Record<string, unknown>;

function isInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value);
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return isInteger(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function checkValue(value: unknown, schema: Schema, path: string, errors: SchemaValidationIssue[]): void {
  const fail = (message: string) => errors.push({ path, message });

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t as string))) {
      fail(`expected type ${types.join('|')}, got ${value === null ? 'null' : typeof value}`);
      return; // shape mismatch: further checks would noise
    }
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    fail(`expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(value, option))) {
    fail(`expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      fail(`string does not match pattern ${schema.pattern}: "${value}"`);
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      fail(`string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      fail(`string longer than maxLength ${schema.maxLength}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`number below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`number above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`array below minItems ${schema.minItems}`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(`array above maxItems ${schema.maxItems}`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => checkValue(item, schema.items as Schema, `${path}[${i}]`, errors));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in obj)) fail(`missing required property "${key}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) fail(`additional property "${key}" not allowed`);
      }
    }
    for (const [key, subschema] of Object.entries(properties)) {
      if (key in obj) checkValue(obj[key], subschema, `${path}.${key}`, errors);
    }
  }

  if (schema.not !== undefined && schema.not !== null && typeof schema.not === 'object') {
    const probe: SchemaValidationIssue[] = [];
    checkValue(value, schema.not as Schema, path, probe);
    if (probe.length === 0) {
      fail(`value must NOT match the "not" schema`);
    }
  }

  // Combinators (applied after base checks; if/then/else per draft-07)
  if (Array.isArray(schema.allOf)) {
    for (const subschema of schema.allOf as Schema[]) {
      checkValue(value, subschema, path, errors);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as Schema[];
    const anyOk = branches.some((branch) => {
      const probe: SchemaValidationIssue[] = [];
      checkValue(value, branch, path, probe);
      return probe.length === 0;
    });
    if (!anyOk) fail(`value matches none of anyOf (${branches.length} branches)`);
  }
  if (schema.if && typeof schema.if === 'object') {
    const probe: SchemaValidationIssue[] = [];
    checkValue(value, schema.if as Schema, path, probe);
    if (probe.length === 0) {
      if (schema.then && typeof schema.then === 'object') checkValue(value, schema.then as Schema, path, errors);
    } else if (schema.else && typeof schema.else === 'object') {
      checkValue(value, schema.else as Schema, path, errors);
    }
  }
}

export function validateAgainstSchema(value: unknown, schema: Schema): SchemaValidationResult {
  const errors: SchemaValidationIssue[] = [];
  checkValue(value, schema, '$', errors);
  return { ok: errors.length === 0, errors };
}
