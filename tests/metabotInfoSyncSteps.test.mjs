import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
  buildFullMetabotInfoSyncPlan,
  buildEditMetabotInfoSyncPlan,
  syncMetaBotToChain,
  syncMetaBotEditChangesToChain,
} = await import('../dist-electron/main/services/metaidCore.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metabotsManagerPath = path.join(projectRoot, 'src', 'renderer', 'components', 'metabots', 'MetabotsManager.tsx');
const i18nPath = path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts');

const metabot = {
  name: 'Alice Bot',
  avatar: '',
  chat_public_key: ' 04abcdef ',
  chat_public_key_pin_id: null,
  role: ' Assistant ',
  soul: ' Direct ',
  goal: ' Help ',
  bio: ' Bio ',
  background: ' Deprecated background ',
  llm_id: ' codex ',
  fallback_llm_id: ' ollama ',
  allow_chat_skills: ['metabot-help', ' metabot-wallet-manage ', 'metabot-help'],
};

test('full sync plan uses protocol paths and includes chatpubkey only before bootstrap', () => {
  const steps = buildFullMetabotInfoSyncPlan(metabot);

  assert.deepEqual(
    steps.map((step) => step.key),
    ['name', 'chatpubkey', 'bio', 'persona', 'llm', 'chatSkills', 'homepage'],
  );
  assert.deepEqual(
    steps.map((step) => step.path),
    ['/info/name', '/info/chatpubkey', '/info/bio', '/info/persona', '/info/llm', '/info/chatSkills', '/info/homepage'],
  );
  assert.equal(steps.find((step) => step.key === 'bio').contentType, 'text/plain');
  assert.equal(steps.find((step) => step.key === 'persona').contentType, 'application/json');
  assert.equal(steps.find((step) => step.key === 'llm').contentType, 'application/json');
  assert.equal(steps.find((step) => step.key === 'chatSkills').contentType, 'application/json');

  const chatpubkeyStep = steps.find((step) => step.key === 'chatpubkey');
  assert.equal(chatpubkeyStep.payload, '04abcdef');

  const afterBootstrap = buildFullMetabotInfoSyncPlan({
    ...metabot,
    chat_public_key_pin_id: 'chat-pin',
  });
  assert.equal(afterBootstrap.some((step) => step.key === 'chatpubkey'), false);
});

test('edit sync plan never includes chatpubkey and splits profile fields', () => {
  const steps = buildEditMetabotInfoSyncPlan({
    metabot,
    syncName: true,
    syncAvatar: false,
    syncBio: true,
    syncPersona: true,
    syncLlm: true,
    syncChatSkills: true,
  });

  assert.deepEqual(
    steps.map((step) => step.key),
    ['name', 'bio', 'persona', 'llm', 'chatSkills'],
  );
  assert.equal(steps.some((step) => step.key === 'chatpubkey'), false);
});

test('sync plans expose protocol payload content for profile steps', () => {
  const steps = buildFullMetabotInfoSyncPlan(metabot);
  const byKey = new Map(steps.map((step) => [step.key, step]));

  assert.equal(byKey.get('bio').contentType, 'text/plain');
  assert.equal(byKey.get('bio').payload, 'Bio');

  assert.equal(byKey.get('persona').contentType, 'application/json');
  assert.deepEqual(JSON.parse(byKey.get('persona').payload), {
    role: 'Assistant',
    soul: 'Direct',
    goal: 'Help',
  });

  assert.equal(byKey.get('llm').contentType, 'application/json');
  assert.deepEqual(JSON.parse(byKey.get('llm').payload), {
    primaryProvider: 'codex',
    fallbackProvider: 'ollama',
  });

  assert.equal(byKey.get('chatSkills').contentType, 'application/json');
  assert.deepEqual(JSON.parse(byKey.get('chatSkills').payload), {
    allowPrivateChatSkills: ['metabot-help', 'metabot-wallet-manage'],
    allowGroupChatSkills: ['metabot-help', 'metabot-wallet-manage'],
  });
});

test('edit sync plan publishes an empty avatar step when avatar is cleared', () => {
  const steps = buildEditMetabotInfoSyncPlan({
    metabot: {
      ...metabot,
      avatar: '',
      chat_public_key_pin_id: 'chat-pin',
    },
    syncAvatar: true,
  });

  assert.deepEqual(steps.map((step) => step.key), ['avatar']);
  assert.equal(steps[0].path, '/info/avatar');
  assert.equal(steps[0].contentType, 'text/plain');
  assert.equal(steps[0].payload, '');
});

test('sync plans publish valid image avatar data URLs as binary', () => {
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

  const fullAvatarStep = buildFullMetabotInfoSyncPlan({
    ...metabot,
    avatar,
    chat_public_key_pin_id: 'chat-pin',
  }).find((step) => step.key === 'avatar');

  assert.equal(fullAvatarStep.path, '/info/avatar');
  assert.equal(fullAvatarStep.contentType, 'image/png;binary');
  assert.equal(fullAvatarStep.encoding, 'base64');
  assert.equal(Buffer.isBuffer(fullAvatarStep.payload), true);
  assert.ok(fullAvatarStep.payload.length > 0);

  const editSteps = buildEditMetabotInfoSyncPlan({
    metabot: {
      ...metabot,
      avatar,
      chat_public_key_pin_id: 'chat-pin',
    },
    syncAvatar: true,
  });

  assert.deepEqual(editSteps.map((step) => step.key), ['avatar']);
  assert.equal(editSteps[0].path, '/info/avatar');
  assert.equal(editSteps[0].contentType, 'image/png;binary');
  assert.equal(editSteps[0].encoding, 'base64');
  assert.equal(Buffer.isBuffer(editSteps[0].payload), true);
  assert.ok(editSteps[0].payload.length > 0);
});

test('edit sync plan rejects invalid non-empty avatar data', () => {
  assert.throws(
    () => buildEditMetabotInfoSyncPlan({
      metabot: {
        ...metabot,
        avatar: 'not-a-data-url',
        chat_public_key_pin_id: 'chat-pin',
      },
      syncAvatar: true,
    }),
    /invalid avatar data url/i,
  );
});

test('edit sync plan rejects unsupported avatar data URL MIME types', () => {
  assert.throws(
    () => buildEditMetabotInfoSyncPlan({
      metabot: {
        ...metabot,
        avatar: 'data:text/plain;base64,aGVsbG8=',
        chat_public_key_pin_id: 'chat-pin',
      },
      syncAvatar: true,
    }),
    /invalid avatar data url/i,
  );
});

test('edit sync plan rejects malformed avatar base64 payloads', () => {
  assert.throws(
    () => buildEditMetabotInfoSyncPlan({
      metabot: {
        ...metabot,
        avatar: 'data:image/png;base64,not valid base64',
        chat_public_key_pin_id: 'chat-pin',
      },
      syncAvatar: true,
    }),
    /invalid avatar data url/i,
  );
});

test('edit sync persists latest successful profile pin before a later profile failure', async () => {
  const updateCalls = [];
  const createPinPaths = [];
  const fakeStore = {
    getMetabotById: (id) => ({
      ...metabot,
      id,
      chat_public_key_pin_id: 'chat-pin',
    }),
    getMetabotWalletByMetabotId: () => {
      throw new Error('test createPin dependency was not used');
    },
    updateMetabot: (id, input) => {
      updateCalls.push({ id, input });
      return { ...metabot, id, ...input };
    },
  };

  const result = await syncMetaBotEditChangesToChain(
    fakeStore,
    {
      metabotId: 7,
      syncBio: true,
      syncPersona: true,
    },
    {
      createPin: async (_store, _metabotId, payload) => {
        createPinPaths.push(payload.path);
        if (payload.path === '/info/bio') {
          return { txids: ['bio-tx'], pinId: 'bio-pin', totalCost: 1 };
        }
        if (payload.path === '/info/persona') {
          throw new Error('persona failed');
        }
        throw new Error(`unexpected path ${payload.path}`);
      },
      sleep: async () => {},
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.error, 'persona failed');
  assert.equal(result.metabotInfoPinId, 'bio-pin');
  assert.deepEqual(result.syncedSteps, ['bio']);
  assert.deepEqual(createPinPaths, ['/info/bio', '/info/persona']);
  assert.deepEqual(updateCalls, [
    { id: 7, input: { metabot_info_pinid: 'bio-pin' } },
  ]);
});

test('edit sync does not mark a profile step synced when local pin persistence fails', async () => {
  const createPinPaths = [];
  const fakeStore = {
    getMetabotById: (id) => ({
      ...metabot,
      id,
      chat_public_key_pin_id: 'chat-pin',
    }),
    getMetabotWalletByMetabotId: () => {
      throw new Error('test createPin dependency was not used');
    },
    updateMetabot: () => {
      throw new Error('sqlite is locked');
    },
  };

  const result = await syncMetaBotEditChangesToChain(
    fakeStore,
    {
      metabotId: 7,
      syncBio: true,
    },
    {
      createPin: async (_store, _metabotId, payload) => {
        createPinPaths.push(payload.path);
        return { txids: ['bio-tx'], pinId: 'bio-pin', totalCost: 1 };
      },
      sleep: async () => {},
    },
  );

  assert.equal(result.success, false);
  assert.match(result.error, /database update failed/i);
  assert.equal(result.metabotInfoPinId, 'bio-pin');
  assert.deepEqual(result.txids, ['bio-tx']);
  assert.deepEqual(result.syncedSteps, []);
  assert.deepEqual(createPinPaths, ['/info/bio']);
});

test('full sync reports partial failure when chatpubkey is missing before bootstrap', async () => {
  const updateCalls = [];
  const createPinPaths = [];
  const fakeStore = {
    getMetabotById: (id) => ({
      ...metabot,
      id,
      chat_public_key: '   ',
      chat_public_key_pin_id: null,
    }),
    getMetabotWalletByMetabotId: () => {
      throw new Error('test createPin dependency was not used');
    },
    updateMetabot: (id, input) => {
      updateCalls.push({ id, input });
      return { ...metabot, id, ...input };
    },
  };

  const result = await syncMetaBotToChain(
    fakeStore,
    8,
    {
      createPin: async (_store, _metabotId, payload) => {
        createPinPaths.push(payload.path);
        const key = payload.path.slice('/info/'.length);
        return { txids: [`${key}-tx`], pinId: `${key}-pin`, totalCost: 1 };
      },
      sleep: async () => {},
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.canSkip, true);
  assert.match(result.error, /chat public key/i);
  assert.equal(result.chatPublicKeyPinId, undefined);
  assert.equal(result.metabotInfoPinId, 'chatSkills-pin');
  // homepage step is skipped in full sync when the bot has no homepage set.
  assert.deepEqual(createPinPaths, ['/info/name', '/info/bio', '/info/persona', '/info/llm', '/info/chatSkills']);
  assert.deepEqual(updateCalls, [
    { id: 8, input: { metabot_info_pinid: 'chatSkills-pin' } },
  ]);
});

test('renderer edit sync splits Bot Info protocol flags and forwards them to IPC', () => {
  const source = fs.readFileSync(metabotsManagerPath, 'utf8');

  assert.match(source, /syncBio:\s*boolean;\s*syncPersona:\s*boolean;\s*syncLlm:\s*boolean;\s*syncChatSkills:\s*boolean;/);
  assert.match(source, /const syncBio =\s*nextBioRaw !== oldBioRaw;/);
  assert.match(source, /const syncPersona =\s*nextRole !== oldRole \|\|\s*nextSoul !== oldSoul \|\|\s*nextGoalRaw !== oldGoalRaw;/);
  assert.match(source, /const syncLlm =\s*nextLlmRaw !== oldLlmRaw \|\| \(hasFallbackLlmValue && nextFallbackLlmRaw !== oldFallbackLlmRaw\);/);
  assert.match(source, /const syncChatSkills =\s*JSON\.stringify\(nextAllowChatSkills\) !== JSON\.stringify\(oldAllowChatSkills\);/);

  const syncBioSection = source.slice(source.indexOf('const syncBio ='), source.indexOf('const syncStepKeys'));
  assert.doesNotMatch(syncBioSection, /nextBossId|oldBossId|nextBossGlobalMetaId|oldBossGlobalMetaId/);

  assert.match(source, /if \(syncPersona\) syncStepKeys\.push\('persona'\);/);
  assert.match(source, /if \(syncLlm\) syncStepKeys\.push\('llm'\);/);
  assert.match(source, /if \(syncChatSkills\) syncStepKeys\.push\('chatSkills'\);/);
  assert.match(source, /syncPersona:\s*plan\.syncPersona/);
  assert.match(source, /syncLlm:\s*plan\.syncLlm/);
  assert.match(source, /syncChatSkills:\s*plan\.syncChatSkills/);
});

test('renderer edit sync retry narrows already synced Bot Info steps', () => {
  const source = fs.readFileSync(metabotsManagerPath, 'utf8');

  assert.match(source, /const buildRemainingEditSyncPlan =\s*\(\s*plan:\s*EditSyncPlan,\s*syncedSteps:\s*readonly SyncStepKey\[\]/);
  assert.match(source, /const synced = new Set\(syncedSteps\);/);
  assert.match(source, /syncName:\s*plan\.syncName && !synced\.has\('name'\)/);
  assert.match(source, /syncAvatar:\s*plan\.syncAvatar && !synced\.has\('avatar'\)/);
  assert.match(source, /syncBio:\s*plan\.syncBio && !synced\.has\('bio'\)/);
  assert.match(source, /syncPersona:\s*plan\.syncPersona && !synced\.has\('persona'\)/);
  assert.match(source, /syncLlm:\s*plan\.syncLlm && !synced\.has\('llm'\)/);
  assert.match(source, /syncChatSkills:\s*plan\.syncChatSkills && !synced\.has\('chatSkills'\)/);
  assert.match(source, /const retryPlan = buildRemainingEditSyncPlan\(plan, result\.syncedSteps \?\? \[\]\);/);
  assert.match(source, /const manualRetryPlan = buildRemainingEditSyncPlan\(retryPlan, result\.syncedSteps \?\? \[\]\);/);
  assert.match(source, /if \(retryPlan\.syncStepKeys\.length > 0\)/);
  assert.match(source, /setEditSyncPlan\(retryPlan\)/);
});

test('renderer chat skill hint copy references the /info/chatSkills protocol path', () => {
  const source = fs.readFileSync(i18nPath, 'utf8');

  assert.match(
    source,
    /metabotAllowChatSkillsHint:\s*'这些技能会写入 \/info\/chatSkills，供私聊和群聊流程读取。'/,
  );
  assert.match(
    source,
    /metabotAllowChatSkillsHint:\s*'These skills are published to \/info\/chatSkills for private-chat and group-chat replies\.'/,
  );
  assert.match(source, /metabotSyncStepChatSkills:\s*'聊天技能'/);
  assert.doesNotMatch(source, /bio\.allowChatSkills/);
});

test('full sync plan includes homepage step', () => {
  const steps = buildFullMetabotInfoSyncPlan({
    name: 'Bot',
    chat_public_key: 'k',
    role: 'r', soul: 's', goal: 'g', bio: 'b', llm_id: 'l',
    homepage: '{"uri":"metaapp://p","renderer":"metaapp","contentType":"application/vnd.metaapp"}',
  });
  const hp = steps.find((s) => s.key === 'homepage');
  assert.ok(hp, 'homepage step present');
  assert.equal(hp.path, '/info/homepage');
  assert.equal(hp.contentType, 'application/json');
});

test('edit sync plan includes homepage only when syncHomepage', () => {
  const baseMetabot = {
    name: 'Bot', avatar: '', role: 'r', soul: 's', goal: 'g', bio: 'b', llm_id: 'l',
    allow_chat_skills: [],
    homepage: '{"uri":"metaapp://p","renderer":"metaapp","contentType":"application/vnd.metaapp"}',
  };
  const withHp = buildEditMetabotInfoSyncPlan({ metabotId: 1, syncHomepage: true, metabot: baseMetabot });
  assert.ok(withHp.some((s) => s.key === 'homepage'));
  const withoutHp = buildEditMetabotInfoSyncPlan({ metabotId: 1, syncName: true, metabot: baseMetabot });
  assert.equal(withoutHp.some((s) => s.key === 'homepage'), false);
});

test('full sync plan with skipEmptyInfoSteps omits empty bio/persona/chatSkills/homepage pins', () => {
  const minimalBot = {
    name: 'Minimal Bot',
    avatar: '',
    chat_public_key: ' 04abcdef ',
    chat_public_key_pin_id: null,
    role: '',
    soul: '',
    goal: '',
    bio: '',
    llm_id: ' openai ',
    allow_chat_skills: [],
    homepage: null,
  };

  const steps = buildFullMetabotInfoSyncPlan(minimalBot, { skipEmptyInfoSteps: true });
  assert.deepEqual(
    steps.map((step) => step.key),
    ['name', 'chatpubkey', 'llm'],
  );
  assert.deepEqual(JSON.parse(steps.find((step) => step.key === 'llm').payload), {
    primaryProvider: 'openai',
    fallbackProvider: null,
  });

  // Without the flag the full plan keeps publishing every step (edit plan relies on this).
  const defaultSteps = buildFullMetabotInfoSyncPlan(minimalBot);
  assert.deepEqual(
    defaultSteps.map((step) => step.key),
    ['name', 'chatpubkey', 'bio', 'persona', 'llm', 'chatSkills', 'homepage'],
  );
});

test('full sync plan with skipEmptyInfoSteps keeps steps that have content', () => {
  const steps = buildFullMetabotInfoSyncPlan(
    {
      name: 'Rich Bot',
      avatar: '',
      chat_public_key: '04abcdef',
      chat_public_key_pin_id: 'chat-pin',
      role: ' Assistant ',
      soul: '',
      goal: '',
      bio: ' Bio ',
      llm_id: 'openai',
      fallback_llm_id: 'ollama',
      allow_chat_skills: ['metabot-help'],
      homepage: '{"uri":"metaapp://p","renderer":"metaapp","contentType":"application/vnd.metaapp"}',
    },
    { skipEmptyInfoSteps: true },
  );

  assert.deepEqual(
    steps.map((step) => step.key),
    ['name', 'bio', 'persona', 'llm', 'chatSkills', 'homepage'],
  );
  assert.deepEqual(JSON.parse(steps.find((step) => step.key === 'llm').payload), {
    primaryProvider: 'openai',
    fallbackProvider: 'ollama',
  });
});

test('edit sync plan still publishes cleared (empty) profile values', () => {
  const clearedBot = {
    name: 'Bot',
    avatar: '',
    chat_public_key: 'k',
    chat_public_key_pin_id: 'chat-pin',
    role: '',
    soul: '',
    goal: '',
    bio: '',
    llm_id: 'openai',
    allow_chat_skills: [],
    homepage: null,
  };
  const steps = buildEditMetabotInfoSyncPlan({
    metabotId: 1,
    metabot: clearedBot,
    syncBio: true,
    syncPersona: true,
    syncChatSkills: true,
    syncHomepage: true,
  });

  assert.deepEqual(steps.map((step) => step.key), ['bio', 'persona', 'chatSkills', 'homepage']);
  assert.equal(steps.find((step) => step.key === 'bio').payload, '');
});
