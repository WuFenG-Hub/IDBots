import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const appPath = new URL('../src/renderer/App.tsx', import.meta.url);
const switchPath = new URL('../src/renderer/features/botBrowser/BotBrowserModeSwitch.tsx', import.meta.url);
const shellPath = new URL('../src/renderer/features/botBrowser/useBotBrowserShell.ts', import.meta.url);

function readSource(url) {
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

const appSource = readSource(appPath);
const switchSource = readSource(switchPath);
const shellSource = readSource(shellPath);

test('App imports and renders BotBrowserModeSwitch and BotBrowserSurface', () => {
  assert.ok(existsSync(switchPath), 'BotBrowserModeSwitch.tsx should exist');
  assert.ok(existsSync(shellPath), 'useBotBrowserShell.ts should exist');
  assert.match(appSource, /import BotBrowserModeSwitch from '\.\/features\/botBrowser\/BotBrowserModeSwitch';/);
  assert.match(appSource, /import \{ BotBrowserSurface \} from '\.\/features\/botBrowser\/BotBrowserSurface';/);
  assert.match(appSource, /<BotBrowserModeSwitch/);
  assert.match(appSource, /<BotBrowserSurface/);
});

test('App gates Home and Browser surfaces with botBrowserShell.surfaceMode', () => {
  assert.match(appSource, /const botBrowserShell = useBotBrowserShell\(/);
  assert.match(appSource, /botBrowserShell\.surfaceMode === 'home'/);
  assert.match(appSource, /botBrowserShell\.hasMountedBrowser \?/);
  assert.match(appSource, /visible=\{botBrowserShell\.surfaceMode === 'browser'\}/);
});

test('shell hook includes no-bot guard toast and persistent browser mount state', () => {
  assert.match(shellSource, /window\.electron\.metabot\.list\(\)/);
  assert.match(shellSource, /No local Bot\. Please create a Bot first\./);
  assert.match(shellSource, /const \[hasMountedBrowser, setHasMountedBrowser\] = useState\(false\);/);
});

test('switch strip exposes Bot Home and Bot Browser labels', () => {
  assert.match(switchSource, />\s*Bot Home\s*</);
  assert.match(switchSource, />\s*Bot Browser\s*</);
});
