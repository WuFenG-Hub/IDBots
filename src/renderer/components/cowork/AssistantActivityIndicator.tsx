import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { isRenderableAvatarSource } from '../../utils/avatarSource';
import { splitThinkTaggedContent } from './ThinkingBlock';

const DEFAULT_BOT_AVATAR = getDefaultMetabotAvatarUrl();

const IDLE_PHRASE_KEYS = [
  'assistantStatusIdleThinking',
  'assistantStatusIdleLookingUp',
  'assistantStatusIdleOrganizing',
  'assistantStatusIdleAlmostThere',
  'assistantStatusIdleMoment',
  'assistantStatusIdleLeads',
  'assistantStatusIdleSorting',
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
 * Single placement: `inline` inside the transcript at the reply position,
 * where it is assistant mode's only activity indicator. It stays visible
 * through the ENTIRE running state — pre-first-token wait, narration and
 * reply streaming, tool runs, hidden thinking — and only its status line
 * differentiates the phases; stepping aside while text streamed left
 * multi-minute tool windows looking idle. Professional mode keeps the
 * above-composer StreamingActivityBar.
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

    // Visible reply text actively streaming (narration or the final answer):
    // the newest streaming non-thinking assistant message is the live one. A
    // stream carrying only think-tag content so far renders nothing in
    // assistant mode, so that still reads as "thinking".
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant' || !msg.metadata?.isStreaming || msg.metadata?.isThinking) {
        continue;
      }
      const content = typeof msg.content === 'string' ? msg.content : '';
      const split = splitThinkTaggedContent(content);
      const visibleText = split.thinking ? split.text : content;
      return i18nService.t(visibleText.trim() ? 'assistantStatusWriting' : 'assistantStatusThinking');
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
    // pt-2 keeps the ring's breathing room below the bubble above it; the
    // bottom edge is slimmer (pb-1) because inline placement is always the
    // transcript's last row and the composer should sit close under it.
    <div className="flex items-center gap-2.5 pt-2 pb-1">
      <div className="assistant-activity-avatar-ring relative h-8 w-8 shrink-0">
        <img
          src={avatarSrc}
          alt=""
          className="h-8 w-8 rounded-full object-cover border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_BOT_AVATAR; }}
        />
      </div>
      {/* The status line gets a calm light-sweep shimmer (CSS class in
          index.css, gated on prefers-reduced-motion: no-preference); the
          glyphs themselves never move. */}
      <span className="assistant-status-shimmer min-w-0 truncate text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
