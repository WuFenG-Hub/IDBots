# Bot Info Protocol Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align IDBots MetaBot create, edit, restore, and chat-skill profile semantics with the OAC Bot Info protocol in `/Users/tusm/Documents/MetaID_Projects/open-agent-connect/docs/metaid_protocols/06-bot-info.md`.

**Architecture:** Keep the current local `metabots` table as the runtime model and move protocol compliance into the on-chain write/read mapping layer. Replace the legacy `/info/bio` JSON bundle with separate Bot Info path writers and readers: `/info/bio`, `/info/persona`, `/info/llm`, and `/info/chatSkills`; keep legacy `/info/bio` JSON parsing only as restore compatibility for already-published bots.

**Tech Stack:** Electron main process, TypeScript, React renderer, sql.js-backed `MetabotStore`, MetaID `create` PIN operations, Node test runner, `npm run compile:electron`.

**Repository note:** Current repo rules require IDBots edits to stay inside this repository. If a task adds plan or test files under ignored paths, use `git add -f` for those files. Each implementation commit must be followed by a Codex `metabot-post-buzz` development journal entry.

---

## Protocol Decisions

- `/info/bio` maps to the existing local `background` field as plain UTF-8 text. Do not add a new DB column in this iteration.
- `/info/persona` maps to `{ role, soul, goal }`.
- `/info/llm` maps to `{ primaryProvider: metabot.llm_id || null, fallbackProvider: null }`. Do not publish API keys, filesystem paths, process ids, or model runtime internals.
- `/info/chatSkills` maps to `{ allowPrivateChatSkills, allowGroupChatSkills }`. Because current IDBots runtime uses one `allow_chat_skills` list for both private and group chat, publish the same normalized list to both arrays.
- `boss_id`, `boss_global_metaid`, `created_by`, `tools`, and `skills` are local/runtime fields for this plan. Do not publish them under `/info/*` unless a separate protocol document defines paths for them.
- `/info/chatpubkey` is immutable. Create it for a new Bot identity when the local row has no `chat_public_key_pin_id`; never include it in profile-edit sync.
- All Bot Info updates use `operation: 'create'` at the same path. Do not use `modify` or `revoke` for updates or clears.
- Keep `metabot_info_pinid` as the local "profile has on-chain info" marker. After multi-path profile sync, store the latest successful profile path pin id, preferring the last successful one among `bio`, `persona`, `llm`, and `chatSkills`.

## File Structure

- Create `src/main/services/metabotInfoPayload.ts`
  - Owns pure protocol mapping from local MetaBot fields to Bot Info path payloads.
  - Exports helpers for write payloads and restore parsing.

- Delete or fully retire `src/main/services/metabotBioPayload.ts` and `src/main/services/metabotBio.js`
  - Remove the legacy helper after `rg "buildMetabotBioPayload"` confirms no remaining imports.

- Modify `src/main/services/metaidCore.ts`
  - Uses the new payload helper for create/full sync and edit sync.
  - Splits edit steps into `bio`, `persona`, `llm`, and `chatSkills`.
  - Skips `/info/chatpubkey` when `chat_public_key_pin_id` already exists.

- Modify `src/main/services/metabotRestoreService.ts`
  - Reads new protocol fields when the indexer exposes them.
  - Parses legacy `/info/bio` JSON as fallback.
  - Keeps plain `/info/bio` as local `background`.

- Modify `src/main/main.ts`
  - Updates IPC input and logging for new sync flags.
  - Restores new read-model fields into local `MetabotStore`.

- Modify `src/main/preload.ts` and `src/renderer/types/electron.d.ts`
  - Keeps IPC types aligned with main process inputs and sync results.

- Modify `src/renderer/components/metabots/MetabotsManager.tsx`
  - Computes separate edit-sync flags for bio/persona/llm/chatSkills.

- Modify `src/renderer/components/metabots/MetaBotCreateSuccessModal.tsx`
  - Renders the expanded sync step list.

- Modify `src/renderer/services/i18n.ts`
  - Replaces `bio.allowChatSkills` copy with `/info/chatSkills` protocol copy in zh-CN and en-US.

- Add tests:
  - `tests/metabotInfoPayload.test.mjs`
  - `tests/metabotRestoreProtocol.test.mjs`
  - `tests/metabotInfoSyncSteps.test.mjs`

---

## Task 1: Add Bot Info Payload Mapping

**Files:**
- Create: `src/main/services/metabotInfoPayload.ts`
- Delete after replacement: `src/main/services/metabotBioPayload.ts`
- Delete after replacement: `src/main/services/metabotBio.js`
- Test: `tests/metabotInfoPayload.test.mjs`

- [ ] **Step 1: Write failing payload tests**

Create `tests/metabotInfoPayload.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildMetabotInfoPayloads,
  normalizeBotInfoStringArrayForTests,
} = await import('../dist-electron/services/metabotInfoPayload.js');

const baseMetabot = {
  role: 'Software assistant',
  soul: 'Careful and direct',
  goal: 'Help users complete work',
  background: 'Public summary',
  llm_id: 'codex',
  allow_chat_skills: ['metabot-help', 'metabot-help', ' metabot-wallet-manage '],
};

test('buildMetabotInfoPayloads emits protocol paths and content types', () => {
  const payloads = buildMetabotInfoPayloads(baseMetabot);
  assert.deepEqual(payloads.map((item) => item.step), ['bio', 'persona', 'llm', 'chatSkills']);
  assert.deepEqual(payloads.map((item) => item.path), ['/info/bio', '/info/persona', '/info/llm', '/info/chatSkills']);
  assert.deepEqual(payloads.map((item) => item.contentType), [
    'text/plain',
    'application/json',
    'application/json',
    'application/json',
  ]);
  assert.equal(payloads[0].payload, 'Public summary');
  assert.deepEqual(JSON.parse(payloads[1].payload), {
    role: 'Software assistant',
    soul: 'Careful and direct',
    goal: 'Help users complete work',
  });
  assert.deepEqual(JSON.parse(payloads[2].payload), {
    primaryProvider: 'codex',
    fallbackProvider: null,
  });
  assert.deepEqual(JSON.parse(payloads[3].payload), {
    allowPrivateChatSkills: ['metabot-help', 'metabot-wallet-manage'],
    allowGroupChatSkills: ['metabot-help', 'metabot-wallet-manage'],
  });
});

test('buildMetabotInfoPayloads clears nullable fields with empty protocol values', () => {
  const payloads = buildMetabotInfoPayloads({
    role: '',
    soul: '',
    goal: null,
    background: null,
    llm_id: null,
    allow_chat_skills: [],
  });
  assert.equal(payloads[0].payload, '');
  assert.deepEqual(JSON.parse(payloads[1].payload), {
    role: '',
    soul: '',
    goal: '',
  });
  assert.deepEqual(JSON.parse(payloads[2].payload), {
    primaryProvider: null,
    fallbackProvider: null,
  });
  assert.deepEqual(JSON.parse(payloads[3].payload), {
    allowPrivateChatSkills: [],
    allowGroupChatSkills: [],
  });
});

test('normalizeBotInfoStringArrayForTests accepts arrays, JSON arrays, and comma strings', () => {
  assert.deepEqual(normalizeBotInfoStringArrayForTests([' a ', 'a', '', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeBotInfoStringArrayForTests('["a"," b ","a"]'), ['a', 'b']);
  assert.deepEqual(normalizeBotInfoStringArrayForTests('a, b, a'), ['a', 'b']);
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run compile:electron && node --test tests/metabotInfoPayload.test.mjs
```

Expected: FAIL because `dist-electron/services/metabotInfoPayload.js` does not exist.

- [ ] **Step 3: Implement the protocol payload helper**

Create `src/main/services/metabotInfoPayload.ts`:

```ts
export type MetabotInfoStep = 'bio' | 'persona' | 'llm' | 'chatSkills';

export interface MetabotInfoPayloadInput {
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  background?: string | null;
  llm_id?: string | null;
  allow_chat_skills?: unknown;
}

export interface MetabotInfoPayload {
  step: MetabotInfoStep;
  path: '/info/bio' | '/info/persona' | '/info/llm' | '/info/chatSkills';
  contentType: 'text/plain' | 'application/json';
  payload: string;
}

const cleanString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function normalizeStringArray(value: unknown): string[] {
  let rawItems: unknown[] = [];
  if (Array.isArray(value)) {
    rawItems = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      rawItems = Array.isArray(parsed) ? parsed : trimmed.split(',');
    } catch {
      rawItems = trimmed.split(',');
    }
  } else if (value != null) {
    rawItems = [value];
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawItems) {
    const normalized = String(item ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function buildMetabotInfoPayloads(metabot: MetabotInfoPayloadInput): MetabotInfoPayload[] {
  const allowChatSkills = normalizeStringArray(metabot.allow_chat_skills);
  return [
    {
      step: 'bio',
      path: '/info/bio',
      contentType: 'text/plain',
      payload: cleanString(metabot.background),
    },
    {
      step: 'persona',
      path: '/info/persona',
      contentType: 'application/json',
      payload: JSON.stringify({
        role: cleanString(metabot.role),
        soul: cleanString(metabot.soul),
        goal: cleanString(metabot.goal),
      }),
    },
    {
      step: 'llm',
      path: '/info/llm',
      contentType: 'application/json',
      payload: JSON.stringify({
        primaryProvider: cleanString(metabot.llm_id) || null,
        fallbackProvider: null,
      }),
    },
    {
      step: 'chatSkills',
      path: '/info/chatSkills',
      contentType: 'application/json',
      payload: JSON.stringify({
        allowPrivateChatSkills: allowChatSkills,
        allowGroupChatSkills: allowChatSkills,
      }),
    },
  ];
}

export const normalizeBotInfoStringArrayForTests = normalizeStringArray;
```

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
npm run compile:electron && node --test tests/metabotInfoPayload.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Remove the legacy helper after imports are gone**

After Task 2 replaces imports, run:

```bash
rg "buildMetabotBioPayload|metabotBioPayload|metabotBio\\.js" src tests
```

Expected: no output. Then delete `src/main/services/metabotBioPayload.ts` and `src/main/services/metabotBio.js`.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add -f tests/metabotInfoPayload.test.mjs
git add src/main/services/metabotInfoPayload.ts
git commit -m "feat: add bot info payload mapper"
```

Then post a development-journal Buzz with Codex's `metabot-post-buzz` skill describing the new protocol mapper and tests.

---

## Task 2: Split MetaBot Chain Sync Into Protocol Paths

**Files:**
- Modify: `src/main/services/metaidCore.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Test: `tests/metabotInfoSyncSteps.test.mjs`

- [ ] **Step 1: Write failing sync-step tests**

Create `tests/metabotInfoSyncSteps.test.mjs` against exported test helpers from `dist-electron/services/metaidCore.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildFullMetabotInfoSyncPlanForTests,
  buildEditMetabotInfoSyncPlanForTests,
} = await import('../dist-electron/services/metaidCore.js');

const metabot = {
  name: 'Alice Bot',
  avatar: '',
  chat_public_key: '04abcdef',
  chat_public_key_pin_id: null,
  role: 'Assistant',
  soul: 'Direct',
  goal: 'Help',
  background: 'Bio',
  llm_id: 'codex',
  allow_chat_skills: ['metabot-help'],
};

test('full sync plan uses protocol paths and includes chatpubkey only before bootstrap', () => {
  const steps = buildFullMetabotInfoSyncPlanForTests(metabot);
  assert.deepEqual(steps.map((step) => step.key), ['name', 'chatpubkey', 'bio', 'persona', 'llm', 'chatSkills']);
  assert.deepEqual(steps.map((step) => step.path), [
    '/info/name',
    '/info/chatpubkey',
    '/info/bio',
    '/info/persona',
    '/info/llm',
    '/info/chatSkills',
  ]);
  assert.equal(steps.find((step) => step.key === 'bio').contentType, 'text/plain');
  assert.equal(steps.find((step) => step.key === 'persona').contentType, 'application/json');
  assert.equal(steps.find((step) => step.key === 'llm').contentType, 'application/json');
  assert.equal(steps.find((step) => step.key === 'chatSkills').contentType, 'application/json');

  const afterBootstrap = buildFullMetabotInfoSyncPlanForTests({
    ...metabot,
    chat_public_key_pin_id: 'chat-pin',
  });
  assert.equal(afterBootstrap.some((step) => step.key === 'chatpubkey'), false);
});

test('edit sync plan never includes chatpubkey and splits profile fields', () => {
  const steps = buildEditMetabotInfoSyncPlanForTests({
    metabot,
    syncName: true,
    syncAvatar: false,
    syncBio: true,
    syncPersona: true,
    syncLlm: true,
    syncChatSkills: true,
  });
  assert.deepEqual(steps.map((step) => step.key), ['name', 'bio', 'persona', 'llm', 'chatSkills']);
  assert.equal(steps.some((step) => step.key === 'chatpubkey'), false);
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run compile:electron && node --test tests/metabotInfoSyncSteps.test.mjs
```

Expected: FAIL because the exported planning helpers and new sync flags do not exist.

- [ ] **Step 3: Update sync types and planning helpers**

In `src/main/services/metaidCore.ts`, replace:

```ts
export type SyncMetaBotEditStep = 'name' | 'avatar' | 'bio';
```

with:

```ts
export type SyncMetaBotStep = 'name' | 'avatar' | 'chatpubkey' | 'bio' | 'persona' | 'llm' | 'chatSkills';
export type SyncMetaBotEditStep = Exclude<SyncMetaBotStep, 'chatpubkey'>;
```

Extend `SyncMetaBotEditChangesInput`:

```ts
export interface SyncMetaBotEditChangesInput {
  metabotId: number;
  syncName?: boolean;
  syncAvatar?: boolean;
  syncBio?: boolean;
  syncPersona?: boolean;
  syncLlm?: boolean;
  syncChatSkills?: boolean;
}
```

Add testable sync-plan helpers:

```ts
export interface MetabotInfoSyncStep {
  key: SyncMetaBotStep;
  path: string;
  contentType: string;
  payload: string | Buffer;
  encoding?: 'base64';
}

export function buildFullMetabotInfoSyncPlanForTests(metabot: any): MetabotInfoSyncStep[] {
  const steps: MetabotInfoSyncStep[] = [{
    key: 'name',
    path: '/info/name',
    contentType: 'text/plain',
    payload: metabot.name || 'MetaBot',
  }];

  const avatarData = parseDataUrlAvatar(metabot.avatar);
  if (avatarData) {
    steps.push({
      key: 'avatar',
      path: '/info/avatar',
      contentType: `${avatarData.mime};binary`,
      payload: avatarData.buffer,
      encoding: 'base64',
    });
  }

  if (!metabot.chat_public_key_pin_id && typeof metabot.chat_public_key === 'string' && metabot.chat_public_key.trim()) {
    steps.push({
      key: 'chatpubkey',
      path: '/info/chatpubkey',
      contentType: 'text/plain',
      payload: metabot.chat_public_key.trim(),
    });
  }

  for (const payload of buildMetabotInfoPayloads(metabot)) {
    steps.push({
      key: payload.step,
      path: payload.path,
      contentType: payload.contentType,
      payload: payload.payload,
    });
  }

  return steps;
}

export function buildEditMetabotInfoSyncPlanForTests(input: SyncMetaBotEditChangesInput & { metabot: any }): MetabotInfoSyncStep[] {
  const steps = buildFullMetabotInfoSyncPlanForTests({
    ...input.metabot,
    chat_public_key_pin_id: input.metabot.chat_public_key_pin_id || 'skip-edit-chatpubkey',
  });
  const wanted = new Set<SyncMetaBotStep>();
  if (input.syncName) wanted.add('name');
  if (input.syncAvatar) wanted.add('avatar');
  if (input.syncBio) wanted.add('bio');
  if (input.syncPersona) wanted.add('persona');
  if (input.syncLlm) wanted.add('llm');
  if (input.syncChatSkills) wanted.add('chatSkills');
  return steps.filter((step) => wanted.has(step.key));
}
```

- [ ] **Step 4: Replace full sync implementation**

Update `syncMetaBotToChain(...)` to iterate `buildFullMetabotInfoSyncPlanForTests(metabot)` instead of hardcoding bio JSON. Keep current behavior:

- Name failure is mandatory and returns `canSkip: false`.
- Avatar, chatpubkey, bio, persona, llm, and chatSkills failures are skippable with partial DB updates.
- Wait 3 seconds between attempted steps.
- `chat_public_key_pin_id` updates only after the `chatpubkey` step succeeds.
- `metabot_info_pinid` updates to the latest successful profile step pin among `bio`, `persona`, `llm`, and `chatSkills`.

The `createPin(...)` call inside the loop should use:

```ts
await createPin(metabotStore, metabot_id, {
  operation: 'create',
  path: step.path,
  contentType: step.contentType,
  payload: step.payload,
  encoding: step.encoding,
});
```

- [ ] **Step 5: Replace edit sync implementation**

Update `syncMetaBotEditChangesToChain(...)` to build planned steps from `syncName`, `syncAvatar`, `syncBio`, `syncPersona`, `syncLlm`, and `syncChatSkills`. Do not include `chatpubkey`.

Update `src/main/main.ts` IPC type for `idbots:syncMetaBotEditChanges`:

```ts
{
  metabotId: number;
  syncName?: boolean;
  syncAvatar?: boolean;
  syncBio?: boolean;
  syncPersona?: boolean;
  syncLlm?: boolean;
  syncChatSkills?: boolean;
}
```

Update `src/main/preload.ts` and `src/renderer/types/electron.d.ts` with the same fields and with:

```ts
syncedSteps?: Array<'name' | 'avatar' | 'bio' | 'persona' | 'llm' | 'chatSkills'>;
```

Also add `allow_chat_skills?: string[]` to `preload.ts` `addMetaBot(...)` and `createMetaBotOnChain(...)` input types, matching the main handler and `electron.d.ts`.

- [ ] **Step 6: Run sync-step tests**

Run:

```bash
npm run compile:electron && node --test tests/metabotInfoPayload.test.mjs tests/metabotInfoSyncSteps.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add src/main/services/metaidCore.ts src/main/main.ts src/main/preload.ts src/renderer/types/electron.d.ts
git add -f tests/metabotInfoSyncSteps.test.mjs
git commit -m "feat: split bot info chain sync paths"
```

Then post a development-journal Buzz with Codex's `metabot-post-buzz` skill describing the multi-path chain sync and immutable chatpubkey behavior.

---

## Task 3: Restore New Protocol Fields With Legacy Fallback

**Files:**
- Modify: `src/main/services/metabotRestoreService.ts`
- Modify: `src/main/main.ts`
- Test: `tests/metabotRestoreProtocol.test.mjs`

- [ ] **Step 1: Write failing restore parser tests**

Create `tests/metabotRestoreProtocol.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseMetaidRestoreProfileInfoForTests,
} = await import('../dist-electron/services/metabotRestoreService.js');

test('new protocol fields override legacy bio JSON', () => {
  const parsed = parseMetaidRestoreProfileInfoForTests({
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

  assert.equal(parsed.bio.background, 'Legacy background');
  assert.equal(parsed.bio.role, 'New role');
  assert.equal(parsed.bio.soul, 'New soul');
  assert.equal(parsed.bio.goal, 'New goal');
  assert.equal(parsed.bio.llm_id, 'codex');
  assert.deepEqual(parsed.bio.allowChatSkills, ['metabot-help']);
  assert.equal(parsed.metabotInfoPinId, 'skills-pin');
});

test('plain text bio becomes local background', () => {
  const parsed = parseMetaidRestoreProfileInfoForTests({
    name: 'Restored Bot',
    bio: 'Plain public bio',
    persona: { role: 'Role', soul: 'Soul', goal: '' },
    chatSkills: {},
  });
  assert.equal(parsed.bio.background, 'Plain public bio');
  assert.equal(parsed.bio.role, 'Role');
  assert.equal(parsed.bio.soul, 'Soul');
  assert.equal(parsed.bio.goal, null);
  assert.deepEqual(parsed.bio.allowChatSkills, []);
});

test('legacy bio JSON still restores old bots', () => {
  const parsed = parseMetaidRestoreProfileInfoForTests({
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
  assert.equal(parsed.bio.background, 'Legacy background');
  assert.equal(parsed.bio.llm_id, 'codex');
  assert.deepEqual(parsed.bio.allowChatSkills, ['legacy-skill']);
  assert.equal(parsed.bio.boss_id, 42);
  assert.equal(parsed.bio.boss_global_metaid, 'meta-owner');
  assert.equal(parsed.metabotInfoPinId, 'legacy-bio-pin');
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
npm run compile:electron && node --test tests/metabotRestoreProtocol.test.mjs
```

Expected: FAIL because `parseMetaidRestoreProfileInfoForTests(...)` does not exist and new fields are not parsed.

- [ ] **Step 3: Extend indexer info types**

In `src/main/services/metabotRestoreService.ts`, extend `MetaidAddressInfo`:

```ts
persona?: unknown;
personaId?: string;
personaPinId?: string;
llm?: unknown;
LLM?: unknown;
llmId?: string;
LLMId?: string;
llmPinId?: string;
chatSkills?: unknown;
chatSkillsId?: string;
chatSkillsPinId?: string;
```

Keep existing `bio`, `bioId`, and chatpubkey fields.

- [ ] **Step 4: Add restore parser helper**

Refactor existing `parseMetaidBio(...)` into a legacy parser and add:

```ts
export function parseMetaidRestoreProfileInfoForTests(info: MetaidAddressInfo): Pick<MetaidRestoreProfile, 'bio' | 'metabotInfoPinId' | 'chatpubkeyPinId' | 'raw'> {
  const legacy = parseLegacyMetaidBio(info.bio);
  const plainBio = typeof info.bio === 'string' && !looksLikeJsonObject(info.bio) ? normalizeOptionalString(info.bio) : null;
  const persona = parsePersonaPayload(info.persona);
  const llm = parseLlmPayload(info.llm ?? info.LLM);
  const chatSkills = parseChatSkillsPayload(info.chatSkills);

  const bio: MetaidBioProfile = {
    ...legacy,
    background: plainBio ?? legacy.background,
    role: persona.role ?? legacy.role,
    soul: persona.soul ?? legacy.soul,
    goal: persona.goal ?? legacy.goal,
    llm_id: llm.primaryProvider ?? legacy.llm_id,
    allowChatSkills: chatSkills.allowPrivateChatSkills ?? legacy.allowChatSkills,
  };

  return {
    bio,
    metabotInfoPinId: normalizeFirstNonEmpty(
      info.chatSkillsId,
      info.chatSkillsPinId,
      info.llmId,
      info.LLMId,
      info.llmPinId,
      info.personaId,
      info.personaPinId,
      info.bioId,
      info.bioPinId,
      info.nameId,
      info.namePinId,
      info.pinId,
    ),
    chatpubkeyPinId: normalizeFirstNonEmpty(info.chatpubkeyId, info.chatPublicKeyPinId),
    raw: info,
  };
}
```

Implement `looksLikeJsonObject`, `parsePersonaPayload`, `parseLlmPayload`, and `parseChatSkillsPayload` in the same file. These helpers should accept both parsed objects and JSON strings. Missing arrays in `chatSkills` must become empty arrays.

- [ ] **Step 5: Wire parser into `fetchMetaidRestoreProfile(...)`**

Replace the direct `parseMetaidBio(info.bio)` call with:

```ts
const parsed = parseMetaidRestoreProfileInfoForTests(info);
```

Return:

```ts
return {
  name,
  avatarDataUrl,
  metabotInfoPinId: parsed.metabotInfoPinId,
  chatpubkeyPinId: parsed.chatpubkeyPinId,
  bio: parsed.bio,
  raw: info,
};
```

`src/main/main.ts` can keep writing `profile.bio.role`, `profile.bio.soul`, `profile.bio.goal`, `profile.bio.background`, `profile.bio.llm_id`, and `profile.bio.allowChatSkills` into local DB. No DB migration is needed.

- [ ] **Step 6: Run restore tests**

Run:

```bash
npm run compile:electron && node --test tests/metabotRestoreProtocol.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add src/main/services/metabotRestoreService.ts src/main/main.ts
git add -f tests/metabotRestoreProtocol.test.mjs
git commit -m "feat: restore bot info protocol fields"
```

Then post a development-journal Buzz with Codex's `metabot-post-buzz` skill describing new restore parsing and legacy `/info/bio` JSON compatibility.

---

## Task 4: Update Renderer Sync UX and Copy

**Files:**
- Modify: `src/renderer/components/metabots/MetabotsManager.tsx`
- Modify: `src/renderer/components/metabots/MetaBotCreateSuccessModal.tsx`
- Modify: `src/renderer/services/i18n.ts`
- Test: covered by `npm run build` and sync-step tests from Task 2.

- [ ] **Step 1: Split edit sync planning in the renderer**

In `MetabotsManager.tsx`, replace `EditSyncPlan` with:

```ts
interface EditSyncPlan {
  metabotId: number;
  syncName: boolean;
  syncAvatar: boolean;
  syncBio: boolean;
  syncPersona: boolean;
  syncLlm: boolean;
  syncChatSkills: boolean;
  syncStepKeys: SyncStepKey[];
}
```

Replace the old `syncBio` boolean calculation with:

```ts
const syncBio = nextBackgroundRaw !== oldBackgroundRaw;
const syncPersona =
  nextRole !== oldRole ||
  nextSoul !== oldSoul ||
  nextGoalRaw !== oldGoalRaw;
const syncLlm = nextLlmRaw !== oldLlmRaw;
const syncChatSkills = JSON.stringify(nextAllowChatSkills) !== JSON.stringify(oldAllowChatSkills);
```

Do not include `boss_id` or `boss_global_metaid` in on-chain Bot Info sync planning. Those fields still save locally.

- [ ] **Step 2: Send expanded sync flags over IPC**

Update both calls to `window.electron.idbots.syncMetaBotEditChanges(...)`:

```ts
{
  metabotId: plan.metabotId,
  syncName: plan.syncName,
  syncAvatar: plan.syncAvatar,
  syncBio: plan.syncBio,
  syncPersona: plan.syncPersona,
  syncLlm: plan.syncLlm,
  syncChatSkills: plan.syncChatSkills,
}
```

- [ ] **Step 3: Expand sync modal step keys**

In `MetaBotCreateSuccessModal.tsx`, replace:

```ts
export type SyncStepKey = 'name' | 'avatar' | 'chatpubkey' | 'bio';
```

with:

```ts
export type SyncStepKey = 'name' | 'avatar' | 'chatpubkey' | 'bio' | 'persona' | 'llm' | 'chatSkills';
```

Replace the full step list:

```ts
const FULL_SYNC_STEP_KEYS: SyncStepKey[] = ['name', 'avatar', 'chatpubkey', 'bio', 'persona', 'llm', 'chatSkills'];
```

Expand label keys:

```ts
const SYNC_STEP_LABEL_KEYS: Record<SyncStepKey,
  | 'metabotSyncStepName'
  | 'metabotSyncStepAvatar'
  | 'metabotSyncStepChatPubKey'
  | 'metabotSyncStepBio'
  | 'metabotSyncStepPersona'
  | 'metabotSyncStepLlm'
  | 'metabotSyncStepChatSkills'
> = {
  name: 'metabotSyncStepName',
  avatar: 'metabotSyncStepAvatar',
  chatpubkey: 'metabotSyncStepChatPubKey',
  bio: 'metabotSyncStepBio',
  persona: 'metabotSyncStepPersona',
  llm: 'metabotSyncStepLlm',
  chatSkills: 'metabotSyncStepChatSkills',
};
```

- [ ] **Step 4: Update i18n copy**

In `src/renderer/services/i18n.ts`, replace the zh-CN hint:

```ts
metabotAllowChatSkillsHint: '这些技能会写入 /info/chatSkills，供私聊和群聊流程读取。',
```

Replace the en-US hint:

```ts
metabotAllowChatSkillsHint: 'These skills are published to /info/chatSkills for private-chat and group-chat replies.',
```

Add labels:

```ts
metabotSyncStepPersona: 'Persona',
metabotSyncStepLlm: 'LLM',
metabotSyncStepChatSkills: 'Chat Skills',
```

For zh-CN, use:

```ts
metabotSyncStepPersona: 'Persona',
metabotSyncStepLlm: 'LLM',
metabotSyncStepChatSkills: '聊天技能',
```

- [ ] **Step 5: Run build verification**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add src/renderer/components/metabots/MetabotsManager.tsx src/renderer/components/metabots/MetaBotCreateSuccessModal.tsx src/renderer/services/i18n.ts
git commit -m "feat: update bot info sync ui"
```

Then post a development-journal Buzz with Codex's `metabot-post-buzz` skill describing the split sync UX and copy updates.

---

## Task 5: Runtime Compatibility Check for Chat Skills

**Files:**
- Inspect: `src/main/services/privateChatDaemon.ts`
- Inspect: `src/main/services/cognitiveOrchestrator.ts`
- Inspect: `src/main/skillManager.ts`
- Test: `tests/privateChatAllowChatSkillsPrompt.test.mjs`
- Test: `tests/groupChatAllowChatSkillsRuntime.test.mjs`
- Test: `tests/chatSkillAuthorization.test.mjs`

- [ ] **Step 1: Confirm no runtime rewrite is needed**

Run:

```bash
rg -n "allow_chat_skills|allowChatSkills" src/main/services/privateChatDaemon.ts src/main/services/cognitiveOrchestrator.ts src/main/skillManager.ts tests/privateChatAllowChatSkillsPrompt.test.mjs tests/groupChatAllowChatSkillsRuntime.test.mjs tests/chatSkillAuthorization.test.mjs
```

Expected: output shows runtime consumes local `metabot.allow_chat_skills` and `SkillManager` resolves local skill ids. This is compatible with the plan because Task 3 maps `/info/chatSkills.allowPrivateChatSkills` into local `allow_chat_skills`, and Task 1 publishes local `allow_chat_skills` to both protocol arrays.

- [ ] **Step 2: Run existing chat-skill tests**

Run:

```bash
npm run compile:electron && node --test tests/privateChatAllowChatSkillsPrompt.test.mjs tests/groupChatAllowChatSkillsRuntime.test.mjs tests/chatSkillAuthorization.test.mjs
```

Expected: PASS. If these fail only because i18n labels changed, fix the affected assertions to expect `/info/chatSkills` copy. Do not change private/group runtime authorization semantics in this task.

- [ ] **Step 3: Commit only if a runtime or test change was required**

If Step 2 required code or test changes, run:

```bash
git add src/main/services/privateChatDaemon.ts src/main/services/cognitiveOrchestrator.ts src/main/skillManager.ts tests/privateChatAllowChatSkillsPrompt.test.mjs tests/groupChatAllowChatSkillsRuntime.test.mjs tests/chatSkillAuthorization.test.mjs
git commit -m "fix: align chat skill protocol mapping"
```

Then post a development-journal Buzz with Codex's `metabot-post-buzz` skill. If Step 2 passed with no file changes, do not create an empty commit.

---

## Task 6: Final Verification and Cleanup

**Files:**
- Verify all modified source and test files.
- Verify old helper removal.

- [ ] **Step 1: Confirm old `/info/bio` JSON writer is gone**

Run:

```bash
rg -n "buildMetabotBioPayload|bio\\.allowChatSkills|/info/bio.*application/json|allowChatSkills.*bio" src tests
```

Expected: no output, except legacy restore tests that intentionally mention old `/info/bio` JSON compatibility.

- [ ] **Step 2: Confirm protocol paths are present**

Run:

```bash
rg -n "/info/persona|/info/llm|/info/chatSkills|allowPrivateChatSkills|allowGroupChatSkills" src tests
```

Expected: output includes `metabotInfoPayload.ts`, `metaidCore.ts`, restore parsing, renderer i18n, and tests.

- [ ] **Step 3: Run focused verification**

Run:

```bash
npm run compile:electron && node --test tests/metabotInfoPayload.test.mjs tests/metabotInfoSyncSteps.test.mjs tests/metabotRestoreProtocol.test.mjs tests/privateChatAllowChatSkillsPrompt.test.mjs tests/groupChatAllowChatSkillsRuntime.test.mjs tests/chatSkillAuthorization.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Run full build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Check git diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` has no output. `git status --short` shows only expected files for this feature plus any pre-existing unrelated user changes.

- [ ] **Step 6: Commit any final cleanup**

If Step 1 through Step 5 required cleanup edits, commit them:

```bash
git add <changed-files>
git commit -m "chore: finalize bot info protocol alignment"
```

Then post a development-journal Buzz with Codex's `metabot-post-buzz` skill. If there are no cleanup edits, do not create an empty commit.

---

## Acceptance Criteria

- Creating a new Bot publishes `/info/name`, optional `/info/avatar`, first-time `/info/chatpubkey`, `/info/bio`, `/info/persona`, `/info/llm`, and `/info/chatSkills` using `operation: create`.
- Editing a Bot can publish name/avatar/bio/persona/llm/chatSkills updates, but never republishes `/info/chatpubkey`.
- `/info/bio` is written as `text/plain`, never as the legacy JSON profile bundle.
- `role`, `soul`, and `goal` are written under `/info/persona`.
- `llm_id` is written as `/info/llm.primaryProvider`.
- `allow_chat_skills` is written as both `/info/chatSkills.allowPrivateChatSkills` and `/info/chatSkills.allowGroupChatSkills`.
- Restoring a Bot reads new protocol fields first and still supports old bots whose persona data was published as `/info/bio` JSON.
- Private and group chat skill runtime behavior remains compatible with the existing local `allow_chat_skills` field.
- Existing user SQLite databases do not require destructive reset or schema replacement.
- Focused tests and `npm run build` pass before closeout.
