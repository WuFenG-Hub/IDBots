import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { isRenderableAvatarSource } from '../../utils/avatarSource';

const DEFAULT_BOT_AVATAR = getDefaultMetabotAvatarUrl();

const IDLE_PHRASE_KEYS = [
  'assistantStatusIdleThinking',
  'assistantStatusIdleLookingUp',
  'assistantStatusIdleOrganizing',
  'assistantStatusIdleAlmostThere',
] as const;

const IDLE_PHRASE_INTERVAL_MS = 3000;

/**
 * Assistant-mode replacement for StreamingActivityBar: the session bot's
 * avatar with a soft breathing ring plus a friendly status line. Status
 * wording stays non-technical (no tool names, no retry counters) — real
 * runtime signals (api_retry / requesting / unpaired tool_use) still take
 * precedence over the rotating idle phrases, mirroring the professional bar's
 * precedence so the text never contradicts the actual state.
 *
 * Two placements: above the composer for the whole running state (default),
 * and `inline` inside the transcript at the reply position while the turn has
 * no visible content yet (replacing the professional TypingDots).
 */
export const AssistantActivityIndicator: React.FC<{
  messages: CoworkMessage[];
  avatar?: string | null;
  fallbackText?: string;
  /** Drop the page-level gutter/max-width wrapper for inline transcript use. */
  inline?: boolean;
}> = ({ messages, avatar, fallbackText, inline = false }) => {
  const [idlePhraseIndex, setIdlePhraseIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIdlePhraseIndex((index) => (index + 1) % IDLE_PHRASE_KEYS.length);
    }, IDLE_PHRASE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const getStatusText = (): string => {
    // SDK runtime-status signals (api_retry / requesting) take precedence —
    // they describe the transport layer, not the agent loop.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const status = msg.metadata?.sdkRuntimeStatus;
      if (status === 'api_retry') {
        return i18nService.t('assistantStatusRetrying');
      }
      if (status === 'requesting') {
        return i18nService.t('assistantStatusThinking');
      }
      // Stop scanning once we hit a non-runtime-status message — only the most
      // recent SDK status applies.
      break;
    }

    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      const id = msg.metadata?.toolUseId;
      if (typeof id === 'string' && msg.type === 'tool_result') {
        toolResultIds.add(id);
      }
    }
    // Walk backwards to find the latest unresolved tool_use. Assistant mode
    // never names the tool — one generic "working on it" line.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'tool_use') {
        const id = msg.metadata?.toolUseId;
        if (typeof id === 'string' && !toolResultIds.has(id)) {
          return i18nService.t('assistantStatusWorking');
        }
      }
    }
    return fallbackText || i18nService.t(IDLE_PHRASE_KEYS[idlePhraseIndex]);
  };

  const avatarSrc = isRenderableAvatarSource(avatar) ? avatar! : DEFAULT_BOT_AVATAR;

  const row = (
    <div className="flex items-center gap-2.5 py-2">
      <div className="assistant-activity-avatar-ring relative h-8 w-8 shrink-0">
        <img
          src={avatarSrc}
          alt=""
          className="h-8 w-8 rounded-full object-cover border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_BOT_AVATAR; }}
        />
      </div>
      <span className="min-w-0 truncate text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {getStatusText()}
      </span>
    </div>
  );

  if (inline) {
    return row;
  }

  return (
    <div className="shrink-0 animate-fade-in px-4">
      <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
        {row}
      </div>
    </div>
  );
};
