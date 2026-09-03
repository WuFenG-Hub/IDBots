import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const appPath = new URL('../src/renderer/App.tsx', import.meta.url);
const sidebarPath = new URL('../src/renderer/components/Sidebar.tsx', import.meta.url);
const switchPath = new URL('../src/renderer/features/botBrowser/BotBrowserModeSwitch.tsx', import.meta.url);
const surfacePath = new URL('../src/renderer/features/botBrowser/BotBrowserSurface.tsx', import.meta.url);
const bridgePath = new URL('../src/renderer/features/botBrowser/browserIframeBridge.ts', import.meta.url);
const shellPath = new URL('../src/renderer/features/botBrowser/useBotBrowserShell.ts', import.meta.url);

function readSource(url) {
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

const appSource = readSource(appPath);
const sidebarSource = readSource(sidebarPath);
const switchSource = readSource(switchPath);
const surfaceSource = readSource(surfacePath);
const bridgeSource = readSource(bridgePath);
const shellSource = readSource(shellPath);

test('Sidebar owns the mode switch while App keeps the Browser surface', () => {
  assert.ok(existsSync(switchPath), 'BotBrowserModeSwitch.tsx should exist');
  assert.ok(existsSync(shellPath), 'useBotBrowserShell.ts should exist');
  assert.match(sidebarSource, /import BotBrowserModeSwitch from '\.\.\/features\/botBrowser\/BotBrowserModeSwitch';/);
  assert.match(appSource, /import \{ BotBrowserSurface \} from '\.\/features\/botBrowser\/BotBrowserSurface';/);
  assert.match(sidebarSource, /<BotBrowserModeSwitch/);
  assert.doesNotMatch(appSource, /<BotBrowserModeSwitch/);
  assert.match(appSource, /<BotBrowserSurface/);
});

test('App gates Home and Browser surfaces with botBrowserShell.surfaceMode', () => {
  assert.match(appSource, /const botBrowserShell = useBotBrowserShell\(/);
  assert.match(appSource, /botBrowserShell\.surfaceMode === 'home'/);
  assert.match(appSource, /botBrowserShell\.hasMountedBrowser \?/);
  assert.match(appSource, /visible=\{botBrowserShell\.surfaceMode === 'browser'\}/);
});

test('shell defaults to Bot Home with a mounted Browser while retaining guarded deep links', () => {
  assert.match(shellSource, /window\.electron\.metabot\.list\(\)/);
  assert.match(shellSource, /if \(!result\?\.success\) \{/);
  assert.match(shellSource, /showToast\(messageFromError\(result\?\.error, 'Failed to load local Bots\.'\)\);/);
  assert.match(shellSource, /if \(!Array\.isArray\(result\.list\) \|\| result\.list\.length === 0\) \{/);
  assert.match(shellSource, /showToast\('No local Bot\. Please create a Bot first\.'\);/);
  assert.match(shellSource, /catch \(error\) \{/);
  assert.match(shellSource, /showToast\(messageFromError\(error, 'Failed to load local Bots\.'\)\);/);
  assert.match(shellSource, /const \[surfaceMode, setSurfaceMode\] = useState<BotBrowserSurfaceMode>\('home'\);/);
  assert.match(shellSource, /const \[hasMountedBrowser, setHasMountedBrowser\] = useState\(true\);/);
});

test('Browser sidebar exposes a working New Tab bridge to the welcome page', () => {
  assert.match(sidebarSource, />New Tab<\/span>/);
  assert.match(shellSource, /controlTabs\(\{ action: 'open-tab' \}\)/);
  assert.match(surfaceSource, /type: 'tab-command'/);
  assert.match(bridgeSource, /if \(data\.type === 'tab-command'\)/);
  assert.match(bridgeSource, /globalThis\.AgentBrowserTabs\.openTab/);
});

test('App forwards host tab commands through the renderer and iframe response bridge', () => {
  assert.match(appSource, /window\.electron\.botBrowser\.onTabCommand/);
  assert.match(appSource, /botBrowserShell\.controlTabs\(command\)/);
  assert.match(appSource, /window\.electron\.botBrowser\.respondToTabCommand/);
  assert.match(surfaceSource, /type: 'tab-command-response'/);
  assert.match(bridgeSource, /globalThis\.AgentBrowserTabs\.getActiveTab\(\)/);
  assert.match(bridgeSource, /globalThis\.AgentBrowserTabs\.getTabs\(\)/);
});

test('App routes Browser conversation opens through the Cowork adapter', () => {
  assert.match(appSource, /openBotBrowserConversationInCowork/);
  assert.match(appSource, /handleBrowserOpenConversation = useCallback\(async \(request/);
  assert.match(appSource, /switchToHome:\s*botBrowserShell\.switchToHome/);
  assert.match(appSource, /showCowork:\s*handleShowCowork/);
  assert.doesNotMatch(appSource, /Conversation opening is not wired yet/);
});

test('App listens for host bot-browser open requests and forwards them to the shell', () => {
  assert.match(shellSource, /const openUri = useCallback\(async \(input: BotBrowserOpenUriInput\)/);
  assert.match(shellSource, /openUriWhenBrowserReady\(\{ uri, actorId, newTab \}\)/);
  assert.match(appSource, /window\.electron\.botBrowser\.onOpenUri\(/);
  assert.match(appSource, /botBrowserShell\.openUri\(input\)/);
});

test('user-initiated URI opens land in a new browser tab, not over the active one', () => {
  // Every in-renderer dispatcher on the DOM channel is a user click
  // (MarkdownContent links, group-task deliverables, cowork panel), so App
  // defaults the channel to newTab and only an explicit false navigates in place.
  assert.match(appSource, /botBrowserShell\.openUri\(\{ uri: uri\.trim\(\), newTab: detail\?\.newTab !== false \}\)/);
  // Shell-level UI gestures (avatar bot pages, MetaApp launches) opt in too,
  // while the host IPC path (agent tools / RPC) forwards the input untouched.
  assert.match(shellSource, /openUriWhenBrowserReady\(\{ uri, actorId, newTab: true \}\)/);
  assert.match(shellSource, /openUriWhenBrowserReady\(\{ uri, newTab: true \}\)/);
  assert.doesNotMatch(shellSource, /openUriWhenBrowserReady\(\{ uri \}\)/);
  assert.match(shellSource, /const newTab = input\?\.newTab === true;/);
});

test('sidebar switch puts Bot Browser before Bot Home', () => {
  assert.match(switchSource, />\s*Bot Browser\s*</);
  assert.match(switchSource, />\s*Bot Home\s*</);
  assert.ok(switchSource.indexOf('Bot Browser') < switchSource.indexOf('Bot Home'));
});
