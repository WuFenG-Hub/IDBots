import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { useMockChat } from '../hooks/useMockChat';

/**
 * Chat demo: send messages, watch the streamed reply render token by token,
 * answer a tool-permission request, and trigger the quota-exhausted card.
 */
export function ChatDemo(): JSX.Element {
  const { messages, isStreaming, permission, quotaExhausted, send, respondPermission, dismissQuota } =
    useMockChat();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  const handleSend = () => {
    const text = draft;
    setDraft('');
    void send(text);
  };

  return (
    <div>
      <p className="mb-3 text-xs text-[var(--text-secondary)]">{t('mobile.demo.chatHint')}</p>
      <div ref={scrollRef} className="mb-3 max-h-72 space-y-2 overflow-y-auto rounded-xl bg-[var(--bg-main)] p-3">
        {messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-5 ${
                message.role === 'user'
                  ? 'bg-[var(--color-primary)] text-black'
                  : 'border border-[var(--border-color)] bg-[var(--bg-panel)] text-[var(--text-primary)]'
              }`}
            >
              <div className="mb-0.5 text-[10px] uppercase tracking-wide opacity-60">
                {message.role === 'user' ? t('mobile.demo.you') : t('mobile.demo.assistant')}
              </div>
              {message.text}
              {isStreaming && message.role === 'assistant' ? <span className="animate-pulse">▍</span> : null}
            </div>
          </div>
        ))}
      </div>

      {permission ? (
        <div className="mb-3 rounded-xl border border-amber-400 bg-amber-50 p-3 text-black">
          <div className="mb-1 text-sm font-semibold">{t('mobile.demo.permissionTitle')}</div>
          <div className="mb-2 text-xs">{t('mobile.demo.permissionTool', { name: permission.toolName })}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void respondPermission(true)}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white"
            >
              {t('mobile.demo.permissionApprove')}
            </button>
            <button
              type="button"
              onClick={() => void respondPermission(false)}
              className="rounded-lg bg-red-500 px-4 py-2 text-xs font-medium text-white"
            >
              {t('mobile.demo.permissionDeny')}
            </button>
          </div>
        </div>
      ) : null}

      {quotaExhausted ? (
        <div className="mb-3 rounded-xl border border-red-400 bg-red-50 p-3 text-black">
          <div className="mb-1 text-sm font-semibold">{t('mobile.demo.quotaTitle')}</div>
          <div className="mb-2 text-xs">{t('mobile.demo.quotaBody')}</div>
          <div className="flex gap-2">
            <a
              href="#plans-demo"
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-xs font-medium text-black"
            >
              {t('mobile.demo.rechargeLink')}
            </a>
            <button
              type="button"
              onClick={dismissQuota}
              className="rounded-lg border border-red-300 px-4 py-2 text-xs font-medium text-red-700"
            >
              {t('mobile.demo.dismiss')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSend();
          }}
          placeholder={t('mobile.demo.composerPlaceholder')}
          className="min-w-0 flex-1 rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={isStreaming}
          className="rounded-xl bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {t('mobile.demo.send')}
        </button>
      </div>
    </div>
  );
}
