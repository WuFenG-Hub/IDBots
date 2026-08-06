import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import path from 'path';
import {
  browserFailure,
  browserManualActionRequired,
  browserSuccess,
  type BrowserLlmCompletePayload,
  type BrowserLlmCompleteResult,
  type BrowserPermissionGrant,
  type BrowserPermissionsResult,
  type BrowserCommandResult,
} from '@openagentinternet/agent-browser-host-contract';
import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import type { MetaidDataPayload } from './metaidCore';

const MAX_PIN_PAYLOAD_BYTES = 512 * 1024;
const PIN_ID_PATTERN = /^[0-9a-f]{64}i\d+$/iu;
const PIN_WRITE_CONFIRMATION_TTL_MS = 60_000;
const MAX_PENDING_PIN_WRITE_CONFIRMATIONS = 256;
const MAX_LLM_INPUT_BYTES = 64 * 1024;
const MAX_LLM_MESSAGES = 128;
const MAX_PERMISSION_GRANTS = 32;
const PROTOCOL_GRANT_PATH_PATTERN = /^\/protocols\/[A-Za-z0-9_-]+$/u;
// Host-owned policy defaults (MetaApp Host Bridge v1.1). Hosts may tune them.
const LLM_COMPLETE_DEFAULT_TIMEOUT_MS = 120_000;
const LLM_COMPLETE_MAX_TIMEOUT_MS = 180_000;
const LLM_COMPLETE_RATE_LIMIT_PER_MINUTE = 6;
const GRANTED_WRITE_RATE_LIMIT_PER_MINUTE = 12;
const GRANTED_WRITE_MAX_PAYLOAD_BYTES = 16 * 1024;
// Only these exact protocol paths may appear in a session grant. Sensitive
// protocols (metaapp, simplemsg, payment-related, ...) never qualify.
const PROTOCOL_GRANT_WHITELIST = new Set([
  '/protocols/simplegroupcreate',
  '/protocols/simplegroupjoin',
  '/protocols/simplegroupchat',
]);

export type BotBrowserBridgeErrorCode =
  | 'invalid_request'
  | 'unsupported_method'
  | 'invalid_params'
  | 'actor_required'
  | 'manual_action_required'
  | 'user_cancelled'
  | 'consent_denied'
  | 'upload_failed'
  | 'pin_write_failed'
  | 'llm_unavailable'
  | 'llm_timeout'
  | 'empty_content'
  | 'rate_limited'
  | 'permissions_failed';

export interface MetaAppBridgeActor {
  uri: string;
  globalMetaId: string;
  name: string;
  avatarPinId?: string;
}

export interface BotBrowserPinWriteResult {
  pinId: string;
  txid: string;
  operation: 'create' | 'modify' | 'revoke';
  path: string;
  actor: MetaAppBridgeActor;
}

export interface BotBrowserMetaFileUploadResultFile {
  pinId: string;
  uri: string;
  name: string;
  size: number;
  contentType: string;
  contentHash?: string;
  actor: MetaAppBridgeActor;
}

export interface BotBrowserMetaFileUploadResult {
  files: BotBrowserMetaFileUploadResultFile[];
}

export interface BotBrowserPinWriteConfirmation {
  actor: MetaAppBridgeActor;
  operation: 'create' | 'modify' | 'revoke';
  path: string;
  contentType: string;
  payloadSize: number;
  confirmationId: string;
  expiresAt: number;
  display: {
    title?: string;
    summary?: string;
  };
}

export interface BotBrowserPinWriteConfirmRequest {
  resourceUri: string;
  kind: 'metaid-pin-write';
  payload: Record<string, unknown>;
}

export interface BotBrowserPinWriteManualActionData {
  confirmation: BotBrowserPinWriteConfirmation;
  confirmRequest: BotBrowserPinWriteConfirmRequest;
}

export interface BotBrowserPinWriteInput {
  actorId?: string;
  resourceUri?: string;
  sessionId?: string;
  payload?: unknown;
  network?: string;
}

export interface BotBrowserMetaFileUploadInput {
  actorId?: string;
  resourceUri?: string;
  sessionId?: string;
  payload?: unknown;
  network?: string;
}

export interface BotBrowserLlmCompleteInput {
  actorId?: string;
  resourceUri?: string;
  sessionId?: string;
  payload?: unknown;
}

export interface BotBrowserPermissionsInput {
  actorId?: string;
  resourceUri?: string;
  sessionId?: string;
  payload?: unknown;
}

export interface BotBrowserHostPickedFile {
  filePath: string;
  name?: string;
  contentType?: string;
}

type CreatePinFn = (
  metabotStore: MetabotStore,
  metabotId: number,
  metaidPayload: MetaidDataPayload,
  options?: { network?: string },
) => Promise<{ txids: string[]; pinId: string; totalCost: number }>;

type UploadMetaFileFn = (
  metabotStore: MetabotStore,
  params: {
    metabotId: number;
    filePath: string;
    contentType?: string;
    network?: string;
  },
) => Promise<Record<string, unknown>>;

type CompleteLlmFn = (input: {
  metabot: Metabot;
  actor: MetaAppBridgeActor;
  resourceUri: string;
  sessionId: string;
  payload: BrowserLlmCompletePayload;
}) => Promise<BrowserLlmCompleteResult>;

export interface BotBrowserBridgeServiceDeps {
  metabotStore: MetabotStore;
  createPin?: CreatePinFn;
  uploadMetaFile?: UploadMetaFileFn;
  completeLlm?: CompleteLlmFn;
  pickFiles?: (input: {
    multiple: boolean;
    accept: string[];
    purpose?: string;
  }) => Promise<BotBrowserHostPickedFile[]>;
  now?: () => number;
  confirmationTtlMs?: number;
  createConfirmationId?: () => string;
  createConfirmationToken?: () => string;
  llmTimeoutMs?: number;
  audit?: (event: BotBrowserBridgeAuditEvent) => void;
}

/**
 * Structured host-local audit entries for session grant and granted-write
 * events. Emitted through the host audit log (defaults to console.info so the
 * electron-log file transport captures them) for later review.
 */
export interface BotBrowserBridgeAuditEvent {
  type: 'permission-granted' | 'permission-revoked' | 'granted-write';
  at: number;
  actorId: number;
  actorGlobalMetaId: string;
  resourceUri: string;
  sessionId: string;
  grants?: BrowserPermissionGrant[];
  reason?: string;
  path?: string;
  pinId?: string;
  txid?: string;
}

export interface BotBrowserBridgeService {
  writeMetaIdPin(input: BotBrowserPinWriteInput): Promise<BrowserCommandResult<BotBrowserPinWriteResult>>;
  uploadMetaFile(input: BotBrowserMetaFileUploadInput): Promise<BrowserCommandResult<BotBrowserMetaFileUploadResult>>;
  completeLlm(input: BotBrowserLlmCompleteInput): Promise<BrowserCommandResult<BrowserLlmCompleteResult>>;
  requestPermissions(input: BotBrowserPermissionsInput): Promise<BrowserCommandResult<BrowserPermissionsResult>>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBridgeGlobalMetaId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.startsWith('metaid:') || !normalized.startsWith('id')) {
    return null;
  }
  if (!new Set(['q', 'p', 'z', 'r', 'y', 't']).has(normalized[2] ?? '')) {
    return null;
  }
  if (normalized[3] !== '1') {
    return null;
  }
  return normalized;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failure<T>(code: BotBrowserBridgeErrorCode, message: string): BrowserCommandResult<T> {
  return browserFailure(code, message) as BrowserCommandResult<T>;
}

function invalidConfirmation<T>(): BrowserCommandResult<T> {
  return failure(
    'invalid_request',
    'MetaID PIN write confirmation is invalid or has already been used.',
  );
}

function parseLocalMetabotActorId(actorId: unknown): number | null {
  const value = text(actorId);
  const match = /^idbots-metabot-(\d+)$/u.exec(value);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function extractPinId(value: unknown): string {
  let candidate = text(value);
  if (!candidate) return '';
  if (/^metafile:\/\//iu.test(candidate)) {
    candidate = candidate.slice('metafile://'.length);
  } else if (/^pin:\/\//iu.test(candidate)) {
    candidate = candidate.slice('pin://'.length);
  } else {
    return '';
  }
  candidate = candidate
    .split(/[?#]/u, 1)[0]
    .replace(/\.[A-Za-z0-9]+$/u, '')
    .toLowerCase();
  return /^[a-z0-9]+i\d+$/u.test(candidate) ? candidate : '';
}

export function sanitizeMetaAppBridgeActor(metabot: Metabot | null | undefined): MetaAppBridgeActor | null {
  const globalMetaId = normalizeBridgeGlobalMetaId(metabot?.globalmetaid ?? null);
  if (!globalMetaId) return null;

  const actor: MetaAppBridgeActor = {
    uri: `metaid://${globalMetaId}`,
    globalMetaId,
    name: text(metabot?.name) || globalMetaId,
  };
  const avatarPinId = extractPinId(metabot?.avatar);
  if (avatarPinId) {
    actor.avatarPinId = avatarPinId;
  }
  return actor;
}

function resolveActor(
  metabotStore: MetabotStore,
  actorId: unknown,
): { metabot: Metabot; actor: MetaAppBridgeActor } | BrowserCommandResult<never> {
  const metabotId = parseLocalMetabotActorId(actorId);
  if (metabotId === null) {
    return failure('actor_required', 'A current Actor Bot is required.');
  }

  const metabot = metabotStore.getMetabotById(metabotId);
  const actor = sanitizeMetaAppBridgeActor(metabot);
  if (!metabot || !actor) {
    return failure('actor_required', 'A current Actor Bot is required.');
  }

  return { metabot, actor };
}

function isCommandFailure(value: unknown): value is BrowserCommandResult<never> {
  return Boolean(value && typeof value === 'object' && (value as BrowserCommandResult<never>).ok === false);
}

function normalizePinId(value: unknown): string {
  const normalized = text(value).toLowerCase();
  return PIN_ID_PATTERN.test(normalized) ? normalized : '';
}

function validatePinWritePath(
  operation: 'create' | 'modify' | 'revoke',
  value: unknown,
): { path: string; targetPinId?: string } | BrowserCommandResult<never> {
  const pinPath = text(value);
  if (!pinPath || /[\r\n]/u.test(pinPath)) {
    return failure('invalid_params', 'MetaID PIN write path is invalid.');
  }

  if (operation === 'create') {
    if (!pinPath.startsWith('/')) {
      return failure('invalid_params', 'MetaID PIN create path must start with /.');
    }
    return { path: pinPath };
  }

  if (!pinPath.startsWith('@')) {
    return failure('invalid_params', 'MetaID PIN modify/revoke path must be @<targetPinId>.');
  }
  const targetPinId = normalizePinId(pinPath.slice(1));
  if (!targetPinId) {
    return failure('invalid_params', 'MetaID PIN modify/revoke target pin id is invalid.');
  }
  return { path: `@${targetPinId}`, targetPinId };
}

function validateBridgeMetadata(
  body: Record<string, unknown>,
  targetPinId?: string,
): { originalId?: string; appAction?: string } | BrowserCommandResult<never> | undefined {
  const originalIdText = text(body.originalId);
  const originalId = originalIdText ? normalizePinId(originalIdText) : undefined;
  if (originalIdText && !originalId) {
    return failure('invalid_params', 'MetaID PIN write originalId is invalid.');
  }
  if (originalId && targetPinId && originalId !== targetPinId) {
    return failure('invalid_params', 'MetaID PIN write originalId must match the target pin id.');
  }

  const appAction = text(body.appAction) || undefined;
  if (appAction && (appAction.length > 128 || /[\r\n]/u.test(appAction))) {
    return failure('invalid_params', 'MetaID PIN write appAction is invalid.');
  }

  if (!originalId && !appAction) {
    return undefined;
  }
  return {
    ...(originalId ? { originalId } : {}),
    ...(appAction ? { appAction } : {}),
  };
}

function decodePayload(
  payloadRecord: Record<string, unknown>,
  operation: 'create' | 'modify' | 'revoke',
): {
  payload: string | Buffer;
  encoding: 'utf-8' | 'base64';
  size: number;
} | BrowserCommandResult<never> {
  const encoding = text(payloadRecord.encoding);
  const value = typeof payloadRecord.value === 'string' ? payloadRecord.value : '';
  if (!value) {
    if (operation === 'revoke' && encoding === 'utf8') {
      return { payload: '', encoding: 'utf-8', size: 0 };
    }
    return failure('invalid_params', 'MetaID PIN write payload is required.');
  }

  if (encoding === 'utf8') {
    const size = Buffer.byteLength(value, 'utf8');
    if (size > MAX_PIN_PAYLOAD_BYTES) {
      return failure('invalid_params', 'MetaID PIN write payload is too large.');
    }
    return { payload: value, encoding: 'utf-8', size };
  }

  if (encoding === 'base64') {
    if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
      return failure('invalid_params', 'MetaID PIN write payload base64 is invalid.');
    }
    const buffer = Buffer.from(value, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_PIN_PAYLOAD_BYTES) {
      return failure('invalid_params', 'MetaID PIN write payload is invalid.');
    }
    return { payload: buffer, encoding: 'base64', size: buffer.length };
  }

  return failure('invalid_params', 'MetaID PIN write payload encoding must be utf8 or base64.');
}

function validatePinWritePayload(payload: unknown): {
  metaidPayload: MetaidDataPayload;
  normalizedPayload: Record<string, unknown>;
  operation: 'create' | 'modify' | 'revoke';
  path: string;
  contentType: string;
  payloadSize: number;
  display: { title?: string; summary?: string };
  bridgeMetadata?: { originalId?: string; appAction?: string };
} | BrowserCommandResult<never> {
  const body = objectRecord(payload);
  if (!body) {
    return failure('invalid_params', 'MetaID PIN write payload must be an object.');
  }

  const operation = text(body.operation);
  if (operation !== 'create' && operation !== 'modify' && operation !== 'revoke') {
    return failure('invalid_params', 'MetaID PIN write operation must be create, modify, or revoke.');
  }

  const pathValidation = validatePinWritePath(operation, body.path);
  if (isCommandFailure(pathValidation)) return pathValidation;

  const encryption = text(body.encryption);
  if (encryption !== '0' && encryption !== '1' && encryption !== '2') {
    return failure('invalid_params', 'MetaID PIN write encryption is invalid.');
  }

  const version = text(body.version);
  const contentType = text(body.contentType);
  if (!version || /[\r\n]/u.test(version) || !contentType || /[\r\n]/u.test(contentType)) {
    return failure('invalid_params', 'MetaID PIN write version and contentType are required.');
  }

  const payloadRecord = objectRecord(body.payload);
  if (!payloadRecord) {
    return failure('invalid_params', 'MetaID PIN write payload data is required.');
  }
  const decoded = decodePayload(payloadRecord, operation);
  if (isCommandFailure(decoded)) return decoded;

  const bridgeMetadata = validateBridgeMetadata(body, pathValidation.targetPinId);
  if (isCommandFailure(bridgeMetadata)) return bridgeMetadata;

  const displayRecord = objectRecord(body.display);
  const display = {
    title: text(displayRecord?.title) || undefined,
    summary: text(displayRecord?.summary) || undefined,
  };

  const normalizedPayload: Record<string, unknown> = {
    operation,
    path: pathValidation.path,
    encryption,
    version,
    contentType,
    payload: {
      encoding: decoded.encoding === 'utf-8' ? 'utf8' : 'base64',
      value: decoded.encoding === 'utf-8'
        ? decoded.payload as string
        : (decoded.payload as Buffer).toString('base64'),
    },
  };
  if (bridgeMetadata?.originalId) {
    normalizedPayload.originalId = bridgeMetadata.originalId;
  }
  if (bridgeMetadata?.appAction) {
    normalizedPayload.appAction = bridgeMetadata.appAction;
  }
  if (display.title || display.summary) {
    normalizedPayload.display = display;
  }

  return {
    metaidPayload: {
      operation,
      path: pathValidation.path,
      encryption,
      version,
      contentType,
      payload: decoded.payload,
      encoding: decoded.encoding,
    },
    normalizedPayload,
    operation,
    path: pathValidation.path,
    contentType,
    payloadSize: decoded.size,
    display,
    ...(bridgeMetadata ? { bridgeMetadata } : {}),
  };
}

interface PendingPinWriteAuthorization {
  actorId: number;
  actorGlobalMetaId: string;
  resourceUri: string;
  requestHash: string;
  tokenHash: Buffer;
  expiresAt: number;
}

interface PendingPermissionAuthorization {
  actorId: number;
  actorGlobalMetaId: string;
  resourceUri: string;
  sessionId: string;
  requestHash: string;
  tokenHash: Buffer;
  expiresAt: number;
}

interface ActivePermissionContext {
  actorId: number;
  actorGlobalMetaId: string;
  resourceUri: string;
  sessionId: string;
  grants: BrowserPermissionGrant[];
}

interface HostConfirmationAttempt {
  id: string;
  token: string;
}

function parseHostConfirmationAttempt(payload: unknown):
  | HostConfirmationAttempt
  | BrowserCommandResult<never>
  | null {
  const body = objectRecord(payload);
  if (!body) return null;

  const hasConfirmed = Object.prototype.hasOwnProperty.call(body, 'confirmed');
  const hasHostConfirmation = Object.prototype.hasOwnProperty.call(body, 'hostConfirmation');
  if (!hasConfirmed && !hasHostConfirmation) {
    return null;
  }

  const hostConfirmation = objectRecord(body.hostConfirmation);
  const id = text(hostConfirmation?.id);
  const token = text(hostConfirmation?.token);
  if (body.confirmed !== true || !id || !token) {
    return invalidConfirmation();
  }
  return { id, token };
}

function normalizedResourceUri(value: unknown): string {
  const resourceUri = text(value);
  if (!resourceUri || resourceUri.length > 4096 || /[\r\n]/u.test(resourceUri)) {
    return '';
  }
  return resourceUri;
}

function normalizedSessionId(value: unknown): string {
  const sessionId = text(value);
  if (!sessionId || sessionId.length > 256 || /[\r\n]/u.test(sessionId)) {
    return '';
  }
  return sessionId;
}

function validateLlmCompletePayload(payload: unknown):
  | BrowserLlmCompletePayload
  | BrowserCommandResult<never> {
  const body = objectRecord(payload);
  const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
  if (!body || rawMessages.length === 0 || rawMessages.length > MAX_LLM_MESSAGES) {
    return failure('invalid_params', 'LLM completion requires between 1 and 128 messages.');
  }

  const messages: BrowserLlmCompletePayload['messages'] = [];
  let totalBytes = 0;
  for (const value of rawMessages) {
    const message = objectRecord(value);
    const role = text(message?.role);
    const content = text(message?.content);
    if ((role !== 'system' && role !== 'user' && role !== 'assistant') || !content) {
      return failure('invalid_params', 'LLM completion messages are invalid.');
    }
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_LLM_INPUT_BYTES) {
      return failure('invalid_params', 'LLM completion input exceeds the 64KB limit.');
    }
    messages.push({ role, content });
  }

  const normalized: BrowserLlmCompletePayload = { messages };
  const rawOptions = objectRecord(body.options);
  if (rawOptions) {
    const options: NonNullable<BrowserLlmCompletePayload['options']> = {};
    if (rawOptions.temperature !== undefined) {
      const temperature = Number(rawOptions.temperature);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        return failure('invalid_params', 'LLM completion temperature must be between 0 and 2.');
      }
      options.temperature = temperature;
    }
    if (rawOptions.maxOutputTokens !== undefined) {
      const maxOutputTokens = Number(rawOptions.maxOutputTokens);
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32_768) {
        return failure('invalid_params', 'LLM completion maxOutputTokens is invalid.');
      }
      options.maxOutputTokens = maxOutputTokens;
    }
    if (rawOptions.timeoutMs !== undefined) {
      const timeoutMs = Number(rawOptions.timeoutMs);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
        return failure('invalid_params', 'LLM completion timeoutMs must be between 1000 and 120000.');
      }
      options.timeoutMs = timeoutMs;
    }
    if (rawOptions.thinking === 'enabled' || rawOptions.thinking === 'disabled') {
      // DeepSeek v4-pro 默认 thinking，轻量 llm.complete 调用可显式 disabled 提速。
      (options as { thinking?: string }).thinking = rawOptions.thinking;
    }
    if (Object.keys(options).length > 0) {
      normalized.options = options;
    }
  }

  const purpose = text(body.purpose);
  if (purpose) {
    normalized.purpose = purpose.slice(0, 120);
  }
  return normalized;
}

interface ValidatedPermissionsRequest {
  grants: BrowserPermissionGrant[];
  reason?: string;
}

function validatePermissionsRequest(payload: unknown):
  | ValidatedPermissionsRequest
  | BrowserCommandResult<never> {
  const body = objectRecord(payload);
  const rawGrants = Array.isArray(body?.grants) ? body.grants : [];
  if (!body || rawGrants.length === 0 || rawGrants.length > MAX_PERMISSION_GRANTS) {
    return failure('invalid_params', 'Permission request requires between 1 and 32 grants.');
  }

  const grants = new Map<string, BrowserPermissionGrant>();
  for (const value of rawGrants) {
    const grant = objectRecord(value);
    const method = text(grant?.method);
    const operation = text(grant?.operation);
    const pathValue = text(grant?.path);
    if (
      method !== 'metaid.pin.write'
      || operation !== 'create'
      || !PROTOCOL_GRANT_PATH_PATTERN.test(pathValue)
    ) {
      return failure(
        'invalid_params',
        'Permissions only support MetaID PIN create writes on exact protocol paths.',
      );
    }
    grants.set(`${method}:${operation}:${pathValue}`, {
      method: 'metaid.pin.write',
      operation: 'create',
      path: pathValue,
    });
  }

  const reason = text(body.reason);
  return {
    grants: [...grants.values()],
    ...(reason ? { reason: reason.slice(0, 500) } : {}),
  };
}

function requestHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokenMatches(token: string, expectedHash: Buffer): boolean {
  const actualHash = tokenHash(token);
  return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
}

function slidingWindowCount(
  timestamps: Map<string, number[]>,
  key: string,
  nowValue: number,
  windowMs: number,
): number {
  const active = (timestamps.get(key) ?? []).filter((stamp) => nowValue - stamp < windowMs);
  if (active.length) {
    timestamps.set(key, active);
  } else {
    timestamps.delete(key);
  }
  return active.length;
}

function recordTimestamp(timestamps: Map<string, number[]>, key: string, nowValue: number): void {
  const active = timestamps.get(key) ?? [];
  active.push(nowValue);
  timestamps.set(key, active);
}

function isLlmTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const name = text((error as { name?: unknown }).name);
  return name === 'AbortError' || name === 'BrowserLlmTimeout';
}

function isEmptyCompletionError(error: unknown): boolean {
  if (!error) return false;
  const name = text((error as { name?: unknown }).name);
  return name === 'EmptyCompletion';
}

function sanitizeLlmModelName(value: unknown): string {
  const model = text(value);
  if (!model) return '';
  return model.replace(/[\r\n]/gu, ' ').slice(0, 64);
}

function sanitizeLlmFinishReason(value: unknown): 'stop' | 'length' | 'error' | undefined {
  const reason = text(value);
  return reason === 'stop' || reason === 'length' || reason === 'error' ? reason : undefined;
}

function validateUploadPayload(payload: unknown): {
  multiple: boolean;
  accept: string[];
  purpose?: string;
} | BrowserCommandResult<never> {
  const body = objectRecord(payload);
  const source = objectRecord(body?.source);
  if (!body || text(source?.kind) !== 'host-picker') {
    return failure('invalid_params', 'MetaFile upload source.kind must be host-picker.');
  }

  const accept = Array.isArray(source?.accept)
    ? source.accept.map(text).filter(Boolean)
    : [];
  return {
    multiple: source?.multiple === true,
    accept,
    purpose: text(body.purpose) || undefined,
  };
}

function safeUploadName(uploadResult: Record<string, unknown>, pickedFile: BotBrowserHostPickedFile): string {
  return (
    text(uploadResult.fileName) ||
    text(uploadResult.name) ||
    text(pickedFile.name) ||
    path.basename(text(pickedFile.filePath)) ||
    'upload'
  );
}

function mapUploadResult(
  uploadResult: Record<string, unknown>,
  pickedFile: BotBrowserHostPickedFile,
  actor: MetaAppBridgeActor,
): BotBrowserMetaFileUploadResultFile | BrowserCommandResult<never> {
  const pinId = text(uploadResult.pinId);
  if (!pinId) {
    return failure('upload_failed', 'MetaFile upload failed.');
  }
  const name = safeUploadName(uploadResult, pickedFile);
  const contentType = text(uploadResult.contentType) || 'application/octet-stream';
  const uri = text(uploadResult.metafileUri) || `metafile://${pinId}`;
  const sizeValue = Number(uploadResult.size);
  const file: BotBrowserMetaFileUploadResultFile = {
    pinId,
    uri,
    name,
    size: Number.isFinite(sizeValue) && sizeValue >= 0 ? sizeValue : 0,
    contentType,
    actor,
  };
  const contentHash = text(uploadResult.contentHash);
  if (contentHash) {
    file.contentHash = contentHash;
  }
  return file;
}

export function createBotBrowserBridgeService(
  deps: BotBrowserBridgeServiceDeps,
): BotBrowserBridgeService {
  const pendingPinWrites = new Map<string, PendingPinWriteAuthorization>();
  const pendingPermissions = new Map<string, PendingPermissionAuthorization>();
  const activePermissions = new Map<string, ActivePermissionContext>();
  // Per-resource sliding windows for host-owned v1.1 quotas.
  const llmTimestamps = new Map<string, number[]>();
  const llmInFlight = new Set<string>();
  const grantedWriteTimestamps = new Map<string, number[]>();
  const now = deps.now ?? Date.now;
  const confirmationTtlMs = typeof deps.confirmationTtlMs === 'number'
    && Number.isFinite(deps.confirmationTtlMs)
    && deps.confirmationTtlMs >= 0
    ? deps.confirmationTtlMs
    : PIN_WRITE_CONFIRMATION_TTL_MS;
  const llmTimeoutMs = typeof deps.llmTimeoutMs === 'number'
    && Number.isFinite(deps.llmTimeoutMs)
    && deps.llmTimeoutMs > 0
    ? Math.min(deps.llmTimeoutMs, LLM_COMPLETE_MAX_TIMEOUT_MS)
    : LLM_COMPLETE_DEFAULT_TIMEOUT_MS;
  const createConfirmationId = deps.createConfirmationId ?? randomUUID;
  const createConfirmationToken = deps.createConfirmationToken
    ?? (() => randomBytes(32).toString('base64url'));
  const recordAudit = deps.audit
    ?? ((event: BotBrowserBridgeAuditEvent) => {
      console.info('[browser-bridge-audit]', JSON.stringify(event));
    });

  const removeExpiredPinWrites = (currentTime: number) => {
    for (const [confirmationId, authorization] of pendingPinWrites) {
      if (authorization.expiresAt <= currentTime) {
        pendingPinWrites.delete(confirmationId);
      }
    }
    for (const [confirmationId, authorization] of pendingPermissions) {
      if (authorization.expiresAt <= currentTime) {
        pendingPermissions.delete(confirmationId);
      }
    }
  };

  const permissionContextKey = (
    actorResult: { metabot: Metabot; actor: MetaAppBridgeActor },
    resourceUri: string,
    sessionId: string,
  ): string => JSON.stringify([
    sessionId,
    actorResult.metabot.id,
    actorResult.actor.globalMetaId,
    resourceUri,
  ]);

  const hasAutoWritePermission = (
    actorResult: { metabot: Metabot; actor: MetaAppBridgeActor },
    resourceUri: string,
    sessionId: string,
    operation: 'create' | 'modify' | 'revoke',
    pinPath: string,
  ): boolean => {
    if (!sessionId || operation !== 'create') return false;
    const context = activePermissions.get(permissionContextKey(actorResult, resourceUri, sessionId));
    return Boolean(context?.grants.some((grant) => (
      grant.method === 'metaid.pin.write'
      && grant.operation === 'create'
      && grant.path === pinPath
    )));
  };

  const issuePinWriteConfirmation = (
    actorResult: { metabot: Metabot; actor: MetaAppBridgeActor },
    resourceUri: string,
    validation: Exclude<ReturnType<typeof validatePinWritePayload>, BrowserCommandResult<never>>,
  ): BrowserCommandResult<BotBrowserPinWriteResult> => {
    const issuedAt = now();
    removeExpiredPinWrites(issuedAt);
    if (pendingPinWrites.size >= MAX_PENDING_PIN_WRITE_CONFIRMATIONS) {
      const oldestConfirmationId = pendingPinWrites.keys().next().value;
      if (typeof oldestConfirmationId === 'string') {
        pendingPinWrites.delete(oldestConfirmationId);
      }
    }

    const confirmationId = createConfirmationId();
    const opaqueToken = createConfirmationToken();
    const expiresAt = issuedAt + confirmationTtlMs;
    pendingPinWrites.set(confirmationId, {
      actorId: actorResult.metabot.id,
      actorGlobalMetaId: actorResult.actor.globalMetaId,
      resourceUri,
      requestHash: requestHash(validation.normalizedPayload),
      tokenHash: tokenHash(opaqueToken),
      expiresAt,
    });

    return browserManualActionRequired(
      'manual_action_required',
      'Confirm this MetaID PIN write before the host signs or broadcasts it.',
      {
        data: {
          confirmation: {
            actor: actorResult.actor,
            operation: validation.operation,
            path: validation.path,
            contentType: validation.contentType,
            payloadSize: validation.payloadSize,
            confirmationId,
            expiresAt,
            display: validation.display,
          },
          confirmRequest: {
            resourceUri,
            kind: 'metaid-pin-write',
            payload: {
              ...validation.normalizedPayload,
              confirmed: true,
              hostConfirmation: {
                id: confirmationId,
                token: opaqueToken,
              },
            },
          },
        },
      },
    );
  };

  const issuePermissionsConfirmation = (
    actorResult: { metabot: Metabot; actor: MetaAppBridgeActor },
    resourceUri: string,
    sessionId: string,
    validation: ValidatedPermissionsRequest,
  ): BrowserCommandResult<BrowserPermissionsResult> => {
    const issuedAt = now();
    removeExpiredPinWrites(issuedAt);
    if (pendingPermissions.size >= MAX_PENDING_PIN_WRITE_CONFIRMATIONS) {
      const oldestConfirmationId = pendingPermissions.keys().next().value;
      if (typeof oldestConfirmationId === 'string') {
        pendingPermissions.delete(oldestConfirmationId);
      }
    }

    const normalizedPayload = {
      grants: validation.grants,
      ...(validation.reason ? { reason: validation.reason } : {}),
    };
    const confirmationId = createConfirmationId();
    const opaqueToken = createConfirmationToken();
    const expiresAt = issuedAt + confirmationTtlMs;
    pendingPermissions.set(confirmationId, {
      actorId: actorResult.metabot.id,
      actorGlobalMetaId: actorResult.actor.globalMetaId,
      resourceUri,
      sessionId,
      requestHash: requestHash(normalizedPayload),
      tokenHash: tokenHash(opaqueToken),
      expiresAt,
    });

    return browserManualActionRequired(
      'manual_action_required',
      'Confirm this session write permission request.',
      {
        data: {
          confirmation: {
            actor: actorResult.actor,
            grants: validation.grants,
            ...(validation.reason ? { reason: validation.reason } : {}),
          },
          confirmRequest: {
            resourceUri,
            kind: 'permissions-request',
            payload: {
              ...normalizedPayload,
              confirmed: true,
              hostConfirmation: {
                id: confirmationId,
                token: opaqueToken,
              },
            },
          },
        },
      },
    ) as BrowserCommandResult<BrowserPermissionsResult>;
  };

  return {
    async writeMetaIdPin(input: BotBrowserPinWriteInput): Promise<BrowserCommandResult<BotBrowserPinWriteResult>> {
      const actorResult = resolveActor(deps.metabotStore, input.actorId);
      if (isCommandFailure(actorResult)) {
        const confirmationAttempt = parseHostConfirmationAttempt(input.payload);
        if (!isCommandFailure(confirmationAttempt) && confirmationAttempt) {
          const authorization = pendingPinWrites.get(confirmationAttempt.id);
          if (authorization && tokenMatches(confirmationAttempt.token, authorization.tokenHash)) {
            pendingPinWrites.delete(confirmationAttempt.id);
          }
        }
        return actorResult;
      }

      const resourceUri = normalizedResourceUri(input.resourceUri);
      if (!resourceUri) {
        return failure('invalid_request', 'MetaID PIN write resourceUri is required.');
      }
      const sessionId = normalizedSessionId(input.sessionId);

      const validation = validatePinWritePayload(input.payload);
      if (isCommandFailure(validation)) return validation;

      if (!deps.createPin) {
        return failure('unsupported_method', 'MetaID PIN write is not supported in this IDBots build.');
      }

      const confirmationAttempt = parseHostConfirmationAttempt(input.payload);
      if (isCommandFailure(confirmationAttempt)) return confirmationAttempt;
      const autoWriteAuthorized = !confirmationAttempt && hasAutoWritePermission(
        actorResult,
        resourceUri,
        sessionId,
        validation.operation,
        validation.path,
      );
      if (!confirmationAttempt && !autoWriteAuthorized) {
        return issuePinWriteConfirmation(actorResult, resourceUri, validation);
      }

      if (confirmationAttempt) {
        const authorization = pendingPinWrites.get(confirmationAttempt.id);
        if (!authorization || !tokenMatches(confirmationAttempt.token, authorization.tokenHash)) {
          return invalidConfirmation();
        }

        const currentTime = now();
        if (authorization.expiresAt <= currentTime) {
          pendingPinWrites.delete(confirmationAttempt.id);
          return issuePinWriteConfirmation(actorResult, resourceUri, validation);
        }

        if (
          authorization.actorId !== actorResult.metabot.id
          || authorization.actorGlobalMetaId !== actorResult.actor.globalMetaId
          || authorization.resourceUri !== resourceUri
          || authorization.requestHash !== requestHash(validation.normalizedPayload)
        ) {
          pendingPinWrites.delete(confirmationAttempt.id);
          return invalidConfirmation();
        }

        // Consume before signing so a retry cannot replay an authorization even
        // when transaction construction or broadcast later fails.
        pendingPinWrites.delete(confirmationAttempt.id);
      }

      // Granted writes skip the two-phase confirmation, so the host enforces
      // its own quota (≤12 per minute per resource) and payload cap (≤16KB)
      // before the request reaches the signer.
      if (autoWriteAuthorized) {
        const grantedResourceKey = resourceUri || 'default-granted-write';
        if (validation.payloadSize > GRANTED_WRITE_MAX_PAYLOAD_BYTES) {
          return failure('invalid_params', 'Granted write payload exceeds the 16KB limit.');
        }
        if (slidingWindowCount(grantedWriteTimestamps, grantedResourceKey, now(), 60_000) >= GRANTED_WRITE_RATE_LIMIT_PER_MINUTE) {
          return failure('rate_limited', 'Too many granted writes in the last minute.');
        }
        recordTimestamp(grantedWriteTimestamps, grantedResourceKey, now());
      }

      try {
        const result = await deps.createPin(
          deps.metabotStore,
          actorResult.metabot.id,
          validation.metaidPayload,
          { network: text(input.network) || undefined },
        );
        const pinId = text(result.pinId);
        const txid = text(result.txids?.[0]);
        if (!pinId || !txid) {
          return failure('pin_write_failed', 'MetaID PIN write failed.');
        }
        if (autoWriteAuthorized) {
          recordAudit({
            type: 'granted-write',
            at: now(),
            actorId: actorResult.metabot.id,
            actorGlobalMetaId: actorResult.actor.globalMetaId,
            resourceUri,
            sessionId,
            path: validation.path,
            pinId,
            txid,
          });
        }
        return browserSuccess({
          pinId,
          txid,
          operation: validation.operation,
          path: validation.path,
          actor: actorResult.actor,
        });
      } catch {
        return failure('pin_write_failed', 'MetaID PIN write failed.');
      }
    },

    async completeLlm(input: BotBrowserLlmCompleteInput): Promise<BrowserCommandResult<BrowserLlmCompleteResult>> {
      const actorResult = resolveActor(deps.metabotStore, input.actorId);
      if (isCommandFailure(actorResult)) return actorResult;

      const resourceUri = normalizedResourceUri(input.resourceUri);
      const sessionId = normalizedSessionId(input.sessionId);
      if (!resourceUri || !sessionId) {
        return failure('invalid_request', 'LLM completion requires a resourceUri and sessionId.');
      }

      const validation = validateLlmCompletePayload(input.payload);
      if (isCommandFailure(validation)) return validation;
      if (!deps.completeLlm) {
        return failure('unsupported_method', 'Local LLM completion is not supported in this IDBots build.');
      }

      // Host-owned quota: one in-flight completion per resource and ≤6 per
      // minute per resource. Exceeded limits return rate_limited.
      const resourceKey = resourceUri;
      if (slidingWindowCount(llmTimestamps, resourceKey, now(), 60_000) >= LLM_COMPLETE_RATE_LIMIT_PER_MINUTE) {
        return failure('rate_limited', 'Local LLM rate limit reached; try again in a minute.');
      }
      if (llmInFlight.has(resourceKey)) {
        return failure('rate_limited', 'Another local LLM completion is already running for this MetaApp.');
      }

      llmInFlight.add(resourceKey);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          deps.completeLlm({
            metabot: actorResult.metabot,
            actor: actorResult.actor,
            resourceUri,
            sessionId,
            payload: validation,
          }),
          new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
              const error = new Error('Local LLM completion timed out.');
              error.name = 'BrowserLlmTimeout';
              reject(error);
            }, llmTimeoutMs);
          }),
        ]);
        clearTimeout(timeoutHandle);
        const completionText = text(result.text);
        if (!completionText) {
          return failure('empty_content', 'Local LLM returned an empty completion.');
        }
        recordTimestamp(llmTimestamps, resourceKey, now());
        // Sanitized response: display-grade model name and finish reason only.
        const data: BrowserLlmCompleteResult = { text: completionText };
        const model = sanitizeLlmModelName(result.model);
        if (model) data.model = model;
        const finishReason = sanitizeLlmFinishReason(result.finishReason);
        if (finishReason) data.finishReason = finishReason;
        return browserSuccess(data);
      } catch (error) {
        clearTimeout(timeoutHandle);
        if (isLlmTimeoutError(error)) {
          return failure('llm_timeout', 'Local LLM completion timed out.');
        }
        if (isEmptyCompletionError(error)) {
          return failure('empty_content', (error as Error).message);
        }
        return failure('llm_unavailable', 'Local LLM completion failed.');
      } finally {
        llmInFlight.delete(resourceKey);
      }
    },

    async requestPermissions(input: BotBrowserPermissionsInput): Promise<BrowserCommandResult<BrowserPermissionsResult>> {
      const actorResult = resolveActor(deps.metabotStore, input.actorId);
      if (isCommandFailure(actorResult)) return actorResult;

      const resourceUri = normalizedResourceUri(input.resourceUri);
      const sessionId = normalizedSessionId(input.sessionId);
      if (!resourceUri || !sessionId) {
        return failure('invalid_request', 'Permission requests require a resourceUri and sessionId.');
      }

      const rawPayload = objectRecord(input.payload);
      if (rawPayload?.revoke === true) {
        const contextKey = permissionContextKey(actorResult, resourceUri, sessionId);
        const existing = activePermissions.get(contextKey);
        if (existing) {
          activePermissions.delete(contextKey);
          recordAudit({
            type: 'permission-revoked',
            at: now(),
            actorId: actorResult.metabot.id,
            actorGlobalMetaId: actorResult.actor.globalMetaId,
            resourceUri,
            sessionId,
            grants: existing.grants,
          });
        }
        return browserSuccess({ revoked: true } as unknown as BrowserPermissionsResult);
      }

      const validation = validatePermissionsRequest(input.payload);
      if (isCommandFailure(validation)) return validation;

      const offWhitelist = validation.grants.find(
        (grant) => !PROTOCOL_GRANT_WHITELIST.has(grant.path),
      );
      if (offWhitelist) {
        return failure(
          'consent_denied',
          `The requested protocol path is not on the host whitelist: ${offWhitelist.path}`,
        );
      }

      const contextKey = permissionContextKey(actorResult, resourceUri, sessionId);
      const existing = activePermissions.get(contextKey);
      if (existing && validation.grants.every((requested) => existing.grants.some((granted) => (
        granted.method === requested.method
        && granted.operation === requested.operation
        && granted.path === requested.path
      )))) {
        return browserSuccess({ granted: existing.grants });
      }

      const confirmationAttempt = parseHostConfirmationAttempt(input.payload);
      if (isCommandFailure(confirmationAttempt)) return confirmationAttempt;
      if (!confirmationAttempt) {
        return issuePermissionsConfirmation(actorResult, resourceUri, sessionId, validation);
      }

      const authorization = pendingPermissions.get(confirmationAttempt.id);
      if (!authorization || !tokenMatches(confirmationAttempt.token, authorization.tokenHash)) {
        return invalidConfirmation();
      }

      const currentTime = now();
      if (authorization.expiresAt <= currentTime) {
        pendingPermissions.delete(confirmationAttempt.id);
        return issuePermissionsConfirmation(actorResult, resourceUri, sessionId, validation);
      }

      const normalizedPayload = {
        grants: validation.grants,
        ...(validation.reason ? { reason: validation.reason } : {}),
      };
      if (
        authorization.actorId !== actorResult.metabot.id
        || authorization.actorGlobalMetaId !== actorResult.actor.globalMetaId
        || authorization.resourceUri !== resourceUri
        || authorization.sessionId !== sessionId
        || authorization.requestHash !== requestHash(normalizedPayload)
      ) {
        pendingPermissions.delete(confirmationAttempt.id);
        return invalidConfirmation();
      }

      pendingPermissions.delete(confirmationAttempt.id);
      const merged = new Map<string, BrowserPermissionGrant>();
      for (const grant of existing?.grants ?? []) {
        merged.set(`${grant.method}:${grant.operation}:${grant.path}`, grant);
      }
      for (const grant of validation.grants) {
        merged.set(`${grant.method}:${grant.operation}:${grant.path}`, grant);
      }
      const grants = [...merged.values()];
      activePermissions.set(contextKey, {
        actorId: actorResult.metabot.id,
        actorGlobalMetaId: actorResult.actor.globalMetaId,
        resourceUri,
        sessionId,
        grants,
      });
      recordAudit({
        type: 'permission-granted',
        at: now(),
        actorId: actorResult.metabot.id,
        actorGlobalMetaId: actorResult.actor.globalMetaId,
        resourceUri,
        sessionId,
        grants,
        ...(validation.reason ? { reason: validation.reason } : {}),
      });
      return browserSuccess({ granted: grants });
    },

    async uploadMetaFile(input: BotBrowserMetaFileUploadInput): Promise<BrowserCommandResult<BotBrowserMetaFileUploadResult>> {
      const actorResult = resolveActor(deps.metabotStore, input.actorId);
      if (isCommandFailure(actorResult)) return actorResult;

      const validation = validateUploadPayload(input.payload);
      if (isCommandFailure(validation)) return validation;

      if (!deps.pickFiles || !deps.uploadMetaFile) {
        return failure('unsupported_method', 'MetaFile upload is not supported in this IDBots build.');
      }

      try {
        const pickedFiles = await deps.pickFiles(validation);
        if (!pickedFiles.length) {
          return failure('user_cancelled', 'MetaFile upload was cancelled.');
        }

        const selectedFiles = validation.multiple ? pickedFiles : pickedFiles.slice(0, 1);
        const files: BotBrowserMetaFileUploadResultFile[] = [];
        for (const pickedFile of selectedFiles) {
          const filePath = text(pickedFile.filePath);
          if (!filePath) {
            return failure('upload_failed', 'MetaFile upload failed.');
          }
          const uploadResult = await deps.uploadMetaFile(deps.metabotStore, {
            metabotId: actorResult.metabot.id,
            filePath,
            contentType: text(pickedFile.contentType) || undefined,
            network: text(input.network) || undefined,
          });
          const mapped = mapUploadResult(uploadResult, pickedFile, actorResult.actor);
          if (isCommandFailure(mapped)) return mapped;
          files.push(mapped);
        }

        return browserSuccess({ files });
      } catch {
        return failure('upload_failed', 'MetaFile upload failed.');
      }
    },
  };
}
