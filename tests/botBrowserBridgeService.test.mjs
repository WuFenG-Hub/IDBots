import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('writeMetaIdPin validates payload before issuing authorization or executing the signer', async () => {
  let createPinCalls = 0;
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    createPin: async () => {
      createPinCalls += 1;
      return { pinId: 'pin123i0', txids: ['tx123'], totalCost: 1 };
    },
  });

  const result = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
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
  assert.equal(createPinCalls, 0);
});

test('phase 1 returns confirmation plus the exact host confirmRequest and Cancel performs no write', async () => {
  let createPinCalls = 0;
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    createPin: async () => {
      createPinCalls += 1;
      return { pinId: 'pin123i0', txids: ['tx123'], totalCost: 1 };
    },
    now: () => 1_700_000_000_000,
    confirmationTtlMs: 60_000,
    createConfirmationId: () => 'confirmation-1',
    createConfirmationToken: () => 'opaque-token-1',
  });

  const missingActor = await service.writeMetaIdPin({
    resourceUri: 'metaapp://app123i0',
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

  const phaseOne = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: createPinWritePayload({
      contentType: 'text/plain',
      payload: { encoding: 'utf8', value: 'hello' },
      display: { title: 'Publish demo', summary: 'Writes one PIN.' },
    }),
  });

  assert.equal(phaseOne.ok, false);
  assert.equal(phaseOne.state, 'manual_action_required');
  assert.equal(phaseOne.code, 'manual_action_required');
  assert.deepEqual(phaseOne.data.confirmation, {
    actor: {
      uri: 'metaid://idq1abc',
      globalMetaId: 'idq1abc',
      name: 'Alpha Bot',
    },
    operation: 'create',
    path: '/protocols/simplebuzz',
    contentType: 'text/plain',
    payloadSize: 5,
    confirmationId: 'confirmation-1',
    expiresAt: 1_700_000_060_000,
    display: { title: 'Publish demo', summary: 'Writes one PIN.' },
  });
  assert.deepEqual(phaseOne.data.confirmRequest, {
    resourceUri: 'metaapp://app123i0',
    kind: 'metaid-pin-write',
    payload: {
      operation: 'create',
      path: '/protocols/simplebuzz',
      encryption: '0',
      version: '1.0',
      contentType: 'text/plain',
      payload: { encoding: 'utf8', value: 'hello' },
      display: { title: 'Publish demo', summary: 'Writes one PIN.' },
      confirmed: true,
      hostConfirmation: { id: 'confirmation-1', token: 'opaque-token-1' },
    },
  });
  // ABC Cancel ends here: no confirmed request is sent to the host.
  assert.equal(createPinCalls, 0);
});

test('phase 2 accepts only the exact confirmRequest and writes create, modify, and revoke once each', async () => {
  const issuedConfirmRequests = [];
  const writes = [];
  let confirmationSequence = 0;
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    createConfirmationId: () => `confirmation-${++confirmationSequence}`,
    createConfirmationToken: () => `opaque-token-${confirmationSequence}`,
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
    const phaseOne = await service.writeMetaIdPin({
      actorId: 'idbots-metabot-7',
      resourceUri: 'metaapp://app123i0',
      payload: request,
    });
    assert.equal(phaseOne.state, 'manual_action_required');
    assert.equal(writes.length, requests.indexOf(request));
    issuedConfirmRequests.push(phaseOne.data.confirmRequest);

    const result = await service.writeMetaIdPin({
      actorId: 'idbots-metabot-7',
      ...phaseOne.data.confirmRequest,
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
        network: undefined,
      },
      {
        metabotId: 7,
        operation: 'modify',
        path: `@${MODIFY_TARGET_PIN_ID}`,
        contentType: 'application/json',
        payload: '{"ok":true}',
        hasOriginalId: false,
        hasAppAction: false,
        network: undefined,
      },
      {
        metabotId: 7,
        operation: 'revoke',
        path: `@${REVOKE_TARGET_PIN_ID}`,
        contentType: 'application/json',
        payload: '',
        hasOriginalId: false,
        hasAppAction: false,
        network: undefined,
      },
    ],
  );
  assert.equal(issuedConfirmRequests[1].payload.originalId, MODIFY_TARGET_PIN_ID);
  assert.equal(issuedConfirmRequests[1].payload.appAction, 'update-profile');
  assert.deepEqual(issuedConfirmRequests[2].payload.payload, {
    encoding: 'utf8',
    value: '',
  });
  assert.deepEqual(issuedConfirmRequests[2].payload.hostConfirmation, {
    id: 'confirmation-3',
    token: 'opaque-token-3',
  });
  assert.equal(writes.length, 3);
});

test('invalid and expired confirmations are rejected, and a consumed token cannot replay', async () => {
  let currentTime = 1_000;
  let confirmationSequence = 0;
  let createPinCalls = 0;
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    now: () => currentTime,
    confirmationTtlMs: 1_000,
    createConfirmationId: () => `confirmation-${++confirmationSequence}`,
    createConfirmationToken: () => `opaque-token-${confirmationSequence}`,
    createPin: async () => {
      createPinCalls += 1;
      return { pinId: 'pin123i0', txids: ['tx123'], totalCost: 1 };
    },
  });

  const forged = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: { ...createPinWritePayload(), confirmed: true },
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'invalid_request');

  const phaseOne = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: createPinWritePayload(),
  });
  const badTokenPayload = structuredClone(phaseOne.data.confirmRequest.payload);
  badTokenPayload.hostConfirmation.token = 'wrong-token';
  const invalid = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: badTokenPayload,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid_request');
  assert.equal(createPinCalls, 0);

  const success = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(success.ok, true);
  assert.equal(createPinCalls, 1);

  const replay = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...phaseOne.data.confirmRequest,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'invalid_request');
  assert.equal(createPinCalls, 1);

  const expiring = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: createPinWritePayload({ payload: { encoding: 'utf8', value: 'expires' } }),
  });
  currentTime = expiring.data.confirmation.expiresAt;
  const renewed = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...expiring.data.confirmRequest,
  });
  assert.equal(renewed.ok, false);
  assert.equal(renewed.state, 'manual_action_required');
  assert.notEqual(renewed.data.confirmation.confirmationId, expiring.data.confirmation.confirmationId);
  assert.equal(createPinCalls, 1);
});

test('authorization is consumed before createPin starts so in-flight replay is rejected', async () => {
  let createPinCalls = 0;
  let phaseTwoInput;
  let replayDuringCreatePin;
  let service;
  service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    createPin: async () => {
      createPinCalls += 1;
      replayDuringCreatePin = await service.writeMetaIdPin(phaseTwoInput);
      return { pinId: 'pin123i0', txids: ['tx123'], totalCost: 1 };
    },
  });

  const phaseOne = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: createPinWritePayload(),
  });
  phaseTwoInput = {
    actorId: 'idbots-metabot-7',
    ...phaseOne.data.confirmRequest,
  };
  const result = await service.writeMetaIdPin(phaseTwoInput);

  assert.equal(result.ok, true);
  assert.equal(createPinCalls, 1);
  assert.equal(replayDuringCreatePin.ok, false);
  assert.equal(replayDuringCreatePin.code, 'invalid_request');
});

test('actor, resourceUri, or normalized write changes invalidate the authorization', async () => {
  const metabot = createMetabot();
  let createPinCalls = 0;
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(metabot),
    createPin: async () => {
      createPinCalls += 1;
      return { pinId: 'pin123i0', txids: ['tx123'], totalCost: 1 };
    },
  });

  const actorBound = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: createPinWritePayload(),
  });
  metabot.globalmetaid = 'idq1changed';
  const actorChanged = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...actorBound.data.confirmRequest,
  });
  assert.equal(actorChanged.code, 'invalid_request');
  metabot.globalmetaid = 'IDQ1ABC';
  const actorRetry = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...actorBound.data.confirmRequest,
  });
  assert.equal(actorRetry.code, 'invalid_request');

  const resourceBound = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: createPinWritePayload(),
  });
  const resourceChanged = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...resourceBound.data.confirmRequest,
    resourceUri: 'metaapp://other456i0',
  });
  assert.equal(resourceChanged.code, 'invalid_request');
  const resourceRetry = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...resourceBound.data.confirmRequest,
  });
  assert.equal(resourceRetry.code, 'invalid_request');

  const contentBound = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: createPinWritePayload(),
  });
  const changedPayload = structuredClone(contentBound.data.confirmRequest.payload);
  changedPayload.payload.value = '{"ok":false}';
  const contentChanged = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    resourceUri: 'metaapp://app123i0',
    payload: changedPayload,
  });
  assert.equal(contentChanged.code, 'invalid_request');
  const contentRetry = await service.writeMetaIdPin({
    actorId: 'idbots-metabot-7',
    ...contentBound.data.confirmRequest,
  });
  assert.equal(contentRetry.code, 'invalid_request');
  assert.equal(createPinCalls, 0);
});

test('writeMetaIdPin rejects modify and revoke slash paths before authorization or signer execution', async () => {
  let createPinCalls = 0;
  const service = createBotBrowserBridgeService({
    metabotStore: createStore(),
    createPin: async () => {
      createPinCalls += 1;
      return { pinId: 'pin123i0', txids: ['tx123'], totalCost: 1 };
    },
  });

  for (const operation of ['modify', 'revoke']) {
    const result = await service.writeMetaIdPin({
      actorId: 'idbots-metabot-7',
      resourceUri: 'metaapp://app123i0',
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
    resourceUri: 'metaapp://app123i0',
    payload: createPinWritePayload({
      operation: 'modify',
      path: '@not-a-pin',
    }),
  });

  assert.equal(malformedTarget.ok, false);
  assert.equal(malformedTarget.code, 'invalid_params');
  assert.equal(createPinCalls, 0);
});

test('installed ABC routes Browser Share and MetaApp iframe writes through one shared modal with no native PIN dialog', () => {
  const abcBrowserSource = readFileSync(
    new URL('../node_modules/@openagentinternet/agent-browser-ui/dist-cjs/browser/app.js', import.meta.url),
    'utf8',
  );
  const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');

  assert.match(
    abcBrowserSource,
    /async function handleBridgePinWrite[\s\S]*?await submitMetaIdPinWrite\(/u,
  );
  assert.match(
    abcBrowserSource,
    /async function confirmAppShareBuzz[\s\S]*?await submitMetaIdPinWrite\(/u,
  );
  assert.match(
    abcBrowserSource,
    /async function submitMetaIdPinWrite[\s\S]*?await promptMetaIdPinWrite\(/u,
  );
  assert.equal((abcBrowserSource.match(/function promptMetaIdPinWrite\(/gu) ?? []).length, 1);
  assert.match(mainSource, /new WeakMap<BrowserWindow, BotBrowserBridgeService>\(\)/u);
  assert.doesNotMatch(mainSource, /confirmBotBrowserPinWrite|confirmPinWrite|Confirm MetaID PIN Write/u);
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
