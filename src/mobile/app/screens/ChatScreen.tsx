import { useEffect, useRef, useState } from 'react';
import { Bars3Icon, PlusIcon, PaperAirplaneIcon, StopIcon } from '@heroicons/react/24/outline';
import MarkdownContent from '@/components/MarkdownContent';
import { t } from '../../i18n';
import type { MockMetabot } from '../../bridge/types';
import type { useChat } from '../hooks/useChat';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import { BottomSheet } from '../components/BottomSheet';

type Chat = ReturnType<typeof useChat>;

function SessionDrawer(props: { chat: Chat; open: boolean; onClose: () => void }): JSX.Element | null {
  const { chat } = props;
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-30">
      <button type="button" aria-label={t('mobile.common.close')} className="absolute inset-0 bg-black/40" onClick={props.onClose} tabIndex={-1} />
      <div className="absolute bottom-0 left-0 top-0 flex w-[85%] max-w-[320px] flex-col bg-[var(--bg-panel)]">
        <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-3">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('mobile.chat.drawerTitle')}</h2>
          <button
            type="button"
            onClick={() => {
              chat.newChat();
              props.onClose();
            }}
            className="flex min-h-[44px] items-center gap-1 px-2 text-sm text-[var(--text-secondary)] active:text-[var(--text-primary)]"
          >
            <PlusIcon className="h-4 w-4" aria-hidden />
            {t('mobile.chat.newChat')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto" data-testid="session-drawer-list">
          {chat.sessions.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--text-secondary)]">{t('mobile.chat.drawerEmpty')}</p>
          ) : (
            chat.sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => {
                  void chat.openSession(session.id);
                  props.onClose();
                }}
                className={`block w-full min-h-[44px] border-b border-[var(--border-color)] px-4 py-3 text-left text-sm active:bg-[var(--bg-hover)] ${
                  session.id === chat.sessionId ? 'bg-[var(--bg-hover)]' : ''
                }`}
              >
                <span className="block truncate text-[var(--text-primary)]">{session.title}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function PermissionSheet({ chat }: { chat: Chat }): JSX.Element | null {
  const permission = chat.permission;
  if (!permission) return null;
  const resolved = permission.resolved;
  return (
    <BottomSheet title={t('mobile.chat.permissionTitle')} onClose={chat.dismissPermission}>
      <p className="mb-1 text-sm text-[var(--text-secondary)]">
        {t('mobile.chat.permissionTool', { name: permission.toolName })}
      </p>
      <pre className="mb-4 max-h-32 overflow-auto rounded-lg bg-[var(--bg-main)] p-3 text-xs text-[var(--text-secondary)]">
        {JSON.stringify(permission.input, null, 2)}
      </pre>
      {resolved ? (
        <p className="min-h-[44px] py-3 text-center text-sm font-medium text-[var(--text-primary)]">
          {resolved === 'approved' ? t('mobile.chat.permissionApproved') : t('mobile.chat.permissionDenied')}
        </p>
      ) : (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => void chat.respondPermission(false)}
            className="min-h-[44px] flex-1 rounded-xl border border-[var(--border-color)] py-2 text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
          >
            {t('mobile.chat.permissionDeny')}
          </button>
          <button
            type="button"
            onClick={() => void chat.respondPermission(true)}
            className="min-h-[44px] flex-1 rounded-xl bg-[var(--color-primary)] py-2 font-medium text-black active:opacity-80"
          >
            {t('mobile.chat.permissionApprove')}
          </button>
        </div>
      )}
    </BottomSheet>
  );
}

function ToolCallList({ chat }: { chat: Chat }): JSX.Element | null {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (chat.toolCalls.length === 0) return null;
  return (
    <div className="border-t border-[var(--border-color)] px-4 py-2" data-testid="tool-call-list">
      {chat.toolCalls.map((call) => {
        const expanded = expandedId === call.requestId;
        return (
          <div key={call.requestId} className="py-1">
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : call.requestId)}
              className="flex min-h-[44px] w-full items-center justify-between gap-2 text-left text-xs text-[var(--text-secondary)] active:text-[var(--text-primary)]"
            >
              <span className="truncate">
                {t('mobile.chat.toolCallSummary', { name: call.toolName })}
                {call.status !== 'pending'
                  ? ` · ${
                      call.status === 'approved'
                        ? t('mobile.chat.toolCallApproved')
                        : t('mobile.chat.toolCallDenied')
                    }`
                  : ''}
              </span>
              <span aria-hidden>{expanded ? '▾' : '▸'}</span>
            </button>
            {expanded ? (
              <div className="mb-1 rounded-lg bg-[var(--bg-main)] p-2">
                <p className="mb-1 text-[11px] font-medium uppercase text-[var(--text-secondary)]">
                  {t('mobile.chat.toolCallInputTitle')}
                </p>
                <pre className="overflow-x-auto text-[11px] text-[var(--text-secondary)]">
                  {JSON.stringify(call.input, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Chat tab (REQ-E-12). */
export default function ChatScreen(props: { chat: Chat; bots: MockMetabot[]; onOpenRecharge: () => void }): JSX.Element {
  const { chat, bots } = props;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const keyboardInset = useKeyboardInset();

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat.messages, chat.isStreaming]);

  const submit = () => {
    const text = draft.trim();
    if (!text || chat.isStreaming) return;
    setDraft('');
    void chat.send(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-panel)] px-2 py-1.5">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label={t('mobile.chat.drawerTitle')}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
        >
          <Bars3Icon className="h-6 w-6" aria-hidden />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--text-primary)]">
          {chat.sessionTitle ?? t('mobile.chat.title')}
        </h1>
      </div>

      <div className="flex gap-2 overflow-x-auto border-b border-[var(--border-color)] bg-[var(--bg-panel)] px-3 py-2">
        <button
          type="button"
          onClick={() => chat.setMetabotId(null)}
          className={`min-h-[36px] shrink-0 rounded-full border px-3 text-sm ${
            chat.metabotId === null
              ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-black'
              : 'border-[var(--border-color)] text-[var(--text-secondary)]'
          }`}
        >
          {t('mobile.chat.allBots')}
        </button>
        {bots.map((bot) => (
          <button
            key={bot.id}
            type="button"
            onClick={() => chat.setMetabotId(bot.id)}
            className={`min-h-[36px] shrink-0 rounded-full border px-3 text-sm ${
              chat.metabotId === bot.id
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-black'
                : 'border-[var(--border-color)] text-[var(--text-secondary)]'
          }`}
          >
            {bot.name}
          </button>
        ))}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {chat.messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-base font-semibold text-[var(--text-primary)]">{t('mobile.chat.emptyTitle')}</p>
            <p className="text-sm text-[var(--text-secondary)]">{t('mobile.chat.emptyBody')}</p>
          </div>
        ) : (
          chat.messages.map((message) => (
            <div key={message.id} className={`mb-3 flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {message.role === 'user' ? (
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[var(--color-primary)] px-3.5 py-2.5 text-[15px] text-black">
                  {message.text}
                </div>
              ) : (
                <div className="max-w-[90%] rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] px-3.5 py-2.5">
                  {/* T3 swap (REQ-E-26): the desktop MarkdownContent renders GFM,
                      highlighted code blocks, and routes file:// link clicks
                      through shell.openPath (the mobile shim signs + opens). */}
                  <MarkdownContent content={message.text} chatExperienceMode="assistant" compact />
                  {message.streaming ? (
                    <span className="mt-1 inline-block h-4 w-2 animate-pulse bg-[var(--color-primary)]" aria-hidden />
                  ) : null}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <ToolCallList chat={chat} />

      {chat.quotaExhausted ? (
        <div className="mx-3 mb-2 rounded-2xl border border-amber-300 bg-amber-50 p-3" data-testid="quota-card">
          <p className="text-sm font-semibold text-amber-800">{t('mobile.chat.quotaTitle')}</p>
          <p className="mb-2 text-sm text-amber-700">{t('mobile.chat.quotaBody')}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={props.onOpenRecharge}
              className="min-h-[44px] flex-1 rounded-xl bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-black active:opacity-80"
            >
              {t('mobile.chat.quotaRecharge')}
            </button>
            <button
              type="button"
              onClick={chat.dismissQuota}
              className="min-h-[44px] rounded-xl border border-amber-300 px-3 py-2 text-sm text-amber-800 active:bg-amber-100"
            >
              {t('mobile.chat.quotaDismiss')}
            </button>
          </div>
        </div>
      ) : null}

      <div
        className="shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-panel)] px-3 pt-2"
        style={{ paddingBottom: `calc(max(env(safe-area-inset-bottom), ${keyboardInset}px) + 8px)` }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('mobile.chat.composerPlaceholder')}
            rows={1}
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none"
          />
          {chat.isStreaming ? (
            <button
              type="button"
              onClick={() => void chat.stop()}
              aria-label={t('mobile.chat.stop')}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-red-100 px-3 text-red-700 active:bg-red-200"
            >
              <StopIcon className="h-5 w-5" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              aria-label={t('mobile.chat.send')}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-[var(--color-primary)] px-3 text-black active:opacity-80 disabled:opacity-40"
            >
              <PaperAirplaneIcon className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>
      </div>

      <SessionDrawer chat={chat} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <PermissionSheet chat={chat} />
    </div>
  );
}
