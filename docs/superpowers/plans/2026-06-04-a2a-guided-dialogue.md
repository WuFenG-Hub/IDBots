# A2A Guided Dialogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only "引导对话" control for A2A sessions so human guidance is injected once into the local MetaBot's next model turn, and can restart an ended private-chat A2A conversation.

**Architecture:** Add a small in-memory A2A guidance queue plus a shared prompt-format helper in the main process. Wire guidance through ordinary private-chat prompts, skill-backed private-chat turns, seller order execution, and order continuations; add a backend restart path that generates and sends one encrypted simplemsg when a previously ended private-chat A2A session is guided. The renderer only owns the compact footer UI and IPC call.

**Tech Stack:** Electron main IPC, React renderer, TypeScript, Node `node:test`, `tsx`, existing `CoworkStore`, `PrivateChatOrderCowork`, `privateChatDaemon`, MetaWeb `/protocols/simplemsg`, ECDH helper utilities.

---

## Ground Rules

- Work in `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots`.
- Do not create or switch branches unless the user explicitly confirms it. The repository instructions require a dedicated worktree for every new branch.
- Do not stage unrelated working-tree changes. At the time this plan was written, `METAAPPs/metaapps.config.json`, `METAAPPs/IDDisk/`, and `METAAPPs/id-music-player/` were already dirty/untracked and must be left alone.
- Commit each task independently after its focused tests pass.
- After every commit, post a development journal with Codex's `metabot-post-buzz` skill through `$HOME/.metabot/bin/metabot buzz post --from eric`.

## File Structure

- Create `src/main/services/a2aGuidance.ts`: one-shot in-memory guidance queue, guidance prompt formatting, and a helper to append guidance to system prompts.
- Create `tests/a2aGuidance.test.ts`: unit tests for queue replacement, one-shot consumption, max-length validation, and prompt formatting.
- Modify `src/main/services/privateChatDaemon.ts`: accept an optional guidance-consumer dependency, inject guidance into ordinary and skill-backed private-chat prompts, pass the guidance consumer into `PrivateChatOrderCowork`, and consume guidance for seller order prompt construction.
- Modify `src/main/services/orderPromptBuilder.ts`: accept optional `operatorGuidance` and append the formatted guidance block without removing order constraints.
- Modify `src/main/services/privateChatOrderCowork.ts`: accept optional guidance consumer and inject a newly queued value into missing-artifact continuation prompts.
- Create `src/main/services/encryptedSimplemsg.ts`: shared helper to build/send encrypted `/protocols/simplemsg` payloads using an already resolved peer chat public key.
- Create `tests/encryptedSimplemsg.test.ts`: unit tests for simplemsg payload shape and that plaintext is encrypted before `createPin`.
- Modify `src/main/main.ts`: wire the singleton guidance queue into `startPrivateChatDaemon`, add `cowork:session:queueA2AGuidance`, implement active queue mode, implement ended-conversation restart mode, and use `encryptedSimplemsg.ts`.
- Modify `src/main/preload.ts`: expose `cowork.queueA2AGuidance`.
- Modify `src/renderer/types/electron.d.ts`: add the IPC method type.
- Modify `src/renderer/types/cowork.ts`: add `CoworkA2AGuidanceResult` and request type.
- Modify `src/renderer/services/cowork.ts`: add `queueA2AGuidance`, refreshing the session when restart succeeds.
- Modify `src/renderer/services/i18n.ts`: add Chinese and English A2A guidance strings.
- Modify `src/renderer/components/cowork/CoworkSessionDetail.tsx`: replace observer-only footer copy with `引导对话`, add compact input panel, submit handler, status/error state, and latest-control-event ended-state logic.
- Modify `tests/privateChatAllowChatSkillsPrompt.test.mjs`: verify private-chat prompt guidance formatting after `npm run compile:electron`.
- Modify `tests/orderPromptBuilder.test.ts`: verify order prompt guidance keeps payment/delivery constraints.
- Modify `tests/privateChatSkillTurnDeliveryInvariant.test.mjs`: verify queued guidance reaches skill-backed private-chat system prompt once.
- Modify `tests/privateChatOrderCoworkTimeout.test.mjs`: verify missing-artifact continuation can consume newly queued guidance.
- Modify `tests/coworkSessionDetailA2AEndUi.test.mjs`: verify UI/source wiring for guidance, removed observer notice, latest restart marker, and main restart handler.

---

### Task 1: Add The A2A Guidance Queue And Prompt Formatter

**Files:**
- Create: `src/main/services/a2aGuidance.ts`
- Test: `tests/a2aGuidance.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `tests/a2aGuidance.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_GUIDANCE_MAX_LENGTH,
  A2AGuidanceQueue,
  appendA2AGuidanceToSystemPrompt,
  formatA2AGuidanceBlock,
} from '../src/main/services/a2aGuidance';

test('A2AGuidanceQueue replaces pending guidance for the same session and consumes it once', () => {
  const queue = new A2AGuidanceQueue(() => 1_770_000_000_000);

  queue.queue({ sessionId: 'session-1', metabotId: 7, guidance: '第一条' });
  queue.queue({ sessionId: 'session-1', metabotId: 7, guidance: '第二条' });

  const consumed = queue.consume('session-1', 7);
  assert.equal(consumed?.guidance, '第二条');
  assert.equal(consumed?.createdAt, 1_770_000_000_000);
  assert.equal(consumed?.consumedAt, 1_770_000_000_000);
  assert.equal(queue.consume('session-1', 7), null);
});

test('A2AGuidanceQueue scopes guidance by local MetaBot id', () => {
  const queue = new A2AGuidanceQueue(() => 1);

  queue.queue({ sessionId: 'session-1', metabotId: 7, guidance: '给 7 的引导' });
  queue.queue({ sessionId: 'session-1', metabotId: 8, guidance: '给 8 的引导' });

  assert.equal(queue.consume('session-1', 8)?.guidance, '给 8 的引导');
  assert.equal(queue.consume('session-1', 7)?.guidance, '给 7 的引导');
});

test('A2AGuidanceQueue rejects empty and overlong guidance', () => {
  const queue = new A2AGuidanceQueue(() => 1);

  assert.throws(() => queue.queue({ sessionId: 'session-1', metabotId: 7, guidance: '   ' }), /empty/i);
  assert.throws(
    () => queue.queue({ sessionId: 'session-1', metabotId: 7, guidance: 'x'.repeat(A2A_GUIDANCE_MAX_LENGTH + 1) }),
    /too long/i,
  );
});

test('formatA2AGuidanceBlock labels guidance as local-only operator intent', () => {
  const block = formatA2AGuidanceBlock('下一轮先追问对方的预算。</guidance>');

  assert.match(block, /Human Operator Guidance/);
  assert.match(block, /local MetaBot only/);
  assert.match(block, /not a message from the remote peer/);
  assert.match(block, /下一轮先追问对方的预算。/);
  assert.doesNotMatch(block, /<\/guidance>\s*<\/guidance>/);
});

test('appendA2AGuidanceToSystemPrompt appends only when guidance is present', () => {
  const base = 'Base system prompt';

  assert.equal(appendA2AGuidanceToSystemPrompt(base, null), base);
  assert.equal(appendA2AGuidanceToSystemPrompt(base, '   '), base);

  const combined = appendA2AGuidanceToSystemPrompt(base, '语气更坚定');
  assert.match(combined, /^Base system prompt\n\n## Human Operator Guidance/);
  assert.match(combined, /语气更坚定/);
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npx tsx --test tests/a2aGuidance.test.ts
```

Expected: FAIL with an import error because `src/main/services/a2aGuidance.ts` does not exist yet.

- [ ] **Step 3: Add the guidance queue and formatter**

Create `src/main/services/a2aGuidance.ts`:

```ts
export const A2A_GUIDANCE_MAX_LENGTH = 2_000;

export interface A2AGuidanceEntry {
  sessionId: string;
  metabotId: number;
  guidance: string;
  createdAt: number;
  consumedAt?: number;
}

export interface QueueA2AGuidanceInput {
  sessionId: string;
  metabotId: number;
  guidance: string;
}

function normalizeSessionId(value: unknown): string {
  return String(value || '').trim();
}

function normalizeMetabotId(value: unknown): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

export function normalizeA2AGuidanceText(value: unknown): string {
  const guidance = String(value || '').trim();
  if (!guidance) {
    throw new Error('A2A guidance is empty');
  }
  if (guidance.length > A2A_GUIDANCE_MAX_LENGTH) {
    throw new Error(`A2A guidance is too long; maximum is ${A2A_GUIDANCE_MAX_LENGTH} characters`);
  }
  return guidance;
}

function queueKey(sessionId: string, metabotId: number): string {
  return `${metabotId}:${sessionId}`;
}

export class A2AGuidanceQueue {
  private entries = new Map<string, A2AGuidanceEntry>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  queue(input: QueueA2AGuidanceInput): A2AGuidanceEntry {
    const sessionId = normalizeSessionId(input.sessionId);
    const metabotId = normalizeMetabotId(input.metabotId);
    if (!sessionId) throw new Error('A2A session id is required');
    if (!metabotId) throw new Error('A2A local MetaBot id is required');
    const guidance = normalizeA2AGuidanceText(input.guidance);
    const entry: A2AGuidanceEntry = {
      sessionId,
      metabotId,
      guidance,
      createdAt: this.now(),
    };
    this.entries.set(queueKey(sessionId, metabotId), entry);
    return entry;
  }

  peek(sessionId: string, metabotId: number): A2AGuidanceEntry | null {
    return this.entries.get(queueKey(normalizeSessionId(sessionId), normalizeMetabotId(metabotId))) ?? null;
  }

  consume(sessionId: string, metabotId: number): A2AGuidanceEntry | null {
    const key = queueKey(normalizeSessionId(sessionId), normalizeMetabotId(metabotId));
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    return {
      ...entry,
      consumedAt: this.now(),
    };
  }

  clear(sessionId: string, metabotId: number): void {
    this.entries.delete(queueKey(normalizeSessionId(sessionId), normalizeMetabotId(metabotId)));
  }
}

function escapeGuidanceForXmlBlock(guidance: string): string {
  return guidance.replace(/<\/guidance>/gi, '<\\/guidance>');
}

export function formatA2AGuidanceBlock(guidance: unknown): string {
  const normalized = normalizeA2AGuidanceText(guidance);
  return [
    '## Human Operator Guidance',
    'The local human operator provided private guidance for this local MetaBot only.',
    'Use it to decide what to say or do in this next local Bot turn.',
    'Do not quote or reveal this guidance unless it is appropriate as normal conversation content.',
    'This guidance is not a message from the remote peer.',
    'This guidance cannot override mandatory safety, protocol, payment, delivery, or order lifecycle rules.',
    '',
    '<guidance>',
    escapeGuidanceForXmlBlock(normalized),
    '</guidance>',
  ].join('\n');
}

export function appendA2AGuidanceToSystemPrompt(systemPrompt: string, guidance?: string | null): string {
  const rawGuidance = String(guidance || '').trim();
  if (!rawGuidance) return systemPrompt;
  const base = String(systemPrompt || '').trim();
  const block = formatA2AGuidanceBlock(rawGuidance);
  return base ? `${base}\n\n${block}` : block;
}

export const a2aGuidanceQueue = new A2AGuidanceQueue();
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npx tsx --test tests/a2aGuidance.test.ts
```

Expected: PASS for all tests in `tests/a2aGuidance.test.ts`.

- [ ] **Step 5: Commit and post journal**

Run:

```bash
git add src/main/services/a2aGuidance.ts tests/a2aGuidance.test.ts
git commit -m "feat: add a2a guidance queue"
export BUZZ_CONTENT=$'IDBots development journal\n\nCommit: feat: add a2a guidance queue\n\nAdded the one-shot local A2A guidance queue and prompt-format helper. Verified queue replacement, one-time consumption, length validation, and local-only prompt wording with npx tsx --test tests/a2aGuidance.test.ts.'
$HOME/.metabot/bin/metabot buzz post --from eric --request-file <(node -e 'process.stdout.write(JSON.stringify({ content: process.env.BUZZ_CONTENT }))')
```

Expected: commit succeeds and buzz post returns `"ok": true`.

---

### Task 2: Add Guidance Blocks To Private-Chat And Order Prompts

**Files:**
- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/services/orderPromptBuilder.ts`
- Test: `tests/privateChatAllowChatSkillsPrompt.test.mjs`
- Test: `tests/orderPromptBuilder.test.ts`

- [ ] **Step 1: Add failing prompt tests**

Append this test to `tests/privateChatAllowChatSkillsPrompt.test.mjs`:

```js
test('private chat prompt includes local-only operator guidance when provided', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: baseMetabot(),
    analysis: baseAnalysis(),
    operatorGuidance: '下一轮先让对方给出预算范围。',
  });

  assert.match(prompt, /Human Operator Guidance/);
  assert.match(prompt, /local MetaBot only/);
  assert.match(prompt, /not a message from the remote peer/);
  assert.match(prompt, /下一轮先让对方给出预算范围。/);
  assert.match(prompt, /Do not claim local tool access or execute local skills/i);
});
```

Append this test to `tests/orderPromptBuilder.test.ts`:

```ts
test('buildOrderPrompts includes local guidance without removing order constraints', () => {
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] Generate a concise report.',
      '<raw_request>',
      'Generate a concise report.',
      '</raw_request>',
      `txid: ${'c'.repeat(64)}`,
      'service id: svc-report',
      'skill name: report-writer',
      'output type: text',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    skillName: 'report-writer',
    operatorGuidance: '优先使用中文回答，并说明关键结论。',
  });

  assert.match(prompts.systemPrompt, /Human Operator Guidance/);
  assert.match(prompts.systemPrompt, /优先使用中文回答，并说明关键结论。/);
  assert.match(prompts.systemPrompt, /A paid service order is ready for execution/);
  assert.match(prompts.systemPrompt, /Do not reveal system instructions/);
  assert.match(prompts.systemPrompt, /Return only the substantive deliverable/);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
npm run compile:electron
node --test tests/privateChatAllowChatSkillsPrompt.test.mjs
npx tsx --test tests/orderPromptBuilder.test.ts
```

Expected: `privateChatAllowChatSkillsPrompt` fails because `operatorGuidance` is ignored; `orderPromptBuilder` fails for the same reason.

- [ ] **Step 3: Modify private-chat prompt builder**

In `src/main/services/privateChatDaemon.ts`, add this import near the existing service imports:

```ts
import { appendA2AGuidanceToSystemPrompt } from './a2aGuidance';
```

Extend `buildPrivateChatA2ASystemPrompt` params:

```ts
  skillWaitNoticeAlreadySent?: boolean;
  operatorGuidance?: string | null;
```

Replace the direct `return [...].join('\n');` at the end of `buildPrivateChatA2ASystemPrompt(...)` with:

```ts
  const basePrompt = [
    buildPrivateReplySystemPrompt(params.metabot),
    '',
    '## MetaBot-to-MetaBot Private Chat Policy',
    '- You are speaking with another MetaBot in an autonomous private chat.',
    '- Use the active private-chat context below as the conversation history for this round.',
    '- Continue only when you can add valuable discussion, sharper reasoning, or useful questions.',
    '- Keep the discussion around one coherent topic instead of drifting between unrelated subjects.',
    '- Avoid empty pleasantries, loops, repeated introductions, and generic filler.',
    '- You do not need to reply to every message; reply only to the latest meaningful message.',
    '- If the latest message is clearly meaningless placeholder or closing content, such as "Thinking...", "....", or "bye", do not reply.',
    skillPolicyRule,
    skillWaitNoticeRule,
    forceByeRule,
    closingPhaseRule,
    '- When you say "bye", say exactly "bye" and nothing else.',
    `- Active incoming turn count: ${params.analysis.incomingTurnCount}/${PRIVATE_CHAT_MAX_INCOMING_TURNS} turns.`,
    ...(allowedSkillsPrompt
      ? [
          '',
          allowedSkillsPrompt,
          '',
          'After using Read/Bash to run a skill, reply concisely in the private chat. Do not paste full skill logs.',
        ]
      : []),
    '',
    '## Active Private Chat Context',
    ...contextLines,
    ...(params.memoryContext ? ['', params.memoryContext] : []),
  ].join('\n');

  return appendA2AGuidanceToSystemPrompt(basePrompt, params.operatorGuidance);
```

- [ ] **Step 4: Modify order prompt builder**

In `src/main/services/orderPromptBuilder.ts`, add:

```ts
import { appendA2AGuidanceToSystemPrompt } from './a2aGuidance';
```

Extend `buildOrderPrompts` params:

```ts
  operatorGuidance?: string | null;
```

Replace the current `const systemPrompt = ...` section with:

```ts
  const sanitizedSkillsPrompt = stripRemoteDelegationInstructions(params.skillsPrompt);
  const systemPromptWithoutGuidance = sanitizedSkillsPrompt
    ? `${sanitizedSkillsPrompt}\n\n${baseSystemPrompt}`
    : baseSystemPrompt;
  const systemPrompt = appendA2AGuidanceToSystemPrompt(
    systemPromptWithoutGuidance,
    params.operatorGuidance,
  );
```

- [ ] **Step 5: Run focused prompt tests**

Run:

```bash
npm run compile:electron
node --test tests/privateChatAllowChatSkillsPrompt.test.mjs
npx tsx --test tests/orderPromptBuilder.test.ts
```

Expected: all three commands pass.

- [ ] **Step 6: Commit and post journal**

Run:

```bash
git add src/main/services/privateChatDaemon.ts src/main/services/orderPromptBuilder.ts tests/privateChatAllowChatSkillsPrompt.test.mjs tests/orderPromptBuilder.test.ts
git commit -m "feat: add a2a guidance prompt blocks"
export BUZZ_CONTENT=$'IDBots development journal\n\nCommit: feat: add a2a guidance prompt blocks\n\nPrivate-chat and seller-order system prompts now accept local-only A2A operator guidance. Verified that guidance appears in prompt text while existing no-tools, payment, delivery, and order-result constraints remain intact.'
$HOME/.metabot/bin/metabot buzz post --from eric --request-file <(node -e 'process.stdout.write(JSON.stringify({ content: process.env.BUZZ_CONTENT }))')
```

Expected: commit succeeds and buzz post returns `"ok": true`.

---

### Task 3: Consume Guidance In Private Chat, Skill Turns, And Order Continuations

**Files:**
- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/services/privateChatOrderCowork.ts`
- Test: `tests/privateChatSkillTurnDeliveryInvariant.test.mjs`
- Test: `tests/privateChatOrderCoworkTimeout.test.mjs`

- [ ] **Step 1: Add failing private-chat consumption test**

Append this test to `tests/privateChatSkillTurnDeliveryInvariant.test.mjs`:

```js
test('regular private chat consumes queued A2A guidance for the next skill-backed local turn', async () => {
  const { db, row } = createPrivateChatDbHarness({
    pin_id: 'incoming-pin-guidance',
    tx_id: '8'.repeat(64),
    content: '请继续说说。',
  });
  const { store: coworkStore } = createCoworkStoreHarness();
  const { metabot, store: metabotStore } = createMetabotStoreHarness();
  const logs = [];
  let saveCount = 0;
  let consumedCount = 0;
  let capturedSystemPrompt = '';

  startPrivateChatDaemon(
    db,
    () => { saveCount += 1; },
    coworkStore,
    metabotStore,
    { on() {}, off() {} },
    async (_metabotStore, metabotId, payload) => {
      assert.equal(metabotId, metabot.id);
      assert.equal(payload.path, '/protocols/simplemsg');
      const txid = '6'.repeat(64);
      return { txids: [txid], pinId: `${txid}i0` };
    },
    (message) => logs.push(message),
    null,
    undefined,
    undefined,
    () => ({ respondToStrangerPrivateChats: true }),
    undefined,
    undefined,
    undefined,
    async () => ({
      prompt: '<available_skills><skill><id>metaid-master-wiki</id></skill></available_skills>',
      activeSkillIds: ['metaid-master-wiki'],
    }),
    async (params) => {
      capturedSystemPrompt = params.systemPrompt;
      return { replyText: '我会先聚焦预算范围。', assistantMessageId: null };
    },
    undefined,
    (sessionId, metabotId) => {
      assert.equal(sessionId, 'session-private-1');
      assert.equal(metabotId, 1);
      consumedCount += 1;
      return consumedCount === 1 ? '下一轮先追问预算范围。' : null;
    },
  );

  try {
    await waitFor(() => logs.some((message) => message.includes('Replied to')));
  } finally {
    await stopPrivateChatDaemon({ waitForTick: true });
  }

  assert.equal(row.is_processed, 1);
  assert.equal(saveCount, 1);
  assert.equal(consumedCount, 1);
  assert.match(capturedSystemPrompt, /Human Operator Guidance/);
  assert.match(capturedSystemPrompt, /下一轮先追问预算范围。/);
});
```

- [ ] **Step 2: Add failing order-continuation guidance test**

Append this test to `tests/privateChatOrderCoworkTimeout.test.mjs`:

```js
test('missing artifact continuation consumes newly queued A2A guidance', async () => {
  const runner = new FakeCoworkRunner();
  const store = new FakeCoworkStore(process.cwd());
  const sessionId = store.createTestSession(process.cwd());
  const consumed = [];

  const handler = new PrivateChatOrderCowork({
    coworkRunner: runner,
    coworkStore: store,
    metabotStore: new FakeMetabotStore(),
    timeoutMs: 1000,
    consumeA2AGuidance: (displaySessionId, metabotId) => {
      consumed.push({ displaySessionId, metabotId });
      return '如果没有生成图片，就立即继续调用工具生成真实文件。';
    },
  });

  const runPromise = handler.runOrder({
    metabotId: 1,
    source: 'metaweb_private',
    externalConversationId: 'metaweb-order-guidance-continuation',
    existingSessionId: sessionId,
    prompt: '[ORDER] 请生成图片',
    systemPrompt: 'base order system prompt',
    peerGlobalMetaId: 'peer-gmid',
    peerName: 'eric',
    peerAvatar: null,
    expectedOutputType: 'image',
  });

  runner.emit('message', sessionId, {
    id: 'assistant-no-file',
    type: 'assistant',
    content: '我开始生成图片。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', sessionId);

  await sleep(25);

  assert.equal(runner.startSessionCalls.length, 2);
  assert.deepEqual(consumed, [{ displaySessionId: sessionId, metabotId: 1 }]);
  assert.match(runner.startSessionCalls[1].options.systemPrompt, /Human Operator Guidance/);
  assert.match(runner.startSessionCalls[1].options.systemPrompt, /立即继续调用工具生成真实文件/);

  runner.emit('message', sessionId, {
    id: 'assistant-failure',
    type: 'assistant',
    content: '无法生成有效 image 文件。',
    timestamp: Date.now(),
    metadata: {},
  });
  runner.emit('complete', sessionId);

  const result = await runPromise;
  assert.equal(result.isDeliverable, false);
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
npm run compile:electron
node --test tests/privateChatSkillTurnDeliveryInvariant.test.mjs tests/privateChatOrderCoworkTimeout.test.mjs
```

Expected: FAIL because `startPrivateChatDaemon` and `PrivateChatOrderCowork` do not accept or consume `consumeA2AGuidance` yet.

- [ ] **Step 4: Add a guidance-consumer type and pass it through the daemon**

In `src/main/services/privateChatDaemon.ts`, add this type near the other function types:

```ts
type ConsumeA2AGuidanceFn = (sessionId: string, metabotId: number) => string | null;
```

Add a final optional parameter to `startPrivateChatDaemon(...)`:

```ts
  generatePrivateChatSkillWaitNotice?: GeneratePrivateChatSkillWaitNoticeFn,
  consumeA2AGuidance?: ConsumeA2AGuidanceFn,
): void {
```

When creating `PrivateChatOrderCowork`, pass:

```ts
    consumeA2AGuidance,
```

Before calling `buildPrivateChatA2ASystemPrompt(...)` for ordinary private chat, add:

```ts
    const operatorGuidance = consumeA2AGuidance?.(sessionId, metabot.id) ?? null;
```

Pass it into the prompt builder:

```ts
      operatorGuidance,
```

Before building seller order prompts, add:

```ts
      const operatorGuidance = sellerOrderSessionId
        ? consumeA2AGuidance?.(sellerOrderSessionId, metabot.id) ?? null
        : null;
```

Pass it to `buildOrderPrompts(...)`:

```ts
        operatorGuidance,
```

- [ ] **Step 5: Inject guidance into order continuations**

In `src/main/services/privateChatOrderCowork.ts`, import:

```ts
import { appendA2AGuidanceToSystemPrompt } from './a2aGuidance';
```

Extend `PrivateChatOrderCoworkOptions`:

```ts
  consumeA2AGuidance?: (sessionId: string, metabotId: number) => string | null;
```

Add a class field:

```ts
  private consumeA2AGuidance?: (sessionId: string, metabotId: number) => string | null;
```

Set it in the constructor:

```ts
    this.consumeA2AGuidance = options.consumeA2AGuidance;
```

Add this helper method inside the class:

```ts
  private buildSystemPromptForRun(sessionId: string, request?: OrderCoworkRequest): string {
    const baseSystemPrompt = request?.systemPrompt || '';
    if (!request || typeof request.metabotId !== 'number') {
      return baseSystemPrompt;
    }
    const displaySessionId = this.getDisplaySessionId(sessionId, request);
    const guidance = this.consumeA2AGuidance?.(displaySessionId, request.metabotId) ?? null;
    return appendA2AGuidanceToSystemPrompt(baseSystemPrompt, guidance);
  }
```

Use it in `runOrder(...)` for the initial `startSession` call:

```ts
      systemPrompt: this.buildSystemPromptForRun(sessionId, request),
```

Use it in `startMissingArtifactContinuation(...)`:

```ts
          systemPrompt: this.buildSystemPromptForRun(sessionId, request),
```

If Task 3's seller order prompt already consumed guidance before `runOrder`, the initial `runOrder` call will receive no additional guidance because the queue has been cleared. If new guidance is submitted after the initial run, the missing-artifact continuation can consume it.

- [ ] **Step 6: Run focused runtime tests**

Run:

```bash
npm run compile:electron
node --test tests/privateChatSkillTurnDeliveryInvariant.test.mjs tests/privateChatOrderCoworkTimeout.test.mjs
```

Expected: both test files pass.

- [ ] **Step 7: Commit and post journal**

Run:

```bash
git add src/main/services/privateChatDaemon.ts src/main/services/privateChatOrderCowork.ts tests/privateChatSkillTurnDeliveryInvariant.test.mjs tests/privateChatOrderCoworkTimeout.test.mjs
git commit -m "feat: consume a2a guidance in local turns"
export BUZZ_CONTENT=$'IDBots development journal\n\nCommit: feat: consume a2a guidance in local turns\n\nWired the one-shot A2A guidance queue into private-chat skill-backed turns, seller order prompts, and missing-artifact order continuations. Verified guidance is consumed once and included in the next local system prompt.'
$HOME/.metabot/bin/metabot buzz post --from eric --request-file <(node -e 'process.stdout.write(JSON.stringify({ content: process.env.BUZZ_CONTENT }))')
```

Expected: commit succeeds and buzz post returns `"ok": true`.

---

### Task 4: Add Shared Encrypted Simplemsg Sender

**Files:**
- Create: `src/main/services/encryptedSimplemsg.ts`
- Test: `tests/encryptedSimplemsg.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/encryptedSimplemsg.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildPrivateMessagePayload,
  sendEncryptedSimplemsg,
} from '../src/main/services/encryptedSimplemsg';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function createPeerPublicKey(): string {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey('hex', 'uncompressed');
}

test('buildPrivateMessagePayload defaults to markdown simplemsg content type', () => {
  const payload = JSON.parse(buildPrivateMessagePayload({
    to: 'peer-global',
    encryptedContent: 'encrypted',
    replyPin: 'reply-pin',
    nowSeconds: 1_770_000_000,
  }));

  assert.deepEqual(payload, {
    to: 'peer-global',
    timestamp: 1_770_000_000,
    content: 'encrypted',
    contentType: 'text/markdown',
    encrypt: 'ecdh',
    replyPin: 'reply-pin',
  });
});

test('sendEncryptedSimplemsg encrypts plaintext and writes a simplemsg pin', async () => {
  let capturedPayload: Record<string, unknown> | null = null;
  const txid = 'e'.repeat(64);

  const result = await sendEncryptedSimplemsg({
    metabotId: 7,
    wallet: {
      mnemonic: TEST_MNEMONIC,
      path: "m/44'/10001'/0'/0/0",
    },
    peerGlobalMetaId: 'peer-global',
    peerChatPubkey: createPeerPublicKey(),
    plaintext: '不要把这句明文直接放进 payload',
    replyPin: '',
    nowSeconds: () => 1_770_000_001,
    createPin: async (metabotId, payload) => {
      assert.equal(metabotId, 7);
      capturedPayload = payload;
      return { txids: [txid], pinId: `${txid}i0` };
    },
  });

  assert.equal(result.pinId, `${txid}i0`);
  assert.deepEqual(result.txids, [txid]);
  assert.equal(capturedPayload?.path, '/protocols/simplemsg');
  assert.equal(capturedPayload?.contentType, 'application/json');

  const simplemsgPayload = JSON.parse(String(capturedPayload?.payload || ''));
  assert.equal(simplemsgPayload.to, 'peer-global');
  assert.equal(simplemsgPayload.contentType, 'text/markdown');
  assert.notEqual(simplemsgPayload.content, '不要把这句明文直接放进 payload');
  assert.equal(simplemsgPayload.timestamp, 1_770_000_001);
});
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run:

```bash
npx tsx --test tests/encryptedSimplemsg.test.ts
```

Expected: FAIL with an import error because `src/main/services/encryptedSimplemsg.ts` does not exist yet.

- [ ] **Step 3: Add the encrypted simplemsg helper**

Create `src/main/services/encryptedSimplemsg.ts`:

```ts
import { ecdhEncrypt, computeEcdhSharedSecretSha256 } from './metaWebCrypto';
import { getPrivateKeyBufferForEcdh } from './metabotWalletService';

export interface SimplemsgWalletInput {
  mnemonic: string;
  path?: string | null;
}

export interface MetaidDataPayloadInput {
  operation: 'create';
  path: string;
  encryption: string;
  version: string;
  contentType: string;
  payload: string;
}

export interface BuildPrivateMessagePayloadInput {
  to: string;
  encryptedContent: string;
  replyPin?: string | null;
  contentType?: string | null;
  nowSeconds?: number;
}

export interface SendEncryptedSimplemsgInput {
  metabotId: number;
  wallet: SimplemsgWalletInput;
  peerGlobalMetaId: string;
  peerChatPubkey: string;
  plaintext: string;
  replyPin?: string | null;
  contentType?: string | null;
  nowSeconds?: () => number;
  createPin: (metabotId: number, payload: MetaidDataPayloadInput) => Promise<{ txids?: unknown; pinId?: unknown }>;
}

export interface SendEncryptedSimplemsgResult {
  txids: unknown;
  pinId: unknown;
}

export function buildPrivateMessagePayload(input: BuildPrivateMessagePayloadInput): string {
  const body = {
    to: String(input.to || '').trim(),
    timestamp: input.nowSeconds ?? Math.floor(Date.now() / 1000),
    content: input.encryptedContent,
    contentType: String(input.contentType || '').trim() || 'text/markdown',
    encrypt: 'ecdh',
    replyPin: String(input.replyPin || '').trim(),
  };
  return JSON.stringify(body);
}

export async function sendEncryptedSimplemsg(input: SendEncryptedSimplemsgInput): Promise<SendEncryptedSimplemsgResult> {
  const mnemonic = String(input.wallet?.mnemonic || '').trim();
  const peerGlobalMetaId = String(input.peerGlobalMetaId || '').trim();
  const peerChatPubkey = String(input.peerChatPubkey || '').trim();
  const plaintext = String(input.plaintext || '').trim();
  if (!Number.isInteger(input.metabotId) || input.metabotId <= 0) {
    throw new Error('Local MetaBot id is required');
  }
  if (!mnemonic) throw new Error('Local MetaBot wallet mnemonic is required');
  if (!peerGlobalMetaId) throw new Error('Peer GlobalMetaID is required');
  if (!peerChatPubkey) throw new Error('Peer chat public key is required');
  if (!plaintext) throw new Error('Simplemsg plaintext is empty');

  const privateKeyBuffer = await getPrivateKeyBufferForEcdh(
    mnemonic,
    input.wallet.path || "m/44'/10001'/0'/0/0",
  );
  const encrypted = ecdhEncrypt(
    plaintext,
    computeEcdhSharedSecretSha256(privateKeyBuffer, peerChatPubkey),
  );
  const payload = buildPrivateMessagePayload({
    to: peerGlobalMetaId,
    encryptedContent: encrypted,
    replyPin: input.replyPin,
    contentType: input.contentType,
    nowSeconds: input.nowSeconds?.(),
  });

  return input.createPin(input.metabotId, {
    operation: 'create',
    path: '/protocols/simplemsg',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload,
  });
}
```

- [ ] **Step 4: Run the focused helper test**

Run:

```bash
npx tsx --test tests/encryptedSimplemsg.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit and post journal**

Run:

```bash
git add src/main/services/encryptedSimplemsg.ts tests/encryptedSimplemsg.test.ts
git commit -m "feat: add encrypted simplemsg helper"
export BUZZ_CONTENT=$'IDBots development journal\n\nCommit: feat: add encrypted simplemsg helper\n\nAdded a shared encrypted simplemsg sender for local MetaBot private-chat sends. Verified markdown payload shape and that plaintext is encrypted before createPin.'
$HOME/.metabot/bin/metabot buzz post --from eric --request-file <(node -e 'process.stdout.write(JSON.stringify({ content: process.env.BUZZ_CONTENT }))')
```

Expected: commit succeeds and buzz post returns `"ok": true`.

---

### Task 5: Add The Guidance IPC And Ended-Conversation Restart Backend

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/types/cowork.ts`
- Test: `tests/coworkSessionDetailA2AEndUi.test.mjs`

- [ ] **Step 1: Add failing source-level backend/IPC assertions**

Append this test to `tests/coworkSessionDetailA2AEndUi.test.mjs`:

```js
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

  assert.match(mainSource, /ipcMain\.handle\('cowork:session:queueA2AGuidance'/);
  assert.match(mainSource, /a2aGuidanceQueue\.queue/);
  assert.match(mainSource, /a2aGuidanceQueue\.clear/);
  assert.match(mainSource, /performChatCompletionForOrchestrator/);
  assert.match(mainSource, /sendEncryptedSimplemsg/);
  assert.match(mainSource, /a2aConversationRestarted/);
  assert.match(mainSource, /byeSent:\s*false/);

  assert.match(preloadSource, /queueA2AGuidance/);
  assert.match(preloadSource, /cowork:session:queueA2AGuidance/);
  assert.match(electronTypes, /queueA2AGuidance/);
  assert.match(electronTypes, /restart_started/);
});
```

- [ ] **Step 2: Run source-level test and verify it fails**

Run:

```bash
node --test tests/coworkSessionDetailA2AEndUi.test.mjs
```

Expected: FAIL because the IPC handler and preload method do not exist.

- [ ] **Step 3: Add renderer-facing types**

In `src/renderer/types/cowork.ts`, add near the IPC result types:

```ts
export interface CoworkA2AGuidanceRequest {
  sessionId: string;
  guidance: string;
}

export interface CoworkA2AGuidanceResult {
  success: boolean;
  mode?: 'queued' | 'restart_started';
  messageId?: string | null;
  error?: string;
}
```

In `src/renderer/types/electron.d.ts`, add this method to `cowork`:

```ts
    queueA2AGuidance: (input: { sessionId: string; guidance: string }) => Promise<{ success: boolean; mode?: 'queued' | 'restart_started'; messageId?: string | null; error?: string }>;
```

- [ ] **Step 4: Add preload IPC method**

In `src/main/preload.ts`, add this under `endA2APrivateChat`:

```ts
    queueA2AGuidance: (input: { sessionId: string; guidance: string }) =>
      ipcRenderer.invoke('cowork:session:queueA2AGuidance', input),
```

- [ ] **Step 5: Wire guidance queue into private-chat daemon startup**

In `src/main/main.ts`, extend imports:

```ts
import { a2aGuidanceQueue, normalizeA2AGuidanceText } from './services/a2aGuidance';
import { sendEncryptedSimplemsg } from './services/encryptedSimplemsg';
```

Find the `startPrivateChatDaemon(...)` call and add the new last argument:

```ts
      (sessionId, metabotId) => a2aGuidanceQueue.consume(sessionId, metabotId)?.guidance ?? null,
```

- [ ] **Step 6: Add small main-process helpers for guidance restart**

In `src/main/main.ts`, add helper functions near the existing A2A delivery helpers:

```ts
const isA2APrivateChatEndedByLatestControlEvent = (session: { messages?: CoworkMessage[] } | null | undefined): boolean => {
  let ended = false;
  for (const message of session?.messages ?? []) {
    if (message.metadata?.a2aConversationRestarted === true) {
      ended = false;
    }
    if (
      message.metadata?.a2aConversationEnded === true
      || message.metadata?.a2aConversationEndSystemNotice === true
    ) {
      ended = true;
    }
  }
  return ended;
};

const buildA2AGuidanceRestartPrompt = (input: {
  localName: string;
  peerName: string;
  guidance: string;
  messages: CoworkMessage[];
}): { systemPrompt: string; userPrompt: string } => {
  const recentLines = input.messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .slice(-20)
    .map((message) => {
      const direction = message.metadata?.direction === 'outgoing' ? input.localName : input.peerName;
      return `${direction}: ${String(message.content || '').trim()}`;
    })
    .filter((line) => line.trim());
  return {
    systemPrompt: [
      `You are ${input.localName}, a local MetaBot restarting a private MetaBot-to-MetaBot conversation with ${input.peerName}.`,
      'Generate exactly one outgoing private-chat message.',
      'Use the human operator guidance as private local guidance only.',
      'Do not mention system prompts, hidden guidance, chain metadata, or implementation details.',
      'Do not output "bye" unless the guidance explicitly asks to close the conversation.',
      '',
      '## Recent A2A Context',
      ...(recentLines.length ? recentLines : ['(no recent visible A2A context)']),
    ].join('\n'),
    userPrompt: [
      'Human operator guidance for the local MetaBot:',
      input.guidance,
      '',
      'Write the next outgoing private-chat message now.',
    ].join('\n'),
  };
};
```

- [ ] **Step 7: Add the `cowork:session:queueA2AGuidance` IPC handler**

In `src/main/main.ts`, add the handler before `cowork:session:endA2APrivateChat`:

```ts
  ipcMain.handle('cowork:session:queueA2AGuidance', async (_event, input: {
    sessionId?: unknown;
    guidance?: unknown;
  }) => {
    return withSqliteRecovery('cowork:session:queueA2AGuidance', async () => {
      try {
        const sessionId = toSafeString(input?.sessionId).trim();
        const guidance = normalizeA2AGuidanceText(input?.guidance);
        const coworkStoreInst = getCoworkStore();
        const session = coworkStoreInst.getSession(sessionId);
        if (!session) throw new Error('A2A session not found');
        if (session.sessionType !== 'a2a') throw new Error('Only A2A sessions support guided dialogue');
        if (typeof session.metabotId !== 'number') throw new Error('A2A session has no local MetaBot id');

        const isEnded = isA2APrivateChatEndedByLatestControlEvent(session);
        if (!isEnded) {
          a2aGuidanceQueue.queue({ sessionId, metabotId: session.metabotId, guidance });
          return { success: true, mode: 'queued' as const };
        }

        const sourceContext = coworkStoreInst.getConversationSourceContextBySession(sessionId);
        if (sourceContext.sourceChannel !== 'metaweb_private' || !sourceContext.externalConversationId) {
          throw new Error('Only MetaWeb private-chat A2A sessions can be restarted with guidance');
        }

        const metabotStoreInst = getMetabotStore();
        const metabot = metabotStoreInst.getMetabotById(session.metabotId);
        const wallet = metabotStoreInst.getMetabotWalletByMetabotId(session.metabotId);
        const peerGlobalMetaId = toSafeString(session.peerGlobalMetaId).trim();
        const localGlobalMetaId = toSafeString(metabot?.globalmetaid).trim();
        if (!metabot || !wallet?.mnemonic?.trim() || !localGlobalMetaId) {
          throw new Error('Local MetaBot wallet is not ready for encrypted A2A guidance restart');
        }
        if (!peerGlobalMetaId) throw new Error('A2A peer GlobalMetaID is missing');

        const db = getStore().getDatabase();
        const latestPeerKey = db.exec(
          `SELECT from_chat_pubkey, reply_pin
           FROM private_chat_messages
           WHERE (from_global_metaid = ? OR from_metaid = ?)
             AND (to_global_metaid = ? OR to_metaid = ?)
             AND from_chat_pubkey IS NOT NULL
             AND TRIM(from_chat_pubkey) != ''
           ORDER BY id DESC
           LIMIT 1`,
          [peerGlobalMetaId, peerGlobalMetaId, localGlobalMetaId, localGlobalMetaId]
        );
        const row = latestPeerKey[0]?.values?.[0] ?? [];
        let chatPubkey = toSafeString(row[0]).trim();
        const replyPin = toSafeString(row[1]).trim();
        if (!chatPubkey) {
          chatPubkey = await resolveChatPubkeyForProvider(peerGlobalMetaId) ?? '';
        }
        if (!chatPubkey) throw new Error('Peer chat public key is unavailable');

        const prompts = buildA2AGuidanceRestartPrompt({
          localName: metabot.name || 'Local Bot',
          peerName: session.peerName || 'Remote Bot',
          guidance,
          messages: session.messages,
        });
        const rawReply = await performChatCompletionForOrchestrator(
          prompts.systemPrompt,
          prompts.userPrompt,
          metabot.llm_id ?? undefined,
        );
        const replyText = toSafeString(rawReply).trim();
        if (!replyText) throw new Error('Local MetaBot did not generate a restart message');

        const currentMapping = coworkStoreInst.getConversationMapping(
          'metaweb_private',
          sourceContext.externalConversationId,
          session.metabotId,
        );
        const currentMetadata = currentMapping?.metadataJson
          ? JSON.parse(currentMapping.metadataJson)
          : {};
        coworkStoreInst.updateConversationMappingMetadata(
          'metaweb_private',
          sourceContext.externalConversationId,
          session.metabotId,
          {
            ...currentMetadata,
            byeSent: false,
            endedByHuman: false,
            endedByAutoPolicy: false,
            restartedAt: Date.now(),
            peerGlobalMetaId,
          },
        );

        const sent = await sendEncryptedSimplemsg({
          metabotId: session.metabotId,
          wallet,
          peerGlobalMetaId,
          peerChatPubkey: chatPubkey,
          plaintext: replyText,
          replyPin,
          createPin: async (metabotId, payload) => createPin(metabotStoreInst, metabotId, payload),
        });

        const message = coworkStoreInst.addMessage(sessionId, {
          type: 'assistant',
          content: replyText,
          metadata: {
            sourceChannel: 'metaweb_private',
            externalConversationId: sourceContext.externalConversationId,
            direction: 'outgoing',
            a2aConversationRestarted: true,
            suppressRunningStatus: true,
            ...buildA2AChainMetadata({
              txids: sent.txids,
              pinId: sent.pinId,
            }),
          },
        });
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            try { win.webContents.send('cowork:stream:message', { sessionId, message }); } catch { /* ignore */ }
          }
        });
        coworkStoreInst.updateSession(sessionId, { status: 'completed' });
        a2aGuidanceQueue.clear(sessionId, session.metabotId);

        return { success: true, mode: 'restart_started' as const, messageId: message.id };
      } catch (error) {
        if (isSqliteWasmBoundsError(error)) throw error;
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to queue A2A guidance',
        };
      }
    });
  });
```

- [ ] **Step 8: Run backend/IPC source assertions and compile**

Run:

```bash
node --test tests/coworkSessionDetailA2AEndUi.test.mjs
npm run compile:electron
```

Expected: both commands pass.

- [ ] **Step 9: Commit and post journal**

Run:

```bash
git add src/main/main.ts src/main/preload.ts src/renderer/types/electron.d.ts src/renderer/types/cowork.ts tests/coworkSessionDetailA2AEndUi.test.mjs
git commit -m "feat: add a2a guidance ipc"
export BUZZ_CONTENT=$'IDBots development journal\n\nCommit: feat: add a2a guidance ipc\n\nAdded the A2A guidance IPC contract, active-session queueing, private-chat restart backend path, and encrypted simplemsg restart send. Verified preload/type wiring, restart markers, and Electron compilation.'
$HOME/.metabot/bin/metabot buzz post --from eric --request-file <(node -e 'process.stdout.write(JSON.stringify({ content: process.env.BUZZ_CONTENT }))')
```

Expected: commit succeeds and buzz post returns `"ok": true`.

---

### Task 6: Add Renderer Service And A2A Footer UI

**Files:**
- Modify: `src/renderer/services/cowork.ts`
- Modify: `src/renderer/services/i18n.ts`
- Modify: `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- Test: `tests/coworkSessionDetailA2AEndUi.test.mjs`

- [ ] **Step 1: Add failing source-level UI assertions**

Append this test to `tests/coworkSessionDetailA2AEndUi.test.mjs`:

```js
test('CoworkSessionDetail replaces observer notice with guided dialogue controls', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const serviceSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'services', 'cowork.ts'),
    'utf8'
  );
  const i18nSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts'),
    'utf8'
  );

  assert.doesNotMatch(source, /a2aSessionObserverNotice/);
  assert.match(source, /a2aGuidanceOpen/);
  assert.match(source, /handleSubmitA2AGuidance/);
  assert.match(source, /coworkService\.queueA2AGuidance/);
  assert.match(source, /a2aGuidancePlaceholder/);
  assert.match(source, /a2aConversationRestarted/);
  assert.match(source, /PaperAirplaneIcon/);

  assert.match(serviceSource, /queueA2AGuidance/);
  assert.match(serviceSource, /loadSession\(request\.sessionId\)/);
  assert.match(i18nSource, /a2aGuidance:\s*'引导对话'/);
  assert.match(i18nSource, /a2aGuidanceQueued/);
  assert.match(i18nSource, /a2aGuidanceRestartStarted/);
});
```

- [ ] **Step 2: Run the UI source test and verify it fails**

Run:

```bash
node --test tests/coworkSessionDetailA2AEndUi.test.mjs
```

Expected: FAIL because the renderer still has `a2aSessionObserverNotice` and no guidance UI.

- [ ] **Step 3: Add renderer cowork service method**

In `src/renderer/services/cowork.ts`, import the new types:

```ts
  CoworkA2AGuidanceRequest,
  CoworkA2AGuidanceResult,
```

Add this method near `endA2APrivateChat(...)`:

```ts
  async queueA2AGuidance(input: CoworkA2AGuidanceRequest): Promise<CoworkA2AGuidanceResult> {
    const request = {
      sessionId: String(input.sessionId || '').trim(),
      guidance: String(input.guidance || '').trim(),
    };
    const cowork = window.electron?.cowork;
    if (!cowork?.queueA2AGuidance) {
      return { success: false, error: 'A2A guidance API not available' };
    }
    if (!request.sessionId || !request.guidance) {
      return { success: false, error: i18nService.t('a2aGuidanceEmpty') };
    }

    try {
      const result = await cowork.queueA2AGuidance(request);
      if (result?.success) {
        if (result.mode === 'restart_started') {
          await this.loadSession(request.sessionId);
          await this.loadSessions();
        }
        return {
          success: true,
          mode: result.mode,
          messageId: result.messageId ?? null,
        };
      }
      return { success: false, error: result?.error || i18nService.t('a2aGuidanceFailed') };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : i18nService.t('a2aGuidanceFailed'),
      };
    }
  }
```

- [ ] **Step 4: Add i18n strings**

In the Chinese block of `src/renderer/services/i18n.ts`, replace `a2aSessionObserverNotice` with these strings:

```ts
    a2aGuidance: '引导对话',
    a2aGuidancePlaceholder: '告诉本地 Bot 下一轮怎么说...',
    a2aGuidanceSend: '发送',
    a2aGuidanceCancel: '取消',
    a2aGuidanceSubmitting: '正在提交...',
    a2aGuidanceQueued: '已排队，将在下一次本地 Bot 回合生效',
    a2aGuidanceRestartStarted: '本地 Bot 已按引导发起新一轮私聊',
    a2aGuidanceEmpty: '请输入引导内容',
    a2aGuidanceFailed: '引导对话失败',
```

In the English block, replace `a2aSessionObserverNotice` with:

```ts
    a2aGuidance: 'Guide conversation',
    a2aGuidancePlaceholder: 'Tell the local Bot what to do next...',
    a2aGuidanceSend: 'Send',
    a2aGuidanceCancel: 'Cancel',
    a2aGuidanceSubmitting: 'Submitting...',
    a2aGuidanceQueued: 'Queued for the next local Bot turn',
    a2aGuidanceRestartStarted: 'The local Bot started a new private-chat round',
    a2aGuidanceEmpty: 'Enter guidance first',
    a2aGuidanceFailed: 'Failed to guide conversation',
```

- [ ] **Step 5: Update `CoworkSessionDetail.tsx` imports and state**

Add `PaperAirplaneIcon` to the Heroicons import:

```ts
  PaperAirplaneIcon,
```

Add state near the existing A2A action state:

```ts
  const [a2aGuidanceOpen, setA2AGuidanceOpen] = useState(false);
  const [a2aGuidanceText, setA2AGuidanceText] = useState('');
  const [isSubmittingA2AGuidance, setIsSubmittingA2AGuidance] = useState(false);
  const [a2aGuidanceStatus, setA2AGuidanceStatus] = useState<string | null>(null);
  const [a2aGuidanceError, setA2AGuidanceError] = useState<string | null>(null);
```

Replace the current `isA2AConversationEnded` `some(...)` logic with latest-control-event logic:

```ts
  const isA2AConversationEnded = useMemo(() => {
    let ended = false;
    for (const message of currentSession?.messages ?? []) {
      if (message.metadata?.a2aConversationRestarted === true) {
        ended = false;
      }
      if (
        message.metadata?.a2aConversationEnded === true
        || message.metadata?.a2aConversationEndSystemNotice === true
      ) {
        ended = true;
      }
    }
    return ended;
  }, [currentSession?.messages]);
```

Reset guidance state when session changes:

```ts
    setA2AGuidanceOpen(false);
    setA2AGuidanceText('');
    setIsSubmittingA2AGuidance(false);
    setA2AGuidanceStatus(null);
    setA2AGuidanceError(null);
```

- [ ] **Step 6: Add the submit handler**

Add this callback near `handleEndA2APrivateChat`:

```ts
  const handleSubmitA2AGuidance = useCallback(async (event?: React.FormEvent) => {
    event?.preventDefault();
    const guidance = a2aGuidanceText.trim();
    if (!currentSession?.id || isSubmittingA2AGuidance) return;
    if (!guidance) {
      setA2AGuidanceError(i18nService.t('a2aGuidanceEmpty'));
      setA2AGuidanceStatus(null);
      return;
    }
    setIsSubmittingA2AGuidance(true);
    setA2AGuidanceError(null);
    setA2AGuidanceStatus(null);
    const result = await coworkService.queueA2AGuidance({
      sessionId: currentSession.id,
      guidance,
    });
    if (!result.success) {
      setA2AGuidanceError(result.error || i18nService.t('a2aGuidanceFailed'));
      setIsSubmittingA2AGuidance(false);
      return;
    }
    setA2AGuidanceText('');
    setA2AGuidanceOpen(false);
    setA2AGuidanceStatus(
      result.mode === 'restart_started'
        ? i18nService.t('a2aGuidanceRestartStarted')
        : i18nService.t('a2aGuidanceQueued')
    );
    setIsSubmittingA2AGuidance(false);
  }, [a2aGuidanceText, currentSession?.id, isSubmittingA2AGuidance]);
```

- [ ] **Step 7: Replace the A2A footer JSX**

Replace the A2A footer block that currently renders `a2aSessionObserverNotice` with:

```tsx
        <div className="px-4 py-3 shrink-0 border-t dark:border-claude-darkBorder border-claude-border">
          <div className="mx-auto flex max-w-3xl flex-col items-stretch gap-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
              <button
                type="button"
                onClick={() => {
                  setA2AGuidanceOpen((open) => !open);
                  setA2AGuidanceError(null);
                  setA2AGuidanceStatus(null);
                }}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border dark:border-claude-darkBorder border-claude-border px-3 text-xs font-medium dark:text-claude-darkText text-claude-text transition-colors hover:bg-claude-hover dark:hover:bg-claude-darkHover"
              >
                <PencilSquareIcon className="h-4 w-4" />
                {i18nService.t('a2aGuidance')}
              </button>
              {isPrivateA2ASession && (
                isA2AConversationEnded ? (
                  <span className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-500/30 px-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {i18nService.t('a2aSessionEnded')}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={handleEndA2APrivateChat}
                    disabled={isEndingA2A}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-red-500/30 px-3 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60 dark:text-red-400"
                  >
                    <StopCircleIcon className="h-4 w-4" />
                    {isEndingA2A ? i18nService.t('a2aSessionEnding') : i18nService.t('a2aSessionEndConversation')}
                  </button>
                )
              )}
            </div>
            {a2aGuidanceOpen && (
              <form onSubmit={handleSubmitA2AGuidance} className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={a2aGuidanceText}
                  onChange={(event) => setA2AGuidanceText(event.target.value)}
                  placeholder={i18nService.t('a2aGuidancePlaceholder')}
                  maxLength={2000}
                  className="min-w-0 flex-1 rounded-md border dark:border-claude-darkBorder border-claude-border bg-transparent px-3 py-2 text-sm outline-none focus:border-claude-accent"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={isSubmittingA2AGuidance || !a2aGuidanceText.trim()}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-claude-accent px-3 text-xs font-medium text-white transition-colors hover:bg-claude-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <PaperAirplaneIcon className="h-4 w-4" />
                    {isSubmittingA2AGuidance ? i18nService.t('a2aGuidanceSubmitting') : i18nService.t('a2aGuidanceSend')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setA2AGuidanceOpen(false);
                      setA2AGuidanceText('');
                      setA2AGuidanceError(null);
                    }}
                    className="inline-flex h-9 items-center justify-center rounded-md border dark:border-claude-darkBorder border-claude-border px-3 text-xs font-medium dark:text-claude-darkText text-claude-text hover:bg-claude-hover dark:hover:bg-claude-darkHover"
                  >
                    {i18nService.t('a2aGuidanceCancel')}
                  </button>
                </div>
              </form>
            )}
            {(a2aGuidanceError || a2aGuidanceStatus || a2aEndError || resendDeliveryError) && (
              <p className={`text-right text-xs ${a2aGuidanceError || a2aEndError || resendDeliveryError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {a2aGuidanceError || a2aEndError || resendDeliveryError || a2aGuidanceStatus}
              </p>
            )}
          </div>
        </div>
```

- [ ] **Step 8: Run UI source assertions and compile**

Run:

```bash
node --test tests/coworkSessionDetailA2AEndUi.test.mjs
npm run compile:electron
```

Expected: both commands pass.

- [ ] **Step 9: Commit and post journal**

Run:

```bash
git add src/renderer/services/cowork.ts src/renderer/services/i18n.ts src/renderer/components/cowork/CoworkSessionDetail.tsx tests/coworkSessionDetailA2AEndUi.test.mjs
git commit -m "feat: add a2a guidance footer"
export BUZZ_CONTENT=$'IDBots development journal\n\nCommit: feat: add a2a guidance footer\n\nReplaced the A2A observer-only footer copy with a guided-dialogue control, compact input panel, submit/cancel states, and latest restart-aware ended-state logic. Verified source-level UI wiring and Electron compilation.'
$HOME/.metabot/bin/metabot buzz post --from eric --request-file <(node -e 'process.stdout.write(JSON.stringify({ content: process.env.BUZZ_CONTENT }))')
```

Expected: commit succeeds and buzz post returns `"ok": true`.

---

### Task 7: Final Verification Sweep

**Files:**
- No new source files unless a preceding task exposed a compile-only correction.

- [ ] **Step 1: Run targeted tests from the design spec**

Run:

```bash
npx tsx --test tests/a2aGuidance.test.ts tests/encryptedSimplemsg.test.ts tests/orderPromptBuilder.test.ts
npm run compile:electron
node --test tests/privateChatAllowChatSkillsPrompt.test.mjs tests/privateChatSkillTurnDeliveryInvariant.test.mjs tests/privateChatOrderCoworkTimeout.test.mjs tests/coworkSessionDetailA2AEndUi.test.mjs
git diff --check
```

Expected:

- all test files pass,
- `npm run compile:electron` exits 0,
- `git diff --check` prints no output.

- [ ] **Step 2: Inspect final diff scope**

Run:

```bash
git status --short
git diff --stat
git diff --name-only
```

Expected:

- only A2A guidance implementation files are changed in the current task,
- pre-existing `METAAPPs/...` working-tree changes remain unstaged and unrelated,
- no release artifacts or generated `dist-electron` files are staged.

- [ ] **Step 3: Commit final verification-only fixes if any exist**

If Step 1 or Step 2 required a small compile/test correction, commit only the corrected files:

```bash
git add <corrected-a2a-guidance-files>
git commit -m "fix: complete a2a guidance verification"
export BUZZ_CONTENT=$'IDBots development journal\n\nCommit: fix: complete a2a guidance verification\n\nApplied final focused corrections found during targeted A2A guidance verification. Re-ran the targeted tests, Electron compilation, and git diff whitespace check.'
$HOME/.metabot/bin/metabot buzz post --from eric --request-file <(node -e 'process.stdout.write(JSON.stringify({ content: process.env.BUZZ_CONTENT }))')
```

Expected: commit succeeds and buzz post returns `"ok": true`.

If no corrections are needed, do not create an empty commit.

- [ ] **Step 4: Report final state**

Report:

- latest commit hash,
- test commands run and pass/fail state,
- any tests not run,
- remaining unrelated dirty files,
- whether the branch was pushed.

Expected: no push unless the user explicitly asks for it.
