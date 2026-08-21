import { desktopCapturer, nativeImage, screen, systemPreferences } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Above this size the image is not inlined into the conversation (context guard). */
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** One top-level window as reported by desktopCapturer. */
export type ScreenshotWindowInfo = { id: string; app: string; title: string };

/**
 * Host-side screen capture surface. The default implementation
 * (createElectronScreenshotHost) backs it with Electron's in-process
 * desktopCapturer/screen/nativeImage APIs; tests inject a fake so plain
 * `node --test` never touches electron or the real screen.
 */
export type ScreenshotHost = {
  platform: string;
  /** List top-level windows (desktopCapturer getSources types:['window'], thumbnails off, fetchWindowIcons false). */
  listWindows(): Promise<ScreenshotWindowInfo[]>;
  /** All displays in screen.getAllDisplays() order, sizes in PIXELS (size * scaleFactor). */
  listDisplays(): Array<{ id: number; width: number; height: number; scaleFactor: number }>;
  /** Capture one display (source display_id matches) at full pixel size; returns PNG bytes. */
  captureScreen(input: { displayId?: number }): Promise<Buffer>;
  /** Capture one window source by its desktopCapturer source id at full size; returns PNG bytes. */
  captureWindow(input: { sourceId: string }): Promise<Buffer>;
  /** Crop a PNG (screen-point rect scaled to pixels) — region mode. */
  cropPng(input: { png: Buffer; rect: { x: number; y: number; width: number; height: number } }): Promise<Buffer>;
};

/**
 * macOS permission diagnostic appended to capture failures. Screen captures
 * silently return blank/empty images when Screen Recording permission is
 * missing, so surface the OS-reported status to make the failure actionable.
 */
function darwinScreenAccessHint(): string {
  if (process.platform !== 'darwin') return '';
  let status = 'unknown';
  try {
    status = systemPreferences.getMediaAccessStatus('screen');
  } catch {
    // Older Electron without getMediaAccessStatus('screen') — keep the generic hint.
  }
  return ` macOS Screen Recording access status: ${status}. Grant it under System Settings > Privacy & Security > Screen Recording, then restart the app.`;
}

/**
 * Default ScreenshotHost backed by Electron's desktopCapturer. Constructing it
 * is side-effect free; electron APIs are only touched inside the methods, so
 * building the tools under plain node (tests) with an injected host is safe.
 */
export function createElectronScreenshotHost(): ScreenshotHost {
  return {
    platform: process.platform,

    async listWindows() {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      // desktopCapturer does not separate the owning app from the window title;
      // source.name is the window title, so app is left empty.
      return sources.map((source) => ({ id: source.id, app: '', title: source.name }));
    },

    listDisplays() {
      return screen.getAllDisplays().map((display) => ({
        id: display.id,
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
        scaleFactor: display.scaleFactor,
      }));
    },

    async captureScreen({ displayId }) {
      const target = displayId != null
        ? screen.getAllDisplays().find((display) => display.id === displayId)
        : screen.getPrimaryDisplay();
      if (!target) {
        throw new Error(`No display with id ${displayId}.`);
      }
      const width = Math.round(target.size.width * target.scaleFactor);
      const height = Math.round(target.size.height * target.scaleFactor);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      });
      const source = sources.find((candidate) => candidate.display_id === String(target.id));
      const png = source && !source.thumbnail.isEmpty() ? source.thumbnail.toPNG() : null;
      if (!png || png.length === 0) {
        throw new Error(
          `Screen capture returned no image for display ${target.id}.${darwinScreenAccessHint()}`,
        );
      }
      return png;
    },

    async captureWindow({ sourceId }) {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 4096, height: 4096 },
        fetchWindowIcons: false,
      });
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (!source) {
        throw new Error(
          `Window source "${sourceId}" not found — it may have closed. Call action="list_windows" again for fresh ids.${darwinScreenAccessHint()}`,
        );
      }
      const png = source.thumbnail.toPNG();
      if (png.length === 0) {
        throw new Error(`Window capture returned an empty image for "${sourceId}".${darwinScreenAccessHint()}`);
      }
      return png;
    },

    async cropPng({ png, rect }) {
      const image = nativeImage.createFromBuffer(png);
      if (image.isEmpty()) {
        throw new Error('Could not decode the captured PNG for cropping.');
      }
      return image.crop({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }).toPNG();
    },
  };
}

/** Format the window list as a readable sheet. Exposed for tests. */
export function formatWindowList(windows: ScreenshotWindowInfo[]): string {
  if (!windows.length) return 'No capturable windows found.';
  const lines = windows.map((w) => {
    const title = w.title || '(untitled)';
    return `- [${w.id}] ${w.app ? `${w.app} — ` : ''}${title}`;
  });
  return [
    `Capturable windows (${windows.length}):`,
    ...lines,
    'Pass one of the [bracketed] ids as window_id with mode="window".',
  ].join('\n');
}

/**
 * Inline MCP tool that captures the host screen via Electron's in-process
 * desktopCapturer (the OS screen-capture API). Cross-platform; on macOS it
 * needs Screen Recording permission and reports the OS status on failure.
 * The in-app Bot Browser has its own capture tool (bot_browser_screenshot).
 */
export function buildScreenshotAgentTools(deps: {
  tool: SdkToolFactory;
  host?: ScreenshotHost;
}): unknown[] {
  const { tool, host = createElectronScreenshotHost() } = deps;

  const screenshot = tool(
    'screenshot',
    [
      'Capture the host machine\'s screen in-process via the OS screen-capture API (Electron desktopCapturer) and return it as an inline PNG image; the file is also written to disk.',
      'Modes: "fullscreen" (default; optional 1-based display index for multi-monitor), "window" (needs window_id — a desktopCapturer source id like "window:123:0" from action="list_windows"), "region" (needs region {x,y,width,height} in screen points; the tool scales by the display scaleFactor and crops).',
      'Use action="list_windows" first to enumerate capturable windows and their ids. Use when the user asks to see the screen, a window, or a screen region.',
      'save_path must be an absolute path; omit it to write into a temp file (path is reported either way).',
      'Cross-platform, but on macOS it requires Screen Recording permission (System Settings > Privacy & Security) — failures report the OS access status.',
      'When NOT to use: to capture the in-app Bot Browser tab use bot_browser_screenshot (renders the page directly, no OS permission needed); do not use this to read page text.',
    ].join(' '),
    {
      action: z
        .enum(['capture', 'list_windows'])
        .optional()
        .describe('Defaults to "capture"; use "list_windows" to enumerate capturable windows and their source ids.'),
      mode: z
        .enum(['fullscreen', 'window', 'region'])
        .optional()
        .describe('Capture mode; defaults to "fullscreen".'),
      window_id: z
        .string()
        .optional()
        .describe('desktopCapturer source id from action=list_windows (e.g. "window:123:0"); required for mode=window'),
      region: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        })
        .optional()
        .describe('Screen rect in points; required for mode=region. Scaled to pixels by the display scaleFactor.'),
      display: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-based display index (into the listDisplays order) for mode=fullscreen/region on multi-monitor setups.'),
      save_path: z
        .string()
        .optional()
        .describe('Absolute output path; defaults to a temp file'),
    },
    async (args: {
      action?: 'capture' | 'list_windows';
      mode?: 'fullscreen' | 'window' | 'region';
      window_id?: string;
      region?: { x: number; y: number; width: number; height: number };
      display?: number;
      save_path?: string;
    }) => {
      const action = args.action ?? 'capture';

      try {
        if (action === 'list_windows') {
          const windows = await host.listWindows();
          return textResult(formatWindowList(windows));
        }

        // action === 'capture'
        const mode = args.mode ?? 'fullscreen';

        // Validate the output path up front so we never capture just to reject it.
        const savePath = typeof args.save_path === 'string' ? args.save_path.trim() : '';
        const outputPath = savePath || path.join(os.tmpdir(), `idbots-screenshot-${Date.now()}.png`);
        if (savePath && !path.isAbsolute(savePath)) {
          return textResult(`screenshot save_path must be an absolute path, got: ${savePath}`, true);
        }

        let png: Buffer;
        if (mode === 'window') {
          const sourceId = typeof args.window_id === 'string' ? args.window_id.trim() : '';
          if (!sourceId) {
            return textResult('screenshot mode="window" requires window_id. Call with action="list_windows" first to get a source id.', true);
          }
          png = await host.captureWindow({ sourceId });
        } else {
          // fullscreen and region both start from a full-display capture.
          // Validate the region up front so a missing one never triggers a
          // wasted capture.
          if (mode === 'region' && !args.region) {
            return textResult('screenshot mode="region" requires region {x,y,width,height} in screen points.', true);
          }
          const displays = host.listDisplays();
          let displayId: number | undefined;
          let scaleFactor = 1;
          if (typeof args.display === 'number') {
            const target = displays[args.display - 1];
            if (!target) {
              return textResult(
                `screenshot: display ${args.display} is out of range — this host has ${displays.length} display(s) (1-based index).`,
                true,
              );
            }
            displayId = target.id;
            scaleFactor = target.scaleFactor;
          } else {
            scaleFactor = displays[0]?.scaleFactor ?? 1;
          }
          const full = await host.captureScreen({ displayId });
          if (mode === 'region') {
            // Validated above; non-null asserted by the early return.
            const region = args.region!;
            png = await host.cropPng({
              png: full,
              rect: {
                x: region.x * scaleFactor,
                y: region.y * scaleFactor,
                width: region.width * scaleFactor,
                height: region.height * scaleFactor,
              },
            });
          } else {
            png = full;
          }
        }

        try {
          await fs.promises.writeFile(outputPath, png);
        } catch (error) {
          return textResult(
            `Captured the screenshot but failed to save to ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }

        if (png.length > MAX_INLINE_IMAGE_BYTES) {
          return textResult(
            `Screenshot saved to ${outputPath} (${png.length} bytes). It is larger than 8 MiB, so the image is not inlined — read the file from disk if you need to inspect it.`,
          );
        }

        return {
          content: [
            { type: 'text' as const, text: `Screenshot saved to ${outputPath} (${png.length} bytes)` },
            { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
          ],
        };
      } catch (error) {
        return textResult(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [screenshot];
}
