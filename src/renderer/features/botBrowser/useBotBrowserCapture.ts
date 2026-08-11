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
 * The actual pixel capture happens via the botBrowser:capturePage IPC
 * (main-side webContents.capturePage, PNG or JPEG); this hook only resolves the
 * rect (optionally narrowed to a clip region), requests the format, and forwards
 * the resulting base64 image back to the capture bridge.
 */

type CaptureRequestInput = {
  requestId: string;
  tabId?: number;
  fullSurface?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  format?: 'png' | 'jpeg';
  quality?: number;
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
    if (!botBrowser?.onCaptureRequest || !botBrowser.respondToCaptureRequest || !botBrowser.capturePage) {
      return;
    }

    const unsubscribe = botBrowser.onCaptureRequest(async (input: CaptureRequestInput) => {
      const { requestId, fullSurface, clip, format, quality } = input;
      const respond = (payload: {
        success: boolean;
        result?: { data: string; mimeType: string; width: number; height: number };
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
      const target = fullSurface
        ? wholeSurface
        : (resolveContentFrameRect(iframe, outerRect) ?? wholeSurface);

      // Narrow the resolved target to the clip region (CSS px, relative to the
      // target's top-left), clamped to the target bounds so capturePage never
      // receives an out-of-range rect.
      let rect = target;
      if (clip) {
        const cx = Math.max(0, clip.x);
        const cy = Math.max(0, clip.y);
        const cw = Math.max(0, Math.min(clip.width, target.width - cx));
        const ch = Math.max(0, Math.min(clip.height, target.height - cy));
        if (cw <= 1 || ch <= 1) {
          respond({ success: false, error: 'clip region is outside the capture target bounds.' });
          return;
        }
        rect = { x: target.x + cx, y: target.y + cy, width: cw, height: ch };
      }

      try {
        const result = await botBrowser.capturePage({
          rect,
          ...(format ? { format } : {}),
          ...(typeof quality === 'number' ? { quality } : {}),
        });
        if (!result?.success || !result.data) {
          respond({ success: false, error: result?.error || 'Failed to capture the Bot Browser surface.' });
          return;
        }
        respond({
          success: true,
          result: {
            data: result.data,
            mimeType: result.mimeType ?? 'image/png',
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
