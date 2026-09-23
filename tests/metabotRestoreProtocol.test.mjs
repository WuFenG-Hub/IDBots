import assert from 'node:assert/strict';
import test from 'node:test';

const {
  parseMetaidRestoreProfileInfo,
  isSemanticallyEmptyMetaidInfoPayload,
  isSemanticallyEmptyRestoreProfilePayload,
  fetchMetaidRestoreProfile,
} = await import('../dist-electron/main/services/metabotRestoreService.js');
const {
  fetchJsonWithFallbackOnMiss,
} = await import('../dist-electron/main/services/localIndexerProxy.js');

test('new protocol fields override legacy bio JSON', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Restored Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      background: 'Legacy background',
      llm: 'legacy-llm',
      allowChatSkills: ['legacy-skill'],
    }),
    persona: { role: 'New role', soul: 'New soul', goal: 'New goal' },
    llm: { primaryProvider: 'codex', fallbackProvider: 'claude-code' },
    chatSkills: {
      allowPrivateChatSkills: ['metabot-help'],
      allowGroupChatSkills: ['group-skill'],
    },
    bioId: 'bio-pin',
    personaId: 'persona-pin',
    llmId: 'llm-pin',
    chatSkillsId: 'skills-pin',
  });

  assert.equal(parsed.bio.bio, 'Legacy background');
  assert.equal(parsed.bio.role, 'New role');
  assert.equal(parsed.bio.soul, 'New soul');
  assert.equal(parsed.bio.goal, 'New goal');
  assert.equal(parsed.bio.llm_id, 'codex');
  assert.deepEqual(parsed.bio.allowChatSkills, ['metabot-help']);
  assert.equal(parsed.metabotInfoPinId, 'skills-pin');
});

test('plain text bio becomes local bio while new paths fill profile fields', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Restored Bot',
    bio: 'Plain public bio',
    persona: { role: 'Role', soul: 'Soul', goal: '' },
    chatSkills: {},
  });

  assert.equal(parsed.bio.bio, 'Plain public bio');
  assert.equal(parsed.bio.role, 'Role');
  assert.equal(parsed.bio.soul, 'Soul');
  assert.equal(parsed.bio.goal, null);
  assert.deepEqual(parsed.bio.allowChatSkills, []);
});

test('legacy bio JSON still restores old bots', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Legacy Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      background: 'Legacy background',
      llm: 'codex',
      allowChatSkills: ['legacy-skill'],
      boss_id: '42',
      boss_global_metaid: 'meta-owner',
      createdBy: '0000',
    }),
    bioId: 'legacy-bio-pin',
  });

  assert.equal(parsed.bio.role, 'Legacy role');
  assert.equal(parsed.bio.soul, 'Legacy soul');
  assert.equal(parsed.bio.goal, 'Legacy goal');
  assert.equal(parsed.bio.bio, 'Legacy background');
  assert.equal(parsed.bio.llm_id, 'codex');
  assert.deepEqual(parsed.bio.allowChatSkills, ['legacy-skill']);
  assert.equal(parsed.bio.boss_id, 42);
  assert.equal(parsed.bio.boss_global_metaid, 'meta-owner');
  assert.equal(parsed.metabotInfoPinId, 'legacy-bio-pin');
});

test('empty new protocol payloads clear stale legacy profile values', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Clear Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      background: 'Legacy background',
      llm: 'legacy-llm',
      allowChatSkills: ['legacy-skill'],
    }),
    persona: '',
    llm: '',
    chatSkills: '',
  });

  assert.equal(parsed.bio.bio, 'Legacy background');
  assert.equal(parsed.bio.role, '');
  assert.equal(parsed.bio.soul, '');
  assert.equal(parsed.bio.goal, null);
  assert.equal(parsed.bio.llm_id, null);
  assert.deepEqual(parsed.bio.allowChatSkills, []);
});

test('null new protocol placeholders without pin ids keep legacy bio JSON values', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Legacy Placeholder Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      background: 'Legacy background',
      llm: 'legacy-llm',
      allowChatSkills: ['legacy-skill'],
    }),
    persona: null,
    llm: null,
    chatSkills: null,
  });

  assert.equal(parsed.bio.bio, 'Legacy background');
  assert.equal(parsed.bio.role, 'Legacy role');
  assert.equal(parsed.bio.soul, 'Legacy soul');
  assert.equal(parsed.bio.goal, 'Legacy goal');
  assert.equal(parsed.bio.llm_id, 'legacy-llm');
  assert.deepEqual(parsed.bio.allowChatSkills, ['legacy-skill']);
});

test('null new protocol payloads with pin ids still clear legacy profile values', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Pinned Clear Bot',
    bio: JSON.stringify({
      role: 'Legacy role',
      soul: 'Legacy soul',
      goal: 'Legacy goal',
      llm: 'legacy-llm',
      allowChatSkills: ['legacy-skill'],
    }),
    persona: null,
    personaId: 'persona-pin',
    llm: null,
    llmId: 'llm-pin',
    chatSkills: null,
    chatSkillsId: 'chat-skills-pin',
  });

  assert.equal(parsed.bio.role, '');
  assert.equal(parsed.bio.soul, '');
  assert.equal(parsed.bio.goal, null);
  assert.equal(parsed.bio.llm_id, null);
  assert.deepEqual(parsed.bio.allowChatSkills, []);
  assert.equal(parsed.metabotInfoPinId, 'chat-skills-pin');
});

test('canonical chatSkills restore ignores group-only skills when private list is missing', () => {
  const parsed = parseMetaidRestoreProfileInfo({
    name: 'Group Only Bot',
    bio: JSON.stringify({
      allowChatSkills: ['legacy-skill'],
    }),
    chatSkills: {
      allowGroupChatSkills: ['group-only'],
    },
  });

  assert.deepEqual(parsed.bio.allowChatSkills, []);
});

// --- Local-first fallback semantics -----------------------------------------
// A fresh local P2P node answers address lookups with a metadata-only stub:
// metaid / globalMetaId / address are filled in while every profile field is
// empty and isInit is false. Such a stub must count as a semantic miss so the
// remote indexer fallback runs — otherwise restore flows silently lose the
// on-chain name (user-identity import ends with an empty name field).

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const LOCAL_ADDRESS_INFO_STUB = {
  code: 1,
  message: 'ok',
  data: {
    chainName: '',
    metaid: '7777775fe18df248b375c3a381401bac84276688b4ce4e8cde12975f9a5922e8',
    name: '',
    nameId: '',
    address: '1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX',
    globalMetaId: 'idq1ncewm6vda5ryqjerwcmsqlty3x89n05k6dp6jv',
    avatar: '',
    avatarId: '',
    bio: '',
    chatpubkey: '',
    isInit: false,
  },
};

const withLocalBase = async (base, run) => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  process.env.IDBOTS_MAN_P2P_LOCAL_BASE = base;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) {
      delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
    } else {
      process.env.IDBOTS_MAN_P2P_LOCAL_BASE = originalBase;
    }
  }
};

test('a metadata-only local stub is a semantic miss for metaid info payloads', () => {
  assert.equal(isSemanticallyEmptyMetaidInfoPayload(LOCAL_ADDRESS_INFO_STUB), true);
  // Real profile content is a hit.
  assert.equal(isSemanticallyEmptyMetaidInfoPayload({ code: 1, data: { name: 'WuFenG' } }), false);
  // A content-less payload is a miss even when it carries isInit: the flag is
  // not proof that profile pins are synced locally.
  assert.equal(isSemanticallyEmptyMetaidInfoPayload({ code: 1, data: { isInit: true } }), true);
  assert.equal(isSemanticallyEmptyMetaidInfoPayload({ code: 1, data: { metaid: 'm', isInit: true } }), true);
  // A bare generic pinId is not profile content either.
  assert.equal(isSemanticallyEmptyMetaidInfoPayload({ code: 1, data: { pinId: 'any-pin' } }), true);
  assert.equal(isSemanticallyEmptyMetaidInfoPayload({ code: 1, data: null }), true);
});

test('restore profile payloads additionally require a name', () => {
  const noName = {
    code: 1,
    data: { globalMetaId: 'idq1x', address: '1X', chatpubkey: '04deadbeef', isInit: false },
  };
  assert.equal(isSemanticallyEmptyRestoreProfilePayload(noName), true);
  assert.equal(
    isSemanticallyEmptyRestoreProfilePayload({ code: 1, data: { name: 'WuFenG' } }),
    false,
  );
});

test('fetchMetaidRestoreProfile falls back to the remote indexer when the local node returns a stub', async () => {
  const calls = [];
  const profile = await withLocalBase('http://127.0.0.1:59999', async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (url.includes('/api/v1/users/info/address/')) {
        return jsonResponse(LOCAL_ADDRESS_INFO_STUB);
      }
      if (url.includes('/api/v1/info/address/')) {
        return jsonResponse({
          code: 1,
          message: 'success',
          data: {
            globalMetaId: 'idq1ncewm6vda5ryqjerwcmsqlty3x89n05k6dp6jv',
            metaid: '7777775fe18df248b375c3a381401bac84276688b4ce4e8cde12975f9a5922e8',
            name: 'WuFenG',
            nameId: '02fe59febdca1104cf8f3050153a747ee14f20dcfd128a105b58443243ad049di0',
            address: '1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX',
            chatpubkey: '',
            chatpubkeyId: '',
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    return fetchMetaidRestoreProfile('1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX');
  });

  assert.equal(profile.name, 'WuFenG');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('127.0.0.1:59999'), 'local proxy must be tried first');
  assert.ok(calls[1].includes('file.metaid.io'), 'remote fallback must run after the local stub');
});

test('fetchMetaidRestoreProfile keeps the local hit when it already carries the name', async () => {
  const calls = [];
  const profile = await withLocalBase('http://127.0.0.1:59998', async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (url.includes('/api/v1/users/info/address/')) {
        return jsonResponse({
          code: 1,
          message: 'ok',
          data: {
            metaid: 'm',
            globalMetaId: 'idq1x',
            address: '1X',
            name: 'Local Winston',
            chatpubkey: '',
            avatar: '',
            isInit: true,
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    return fetchMetaidRestoreProfile('1X');
  });

  assert.equal(profile.name, 'Local Winston');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('127.0.0.1:59998'), 'a real local hit must not trigger the remote');
});

// Review round: a failed remote attempt must degrade to the local response
// again (pre-fallback semantics), not turn a remote outage into a hard failure.

test('remote failure degrades to the local stub instead of failing the restore', async () => {
  const calls = [];
  const outcome = await withLocalBase('http://127.0.0.1:59997', async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (url.includes('/api/v1/users/info/address/')) {
        return jsonResponse(LOCAL_ADDRESS_INFO_STUB);
      }
      if (url.includes('/api/v1/info/address/')) {
        throw new TypeError('remote down');
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      await fetchMetaidRestoreProfile('1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX');
      return 'resolved';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  // The degraded local stub has no name, so the restore keeps its pre-existing
  // NAME_EMPTY contract (the import stores an empty name and fills it later).
  assert.equal(outcome, 'NAME_EMPTY');
  assert.equal(calls.length, 2);
});

test('a remote error status degrades to the local stub as well', async () => {
  const outcome = await withLocalBase('http://127.0.0.1:59996', async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/v1/users/info/address/')) {
        return jsonResponse(LOCAL_ADDRESS_INFO_STUB);
      }
      if (url.includes('/api/v1/info/address/')) {
        return new Response('upstream unavailable', { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      await fetchMetaidRestoreProfile('1FRUmweLcWcLa7VYumSnh9w3soAmydQSzX');
      return 'resolved';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  assert.equal(outcome, 'NAME_EMPTY');
});

test('a remote failure with no local response still propagates', async () => {
  const outcome = await withLocalBase('http://127.0.0.1:59995', async () => {
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/v1/users/info/address/')) {
        throw new TypeError('local down');
      }
      if (url.includes('/api/v1/info/address/')) {
        throw new TypeError('remote down');
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      await fetchMetaidRestoreProfile('1X');
      return 'resolved';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  assert.equal(outcome, 'remote down');
});

test('a content-less remote payload degrades to the local response too (remote re-check)', async () => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  process.env.IDBOTS_MAN_P2P_LOCAL_BASE = 'http://127.0.0.1:59993';
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url.includes('/api/v1/users/info/address/')) {
      return jsonResponse({
        code: 1,
        message: 'ok',
        data: {
          metaid: 'LOCAL-MARK',
          name: '',
          address: '1X',
          globalMetaId: 'idq1local',
          isInit: false,
        },
      });
    }
    if (url.includes('/api/v1/info/address/')) {
      // Remote answers fine but its payload is content-less as well.
      return jsonResponse({
        code: 1,
        message: 'success',
        data: {
          metaid: 'REMOTE-MARK',
          name: '',
          address: '1X',
          globalMetaId: 'idq1remote',
        },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const res = await fetchJsonWithFallbackOnMiss(
      '/api/v1/users/info/address/1X',
      'https://file.metaid.io/metafile-indexer/api/v1/info/address/1X',
      isSemanticallyEmptyRestoreProfilePayload,
      { degradeToLocalOnRemoteError: true },
    );
    const payload = await res.json();
    // Both sides are semantic misses: the local response wins (same degrade
    // contract as an unreachable remote).
    assert.equal(payload.data.metaid, 'LOCAL-MARK');
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) {
      delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
    } else {
      process.env.IDBOTS_MAN_P2P_LOCAL_BASE = originalBase;
    }
  }
});
