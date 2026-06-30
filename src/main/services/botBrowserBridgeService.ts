import path from 'path';
import {
  browserFailure,
  browserSuccess,
  type BrowserCommandResult,
} from '@openagentinternet/agent-browser-host-contract';
import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import type { MetaidDataPayload } from './metaidCore';

const MAX_PIN_PAYLOAD_BYTES = 512 * 1024;

export type BotBrowserBridgeErrorCode =
  | 'invalid_request'
  | 'unsupported_method'
  | 'invalid_params'
  | 'actor_required'
  | 'manual_action_required'
  | 'user_cancelled'
  | 'upload_failed'
  | 'pin_write_failed';

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

export interface BotBrowserPinWriteConfirmDetails {
  actor: MetaAppBridgeActor;
  operation: 'create' | 'modify' | 'revoke';
  path: string;
  contentType: string;
  payloadSize: number;
  display: {
    title?: string;
    summary?: string;
  };
}

export interface BotBrowserPinWriteInput {
  actorId?: string;
  resourceUri?: string;
  payload?: unknown;
  network?: string;
}

export interface BotBrowserMetaFileUploadInput {
  actorId?: string;
  resourceUri?: string;
  payload?: unknown;
  network?: string;
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

export interface BotBrowserBridgeServiceDeps {
  metabotStore: MetabotStore;
  createPin?: CreatePinFn;
  uploadMetaFile?: UploadMetaFileFn;
  confirmPinWrite?: (details: BotBrowserPinWriteConfirmDetails) => Promise<boolean>;
  pickFiles?: (input: {
    multiple: boolean;
    accept: string[];
    purpose?: string;
  }) => Promise<BotBrowserHostPickedFile[]>;
}

export interface BotBrowserBridgeService {
  writeMetaIdPin(input: BotBrowserPinWriteInput): Promise<BrowserCommandResult<BotBrowserPinWriteResult>>;
  uploadMetaFile(input: BotBrowserMetaFileUploadInput): Promise<BrowserCommandResult<BotBrowserMetaFileUploadResult>>;
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

function decodePayload(payloadRecord: Record<string, unknown>): {
  payload: string | Buffer;
  encoding: 'utf-8' | 'base64';
  size: number;
} | BrowserCommandResult<never> {
  const encoding = text(payloadRecord.encoding);
  const value = typeof payloadRecord.value === 'string' ? payloadRecord.value : '';
  if (!value) {
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
  operation: 'create' | 'modify' | 'revoke';
  path: string;
  contentType: string;
  payloadSize: number;
  display: { title?: string; summary?: string };
} | BrowserCommandResult<never> {
  const body = objectRecord(payload);
  if (!body) {
    return failure('invalid_params', 'MetaID PIN write payload must be an object.');
  }

  const operation = text(body.operation);
  if (operation !== 'create' && operation !== 'modify' && operation !== 'revoke') {
    return failure('invalid_params', 'MetaID PIN write operation must be create, modify, or revoke.');
  }

  const pinPath = text(body.path);
  if (!pinPath || !pinPath.startsWith('/') || /[\r\n]/u.test(pinPath)) {
    return failure('invalid_params', 'MetaID PIN write path is invalid.');
  }

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
  const decoded = decodePayload(payloadRecord);
  if (isCommandFailure(decoded)) return decoded;

  const displayRecord = objectRecord(body.display);
  const display = {
    title: text(displayRecord?.title) || undefined,
    summary: text(displayRecord?.summary) || undefined,
  };

  return {
    metaidPayload: {
      operation,
      path: pinPath,
      encryption,
      version,
      contentType,
      payload: decoded.payload,
      encoding: decoded.encoding,
    },
    operation,
    path: pinPath,
    contentType,
    payloadSize: decoded.size,
    display,
  };
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
  return {
    async writeMetaIdPin(input: BotBrowserPinWriteInput): Promise<BrowserCommandResult<BotBrowserPinWriteResult>> {
      const actorResult = resolveActor(deps.metabotStore, input.actorId);
      if (isCommandFailure(actorResult)) return actorResult;

      const validation = validatePinWritePayload(input.payload);
      if (isCommandFailure(validation)) return validation;

      if (!deps.createPin) {
        return failure('unsupported_method', 'MetaID PIN write is not supported in this IDBots build.');
      }
      if (!deps.confirmPinWrite) {
        return failure('manual_action_required', 'MetaID PIN write requires host confirmation.');
      }

      const confirmed = await deps.confirmPinWrite({
        actor: actorResult.actor,
        operation: validation.operation,
        path: validation.path,
        contentType: validation.contentType,
        payloadSize: validation.payloadSize,
        display: validation.display,
      });
      if (!confirmed) {
        return failure('user_cancelled', 'MetaID PIN write was cancelled.');
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
