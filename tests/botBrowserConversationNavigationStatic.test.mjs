import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertBefore(source, earlier, later) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert.notEqual(earlierIndex, -1, `${earlier} should exist`);
  assert.notEqual(laterIndex, -1, `${later} should exist`);
  assert.ok(earlierIndex < laterIndex, `${earlier} should appear before ${later}`);
}

test('Bot Browser conversation adapter ensures A2A session and opens Cowork without sending messages', () => {
  const adapterPath = path.join(repoRoot, 'src/renderer/features/botBrowser/conversationNavigationAdapter.ts');
  assert.ok(fs.existsSync(adapterPath), 'conversationNavigationAdapter.ts should exist');
  const source = fs.readFileSync(adapterPath, 'utf8');

  assert.match(source, /parseLocalMetabotActorId/);
  assert.match(source, /normalizeBrowserGlobalMetaId/);
  assert.match(source, /window\.electron\?\.cowork\?\.ensureA2ASession/);
  assert.match(source, /actorId:\s*request\.actorId/);
  assert.match(source, /localMetabotId/);
  assert.match(source, /peerGlobalMetaId/);
  assert.match(source, /switchToHome\(\)/);
  assert.match(source, /showCowork\(\)/);
  assert.match(source, /coworkService\.loadSessions\(\)/);
  assert.match(source, /coworkService\.loadSession\(sessionId\)/);
  assertBefore(source, 'coworkService.loadSession(sessionId)', 'deps.switchToHome()');
  assertBefore(source, 'deps.switchToHome()', 'deps.showCowork()');
  assert.match(source, /if \(error instanceof Error\) \{\s*throw error;\s*\}/);
  assert.doesNotMatch(source, /queueA2AGuidance|continueSession|startSession/);
});

test('App routes Browser conversation requests through the adapter', () => {
  const source = read('src/renderer/App.tsx');

  assert.match(source, /import \{ openBotBrowserConversationInCowork \} from '\.\/features\/botBrowser\/conversationNavigationAdapter';/);
  assert.match(source, /import type \{ BotBrowserConversationRequest \} from '\.\/features\/botBrowser\/types';/);
  assert.match(source, /const handleBrowserOpenConversation = useCallback\(async \(request: BotBrowserConversationRequest\) => \{/);
  assert.match(source, /await openBotBrowserConversationInCowork\(request,\s*\{[\s\S]*switchToHome:\s*botBrowserShell\.switchToHome,[\s\S]*showCowork:\s*handleShowCowork,[\s\S]*showToast,[\s\S]*\}\);/);
  assert.doesNotMatch(source, /Conversation opening is not wired yet/);
});
