/**
 * C2 gateway protocol — frame types, error codes, and the inbound frame codec
 * for the mobile gateway WebSocket (`/gateway/v1/ws`).
 *
 * Pure module: no electron imports, loadable from plain node. The server
 * layer (WS-A T3 wiring) composes this with the allowlist, the IPC registry,
 * and the ws socket.
 *
 * Contract: docs/cloud-mobile/01-interface-contracts.md, C2 "Frames",
 * "Error Codes", and "Limits".
 */

import { DEFAULT_INVOKE_TIMEOUT_MS } from './allowlist';

// ---------------------------------------------------------------------------
// Error codes (C2 "Error Codes")
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'CHANNEL_NOT_ALLOWED'
  | 'CHANNEL_NOT_FOUND'
  | 'INVALID_FRAME'
  | 'INVALID_ARGS'
  | 'ARG_RESTRICTED'
  | 'HANDLER_ERROR'
  | 'TIMEOUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'TENANT_NOT_READY'
  | 'UPGRADING';

/** Default retryable flag per code; `makeError` uses this unless overridden. */
export const ERROR_RETRYABLE: Record<ErrorCode, boolean> = {
  CHANNEL_NOT_ALLOWED: false,
  CHANNEL_NOT_FOUND: false,
  INVALID_FRAME: false,
  INVALID_ARGS: false,
  ARG_RESTRICTED: false,
  HANDLER_ERROR: false,
  TIMEOUT: true,
  PAYLOAD_TOO_LARGE: false,
  RATE_LIMITED: true,
  TENANT_NOT_READY: true,
  UPGRADING: true,
};

export interface GatewayError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Frame types (C2 "Frames"); every frame carries v: 1.
// ---------------------------------------------------------------------------

export type Welcome = {
  v: 1;
  type: 'welcome';
  contractVersion: string;
  appVersion: string;
  tenantId: string;
  serverTime: number;
  ready: boolean;
  phase: string;
};

export type Invoke = {
  v: 1;
  type: 'invoke';
  id: string;
  channel: string;
  args: unknown[];
};

export type Result =
  | { v: 1; type: 'result'; id: string; ok: true; value: unknown }
  | { v: 1; type: 'result'; id: string; ok: false; error: GatewayError };

export type Event = {
  v: 1;
  type: 'event';
  channel: string;
  args: unknown[];
};

export type Ping = { v: 1; type: 'ping'; ts: number };
export type Pong = { v: 1; type: 'pong'; ts: number };

export type OutboundFrame = Welcome | Result | Event | Pong;
export type InboundFrame = Invoke | Ping;

// ---------------------------------------------------------------------------
// Limits (C2 "Limits")
// ---------------------------------------------------------------------------

export const INBOUND_FRAME_MAX_BYTES = 1024 * 1024; // 1 MiB
export const OUTBOUND_FRAME_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
export const MAX_IN_FLIGHT_INVOKES = 32;
export const INVOKE_RATE_PER_SEC = 50;
export const INVOKE_RATE_BURST = 100;

/** Re-exported from the allowlist module so all timeout data has one home. */
export { DEFAULT_INVOKE_TIMEOUT_MS };

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function makeError(code: ErrorCode, message: string, retryable?: boolean): GatewayError {
  return { code, message, retryable: retryable ?? ERROR_RETRYABLE[code] };
}

export function makeResultOk(id: string, value: unknown): Result {
  return { v: 1, type: 'result', id, ok: true, value };
}

export function makeResultError(id: string, error: GatewayError): Result {
  return { v: 1, type: 'result', id, ok: false, error };
}

/** Type guard for the error side of the `signFileDownload`-style unions. */
export function isGatewayError(value: unknown): value is GatewayError {
  return (
    !!value
    && typeof value === 'object'
    && typeof (value as GatewayError).code === 'string'
    && typeof (value as GatewayError).message === 'string'
    && typeof (value as GatewayError).retryable === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// Inbound frame codec
// ---------------------------------------------------------------------------

const MAX_INVOKE_ID_LENGTH = 64;

function invalidFrame(message: string): { ok: false; error: GatewayError } {
  return { ok: false, error: makeError('INVALID_FRAME', message) };
}

/**
 * Parse and structurally validate one inbound text frame. Only `invoke` and
 * `ping` travel client → server; anything else is INVALID_FRAME.
 */
export function parseInboundFrame(text: string): { ok: true; frame: InboundFrame } | { ok: false; error: GatewayError } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalidFrame('frame is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalidFrame('frame must be a JSON object');
  }
  const frame = raw as Record<string, unknown>;
  if (frame.v !== 1) {
    return invalidFrame(`unsupported frame version: ${String(frame.v)}`);
  }
  if (frame.type === 'ping') {
    if (typeof frame.ts !== 'number' || !Number.isFinite(frame.ts)) {
      return invalidFrame('ping frame requires a numeric ts');
    }
    return { ok: true, frame: { v: 1, type: 'ping', ts: frame.ts } };
  }
  if (frame.type !== 'invoke') {
    return invalidFrame(`unsupported frame type: ${String(frame.type)}`);
  }
  if (
    typeof frame.id !== 'string'
    || frame.id.length === 0
    || frame.id.length > MAX_INVOKE_ID_LENGTH
  ) {
    return invalidFrame(`invoke frame requires an id of 1..${MAX_INVOKE_ID_LENGTH} chars`);
  }
  if (typeof frame.channel !== 'string' || frame.channel.length === 0) {
    return invalidFrame('invoke frame requires a non-empty channel string');
  }
  if (!Array.isArray(frame.args)) {
    return invalidFrame('invoke frame requires an args array');
  }
  return {
    ok: true,
    frame: { v: 1, type: 'invoke', id: frame.id, channel: frame.channel, args: frame.args },
  };
}

export function encodeFrame(frame: OutboundFrame | InboundFrame): string {
  return JSON.stringify(frame);
}
