import { useEffect } from 'react';

/**
 * Renderer-side handler for Bot Browser screenshot requests.
 *
 * The main process asks the renderer that hosts the BotBrowserSurface to capture
 * the active tab (botBrowser:capture-request). Only this renderer knows the
 * surface's on-screen geometry: the outer ABC iframe rect (iframeRef), and —
 * because the ABC shell is a same-origin srcDoc iframe — the nested MetaApp
 * frame rect, read from the ABC document without modifying ABC.
 *
 * The actual pixel capture happens via the existing cowork captureImageChunk IPC
 * (main-side webContents.capturePage); this hook only resolves the rect and
 * forwards the resulting base64 PNG back to the capture bridge.
 */

type CaptureRequestInput = {
  requestId: string;
  tabId?: number;
  fullSurface?: boolean;
};

type CaptureRect = { x: number; y: number; width: number; height: number };

const NOT_VISIBLE_ERROR =
  'Bot Browser surface is not visible. Ask the user to switch to Bot Browser mode.';

/**
 * Resolve the MetaApp content frame rect (the `iframe.browser-html-frame` inside
 * the ABC shell) to parent-viewport coordinates. Returns null when no such frame
 * exists (e.g. a first-party bot homepage or the gallery) so the caller falls
 * back to the whole surface.
 */
function resolveContentFrameRect(
  iframe: HTMLIFrameElement,
  outerRect: DOMRect,
): CaptureRect | null {
  // The ABC shell is a same-origin srcDoc iframe, so its document is readable.
  // We only read the nested frame ELEMENT's geometry — never its cross-origin
  // contentDocument — which is all capturePage needs.
  let doc: Document | null = null;
  try {
    doc = iframe.contentDocument;
  } catch {
    return null;
  }
  if (!doc) return null;

  const frame = doc.querySelector('iframe.browser-html-frame');
  if (!frame) return null;

  const r = frame.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1) return null;

  // getBoundingClientRect on an element inside the ABC document is relative to
  // the ABC iframe's viewport; offset by the iframe's own position to get
  // parent-viewport coordinates (which is what capturePage expects).
  return {
    x: outerRect.left + r.left,
    y: outerRect.top + r.top,
    width: r.width,
    height: r.height,
  };
}

export function useBotBrowserCapture(options: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  visible: boolean;
}): void {
  const { iframeRef, visible } = options;

  useEffect(() => {
    const botBrowser = window.electron?.botBrowser;
    const cowork = window.electron?.cowork;
    if (!botBrowser?.onCaptureRequest || !botBrowser.respondToCaptureRequest || !cowork?.captureImageChunk) {
      return;
    }

    const unsubscribe = botBrowser.onCaptureRequest(async (input: CaptureRequestInput) => {
      const { requestId, fullSurface } = input;
      const respond = (payload: {
        success: boolean;
        result?: { pngBase64: string; width: number; height: number };
        error?: string;
      }) => {
        botBrowser.respondToCaptureRequest({ requestId, ...payload });
      };

      const iframe = iframeRef.current;
      if (!visible || !iframe) {
        respond({ success: false, error: NOT_VISIBLE_ERROR });
        return;
      }

      const outerRect = iframe.getBoundingClientRect();
      if (outerRect.width <= 1 || outerRect.height <= 1) {
        respond({ success: false, error: NOT_VISIBLE_ERROR });
        return;
      }

      const wholeSurface: CaptureRect = {
        x: outerRect.left,
        y: outerRect.top,
        width: outerRect.width,
        height: outerRect.height,
      };
      const rect = fullSurface
        ? wholeSurface
        : (resolveContentFrameRect(iframe, outerRect) ?? wholeSurface);

      try {
        const result = await cowork.captureImageChunk({ rect });
        if (!result?.success || !result.pngBase64) {
          respond({ success: false, error: result?.error || 'Failed to capture the Bot Browser surface.' });
          return;
        }
        respond({
          success: true,
          result: {
            pngBase64: result.pngBase64,
            width: result.width ?? Math.round(rect.width),
            height: result.height ?? Math.round(rect.height),
          },
        });
      } catch (error) {
        respond({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
    });

    return unsubscribe;
  }, [iframeRef, visible]);
}
