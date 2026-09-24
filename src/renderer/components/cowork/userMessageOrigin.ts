/**
 * Origin resolution for right-side (user-type) cowork messages.
 *
 * Every user bubble has an origin — the local human via the composer, a
 * quick action, a long-term-task heartbeat, a scheduled (cron) task, a
 * cross-session forward, a relayed MetaWeb group/private message, or the
 * orchestrator. Origins resolve from explicit `metadata.origin` tags first,
 * then from legacy markers (`sourceChannel`, `source: 'quick_action'`,
 * `submissionId`) so historical messages are labeled too; the final fallback
 * is 'user'.
 *
 * Pure module (no React / electron imports) so it can be unit-tested.
 */
import type { CoworkMessage } from '../../types/cowork';

export type UserMessageOriginKind =
  | 'user'
  | 'quick_action'
  | 'heartbeat'
  | 'schedule'
  | 'cross_session'
  | 'metaweb_group'
  | 'metaweb_private'
  | 'orchestrator';

export interface UserMessageOrigin {
  kind: UserMessageOriginKind;
  /** Extra detail: scheduled task name, source session id, ... */
  detail?: string;
  /** Remote sender globalMetaId for metaweb_group / metaweb_private origins. */
  senderGlobalMetaId?: string;
}

export interface UserMessageOriginContext {
  sessionType?: string;
  sessionTitle?: string;
}

const EXPLICIT_ORIGIN_KINDS: ReadonlySet<string> = new Set<UserMessageOriginKind>([
  'user',
  'quick_action',
  'heartbeat',
  'schedule',
  'cross_session',
  'metaweb_group',
  'metaweb_private',
  'orchestrator',
]);

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

export const resolveUserMessageOrigin = (
  message: CoworkMessage,
  context?: UserMessageOriginContext,
): UserMessageOrigin => {
  const metadata = (message.metadata ?? {}) as Record<string, unknown>;

  const explicit = asNonEmptyString(metadata.origin);
  if (explicit && EXPLICIT_ORIGIN_KINDS.has(explicit)) {
    return {
      kind: explicit as UserMessageOriginKind,
      detail: asNonEmptyString(metadata.originLabel),
    };
  }

  const sourceChannel = asNonEmptyString(metadata.sourceChannel);
  if (sourceChannel === 'idbots_cross_session') {
    return { kind: 'cross_session', detail: asNonEmptyString(metadata.sourceSessionId) };
  }
  if (
    sourceChannel === 'metaweb_group'
    || sourceChannel === 'metaweb_private'
    || sourceChannel === 'orchestrator'
  ) {
    return {
      kind: sourceChannel,
      senderGlobalMetaId:
        asNonEmptyString(metadata.latestMessageSenderGlobalmetaid)
        ?? asNonEmptyString(metadata.senderGlobalMetaId),
    };
  }

  if (metadata.source === 'quick_action') {
    return { kind: 'quick_action' };
  }
  if (asNonEmptyString(metadata.submissionId)) {
    return { kind: 'user' };
  }

  // Legacy heuristics for untagged messages: heartbeat escalations and
  // scheduled-task prompts were persisted with no metadata at all. Composer
  // input in those sessions always carries a submissionId, so an untagged
  // user message in a longterm / [定时] session is machine-submitted.
  if (context?.sessionType === 'longterm') {
    return { kind: 'heartbeat' };
  }
  const title = context?.sessionTitle ?? '';
  if (title.startsWith('[定时] ')) {
    return { kind: 'schedule', detail: title.slice('[定时] '.length) };
  }

  return { kind: 'user' };
};
