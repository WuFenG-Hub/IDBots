/**
 * In-app session deep link emitted e.g. by the Twin Bot's daily report:
 * idbots://session/<sessionId> jumps straight to the referenced CoWork
 * conversation via the app-wide 'cowork:viewSession' DOM event (handler in
 * App.tsx). Other idbots:// shapes are not recognised and stay no-ops.
 *
 * Consumed by MarkdownContent link rendering and by the inline HTML report
 * block's in-frame link bridge, so both surfaces behave identically.
 */

export const IDBOTS_SESSION_URI_RE = /^idbots:\/\/session\/([A-Za-z0-9][A-Za-z0-9._~-]*)$/i;

/** Extract the session id from an idbots://session/<id> URI, or null. */
export const parseIdbotsSessionUri = (href: string): string | null => {
  const match = href.trim().match(IDBOTS_SESSION_URI_RE);
  return match ? match[1] : null;
};

/** Jump to a CoWork conversation (App.tsx listens and switches view/session). */
export const dispatchViewSession = (sessionId: string): void => {
  window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId } }));
};
