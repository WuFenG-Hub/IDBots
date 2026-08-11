/**
 * Main↔renderer bridge for Bot Browser screenshots.
 *
 * Mirrors botBrowserTabBridge, but instead of driving the ABC runtime it asks
 * the renderer that hosts the BotBrowserSurface to capture the active tab's
 * pixels. The renderer owns the only copy of the surface's on-screen geometry
 * (the iframe rect, and — because the ABC shell is a same-origin srcDoc iframe
 * — the nested MetaApp frame rect), so it computes the capture rect (optionally
 * narrowed by a clip region) and calls the botBrowser:capturePage IPC
 * (main-side webContents.capturePage) to produce the image in the requested
 * format. This bridge only orchestrates the request/response round trip and
 * resolves with the base64 image.
 *
 * Unlike tab commands, capture never steals focus: a minimized window is
 * restored (so the compositor has fresh pixels) but never focused.
 */
export type BotBrowserCaptureClip = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BotBrowserCaptureFormat = 'png' | 'jpeg';

export type BotBrowserCaptureRequest = {
  tabId?: number;
  /** When true, capture the whole Bot Browser surface (including the ABC chrome). */
  fullSurface?: boolean;
  /**
   * Optional region (CSS px) relative to the resolved capture target's top-left
   * (the content area by default, the whole surface when fullSurface is set).
   * Clamped to the target bounds by the renderer.
   */
  clip?: BotBrowserCaptureClip;
  /** Output format; defaults to png. jpeg is smaller for sending to the model. */
  format?: BotBrowserCaptureFormat;
  /** JPEG quality 0–100 (ignored for png). Defaults to 80. */
  quality?: number;
};

export type BotBrowserCaptureResult = {
  /** Base64-encoded image bytes (PNG or JPEG, see mimeType). */
  data: string;
  mimeType: string;
  width: number;
  height: number;
};

export type BotBrowserCaptureResponse = {
  requestId: string;
  success: boolean;
  result?: BotBrowserCaptureResult;
  error?: string;
};

type BrowserCaptureBridgeWebContents = {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
};

type BrowserCaptureBridgeWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  webContents: BrowserCaptureBridgeWebContents;
};

type PendingCapture = {
  target: BrowserCaptureBridgeWebContents;
  resolve(result: BotBrowserCaptureResult): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

export type BotBrowserCaptureBridge = {
  capture(input: BotBrowserCaptureRequest): Promise<BotBrowserCaptureResult>;
  handleResponse(
    source: BrowserCaptureBridgeWebContents,
    response: BotBrowserCaptureResponse,
  ): void;
  dispose(): void;
};

export function createBotBrowserCaptureBridge(options: {
  getWindows(): BrowserCaptureBridgeWindow[];
  timeoutMs?: number;
}): BotBrowserCaptureBridge {
  const pending = new Map<string, PendingCapture>();
  const timeoutMs = options.timeoutMs ?? 15_000;
  let requestSequence = 0;
  let disposed = false;

  const capture = (input: BotBrowserCaptureRequest): Promise<BotBrowserCaptureResult> => {
    if (disposed) {
      return Promise.reject(new Error('Bot Browser capture bridge is disposed'));
    }

    const targetWindow = options.getWindows().find((window) => (
      !window.isDestroyed() && !window.webContents.isDestroyed()
    ));
    if (!targetWindow) {
      return Promise.reject(new Error('No IDBots window is available to capture the Bot Browser'));
    }

    const requestId = `bot-browser-capture-${Date.now()}-${++requestSequence}`;
    const promise = new Promise<BotBrowserCaptureResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Bot Browser capture request timed out'));
      }, timeoutMs);
      pending.set(requestId, {
        target: targetWindow.webContents,
        resolve,
        reject,
        timeout,
      });
    });

    try {
      targetWindow.webContents.send('botBrowser:capture-request', { requestId, ...input });
      // The Bot Browser surface must paint to be captured. Restore a minimized
      // window so the compositor has fresh pixels; do NOT steal focus.
      if (targetWindow.isMinimized()) targetWindow.restore();
    } catch (error) {
      const request = pending.get(requestId);
      if (request) {
        clearTimeout(request.timeout);
        pending.delete(requestId);
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return promise;
  };

  const handleResponse = (
    source: BrowserCaptureBridgeWebContents,
    response: BotBrowserCaptureResponse,
  ): void => {
    const requestId = String(response?.requestId ?? '').trim();
    if (!requestId) return;
    const request = pending.get(requestId);
    if (!request || request.target !== source) return;

    clearTimeout(request.timeout);
    pending.delete(requestId);
    if (!response.success || !response.result) {
      request.reject(new Error(String(response.error || 'Bot Browser capture failed')));
      return;
    }
    request.resolve(response.result);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Bot Browser capture bridge was closed'));
    }
    pending.clear();
  };

  return { capture, handleResponse, dispose };
}
