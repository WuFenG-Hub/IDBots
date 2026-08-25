import { v4 as uuidv4 } from 'uuid';
import {
  normalizeGlobalMetaID,
  requireGlobalMetaID,
  type GlobalMetaID,
} from './shared/globalMetaId';
import type { SqliteDatabase as Database } from './sqliteTypes';
import { truncateUtf16Units } from './libs/llmSafeText';

export const METAID_MEMORY_GRANT_CAPABILITIES = [
  'read_summary',
  'read_evidence_index',
  'read_raw_evidence',
  'append_observation',
  'update_snapshot',
  'manage_grant',
] as const;

export type MetaIDMemoryGrantCapability = typeof METAID_MEMORY_GRANT_CAPABILITIES[number];

export const METAID_MEMORY_GRANT_RESOURCE_TYPES = [
  'snapshot',
  'observation_index',
  'raw_evidence',
] as const;

export type MetaIDMemoryGrantResourceType = typeof METAID_MEMORY_GRANT_RESOURCE_TYPES[number];

export interface MetaIDMemoryGrant {
  id: string;
  resourceOwnerGlobalMetaID: GlobalMetaID;
  granteeGlobalMetaID: GlobalMetaID;
  subjectGlobalMetaID: GlobalMetaID | null;
  resourceType: MetaIDMemoryGrantResourceType;
  capabilities: MetaIDMemoryGrantCapability[];
  scope: Record<string, unknown>;
  validFrom: number;
  expiresAt: number;
  revokedAt: number | null;
  createdByGlobalMetaID: GlobalMetaID;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMetaIDMemoryGrantInput {
  id?: string;
  resourceOwnerGlobalMetaID: unknown;
  granteeGlobalMetaID: unknown;
  subjectGlobalMetaID?: unknown;
  resourceType: unknown;
  capabilities: unknown[];
  scope?: Record<string, unknown>;
  validFrom?: unknown;
  expiresAt: unknown;
  createdByGlobalMetaID: unknown;
}

export interface MetaIDMemoryAccessAuditRecord {
  id: string;
  requestId: string;
  requestedAt: number;
  resourceOwnerGlobalMetaID: GlobalMetaID;
  readerGlobalMetaID: GlobalMetaID;
  subjectGlobalMetaID: GlobalMetaID | null;
  resourceType: string;
  requestedCapability: string;
  grantId: string | null;
  outcome: 'allowed' | 'denied';
  reasonCode: string;
  scopeReference: string | null;
  createdAt: number;
}

export interface AppendMetaIDMemoryAccessAuditInput {
  id?: string;
  requestId: string;
  requestedAt: number;
  resourceOwnerGlobalMetaID: unknown;
  readerGlobalMetaID: unknown;
  subjectGlobalMetaID?: unknown;
  resourceType: string;
  requestedCapability: string;
  grantId?: string | null;
  outcome: 'allowed' | 'denied';
  reasonCode: string;
  scopeReference?: string | null;
}

interface GrantRow {
  id: string;
  resource_owner_globalmetaid: string;
  grantee_globalmetaid: string;
  subject_globalmetaid: string | null;
  resource_type: string;
  capabilities_json: string;
  scope_json: string;
  valid_from: number | string;
  expires_at: number | string;
  revoked_at: number | string | null;
  created_by_globalmetaid: string;
  created_at: number | string;
  updated_at: number | string;
}

interface AuditRow {
  id: string;
  request_id: string;
  requested_at: number | string;
  resource_owner_globalmetaid: string;
  reader_globalmetaid: string;
  subject_globalmetaid: string | null;
  resource_type: string;
  requested_capability: string;
  grant_id: string | null;
  outcome: string;
  reason_code: string;
  scope_reference: string | null;
  created_at: number | string;
}

const MAX_SCOPE_JSON_CHARS = 4_000;
const MAX_REASON_CODE_CHARS = 80;
const MAX_SCOPE_REFERENCE_CHARS = 200;

function asNumber(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return Math.floor(parsed);
}

function asBoundedText(value: unknown, fieldName: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${fieldName} must be a non-empty string`);
  return normalized.length > maxLength ? truncateUtf16Units(normalized, maxLength) : normalized;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeCapabilities(value: unknown[]): MetaIDMemoryGrantCapability[] {
  const seen = new Set<MetaIDMemoryGrantCapability>();
  const capabilities: MetaIDMemoryGrantCapability[] = [];
  for (const entry of value ?? []) {
    if (typeof entry !== 'string') continue;
    if (!(METAID_MEMORY_GRANT_CAPABILITIES as readonly string[]).includes(entry)) {
      throw new Error(`Unsupported grant capability: ${entry}`);
    }
    const capability = entry as MetaIDMemoryGrantCapability;
    if (!seen.has(capability)) {
      seen.add(capability);
      capabilities.push(capability);
    }
  }
  if (capabilities.length === 0) {
    throw new Error('At least one grant capability is required');
  }
  return capabilities;
}

function normalizeResourceType(value: unknown): MetaIDMemoryGrantResourceType {
  if (typeof value !== 'string' || !(METAID_MEMORY_GRANT_RESOURCE_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported grant resource type: ${String(value)}`);
  }
  return value as MetaIDMemoryGrantResourceType;
}

function normalizeScope(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Grant scope must be a JSON object');
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_SCOPE_JSON_CHARS) {
    throw new Error('Grant scope exceeds the JSON size limit');
  }
  return value;
}

function rowToGrant(row: GrantRow): MetaIDMemoryGrant {
  return {
    id: row.id,
    resourceOwnerGlobalMetaID: row.resource_owner_globalmetaid as GlobalMetaID,
    granteeGlobalMetaID: row.grantee_globalmetaid as GlobalMetaID,
    subjectGlobalMetaID: row.subject_globalmetaid as GlobalMetaID | null,
    resourceType: row.resource_type as MetaIDMemoryGrantResourceType,
    capabilities: parseJsonArray<MetaIDMemoryGrantCapability>(row.capabilities_json),
    scope: parseJsonObject(row.scope_json),
    validFrom: asNumber(row.valid_from, 'validFrom'),
    expiresAt: asNumber(row.expires_at, 'expiresAt'),
    revokedAt: row.revoked_at == null ? null : asNumber(row.revoked_at, 'revokedAt'),
    createdByGlobalMetaID: row.created_by_globalmetaid as GlobalMetaID,
    createdAt: asNumber(row.created_at, 'createdAt'),
    updatedAt: asNumber(row.updated_at, 'updatedAt'),
  };
}

function rowToAudit(row: AuditRow): MetaIDMemoryAccessAuditRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    requestedAt: asNumber(row.requested_at, 'requestedAt'),
    resourceOwnerGlobalMetaID: row.resource_owner_globalmetaid as GlobalMetaID,
    readerGlobalMetaID: row.reader_globalmetaid as GlobalMetaID,
    subjectGlobalMetaID: row.subject_globalmetaid as GlobalMetaID | null,
    resourceType: row.resource_type,
    requestedCapability: row.requested_capability,
    grantId: row.grant_id,
    outcome: row.outcome as 'allowed' | 'denied',
    reasonCode: row.reason_code,
    scopeReference: row.scope_reference,
    createdAt: asNumber(row.created_at, 'createdAt'),
  };
}

/** Create the shared-memory grant and access-audit schema (idempotent). */
export function ensureMetaIDMemoryGrantSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_memory_grants (
      id TEXT PRIMARY KEY,
      resource_owner_globalmetaid TEXT NOT NULL CHECK (trim(resource_owner_globalmetaid) <> ''),
      grantee_globalmetaid TEXT NOT NULL CHECK (trim(grantee_globalmetaid) <> ''),
      subject_globalmetaid TEXT,
      resource_type TEXT NOT NULL CHECK (trim(resource_type) <> ''),
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      scope_json TEXT NOT NULL DEFAULT '{}',
      valid_from INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > 0),
      revoked_at INTEGER,
      created_by_globalmetaid TEXT NOT NULL CHECK (trim(created_by_globalmetaid) <> ''),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (resource_owner_globalmetaid <> grantee_globalmetaid),
      CHECK (expires_at > valid_from)
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_memory_grants_owner_grantee
      ON metaid_memory_grants(resource_owner_globalmetaid, grantee_globalmetaid);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_memory_grants_grantee
      ON metaid_memory_grants(grantee_globalmetaid);
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS metaid_memory_access_audit (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL CHECK (trim(request_id) <> ''),
      requested_at INTEGER NOT NULL,
      resource_owner_globalmetaid TEXT NOT NULL CHECK (trim(resource_owner_globalmetaid) <> ''),
      reader_globalmetaid TEXT NOT NULL CHECK (trim(reader_globalmetaid) <> ''),
      subject_globalmetaid TEXT,
      resource_type TEXT NOT NULL CHECK (trim(resource_type) <> ''),
      requested_capability TEXT NOT NULL CHECK (trim(requested_capability) <> ''),
      grant_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied')),
      reason_code TEXT NOT NULL CHECK (trim(reason_code) <> ''),
      scope_reference TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_memory_audit_owner_time
      ON metaid_memory_access_audit(resource_owner_globalmetaid, created_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_memory_audit_reader_time
      ON metaid_memory_access_audit(reader_globalmetaid, created_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_metaid_memory_audit_grant
      ON metaid_memory_access_audit(grant_id);
  `);
}

/**
 * Grants are explicit records only: Boss/Twin/Worker topology never creates a
 * grant implicitly. The store enforces ownership for create/revoke and keeps
 * the audit trail append-only.
 */
export class MetaIDMemoryGrantStore {
  constructor(
    private readonly db: Database,
    private readonly saveDb: () => void,
    private readonly now: () => number = Date.now,
  ) {
    ensureMetaIDMemoryGrantSchema(db);
  }

  private getOne<T>(sql: string, params: unknown[] = []): T | null {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    const values = result[0]?.values?.[0];
    if (!values) return null;
    return Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T;
  }

  private getAll<T>(sql: string, params: unknown[] = []): T[] {
    const result = this.db.exec(sql, params);
    const columns = result[0]?.columns ?? [];
    return (result[0]?.values ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T
    );
  }

  createGrant(input: CreateMetaIDMemoryGrantInput): { grant: MetaIDMemoryGrant; created: boolean } {
    const resourceOwnerGlobalMetaID = requireGlobalMetaID(
      input.resourceOwnerGlobalMetaID,
      'resourceOwnerGlobalMetaID',
    );
    const granteeGlobalMetaID = requireGlobalMetaID(input.granteeGlobalMetaID, 'granteeGlobalMetaID');
    const createdByGlobalMetaID = requireGlobalMetaID(
      input.createdByGlobalMetaID,
      'createdByGlobalMetaID',
    );
    if (resourceOwnerGlobalMetaID === granteeGlobalMetaID) {
      throw new Error('Grant owner and grantee must be different GlobalMetaIDs');
    }
    if (createdByGlobalMetaID !== resourceOwnerGlobalMetaID) {
      throw new Error('Only the resource owner can create a grant');
    }
    const subjectGlobalMetaID = input.subjectGlobalMetaID === undefined
      ? null
      : requireGlobalMetaID(input.subjectGlobalMetaID, 'subjectGlobalMetaID');
    if (subjectGlobalMetaID === resourceOwnerGlobalMetaID || subjectGlobalMetaID === granteeGlobalMetaID) {
      throw new Error('Grant subject cannot be the owner or the grantee');
    }
    const resourceType = normalizeResourceType(input.resourceType);
    const capabilities = normalizeCapabilities(input.capabilities);
    const scope = normalizeScope(input.scope);
    const now = this.now();
    const validFrom = input.validFrom === undefined
      ? now
      : asNumber(input.validFrom, 'validFrom');
    const expiresAt = asNumber(input.expiresAt, 'expiresAt');
    if (expiresAt <= validFrom) {
      throw new Error('Grant expiresAt must be after validFrom');
    }
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : uuidv4();
    const existing = this.getGrant(id);
    if (existing) return { grant: existing, created: false };

    this.db.run(
      `INSERT INTO metaid_memory_grants (
        id, resource_owner_globalmetaid, grantee_globalmetaid, subject_globalmetaid,
        resource_type, capabilities_json, scope_json, valid_from, expires_at, revoked_at,
        created_by_globalmetaid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        id,
        resourceOwnerGlobalMetaID,
        granteeGlobalMetaID,
        subjectGlobalMetaID,
        resourceType,
        JSON.stringify(capabilities),
        JSON.stringify(scope),
        validFrom,
        expiresAt,
        createdByGlobalMetaID,
        now,
        now,
      ],
    );
    this.saveDb();
    const grant = this.getGrant(id);
    if (!grant) throw new Error(`Failed to create memory grant: ${id}`);
    return { grant, created: true };
  }

  getGrant(idValue: unknown): MetaIDMemoryGrant | null {
    const id = typeof idValue === 'string' ? idValue.trim() : '';
    if (!id) return null;
    const row = this.getOne<GrantRow>(
      'SELECT * FROM metaid_memory_grants WHERE id = ? LIMIT 1',
      [id],
    );
    return row ? rowToGrant(row) : null;
  }

  revokeGrant(idValue: unknown, byGlobalMetaID: unknown): boolean {
    const id = typeof idValue === 'string' ? idValue.trim() : '';
    if (!id) return false;
    const by = requireGlobalMetaID(byGlobalMetaID, 'byGlobalMetaID');
    const grant = this.getGrant(id);
    if (!grant) return false;
    if (grant.resourceOwnerGlobalMetaID !== by) {
      throw new Error('Only the resource owner can revoke a grant');
    }
    if (grant.revokedAt != null) return false;
    const now = this.now();
    this.db.run(
      `UPDATE metaid_memory_grants SET revoked_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
    this.saveDb();
    return true;
  }

  listGrants(input: {
    resourceOwnerGlobalMetaID?: unknown;
    granteeGlobalMetaID?: unknown;
    includeRevoked?: boolean;
  } = {}): MetaIDMemoryGrant[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.resourceOwnerGlobalMetaID !== undefined) {
      conditions.push('resource_owner_globalmetaid = ?');
      params.push(requireGlobalMetaID(input.resourceOwnerGlobalMetaID, 'resourceOwnerGlobalMetaID'));
    }
    if (input.granteeGlobalMetaID !== undefined) {
      conditions.push('grantee_globalmetaid = ?');
      params.push(requireGlobalMetaID(input.granteeGlobalMetaID, 'granteeGlobalMetaID'));
    }
    if (!input.includeRevoked) conditions.push('revoked_at IS NULL');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.getAll<GrantRow>(
      `SELECT * FROM metaid_memory_grants ${where} ORDER BY created_at DESC, id ASC`,
      params,
    ).map(rowToGrant);
  }

  /**
   * Candidate grants for one access decision: same owner, grantee, resource
   * type and (subject-specific or wildcard) scope, most specific first. The
   * access service still validates capability, time window, revocation and
   * scope constraints so audit reasons stay precise.
   */
  listGrantsForAccess(input: {
    resourceOwnerGlobalMetaID: unknown;
    granteeGlobalMetaID: unknown;
    subjectGlobalMetaID: unknown;
    resourceType: string;
  }): MetaIDMemoryGrant[] {
    const resourceOwnerGlobalMetaID = requireGlobalMetaID(
      input.resourceOwnerGlobalMetaID,
      'resourceOwnerGlobalMetaID',
    );
    const granteeGlobalMetaID = requireGlobalMetaID(input.granteeGlobalMetaID, 'granteeGlobalMetaID');
    const subjectGlobalMetaID = requireGlobalMetaID(input.subjectGlobalMetaID, 'subjectGlobalMetaID');
    const resourceType = asBoundedText(input.resourceType, 'resourceType', 120);
    return this.getAll<GrantRow>(
      `SELECT * FROM metaid_memory_grants
       WHERE resource_owner_globalmetaid = ?
         AND grantee_globalmetaid = ?
         AND resource_type = ?
         AND (subject_globalmetaid IS NULL OR subject_globalmetaid = ?)
       ORDER BY (subject_globalmetaid IS NOT NULL) DESC, valid_from DESC, created_at DESC`,
      [resourceOwnerGlobalMetaID, granteeGlobalMetaID, resourceType, subjectGlobalMetaID],
    ).map(rowToGrant);
  }

  appendAudit(input: AppendMetaIDMemoryAccessAuditInput): MetaIDMemoryAccessAuditRecord {
    const resourceOwnerGlobalMetaID = requireGlobalMetaID(
      input.resourceOwnerGlobalMetaID,
      'resourceOwnerGlobalMetaID',
    );
    const readerGlobalMetaID = requireGlobalMetaID(input.readerGlobalMetaID, 'readerGlobalMetaID');
    const subjectGlobalMetaID = input.subjectGlobalMetaID === undefined
      ? null
      : requireGlobalMetaID(input.subjectGlobalMetaID, 'subjectGlobalMetaID');
    const resourceType = asBoundedText(input.resourceType, 'resourceType', 120);
    const requestedCapability = asBoundedText(
      input.requestedCapability,
      'requestedCapability',
      80,
    );
    const reasonCode = asBoundedText(input.reasonCode, 'reasonCode', MAX_REASON_CODE_CHARS);
    const scopeReference = input.scopeReference === undefined
      || input.scopeReference === null
      || String(input.scopeReference).trim() === ''
      ? null
      : asBoundedText(input.scopeReference, 'scopeReference', MAX_SCOPE_REFERENCE_CHARS);
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : uuidv4();
    const requestedAt = asNumber(input.requestedAt, 'requestedAt');
    const createdAt = this.now();
    this.db.run(
      `INSERT INTO metaid_memory_access_audit (
        id, request_id, requested_at, resource_owner_globalmetaid, reader_globalmetaid,
        subject_globalmetaid, resource_type, requested_capability, grant_id, outcome,
        reason_code, scope_reference, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.requestId,
        requestedAt,
        resourceOwnerGlobalMetaID,
        readerGlobalMetaID,
        subjectGlobalMetaID,
        resourceType,
        requestedCapability,
        input.grantId ?? null,
        input.outcome,
        reasonCode,
        scopeReference,
        createdAt,
      ],
    );
    this.saveDb();
    const row = this.getOne<AuditRow>(
      'SELECT * FROM metaid_memory_access_audit WHERE id = ? LIMIT 1',
      [id],
    );
    if (!row) throw new Error(`Failed to append memory access audit: ${id}`);
    return rowToAudit(row);
  }

  listAudit(input: {
    resourceOwnerGlobalMetaID?: unknown;
    readerGlobalMetaID?: unknown;
    grantId?: string;
    limit?: number;
  } = {}): MetaIDMemoryAccessAuditRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.resourceOwnerGlobalMetaID !== undefined) {
      conditions.push('resource_owner_globalmetaid = ?');
      params.push(requireGlobalMetaID(input.resourceOwnerGlobalMetaID, 'resourceOwnerGlobalMetaID'));
    }
    if (input.readerGlobalMetaID !== undefined) {
      conditions.push('reader_globalmetaid = ?');
      params.push(requireGlobalMetaID(input.readerGlobalMetaID, 'readerGlobalMetaID'));
    }
    if (input.grantId) {
      conditions.push('grant_id = ?');
      params.push(input.grantId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, Math.floor(Number(input.limit ?? 100) || 100)));
    return this.getAll<AuditRow>(
      `SELECT * FROM metaid_memory_access_audit ${where} ORDER BY created_at DESC, id ASC LIMIT ?`,
      [...params, limit],
    ).map(rowToAudit);
  }
}
