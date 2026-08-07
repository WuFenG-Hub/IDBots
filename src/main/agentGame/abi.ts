/**
 * Agent-Game-v2: ABI types and `agent-game/1` protocol envelope.
 *
 * Implements the frozen contract surface defined in:
 *  - docs/08-game-adapter-abi-v1.md  (Adapter ABI v1)
 *  - docs/07-agent-game-protocol-v1.md (event envelope)
 *  - docs/09-abc-app-session-requirements.md (session API + error codes)
 *
 * The host Runtime is game-agnostic: every game is a conforming `adapter.js`
 * module. These types are the only contract the host depends on.
 */

/* ------------------------------------------------------------------ */
/* Adapter ABI v1 (frozen)                                            */
/* ------------------------------------------------------------------ */

/** Adapter config passed to `createMatch` / `initialState`. */
export interface AdapterConfig {
  gameId: string;
  seat: string;
  /** Additional game-specific options from the Manifest (maxPlayers, turnModel, ...). */
  options?: Record<string, unknown>;
}

/** Deterministic turn descriptor returned by `getTurn`. */
export interface TurnInfo {
  /** Current phase of the match. */
  phase: 'playing' | 'finished';
  /** Seat identifier whose turn it is when `phase === 'playing'`. */
  seat?: string;
  /** Optional winner seat when `phase === 'finished'`. */
  winner?: string | null;
}

/** Structured validation outcome. Adapters must return codes, not prose. */
export interface ValidationResult {
  valid: boolean;
  /** Machine-readable code when invalid (e.g. `out_of_turn`, `illegal_move`). */
  code?: string;
  message?: string;
  /** The canonical/normalized action the host should write on-chain. */
  normalizedAction?: unknown;
}

/** Parse outcome of `parseAction`. */
export interface ParseResult {
  error?: string;
  action?: unknown;
}

/** Match result reported by `getResult`. */
export interface MatchResult {
  finished: boolean;
  winner?: string | null;
  score?: Record<string, unknown>;
  /** Optional human-readable summary. */
  summary?: string;
}

/**
 * The 10 frozen Adapter exports (docs/08). Every function MUST be:
 *  - deterministic (no Math.random / Date.now side effects),
 *  - side-effect free (no network / fs / host bridge),
 *  - JSON-serializable in every input and output.
 *
 * The host only ever calls these through the sandbox; it never imports the
 * adapter directly.
 */
export interface GameAdapter {
  createMatch(config: AdapterConfig): unknown;
  initialState(config: AdapterConfig): unknown;
  reduce(state: unknown, event: GameEvent): unknown;
  getTurn(state: unknown): TurnInfo;
  getObservation(state: unknown, seat: string): unknown;
  getActionSchema(state: unknown, seat: string): unknown;
  parseAction(llmText: string, context: ActionContext): ParseResult;
  validateAction(state: unknown, action: unknown, context: ActionContext): ValidationResult;
  serializeState(state: unknown): string;
  getResult(state: unknown): MatchResult;
}

/** Context handed to `parseAction` / `validateAction`. */
export interface ActionContext {
  schema: unknown;
  observation: unknown;
  seat: string;
}

/* ------------------------------------------------------------------ */
/* Manifest                                                           */
/* ------------------------------------------------------------------ */

/** `game-manifest.json` shipped beside `adapter.js`. */
export interface GameManifest {
  protocol: 'agent-game/1';
  gameId: string;
  rulesVersion: string;
  adapter: string;
  adapterHash: string;
  turnModel: 'sequential' | 'simultaneous';
  informationModel: 'public' | 'private';
  maxPlayers: number;
}

/* ------------------------------------------------------------------ */
/* `agent-game/1` event envelope (docs/07)                           */
/* ------------------------------------------------------------------ */

export type GameEventType =
  | 'match.created'
  | 'seat.claimed'
  | 'match.ready'
  | 'action'
  | 'resign'
  | 'timeout.claimed'
  | 'match.finished'
  | 'chat';

/** Common envelope fields shared by all event types. */
export interface GameEventBase {
  protocol: 'agent-game/1';
  gameId: string;
  /** Must equal the outer group chat's groupId. */
  matchId: string;
  rulesHash: string;
  type: GameEventType;
  /** `<actorGlobalMetaId>:<uuid>` — used for write retries / dedup. */
  eventId: string;
}

/** `action` event (docs/07 §3). */
export interface ActionEvent extends GameEventBase {
  type: 'action';
  /** Sequence number, continuous from 1, only for action events. */
  actionSeq: number;
  prevStateHash: string;
  stateHash: string;
  payload: Record<string, unknown>;
}

export type GameEvent = GameEventBase | ActionEvent;

/** Narrow an envelope to an `action` event. */
export function isActionEvent(env: GameEvent): env is ActionEvent {
  return env.type === 'action';
}

/* ------------------------------------------------------------------ */
/* Session state machine + budget                                     */
/* ------------------------------------------------------------------ */

export type SessionStatus = 'running' | 'paused' | 'stopped' | 'finished' | 'error';

/** Resource budget for a session. Pauses when depleted. */
export interface SessionBudget {
  llmCalls: number;
  llmCallsUsed: number;
  writes: number;
  writesUsed: number;
}

/** Task-level authorization grant bound at `start` time. */
export interface SessionConsent {
  actorId: string;
  appId: string;
  groupId: string;
  gameId: string;
  rulesHash: string;
  adapterHash: string;
  seat: string;
  resourceUri: string;
  /** Protocol paths allowed for auto-write (skip manual confirmation). */
  protocolPaths: string[];
  ttlMs: number;
  budget: SessionBudget;
  grantedAt: number;
}

/** Persistent session record owned by the host Runtime. */
export interface GameSession {
  sessionId: string;
  status: SessionStatus;
  appId: string;
  groupId: string;
  gameId: string;
  /** Actor globalMetaId (agentId). */
  agentId: string;
  seat: string;
  rulesHash: string;
  adapterHash: string;
  manifestUri: string;
  protocolPaths: string[];
  budget: SessionBudget;
  /** Cursor: max consumed group message index. */
  lastIndex: number;
  /** Sequence of the most recent valid action. */
  lastActionSeq: number;
  lastError: SessionError | null;
  expiresAt: number;
  consent: SessionConsent | null;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Structured error captured in `lastError`. */
export interface SessionError {
  code: SessionErrorCode;
  message: string;
  at: number;
}

/* ------------------------------------------------------------------ */
/* Error codes (docs/09 §1)                                           */
/* ------------------------------------------------------------------ */

export type SessionErrorCode =
  | 'invalid_params'
  | 'unsupported_method'
  | 'consent_denied'
  | 'session_not_found'
  | 'session_conflict'
  | 'adapter_invalid'
  | 'rules_hash_mismatch'
  | 'group_not_found'
  | 'seat_unavailable'
  | 'adapter_error'
  | 'adapter_timeout'
  | 'llm_unavailable'
  | 'llm_timeout'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'bridge_timeout'
  | 'internal_error';

/* ------------------------------------------------------------------ */
/* `browser.app.session.*` request/response shapes (docs/09 §3)       */
/* ------------------------------------------------------------------ */

export interface SessionStartParams {
  appId: string;
  sessionType?: string;
  groupId: string;
  gameId: string;
  manifestUri: string;
  rulesHash: string;
  seat: string;
  agentId: string;
  ttlMs: number;
  budget: { llmCalls: number; writes: number };
  protocolPaths?: string[];
}

export interface SessionListParams {
  appId?: string;
  status?: SessionStatus;
  groupId?: string;
}

export interface SessionStatusParams {
  sessionId: string;
}

export interface SessionPauseParams {
  sessionId: string;
}

export interface SessionResumeParams {
  sessionId: string;
}

export interface SessionStopParams {
  sessionId: string;
  releaseSeat?: boolean;
}

/** Public session view returned by every session method. */
export interface SessionView {
  sessionId: string;
  status: SessionStatus;
  appId: string;
  groupId: string;
  gameId: string;
  seat: string;
  agentId: string;
  lastIndex: number;
  lastActionSeq: number;
  lastError: SessionError | null;
  expiresAt: number;
  budget: SessionBudget;
}

/** Map an internal session record to the public view. */
export function toSessionView(s: GameSession): SessionView {
  return {
    sessionId: s.sessionId,
    status: s.status,
    appId: s.appId,
    groupId: s.groupId,
    gameId: s.gameId,
    seat: s.seat,
    agentId: s.agentId,
    lastIndex: s.lastIndex,
    lastActionSeq: s.lastActionSeq,
    lastError: s.lastError,
    expiresAt: s.expiresAt,
    budget: s.budget,
  };
}
