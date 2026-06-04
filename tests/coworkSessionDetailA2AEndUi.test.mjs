import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'cowork',
  'CoworkSessionDetail.tsx'
);

test('CoworkSessionDetail renders an end-conversation button for private A2A sessions', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /a2aSessionEndConversation/);
  assert.match(source, /handleEndA2APrivateChat/);
  assert.match(source, /coworkService\.endA2APrivateChat\(currentSession\.id\)/);
});

test('manual A2A private-chat bye stores the simplemsg txid on the local bubble', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(source, /const byePin = await createPin/);
  assert.match(source, /attachSimplemsgMetadataToCoworkMessage\(/);
  assert.match(source, /result\.endMessage/);
  assert.match(source, /pinId: byePin\.pinId/);
});

test('CoworkSessionDetail renders ordinary private A2A sessionid with copy action', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /buildPrivateA2ASessionDisplayId/);
  assert.match(source, /showPrivateA2ASessionId/);
  assert.match(source, /sessionMetabot\?\.globalmetaid/);
  assert.match(source, /currentSession\.peerGlobalMetaId/);
  assert.match(source, /handleCopyHeaderValue\(privateA2ASessionDisplayId\)/);
  assert.match(source, /sessionid:/);
});

test('CoworkSessionDetail hides A2A transport handshake bubbles', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /isA2ATransportHandshakeMessage/);
  assert.match(source, /sourceChannel === 'metaweb_private'/);
  assert.match(source, /normalizedContent === 'ping'/);
  assert.match(source, /normalizedContent === 'pong'/);
  assert.match(source, /shouldHideControlMessage\(message\)/);
  assert.match(source, /isA2ATransportHandshakeMessage\(message\)/);
});

test('CoworkSessionDetail wires resend digital delivery to order-scoped A2A messages', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /a2aResendDigitalDelivery/);
  assert.match(source, /handleResendDigitalDelivery/);
  assert.match(source, /onResendDigitalDelivery=\{handleResendDigitalDelivery\}/);
  assert.match(source, /canResendDigitalDelivery=\{canResendDigitalDelivery\}/);
  assert.match(source, /coworkService\.resendA2ADeliveryArtifact\(\{\s*sessionId: currentSession\.id,\s*orderTxid,/s);
  assert.match(source, /serviceOrderSummary\?\.role === 'seller'/);
  assert.match(source, /NON_TEXT_SERVICE_OUTPUT_TYPES\.includes/);
  assert.doesNotMatch(source, /onClick=\{handleResendDigitalDelivery\}/);
  assert.doesNotMatch(source, /outputType !== 'text'/);
});

test('manual A2A delivery resend IPC accepts an order-scoped request', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(source, /normalizeA2ADeliveryArtifactResendInput/);
  assert.match(source, /resolveServiceOrderForSessionAndOrderTxid/);
  assert.match(source, /findOrderByOrderMessageTxid\(\s*'seller'/s);
  assert.match(source, /orderTxid/);
  assert.doesNotMatch(source, /ipcMain\.handle\('cowork:session:resendA2ADeliveryArtifact', async \(_event, sessionId: string\)/);
});

test('manual A2A delivery resend failure sends a refund-flow notice to the buyer', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(source, /manualResendFailureReply/);
  assert.match(source, /上传链上交付失败/);
  assert.match(source, /系统将自动转入退款流程/);
  assert.match(source, /orderDeliveryFailed/);
});

test('manual A2A delivery resend preserves service order pin identity for free orders', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(
    source,
    /const deliveryText = buildDeliveryMessage\(\{\s*paymentTxid: order\.paymentTxid,\s*\.\.\.\(order\.orderPinId\s*\?\s*\{\s*serviceOrderPinId: order\.orderPinId,\s*orderPinId: order\.orderPinId,\s*\}\s*:\s*\{\}\),/s
  );
  assert.match(
    source,
    /markSellerOrderDelivered\(\{\s*localMetabotId: metabotId,\s*counterpartyGlobalMetaId: peerGlobalMetaId,\s*orderPinId: order\.orderPinId,\s*paymentTxid: order\.paymentTxid,/s
  );
});

test('A2A guidance IPC queues active sessions and restarts ended private chats', () => {
  const mainSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );
  const preloadSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'preload.ts'),
    'utf8'
  );
  const electronTypes = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'types', 'electron.d.ts'),
    'utf8'
  );
  const coworkTypes = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'types', 'cowork.ts'),
    'utf8'
  );

  assert.match(mainSource, /ipcMain\.handle\('cowork:session:queueA2AGuidance'/);
  assert.match(mainSource, /a2aGuidanceQueue\.queue/);
  assert.match(mainSource, /a2aGuidanceQueue\.clear/);
  assert.match(mainSource, /startPrivateChatDaemon\([\s\S]*a2aGuidanceQueue\.consume/);
  assert.match(mainSource, /performChatCompletionForOrchestrator/);
  assert.match(mainSource, /sendEncryptedSimplemsg/);
  assert.match(mainSource, /a2aConversationRestarted/);
  assert.match(mainSource, /byeSent:\s*false/);

  assert.match(preloadSource, /queueA2AGuidance/);
  assert.match(preloadSource, /cowork:session:queueA2AGuidance/);
  assert.match(preloadSource, /CoworkA2AGuidanceRequest/);
  assert.match(electronTypes, /queueA2AGuidance/);
  assert.match(electronTypes, /CoworkA2AGuidanceRequest/);
  assert.match(electronTypes, /CoworkA2AGuidanceResult/);
  assert.match(coworkTypes, /interface CoworkA2AGuidanceRequest/);
  assert.match(coworkTypes, /interface CoworkA2AGuidanceResult/);
  assert.match(coworkTypes, /restart_started/);
});
