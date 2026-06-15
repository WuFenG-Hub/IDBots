# Cross-Session Supervision Design

**Date:** 2026-06-15
**Project:** IDBots
**Status:** Confirmed design, pending user review

---

## 1. Goal

Add a local cross-session supervision capability for Cowork and A2A sessions.

The feature lets one Cowork session observe another local Cowork or A2A session by session ID, and lets one Cowork session insert an operator-style user message into another Cowork session. The inserted message automatically wakes or queues the target Cowork session so it can continue running without human intervention.

This supports supervision loops where one Bot can watch another Bot's progress, read its latest state, and send follow-up instructions to a Cowork session.

---

## 2. Confirmed Decisions

### 2.1 Session Link Format

The left session list menu should expose a copy action that writes this value to the clipboard:

```text
IDBots://{sessionId}
```

`sessionId` is the local SQLite `cowork_sessions.id` value. It is not `claude_session_id`.

Both `IDBots://{sessionId}` and `idbots://{sessionId}` are accepted when parsing links. Tool parameters may also pass a raw session ID.

### 2.2 Read Scope

Any local Cowork or A2A session can be read when the caller has its session ID.

Direct session-ID lookup is not limited by whether the session is visible in the sidebar list. The ID is treated as an explicit local reference.

### 2.3 Write Scope

Cross-session writes are allowed only into ordinary Cowork sessions.

A2A sessions are read-only for this feature. Cross-session insertion into A2A sessions is rejected because A2A has private-chat, encryption, restart, and guidance semantics that must not be bypassed by a generic message insertion tool.

### 2.4 Inserted Message Source

The source session ID is always the currently running Cowork Runner session. It is not accepted from LLM tool parameters.

Inserted user messages use this exact prefix:

```text
来自{sourceSessionId} 的信息：{message}
```

The target session ID is not used in the prefix.

### 2.5 Write Then Run

After a successful write into a Cowork session, the target Cowork session automatically continues running.

If the target Cowork session is already running, the continuation request is queued for that target session. It does not interrupt the active run.

Multiple inserted messages for the same target are processed in insertion order. They are not merged and are not skipped.

---

## 3. User Experience

### 3.1 Sidebar Menu

For each Cowork or A2A session in the left session list, the existing hover three-dot menu gains one item:

```text
复制Session ID
```

Clicking the item copies `IDBots://{session.id}` to the clipboard.

Existing menu actions such as rename, pin, and delete keep their current behavior.

### 3.2 Cowork Prompt Behavior

When a Cowork LLM sees a value like:

```text
IDBots://abc-123
```

the system prompt should instruct it to extract `abc-123` and use the built-in cross-session tools rather than guessing, asking the user to paste history, or treating the link as a web URL.

---

## 4. Architecture

Use the existing Cowork Runner host-tool architecture.

### 4.1 Renderer

Primary surface:

- `src/renderer/components/cowork/CoworkSessionItem.tsx`
- `src/renderer/components/cowork/CoworkSessionList.tsx`
- `src/renderer/services/i18n.ts`

Responsibilities:

- add the `复制Session ID` menu item,
- copy the `IDBots://{session.id}` link,
- keep existing item menu behavior intact,
- and show a concise copied status if the current UI pattern supports it.

The renderer does not read session history and does not perform cross-session writes.

### 4.2 Store

Primary surface:

- `src/main/coworkStore.ts`
- `src/main/sqliteStore.ts`

Use existing tables:

- `cowork_sessions`
- `cowork_messages`

No database schema change is required.

Store-level helpers should support:

- resolving a session by `cowork_sessions.id`,
- reading all persisted messages for a session,
- reading the latest persisted message using the same ordering as `getSessionMessages`,
- inserting a user message into a target Cowork session,
- and rejecting writes into A2A sessions.

The read functions return persisted records. Transient streaming text that has not been persisted yet is out of scope.

### 4.3 Runner Host Tools

Primary surface:

- `src/main/libs/coworkRunner.ts`
- `sandbox/agent-runner/index.js`

Add built-in host tools alongside the existing memory/history tools:

```text
idbots_session_read_all
idbots_session_read_latest
idbots_session_insert_user_message
```

Tool semantics:

- `idbots_session_read_all({ sessionId })` reads the target session metadata and all persisted messages.
- `idbots_session_read_latest({ sessionId })` reads the target session metadata and latest persisted message.
- `idbots_session_insert_user_message({ targetSessionId, message })` inserts a source-prefixed user message into the target Cowork session and queues or starts the target Cowork continuation.

The write tool obtains `sourceSessionId` from the current Runner context. The LLM cannot override it.

### 4.4 Continuation Queue

Cross-session writes need a per-target-session continuation queue.

If the target session is idle:

```text
insert message -> start target Cowork continuation
```

If the target session is running:

```text
insert message -> enqueue target continuation -> run after current target continuation completes
```

The queue is local process state. It is not a database migration. If the app exits, inserted messages remain persisted, but queued automatic runs do not survive process restart.

---

## 5. Data Flow

### 5.1 Copy Session Link

```text
session item
-> read item.session.id
-> clipboard.writeText("IDBots://" + session.id)
```

### 5.2 Read Full Session

```text
current Cowork Runner
-> idbots_session_read_all(sessionId)
-> parse raw ID or IDBots link
-> coworkStore.getSession(sessionId)
-> return session metadata + messages[]
```

Read is allowed for Cowork and A2A sessions.

### 5.3 Read Latest Session Message

```text
current Cowork Runner
-> idbots_session_read_latest(sessionId)
-> parse raw ID or IDBots link
-> coworkStore.getSession(sessionId)
-> select latest message by existing store ordering
-> return session metadata + message
```

The latest message is the newest persisted `cowork_messages` row under the store's established message ordering.

### 5.4 Insert User Message Into Cowork

```text
current Cowork Runner
-> idbots_session_insert_user_message(targetSessionId, message)
-> parse raw ID or IDBots link
-> resolve target session
-> reject target A2A sessions
-> build "来自{sourceSessionId} 的信息：{message}"
-> coworkStore.addMessage(targetSessionId, user message)
-> notify renderer about the inserted message
-> start or enqueue target Cowork continuation
```

---

## 6. Error Handling

Tools return structured results. They do not silently degrade into empty data.

### 6.1 Invalid Session ID

```json
{
  "ok": false,
  "code": "INVALID_SESSION_ID",
  "message": "Session ID is missing or invalid."
}
```

### 6.2 Session Not Found

```json
{
  "ok": false,
  "code": "SESSION_NOT_FOUND",
  "message": "No Cowork/A2A session found for the given session ID."
}
```

### 6.3 A2A Write Rejected

```json
{
  "ok": false,
  "code": "WRITE_NOT_ALLOWED_FOR_A2A",
  "message": "A2A sessions are read-only for cross-session tools."
}
```

### 6.4 Empty Message

```json
{
  "ok": false,
  "code": "EMPTY_MESSAGE",
  "message": "Message is empty after trimming."
}
```

### 6.5 Message Too Long

```json
{
  "ok": false,
  "code": "MESSAGE_TOO_LONG",
  "message": "Message exceeds the cross-session insert limit."
}
```

Implementation should use one explicit maximum length for inserted messages. Suggested limit: 8,000 characters after trimming.

### 6.6 Source Equals Target

Writing to the current session is allowed, but the result should include a warning:

```json
{
  "ok": true,
  "warning": "SOURCE_AND_TARGET_SESSION_ARE_THE_SAME"
}
```

### 6.7 Inserted But Run Not Queued

If the message is inserted but automatic continuation cannot be scheduled, return partial success:

```json
{
  "ok": true,
  "inserted": true,
  "runQueued": false,
  "warning": "MESSAGE_INSERTED_BUT_RUN_NOT_QUEUED"
}
```

This preserves the inserted instruction while making the scheduling failure visible to the caller.

---

## 7. Safety Boundaries

First version intentionally uses local full-open read access by explicit session ID.

The boundaries are:

- read any local Cowork/A2A session by session ID,
- write only ordinary Cowork sessions,
- reject all A2A writes,
- always derive source session ID from the Runner,
- never accept source session ID from the LLM,
- never silently truncate inserted messages,
- and never treat failed reads as empty sessions.

Out of scope:

- permission UI,
- human confirmation popups,
- cross-device session access,
- remote/on-chain session reads,
- URL protocol registration with the operating system,
- and generic A2A message insertion.

---

## 8. Test Plan

### 8.1 Store and Tool Tests

Cover:

- reading by `cowork_sessions.id`,
- reading all messages in established store order,
- reading the latest persisted message,
- rejecting missing sessions with `SESSION_NOT_FOUND`,
- inserting into Cowork with the source prefix,
- rejecting writes into A2A with `WRITE_NOT_ALLOWED_FOR_A2A`,
- rejecting empty and over-limit messages,
- and verifying the LLM cannot spoof `sourceSessionId`.

### 8.2 Runner Tests

Cover:

- the new tools are registered in the Cowork Runner host-tool list,
- sandbox runner has matching host-tool support,
- the prompt rule for `IDBots://{sessionId}` exists,
- tool calls use the current Runner session as the source,
- successful insert schedules a target Cowork continuation,
- and active target sessions queue continuations instead of being interrupted.

### 8.3 Renderer Tests

Cover:

- Cowork session menu shows `复制Session ID`,
- A2A session menu shows `复制Session ID`,
- clicking the action writes `IDBots://{session.id}` to the clipboard,
- it does not copy `claude_session_id`,
- and existing rename, pin, and delete actions still work.

### 8.4 Manual End-to-End Acceptance

Use two Cowork sessions and one A2A session:

1. Cowork A reads Cowork B's full history through `IDBots://...`.
2. Cowork A reads Cowork B's latest message.
3. Cowork A inserts an instruction into Cowork B, and Cowork B automatically continues running.
4. Cowork B is already running; Cowork A inserts two instructions; Cowork B processes them in order after the current run.
5. Cowork A reads an A2A session successfully.
6. Cowork A attempts to write into an A2A session and receives `WRITE_NOT_ALLOWED_FOR_A2A`.

---

## 9. Implementation Notes

Keep the implementation scoped to the IDBots project.

Do not create a branch or worktree without explicit user confirmation.

Do not modify unrelated dirty files.

After the user approves this written spec, create a separate implementation plan before writing implementation code.
