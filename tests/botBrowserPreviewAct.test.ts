import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildPreviewActScript,
  collectMatchingFrames,
  executeBotBrowserPreviewAct,
  frameMatchesRendererUrl,
  isActableRenderUrl,
  type ActFrameShape,
} from '../src/main/services/botBrowserPreviewAct';

const PREVIEW_URL = 'http://127.0.0.1:56133/browser-cache/metaapp-preview/metaapp-preview-abc/index.html?view=play&pin=NQwXON0';

test('preview act scripts are syntactically valid and JSON-inject the selector', () => {
  const tricky = `"#btn-main"); process.exit(1); ("`;
  for (const action of ['click', 'read'] as const) {
    const script = buildPreviewActScript(action, tricky);
    // Compiling (not running) validates the snippet parses as an expression.
    assert.doesNotThrow(() => new Function(`return ${script};`), `${action} script must parse`);
    // The selector only ever appears as a JSON literal, so quotes cannot break out.
    assert.ok(script.includes(JSON.stringify(tricky)), `${action} script must embed the selector as JSON`);
  }
  const state = buildPreviewActScript('state');
  assert.doesNotThrow(() => new Function(`return ${state};`), 'state script must parse');
  assert.ok(!state.includes('selector'), 'state ignores the selector by design');
});

test('frameMatchesRendererUrl accepts exact and prefix matches only', () => {
  assert.equal(frameMatchesRendererUrl(PREVIEW_URL, PREVIEW_URL), true);
  assert.equal(frameMatchesRendererUrl(PREVIEW_URL + '#frag', PREVIEW_URL), true);
  assert.equal(frameMatchesRendererUrl('http://127.0.0.1:1/other', PREVIEW_URL), false);
  assert.equal(frameMatchesRendererUrl(PREVIEW_URL, ''), false);
});

test('isActableRenderUrl limits the act surface to localhost previews', () => {
  assert.equal(isActableRenderUrl('http://127.0.0.1:56133/x/index.html'), true);
  assert.equal(isActableRenderUrl('http://localhost:8080/app/index.html'), true);
  assert.equal(isActableRenderUrl('https://example.com/player'), false);
  assert.equal(isActableRenderUrl('file:///tmp/app/index.html'), false);
  assert.equal(isActableRenderUrl('not a url'), false);
});

const makeFrame = (url: string, frames: ActFrameShape[] = []): ActFrameShape => ({
  url,
  frames,
  executeJavaScript: async () => ({}),
});

test('collectMatchingFrames walks the nested frame tree depth-first', () => {
  const preview = makeFrame(PREVIEW_URL);
  const tree = makeFrame('http://127.0.0.1:5185/', [
    makeFrame('about:srcdoc', [
      makeFrame('http://127.0.0.1:9999/unrelated'),
      preview,
    ]),
    makeFrame('http://127.0.0.1:56133/browser-cache/metaapp-preview/other-session/index.html'),
  ]);
  const found = collectMatchingFrames(tree, PREVIEW_URL);
  assert.equal(found.length, 1);
  assert.equal(found[0], preview);
});

type FakeBridgeCall = { action: string; tabId?: number };

function makeDeps(options: {
  rendererType?: string;
  rendererUrl?: string;
  previewFrameUrl?: string | null;
  payload?: Record<string, unknown>;
}) {
  const calls: FakeBridgeCall[] = [];
  const executed: Array<{ code: string; userGesture: boolean }> = [];
  const previewFrameUrl = options.previewFrameUrl === null ? null : (options.previewFrameUrl ?? PREVIEW_URL);
  const previewFrame: ActFrameShape = {
    url: previewFrameUrl ?? '',
    frames: [],
    executeJavaScript: async (code: string, userGesture?: boolean) => {
      executed.push({ code, userGesture: userGesture === true });
      return options.payload ?? { ok: true };
    },
  };
  const deps = {
    getWindows: () => [{
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        mainFrame: makeFrame('http://127.0.0.1:5185/', [
          makeFrame('about:srcdoc', previewFrameUrl ? [previewFrame] : []),
        ]),
      },
    }],
    executeTabCommand: async (command: FakeBridgeCall) => {
      calls.push(command);
      if (command.action === 'get-active-tab') {
        return {
          action: 'get-active-tab',
          tabs: [{ id: 7, uri: 'metaapp://abc', title: '音乐舞台播放器', isActive: true }],
          activeTab: { id: 7, uri: 'metaapp://abc', title: '音乐舞台播放器', isActive: true },
        };
      }
      return {
        action: 'get-tab-info',
        tabs: [],
        activeTab: null,
        info: {
          current: {
            renderer: {
              type: options.rendererType ?? 'html-iframe',
              url: options.rendererUrl ?? PREVIEW_URL,
            },
          },
        },
      };
    },
  };
  return { deps, calls, executed };
}

test('executor resolves the active tab, targets its preview frame with a user gesture, and returns the outcome', async () => {
  const { deps, calls, executed } = makeDeps({
    payload: { ok: true, pageTitle: '音乐舞台播放器', media: [{ tag: 'audio', paused: false, muted: false, currentTime: 1.5, readyState: 4, src: PREVIEW_URL }] },
  });
  const outcome = await executeBotBrowserPreviewAct(deps, { action: 'state' });
  assert.deepEqual(calls.map((c) => c.action), ['get-active-tab', 'get-tab-info']);
  assert.equal(outcome.tabId, 7);
  assert.equal(outcome.frameUrl, PREVIEW_URL);
  assert.equal(outcome.media?.[0]?.paused, false);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].userGesture, true, 'click/state must run with a user gesture allowance');
});

test('executor passes the click through and reports what was clicked', async () => {
  const { deps, executed } = makeDeps({
    payload: { ok: true, tag: 'button', id: 'btn-main', text: '播放' },
  });
  const outcome = await executeBotBrowserPreviewAct(deps, { action: 'click', selector: '#btn-main' });
  assert.deepEqual(outcome.clicked, { tag: 'button', id: 'btn-main', text: '播放' });
  assert.ok(executed[0].code.includes('"#btn-main"'), 'selector must be embedded as a JSON literal');
});

test('executor rejects non-MetaApp renderers, non-local renderers, and missing frames honestly', async () => {
  const botPage = makeDeps({ rendererType: 'bot-page' });
  await assert.rejects(
    executeBotBrowserPreviewAct(botPage.deps, { action: 'state' }),
    /not a MetaApp preview/,
  );

  const web = makeDeps({ rendererUrl: 'https://example.com/player' });
  await assert.rejects(
    executeBotBrowserPreviewAct(web.deps, { action: 'state' }),
    /not a locally served preview/,
  );

  const noFrame = makeDeps({ previewFrameUrl: null });
  await assert.rejects(
    executeBotBrowserPreviewAct(noFrame.deps, { action: 'state' }),
    /No live MetaApp preview frame/,
  );

  const notFound = makeDeps({ payload: { ok: false, reason: 'selector-not-found' } });
  await assert.rejects(
    executeBotBrowserPreviewAct(notFound.deps, { action: 'click', selector: '#nope' }),
    /selector-not-found/,
  );
});

// ---- static wiring guards: the tool must exist and be registered everywhere ----

const readRepo = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('bot_browser_act is registered as an always-on tool with structured actions', () => {
  const tools = readRepo('../src/main/libs/botBrowserAgentTools.ts');
  assert.match(tools, /export function buildBotBrowserActTool/);
  assert.match(tools, /'bot_browser_act'/);
  assert.match(tools, /action: z\.enum\(\['click', 'read', 'state'\]\)/);
  assert.match(tools, /action "click" requires a CSS selector/);
  assert.match(tools, /act\?\(input: BotBrowserPreviewActRequest\)/);
});

test('coworkRunner registers the act tool for every surface next to screenshot', () => {
  const runner = readRepo('../src/main/libs/coworkRunner.ts');
  assert.match(runner, /buildBotBrowserActTool/);
  assert.match(
    runner,
    /buildBotBrowserScreenshotTool\(\{ tool, controlBotBrowser: this\.controlBotBrowser, sessionId \}\)[\s\S]*?if \(this\.controlBotBrowser\.act\) \{[\s\S]*?buildBotBrowserActTool/,
    'act must be registered right after the screenshot block, gated on controlBotBrowser.act',
  );
});

test('the RPC gateway exposes POST /api/idbots/bot-browser/act', () => {
  const rpc = readRepo('../src/main/services/metaidRpcServer.ts');
  assert.match(rpc, /BOT_BROWSER_ACT_PATH = '\/api\/idbots\/bot-browser\/act'/);
  assert.match(rpc, /normalizeBotBrowserActRequest/);
  assert.match(rpc, /controlBotBrowserAct\?: \(input: BotBrowserPreviewActRequest\)/);
});

test('main.ts wires the act executor into controlBotBrowser and the RPC server', () => {
  const main = readRepo('../src/main/main.ts');
  assert.match(main, /act: \(input\) => executeBotBrowserAct\(input\)/);
  assert.match(main, /controlBotBrowserAct: \(input\) => executeBotBrowserAct\(input\)/);
  assert.match(main, /import \{\s*executeBotBrowserPreviewAct,/);
});
