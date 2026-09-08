import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');

test('cowork session navigation leaves Bot Internet before loading the session', () => {
  const listenerStart = appSource.indexOf("window.addEventListener('cowork:viewSession'");
  assert.notEqual(listenerStart, -1, 'cowork:viewSession listener must exist');

  const effectStart = appSource.lastIndexOf('useEffect(() => {', listenerStart);
  const listenerEnd = appSource.indexOf("window.removeEventListener('cowork:viewSession'", listenerStart);
  const effectSource = appSource.slice(effectStart, listenerEnd);

  const switchIndex = effectSource.indexOf('botBrowserShell.switchToHome()');
  const loadIndex = effectSource.indexOf('coworkService.loadSession(sessionId)');
  assert.ok(switchIndex >= 0, 'navigation must switch to Bot Home');
  assert.ok(loadIndex > switchIndex, 'Bot Home must be selected before the session loads');
});
