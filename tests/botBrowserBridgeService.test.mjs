import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBotBrowserBridgeService,
  sanitizeMetaAppBridgeActor,
} from '../src/main/services/botBrowserBridgeService.ts';

function createMetabot(overrides = {}) {
  return {
    id: 7,
    wallet_id: 3,
    mvc_address: 'mvc-address',
    btc_address: 'btc-address',
    doge_address: 'doge-address',
    public_key: 'public-key',
    chat_public_key: 'chat-public-key',
    chat_public_key_pin_id: null,
    name: ' Alpha Bot ',
    avatar: 'https://cdn.example/avatar.png',
    enabled: true,
    metaid: 'metaid-local',
    globalmetaid: ' IDQ1ABC ',
    metabot_info_pinid: null,
    metabot_type: 'twin',
    created_by: 'owner',
    role: 'assistant',
    soul: 'soul',
    goal: null,
    bio: null,
    background: null,
    boss_id: null,
    boss_global_metaid: null,
    llm_id: null,
    tools: [],
    skills: [],
    allow_chat_skills: [],
    homepage: null,
    created_at: 1,
    updated_at: 2,
    wallet: {
      mnemonic: 'never leak me',
    },
    localPath: '/Users/tusm/private/avatar.png',
    capabilities: ['wallet'],
    ...overrides,
  };
}

function createStore(metabot = createMetabot()) {
  return {
    getMetabotById(id) {
      return id === metabot.id ? metabot : null;
    },
    getMetabotWalletByMetabotId(id) {
      return id === metabot.id ? { mnemonic: 'seed words', path: "m/44'/10001'/0'/0/0" } : null;
    },
  };
}

const MODIFY_TARGET_PIN_ID = `${'a'.repeat(64)}i0`;
const REVOKE_TARGET_PIN_ID = `${'b'.repeat(64)}i0`;

function createPinWritePayload(overrides = {}) {
  return {
    operation: 'create',
    path: '/protocols/simplebuzz',
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: { encoding: 'utf8', value: '{"ok":true}' },
    display: { title: 'Demo title', summary: 'Demo summary' },
    ...overrides,
  };
}

test('sanitizeMetaAppBridgeActor exposes only MetaID actor display fields', () => {
  const actor = sanitizeMetaAppBridgeActor(createMetabot({
    avatar: 'metafile://PIN123I0.png',
  }));

  assert.deepEqual(actor, {
    uri: 'metaid://idq1abc',
    globalMetaId: 'idq1abc',
    name: 'Alpha Bot',
    avatarPinId: 'pin123i0',
  });
  assert.equal('id' in actor, false);
  assert.equal('wallet' in actor, false);
  assert.equal('mvc_address' in actor, false);
  assert.equal('avatar' in actor, false);
  assert.equal('localPath' in actor, false);
  assert.equal('capabilities' in actor, false);
});

test('writeMetaIdPin validates payload before confirmation and signer execution', async () => {
  let confirmCalls = 0;
  let createPinCalls = 0;
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    confirmPinWrite: async () => {
      confirmCalls += 1;
      return true;
    },
    createPin: async () => {
      createPinCalls += 1;
      return { pinId: 'pin123i0', txids: ['tx123'], totalCost: 1 };
    },
  });

  const result = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    payload: {
      operation: 'create',
      path: '/protocols/simplebuzz',
      encryption: '0',
      version: '1.0',
      contentType: 'text/plain',
      payload: { encoding: 'utf8', value: '' },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_params');
  assert.equal(confirmCalls, 0);
  assert.equal(createPinCalls, 0);
});

test('writeMetaIdPin requires a current actor and handles user cancellation', async () => {
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    confirmPinWrite: async () => false,
    createPin: async () => {
      throw new Error('signer should not run');
    },
  });

  const missingActor = await service.writeMetaIdPin({
    payload: {
      operation: 'create',
      path: '/protocols/simplebuzz',
      encryption: '0',
      version: '1.0',
      contentType: 'text/plain',
      payload: { encoding: 'utf8', value: 'hello' },
    },
  });
  assert.equal(missingActor.ok, false);
  assert.equal(missingActor.code, 'actor_required');

  const cancelled = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    payload: {
      operation: 'create',
      path: '/protocols/simplebuzz',
      encryption: '0',
      version: '1.0',
      contentType: 'text/plain',
      payload: { encoding: 'utf8', value: 'hello' },
      display: { title: 'Publish demo', summary: 'Writes one PIN.' },
    },
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'user_cancelled');
});

test('writeMetaIdPin confirms and writes create, modify, and revoke with operation-specific path semantics', async () => {
  const confirmations = [];
  const writes = [];
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    confirmPinWrite: async (details) => {
      confirmations.push(details);
      return true;
    },
    createPin: async (_store, metabotId, metaidPayload, options) => {
      writes.push({ metabotId, metaidPayload, options });
      return { pinId: `${metaidPayload.operation}-pin`, txids: [`${metaidPayload.operation}-tx`], totalCost: 1 };
    },
  });

  const requests = [
    createPinWritePayload({
      operation: 'create',
      path: '/protocols/simplebuzz',
    }),
    createPinWritePayload({
      operation: 'modify',
      path: `@${MODIFY_TARGET_PIN_ID}`,
      originalId: MODIFY_TARGET_PIN_ID,
      appAction: 'update-profile',
    }),
    createPinWritePayload({
      operation: 'revoke',
      path: `@${REVOKE_TARGET_PIN_ID}`,
      payload: { encoding: 'utf8', value: '' },
      originalId: REVOKE_TARGET_PIN_ID,
      appAction: 'remove-profile',
    }),
  ];

  for (const request of requests) {
    const result = await service.writeMetaIdPin({
      actorId: 'idbots-metabot-7',
      network: 'mvc',
      payload: request,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, {
      pinId: `${request.operation}-pin`,
      txid: `${request.operation}-tx`,
      operation: request.operation,
      path: request.path,
      actor: {
        uri: 'metaid://idq1abc',
        globalMetaId: 'idq1abc',
        name: 'Alpha Bot',
      },
    });
  }

  assert.deepEqual(
    writes.map((entry) => ({
      metabotId: entry.metabotId,
      operation: entry.metaidPayload.operation,
      path: entry.metaidPayload.path,
      contentType: entry.metaidPayload.contentType,
      payload: entry.metaidPayload.payload,
      hasOriginalId: Object.prototype.hasOwnProperty.call(entry.metaidPayload, 'originalId'),
      hasAppAction: Object.prototype.hasOwnProperty.call(entry.metaidPayload, 'appAction'),
      network: entry.options.network,
    })),
    [
      {
        metabotId: 7,
        operation: 'create',
        path: '/protocols/simplebuzz',
        contentType: 'application/json',
        payload: '{"ok":true}',
        hasOriginalId: false,
        hasAppAction: false,
        network: 'mvc',
      },
      {
        metabotId: 7,
        operation: 'modify',
        path: `@${MODIFY_TARGET_PIN_ID}`,
        contentType: 'application/json',
        payload: '{"ok":true}',
        hasOriginalId: false,
        hasAppAction: false,
        network: 'mvc',
      },
      {
        metabotId: 7,
        operation: 'revoke',
        path: `@${REVOKE_TARGET_PIN_ID}`,
        contentType: 'application/json',
        payload: '',
        hasOriginalId: false,
        hasAppAction: false,
        network: 'mvc',
      },
    ],
  );
  assert.equal(confirmations.length, 3);
  assert.deepEqual(confirmations[0], {
    actor: {
      uri: 'metaid://idq1abc',
      globalMetaId: 'idq1abc',
      name: 'Alpha Bot',
    },
    operation: 'create',
    path: '/protocols/simplebuzz',
    contentType: 'application/json',
    payloadSize: 11,
    display: {
      title: 'Demo title',
      summary: 'Demo summary',
    },
  });
  assert.deepEqual(confirmations[1].bridgeMetadata, {
    originalId: MODIFY_TARGET_PIN_ID,
    appAction: 'update-profile',
  });
  assert.deepEqual(confirmations[2].bridgeMetadata, {
    originalId: REVOKE_TARGET_PIN_ID,
    appAction: 'remove-profile',
  });
  assert.equal(confirmations[2].payloadSize, 0);
});

test('writeMetaIdPin rejects modify and revoke slash paths before confirmation or signer execution', async () => {
  let confirmCalls = 0;
  let createPinCalls = 0;
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    confirmPinWrite: async () => {
      confirmCalls += 1;
      return true;
    },
    createPin: async () => {
      createPinCalls += 1;
      return { pinId: 'pin123i0', txids: ['tx123'], totalCost: 1 };
    },
  });

  for (const operation of ['modify', 'revoke']) {
    const result = await service.writeMetaIdPin({
      actorId: 'idbots-metabot-7',
      payload: createPinWritePayload({
        operation,
        path: '/protocols/simplebuzz',
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_params');
  }

  const malformedTarget = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    payload: createPinWritePayload({
      operation: 'modify',
      path: '@not-a-pin',
    }),
  });

  assert.equal(malformedTarget.ok, false);
  assert.equal(malformedTarget.code, 'invalid_params');
  assert.equal(confirmCalls, 0);
  assert.equal(createPinCalls, 0);
});

test('uploadMetaFile supports only host-picker and never returns local paths or preview URLs', async () => {
  const uploads = [];
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    pickFiles: async () => [
      { filePath: '/Users/tusm/private/report.pdf', name: 'report.pdf' },
    ],
    uploadMetaFile: async (_store, params) => {
      uploads.push(params);
      return {
        pinId: 'file123i0',
        metafileUri: 'metafile://file123i0.pdf',
        fileName: 'report.pdf',
        size: 1234,
        contentType: 'application/pdf',
        contentHash: 'sha256:abc',
        previewUrl: 'http://127.0.0.1/private-preview',
        fallbackUrl: 'file:///Users/tusm/private/report.pdf',
      };
    },
  });

  const invalid = await service.uploadMetaFile({
    actorId: 'idbots-metabot-7',
    payload: { source: { kind: 'iframe-file' } },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid_params');

  const result = await service.uploadMetaFile({
    actorId: 'idbots-metabot-7',
    payload: {
      source: {
        kind: 'host-picker',
        multiple: false,
        accept: ['application/pdf'],
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.files, [
    {
      pinId: 'file123i0',
      uri: 'metafile://file123i0.pdf',
      name: 'report.pdf',
      size: 1234,
      contentType: 'application/pdf',
      contentHash: 'sha256:abc',
      actor: {
        uri: 'metaid://idq1abc',
        globalMetaId: 'idq1abc',
        name: 'Alpha Bot',
      },
    },
  ]);
  assert.deepEqual(uploads, [
    {
      metabotId: 7,
      filePath: '/Users/tusm/private/report.pdf',
      contentType: undefined,
      network: undefined,
    },
  ]);
  assert.equal(JSON.stringify(result.data).includes('/Users/tusm/private'), false);
  assert.equal(JSON.stringify(result.data).includes('127.0.0.1'), false);
});

test('uploadMetaFile reports user cancellation and upload failures with stable bridge codes', async () => {
  const cancelledService = createBotBrowserBridgeService({
    metabotStore: createStore(),
    pickFiles: async () => [],
    uploadMetaFile: async () => {
      throw new Error('upload should not run');
    },
  });
  const cancelled = await cancelledService.uploadMetaFile({
    actorId: 'idbots-metabot-7',
    payload: { source: { kind: 'host-picker' } },
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'user_cancelled');

  const failedService = createBotBrowserBridgeService({
    metabotStore: createStore(),
    pickFiles: async () => [{ filePath: '/tmp/fail.png', name: 'fail.png' }],
    uploadMetaFile: async () => {
      throw new Error('stack /tmp/fail.png private');
    },
  });
  const failed = await failedService.uploadMetaFile({
    actorId: 'idbots-metabot-7',
    payload: { source: { kind: 'host-picker' } },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'upload_failed');
  assert.equal(failed.message.includes('/tmp/fail.png'), false);
  assert.equal(failed.message.includes('stack'), false);
});
