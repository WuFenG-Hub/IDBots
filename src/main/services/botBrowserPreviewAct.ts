import type { BotBrowserTabCommand, BotBrowserTabCommandResult } from './botBrowserTabBridge';
import { readRendererFromEnvelope } from './botBrowserSourceLocator';

/**
 * Gesture-free act executor for the MetaApp preview frame inside the Bot
 * Browser.
 *
 * The preview renders inside a sandboxed CROSS-ORIGIN iframe (served by the
 * local preview/cache server on 127.0.0.1), so neither the renderer bridge nor
 * the ABC page can reach into it — only the main process can, via the
 * privileged WebFrameMain.executeJavaScript() which bypasses same-origin
 * policy. The host window runs with autoplayPolicy
 * 'no-user-gesture-required', so a play() dispatched here starts without any
 * user gesture.
 *
 * Scope guardrails: the executor only touches frames whose URL matches the
 * ACTIVE tab's renderer URL AND only when that renderer is a locally served
 * (localhost) html-iframe preview. First-party pages (bot homepages, pin
 * inspectors) and ordinary web content are never actable through this module.
 *
 * Everything below is expressed against structural shapes (no `electron`
 * import) so the pure helpers are unit-testable under tsx.
 */

export type BotBrowserPreviewActAction = 'click' | 'read' | 'state';

export type BotBrowserPreviewActRequest = {
  action: BotBrowserPreviewActAction;
  /** CSS selector inside the preview frame. Required for click; optional for read (defaults to body). Ignored by state. */
  selector?: string;
  /** Target tab; defaults to the ACTIVE Bot Browser tab. */
  tabId?: number;
};

export type BotBrowserPreviewActClicked = {
  tag: string;
  id: string | null;
  text: string;
};

export type BotBrowserPreviewActMedia = {
  tag: string;
  paused: boolean;
  muted: boolean;
  currentTime: number;
  readyState: number;
  src: string;
};

export type BotBrowserPreviewActOutcome = {
  action: BotBrowserPreviewActAction;
  tabId: number | null;
  frameUrl: string;
  clicked?: BotBrowserPreviewActClicked;
  text?: string;
  truncated?: boolean;
  pageTitle?: string | null;
  media?: BotBrowserPreviewActMedia[];
};

/** Structural shape of an Electron WebFrameMain (main process, privileged). */
export type ActFrameShape = {
  url: string;
  frames: ActFrameShape[];
  /** Matches Electron's real signature, which resolves to Promise<unknown>. */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
};

export type ActWebContentsShape = {
  isDestroyed(): boolean;
  mainFrame: ActFrameShape;
};

export type ActWindowShape = {
  isDestroyed(): boolean;
  webContents: ActWebContentsShape;
};

const MAX_READ_CHARS = 8000;
const MAX_CLICKED_TEXT_CHARS = 160;

/**
 * The act surface is limited to locally served previews (the browser-cache
 * preview server and the local MetaApp/preview-metaapp servers) — never
 * arbitrary web content, even if a future renderer type ever hosts one.
 */
export function isActableRenderUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * The iframe src recorded in the tab's renderer envelope vs. the live frame
 * URL should be equal; startsWith keeps the match stable when the live URL
 * carries query/fragment residue the envelope omits.
 */
export function frameMatchesRendererUrl(frameUrl: string, rendererUrl: string): boolean {
  if (!rendererUrl) return false;
  return frameUrl === rendererUrl || frameUrl.startsWith(rendererUrl);
}

/** Depth-first collection of frames whose URL matches the renderer URL. */
export function collectMatchingFrames(root: ActFrameShape, rendererUrl: string): ActFrameShape[] {
  const out: ActFrameShape[] = [];
  const visit = (frame: ActFrameShape): void => {
    if (frameMatchesRendererUrl(frame.url, rendererUrl)) out.push(frame);
    for (const child of frame.frames ?? []) visit(child);
  };
  visit(root);
  return out;
}

const jsonLiteral = (value: unknown): string => JSON.stringify(value ?? null);

/**
 * Build the privileged script executed inside the preview frame. The selector
 * is injected as a JSON literal (never string-concatenated), so agent-supplied
 * selectors cannot break out of the snippet.
 */
export function buildPreviewActScript(
  action: BotBrowserPreviewActAction,
  selector?: string,
): string {
  const sel = jsonLiteral(typeof selector === 'string' ? selector : undefined);
  if (action === 'click') {
    return `(() => {
  const el = document.querySelector(${sel});
  if (!el) return { ok: false, reason: 'selector-not-found', selector: ${sel} };
  try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* offscreen is fine */ }
  el.click();
  return { ok: true, tag: String(el.tagName || '').toLowerCase(), id: el.id || null, text: String(el.textContent || '').trim().slice(0, ${MAX_CLICKED_TEXT_CHARS}) };
})()`;
  }
  if (action === 'read') {
    return `(() => {
  const el = ${sel} ? document.querySelector(${sel}) : document.body;
  if (!el) return { ok: false, reason: 'selector-not-found', selector: ${sel} };
  const text = String(el.innerText || el.textContent || '');
  return { ok: true, text: text.slice(0, ${MAX_READ_CHARS}), truncated: text.length > ${MAX_READ_CHARS} };
})()`;
  }
  return `(() => {
  const media = Array.from(document.querySelectorAll('audio, video')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    paused: el.paused,
    muted: el.muted,
    currentTime: Number(el.currentTime && el.currentTime.toFixed ? el.currentTime.toFixed(2) : 0),
    readyState: el.readyState,
    src: String(el.currentSrc || el.src || '').slice(0, 200),
  }));
  return { ok: true, pageTitle: document.title || null, media };
})()`;
}

type ActTabBridge = {
  execute(command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult>;
};

export type BotBrowserPreviewActDeps = {
  getWindows(): ActWindowShape[];
  executeTabCommand: ActTabBridge['execute'];
  readRenderer?(current: unknown): { type?: string; url?: string };
};

const resolveActiveTabId = async (deps: BotBrowserPreviewActDeps): Promise<number> => {
  const active = await deps.executeTabCommand({ action: 'get-active-tab' });
  const id = active.activeTab?.id;
  if (typeof id !== 'number') {
    throw new Error('No active Bot Browser tab is available to act on.');
  }
  return id;
};

/**
 * Resolve the active (or requested) tab's renderer envelope, locate the
 * matching preview frame across live windows, and execute the action inside
 * it. Throws honest, agent-readable errors for every unreachable case.
 */
export async function executeBotBrowserPreviewAct(
  deps: BotBrowserPreviewActDeps,
  request: BotBrowserPreviewActRequest,
): Promise<BotBrowserPreviewActOutcome> {
  const readRenderer = deps.readRenderer ?? readRendererFromEnvelope;
  const tabId = typeof request.tabId === 'number'
    ? request.tabId
    : await resolveActiveTabId(deps);

  const info = await deps.executeTabCommand({ action: 'get-tab-info', tabId });
  const renderer = readRenderer(info.info?.current);
  if (renderer.type !== 'html-iframe' || !renderer.url) {
    throw new Error(
      `The active Bot Browser tab is not a MetaApp preview (renderer: ${renderer.type || 'unknown'}); there is nothing to act on. Open a metaapp:// page first.`,
    );
  }
  if (!isActableRenderUrl(renderer.url)) {
    throw new Error(
      `The active tab's renderer (${renderer.url.slice(0, 120)}) is not a locally served preview; acting on it is not permitted.`,
    );
  }

  const matches: ActFrameShape[] = [];
  for (const window of deps.getWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    matches.push(...collectMatchingFrames(window.webContents.mainFrame, renderer.url));
  }
  if (!matches.length) {
    throw new Error(
      'No live MetaApp preview frame matches the active tab yet — the page may still be loading. Retry in a moment.',
    );
  }

  const frame = matches[0];
  const script = buildPreviewActScript(request.action, request.selector);
  const payload = (await frame.executeJavaScript(script, true)) as Record<string, unknown> | null;
  if (!payload || payload.ok !== true) {
    const reason = String((payload as { reason?: unknown } | null)?.reason || 'action failed');
    throw new Error(`Preview act failed: ${reason}${request.selector ? ` (selector: ${request.selector})` : ''}`);
  }

  const outcome: BotBrowserPreviewActOutcome = {
    action: request.action,
    tabId,
    frameUrl: frame.url,
  };
  if (request.action === 'click') {
    outcome.clicked = {
      tag: String(payload.tag || ''),
      id: typeof payload.id === 'string' ? payload.id : null,
      text: String(payload.text || ''),
    };
  }
  if (request.action === 'read') {
    outcome.text = String(payload.text || '');
    outcome.truncated = payload.truncated === true;
  }
  if (request.action === 'state') {
    outcome.pageTitle = typeof payload.pageTitle === 'string' ? payload.pageTitle : null;
    outcome.media = Array.isArray(payload.media) ? (payload.media as BotBrowserPreviewActMedia[]) : [];
  }
  return outcome;
}
