/**
 * Server-mode JSON-line logger (REQ-A-10, C1 "Logs").
 *
 * In server mode every console line is re-emitted as ONE JSON object on
 * stdout/stderr: `{ts, level, tenant, component, msg}`. Redaction runs over
 * the serialized text first: the gateway secret, apiKey field values,
 * BIP-39-style mnemonics (12/24-word sequences — a heuristic over the
 * string), and phone numbers (`+861…` patterns) never reach the log stream.
 *
 * Desktop never installs this wrapper (the guarded branch in main.ts), so
 * desktop logging is untouched. The module stays electron-free and is
 * exercised from plain node tests (tests/serverMode.test.mjs).
 */

import { format } from 'node:util';
import { resolveTenantId } from './serverMode';

export type ServerLogLevel = 'info' | 'warn' | 'error';

export interface ServerLogOptions {
  tenantId?: string;
  /** The gateway secret is redacted wherever it appears verbatim. */
  gatewaySecret?: string;
  /** Injected writers; default to the real stdout/stderr streams. */
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
}

const DEFAULT_COMPONENT = 'main';

/**
 * Heuristic redaction (REQ-A-10). Each pattern rewrites its match in place;
 * the result is what lands in `msg`. Patterns are ordered cheap-first.
 */
export function redactServerLogText(text: string, secrets: Array<string | undefined> = []): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 8 && out.includes(trimmed)) {
      out = out.split(trimmed).join('[redacted]');
    }
  }
  // apiKey field values: "apiKey": "…", 'apiKey': '…', apiKey=…, API_KEY=…
  out = out.replace(
    /(["']?)\b(api[_-]?key|apikey|secret[_-]?key|access[_-]?token)\b\1\s*[:=]\s*(["']?)[A-Za-z0-9_\-.]{6,}\3/gi,
    (_match, keyQuote: string, field: string, valueQuote: string) =>
      `${keyQuote}${field}${keyQuote}: ${valueQuote}[redacted]${valueQuote}`,
  );
  // Phone numbers: +861… patterns (leading +86 / 86 / 0086 optional).
  out = out.replace(/(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d{9}(?!\d)/g, '[phone redacted]');
  // Mnemonics: exactly 12 or 24 whitespace-separated lowercase BIP-39-shaped
  // words (3-8 letters). Heuristic — a false positive only redacts prose.
  out = out.replace(/\b([a-z]{3,8}\s+){23}[a-z]{3,8}\b/g, '[mnemonic redacted]');
  out = out.replace(/\b([a-z]{3,8}\s+){11}[a-z]{3,8}\b/g, '[mnemonic redacted]');
  return out;
}

/** Build the one-line JSON payload C1 prescribes. */
export function buildServerLogLine(
  level: ServerLogLevel,
  component: string,
  msg: string,
  tenantId: string,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, tenant: tenantId, component, msg, ...extra });
}

/**
 * A direct JSON-line writer. Used by the console wrapper and by the gateway
 * logger wiring so gateway lines are single JSON objects, not JSON nested in
 * a wrapped console string.
 */
export function makeServerLogger(options: ServerLogOptions = {}) {
  const tenantId = options.tenantId ?? resolveTenantId();
  const secrets = [options.gatewaySecret, process.env.IDBOTS_GATEWAY_SECRET];
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  return (level: ServerLogLevel, component: string, msg: string, extra?: Record<string, unknown>): void => {
    const line = redactServerLogText(buildServerLogLine(level, component || DEFAULT_COMPONENT, msg, tenantId, extra), secrets);
    if (level === 'error') stderr.write(`${line}\n`);
    else if (level === 'warn') stderr.write(`${line}\n`);
    else stdout.write(`${line}\n`);
  };
}

/**
 * REQ-A-10: wrap console.log/info/warn/error so every line becomes one JSON
 * object. Call only in server mode (main.ts guards it); wrapping is one-shot
 * and idempotent per process.
 */
export function installServerConsoleLogger(options: ServerLogOptions = {}): void {
  const write = makeServerLogger(options);
  const emit = (level: ServerLogLevel) => (...args: unknown[]) => {
    let msg: string;
    try {
      msg = format(...args);
    } catch {
      msg = args.map((arg) => String(arg)).join(' ');
    }
    write(level, DEFAULT_COMPONENT, msg);
  };
  console.log = emit('info');
  console.info = emit('info');
  console.warn = emit('warn');
  console.error = emit('error');
  console.debug = emit('info');
}
