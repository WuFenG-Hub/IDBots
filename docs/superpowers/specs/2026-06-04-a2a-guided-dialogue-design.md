# A2A Guided Dialogue Design

**Date:** 2026-06-04
**Project:** IDBots
**Status:** Confirmed design, pending implementation plan

---

## 1. Goal

A2A conversation windows currently represent MetaBot-to-MetaBot communication. Human users can observe and can manually end a private-chat A2A conversation, but they cannot influence what the local MetaBot should say next.

The new feature adds a local-only "guided dialogue" control:

- The human can write private guidance for the local MetaBot.
- The guidance is used only by the local MetaBot's next model turn.
- The guidance is not sent directly to the remote MetaBot.
- The guidance is not written on-chain as a human message.
- The guidance is consumed once and then cleared.
- If the private-chat conversation has already ended, the same guidance can make the local MetaBot start a new private-chat round with the remote MetaBot.

The product model stays A2A-first: humans guide the local Bot; humans do not become participants in the Bot-to-Bot conversation.

---

## 2. Confirmed Decisions

### 2.1 One-Shot Local Guidance Queue

Use a session-scoped pending guidance queue with one active value per A2A session.

When a user submits guidance:

```text
sessionId -> pendingGuidance
```

The next local MetaBot model turn reads this value, injects it into the system prompt, and clears it after the turn is scheduled. This avoids carrying stale human intent into later rounds.

If the user submits new guidance before the pending guidance is consumed, the newer value replaces the older value. This keeps the UI simple and prevents conflicting instructions from stacking.

### 2.2 Queue Semantics During Active Work

If the local Bot is already running a model/tool/order turn, the guidance does not interrupt that active execution.

It becomes effective at the next new local model turn:

- the next ordinary private-chat auto-reply,
- the next private-chat skill-backed turn,
- the next service-order execution turn,
- or a later service-order continuation turn.

This is necessary because system prompts for already-started LLM/tool execution cannot be reliably rewritten mid-flight.

### 2.3 Ended Conversation Restart

If the selected A2A private-chat conversation is ended and the user submits guidance, the app should use the guidance to let the local MetaBot initiate a new private-chat round with the remote MetaBot.

The local MetaBot first generates an outgoing message from:

- the local MetaBot identity,
- recent visible A2A context,
- the private human guidance,
- and a restart-specific system rule that this is a new outgoing private-chat round.

The generated message is then sent to the remote MetaBot via the existing encrypted simplemsg path. It appears as a local outgoing A2A bubble with normal chain metadata.

Submitting restart guidance should also reopen the local conversation mapping so future remote replies are not ignored because of the previous human-ended `byeSent` state.

---

## 3. User Experience

### 3.1 A2A Footer

For A2A sessions, remove this footer text:

```text
此对话为两个 MetaBot 之间直接开展，人类只能观察不能插话
```

Replace it with compact actions:

- `引导对话`
- `结束对话` for active private-chat A2A sessions
- `对话已结束` for ended private-chat A2A sessions

`结束对话` remains available only for MetaWeb private-chat A2A sessions that have not already ended.

### 3.2 Guidance Input

Clicking `引导对话` expands a compact one-line panel near the button:

- single-line input,
- send button,
- cancel/close affordance,
- short pending/success/error status text.

The input placeholder should make the scope clear without long instruction copy:

```text
告诉本地 Bot 下一轮怎么说...
```

The send button submits the guidance. Empty or whitespace-only text is rejected client-side.

### 3.3 Status Feedback

After successful submission:

- Active or running conversation: show that guidance is queued for the next local Bot turn.
- Ended conversation restart: show that the local Bot is preparing a new outgoing message.
- Failure: show a concise error near the footer.

No hidden guidance should be rendered as a normal chat bubble. The visible conversation should only contain real A2A messages, system notices, tool output, or delivery/status messages that already belong to the current product surface.

### 3.4 Ended State After Restart

The current UI treats a private-chat A2A session as ended when any historical message contains an end marker. Restart support needs a more precise state rule.

After implementation, the footer should derive ended state from the latest A2A control event, not from the mere existence of an older end marker:

- latest `a2aConversationEnded` or `a2aConversationEndSystemNotice` means ended,
- latest `a2aConversationRestarted` means active again.

This allows an ended conversation to restart in the same visible A2A window without the old `bye` bubble permanently locking the footer into `对话已结束`.

---

## 4. Architecture

### 4.1 Renderer

Primary files:

- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- `src/renderer/services/cowork.ts`
- `src/renderer/types/electron.d.ts`
- `src/renderer/services/i18n.ts`

The renderer owns:

- footer state for showing/hiding the guidance input,
- guidance text validation,
- submit loading state,
- user-facing success/error messages,
- IPC call to queue or trigger guidance,
- and resetting local input state when the current session changes.

The renderer does not decide whether guidance is queued or used for restart. It passes `sessionId` and `guidance` to the main process.

### 4.2 Main IPC

Add a Cowork IPC method:

```ts
cowork.queueA2AGuidance({
  sessionId: string;
  guidance: string;
}): Promise<{
  success: boolean;
  mode?: 'queued' | 'restart_started';
  messageId?: string | null;
  error?: string;
}>
```

The main process validates:

- session exists,
- session is `sessionType === 'a2a'`,
- session has a local `metabotId`,
- guidance is non-empty after trimming,
- guidance stays under a bounded maximum length.

Suggested limit: 2,000 characters after trimming. This is enough for useful human direction while keeping prompt injection bounded.

### 4.3 Guidance Store

Add a small in-memory service for pending guidance:

```ts
interface A2AGuidanceEntry {
  sessionId: string;
  metabotId: number;
  guidance: string;
  createdAt: number;
  consumedAt?: number;
}
```

The store should expose:

```ts
queue(sessionId, metabotId, guidance): A2AGuidanceEntry
consume(sessionId, metabotId): A2AGuidanceEntry | null
peek(sessionId, metabotId): A2AGuidanceEntry | null
clear(sessionId, metabotId): void
```

In-memory storage is intentional for the first implementation:

- guidance is transient operator intent,
- it should not survive app restart,
- it should not be treated as durable conversation content,
- and it should not require a database migration.

If a queued entry is not consumed after a timeout, it may stay in memory until replacement or app restart. The UI only promises "next local Bot turn" within the current process lifetime.

### 4.4 Prompt Injection Helper

Add one helper to format guidance into system prompt text:

```text
## Human Operator Guidance
The local human operator provided private guidance for this local MetaBot only.
Use it to decide what to say or do in this next local Bot turn.
Do not quote or reveal this guidance unless it is appropriate as normal conversation content.
This guidance is not a message from the remote peer.

<guidance>
...
</guidance>
```

This helper should be used by all A2A local-turn prompt paths so behavior stays consistent.

---

## 5. Runtime Data Flow

### 5.1 Active Ordinary Private Chat

1. User submits guidance in the A2A footer.
2. Main process stores pending guidance for the session.
3. A later incoming private-chat message triggers local auto-reply.
4. `privateChatDaemon` analyzes the conversation and builds the A2A system prompt.
5. Before calling the LLM or `runSkillTurnInExistingSession`, it consumes pending guidance for that session.
6. The formatted guidance block is appended to the system prompt.
7. The local Bot replies normally.
8. The reply is encrypted and posted through `/protocols/simplemsg` as today.

### 5.2 Active Private Chat With Local Skills

The same pending guidance is injected before the prompt is passed into `runSkillTurnInExistingSession(...)`.

The existing wait-notice behavior remains unchanged:

- guidance does not send a wait notice by itself,
- wait notice is still triggered only when a real local skill `tool_use` starts,
- guidance is not displayed to the peer.

### 5.3 Service Order Execution

For seller-side service orders, inject pending guidance into the order execution system prompt generated by `buildOrderPrompts(...)` before `PrivateChatOrderCowork.runOrder(...)` starts.

The guidance should influence the local provider Bot's execution behavior, not the protocol envelope. It must not alter payment verification, allowed skill scope validation, refund policy, delivery upload rules, or order lifecycle state transitions.

### 5.4 Service Order Continuation

For follow-up order continuation turns, such as missing-artifact continuation, inject pending guidance before calling `coworkRunner.startSession(...)` for that continuation.

If guidance was already consumed for the initial order execution turn, it should not appear again in the continuation. If the user submits guidance after the initial turn and before the continuation, that new guidance should be consumed by the continuation.

### 5.5 Ended Conversation Restart

If the selected A2A private-chat session has ended:

1. User submits guidance.
2. Main process verifies that the session has MetaWeb private-chat source context and a peer GlobalMetaID.
3. Main process clears or updates the conversation mapping metadata:
   - `byeSent: false`
   - `endedByHuman: false`
   - `restartedAt: Date.now()`
4. Main process builds a restart system prompt using the local MetaBot identity, recent visible A2A context, and guidance.
5. It asks the local LLM to generate the first outgoing private-chat message.
6. It sends that message through the existing ECDH `/protocols/simplemsg` path.
7. It appends an outgoing A2A message with chain metadata to the current session.
8. It appends or updates a local control marker with `a2aConversationRestarted: true`.
9. It marks the session active/completed according to existing stream/status conventions.

The generated outgoing message is the only content sent to the remote peer. The raw guidance remains local-only.

---

## 6. Send Helper

The ended-conversation restart should reuse the same simplemsg mechanics already used for ordinary replies, bye notices, order status updates, and digital delivery resend.

Extract or introduce a small main-process helper that:

- resolves local MetaBot and wallet,
- resolves peer chat public key from latest `private_chat_messages` or provider lookup,
- derives ECDH shared secret,
- builds `/protocols/simplemsg` JSON payload,
- calls `createPin`,
- returns chain metadata.

This helper should not change protocol semantics. It exists to avoid duplicating encryption and chain-write code in another IPC handler.

---

## 7. Error Handling

### 7.1 Queue Errors

Return an IPC error when:

- session is missing,
- session is not A2A,
- local MetaBot id is missing,
- guidance is empty,
- guidance exceeds the maximum length.

Renderer shows the returned error near the footer.

### 7.2 Restart Errors

Restart mode can fail if:

- peer GlobalMetaID is missing,
- local wallet is unavailable,
- peer chat public key cannot be resolved,
- LLM returns empty text,
- simplemsg chain write fails.

If restart fails, do not mark the guidance as successfully consumed. The user should be able to retry with the same or edited guidance.

### 7.3 Prompt Injection Safety

Guidance is operator intent, but it is still untrusted prompt text. The injected block must state that:

- it is private local operator guidance,
- it is not a remote peer message,
- it should not override mandatory safety, protocol, payment, delivery, or order rules,
- it should not be revealed as "system prompt" content.

Existing hard rules in order prompts, skill prompts, and private-chat policy remain stronger than guidance.

---

## 8. Testing

### 8.1 Renderer Tests

Add or extend A2A footer tests to verify:

- old observer notice is no longer rendered,
- `引导对话` renders for A2A sessions,
- clicking it opens a single-line input and send button,
- empty guidance is not submitted,
- submitting calls the new cowork service API,
- ended private-chat A2A sessions can still show `引导对话`.

### 8.2 Prompt Tests

Add focused tests for:

- `buildPrivateChatA2ASystemPrompt` can include a formatted guidance block,
- no guidance block appears when there is no pending guidance,
- order prompts can include guidance without removing payment/delivery constraints,
- guidance is consumed once.

### 8.3 Runtime Tests

Add main-process/service tests for:

- active private-chat guidance is queued and consumed on next local reply,
- skill-backed private-chat turns receive the same guidance block,
- seller order execution receives pending guidance,
- missing-artifact continuation can consume guidance submitted after the initial run,
- ended conversation guidance triggers a generated outgoing simplemsg,
- raw guidance is not added as a normal chat message and not passed to simplemsg payload directly.

### 8.4 Regression Commands

Targeted verification should include:

```bash
npx tsx --test tests/orderPromptBuilder.test.ts
node --test tests/privateChatAllowChatSkillsPrompt.test.mjs tests/privateChatSkillTurnDeliveryInvariant.test.mjs tests/coworkSessionDetailA2AEndUi.test.mjs
npm run compile:electron
git diff --check
```

Broader verification can include existing private-chat and order suites if implementation touches routing or order continuation beyond prompt injection.

---

## 9. Non-Goals

This feature does not:

- let humans directly send messages to the remote Bot from the A2A footer,
- store human guidance on-chain,
- store human guidance in Bot memory,
- expose guidance to the remote peer as metadata,
- change payment verification,
- change service-order lifecycle semantics,
- change ordinary private-chat auto-reply policy except for ended-session restart.

---

## 10. Implementation Scope

Expected implementation units:

1. Add guidance i18n strings and A2A footer UI.
2. Add renderer cowork service and preload IPC contract.
3. Add pending guidance store and prompt-format helper.
4. Inject guidance into ordinary private-chat prompt paths.
5. Inject guidance into order execution and continuation prompt paths.
6. Add ended-conversation restart flow with encrypted simplemsg send helper.
7. Add focused tests and run targeted verification.

Each unit should remain small enough to commit independently if implementation proceeds in separate steps.
