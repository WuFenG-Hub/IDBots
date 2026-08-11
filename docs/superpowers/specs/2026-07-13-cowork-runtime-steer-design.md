# Co-Worker Runtime Steer Design

Date: 2026-07-13
Status: Approved design
Scope: Co-Worker standard sessions in local execution mode

## Summary

Co-Worker will allow a user to send corrective guidance while a local MetaBot task is running. The guidance enters the active Claude Agent SDK query through a bidirectional input channel. It does not start a second runner, cancel an in-flight tool, change the System Prompt, or roll back completed work.

The existing Stop action remains the hard-termination control. While a task is running, an empty composer shows Stop; entering text changes that control to Send Steer.

The first release supports text-only steer messages for standard sessions using local execution. Sandbox and A2A sessions are outside this feature's first-release scope.

## Goals

- Let the user correct or redirect a running local MetaBot task without waiting for completion.
- Deliver guidance to the active SDK query at its nearest safe input boundary.
- Keep one runner and one query per active session.
- Preserve in-flight tool execution and already completed valid work.
- Persist every steer in the conversation timeline with honest delivery status.
- Preserve FIFO order when several steer messages arrive while the MetaBot is busy.
- Make task-completion races idempotent so a message is neither lost nor executed twice.

## Non-goals

- Cancelling or rolling back an in-flight tool call.
- Dynamically changing the model, selected skills, working directory, attachments, or System Prompt during an active turn.
- Supporting sandbox execution in the first release.
- Replacing the existing A2A guidance mechanism.
- Claiming that the MetaBot followed a steer merely because the runtime accepted it.

## Existing Behavior and Constraints

`CoworkPromptInput` currently blocks submit and Enter while `isStreaming` is true, disables attachments, and replaces Send with Stop. `CoworkView` routes ordinary follow-up input through `cowork:session:continue`.

`CoworkRunner.continueSession()` is not a safe steer path. If the session is already active, it calls `runClaudeCode()` again with the same `ActiveSession`. Concurrent calls would share streaming buffers, permission state, and the abort controller while potentially operating on the same workspace.

The installed `@anthropic-ai/claude-agent-sdk` version is `0.2.12`. It supports bidirectional input when `query()` receives an `AsyncIterable<SDKUserMessage>`. The current runner passes a string prompt, which selects the SDK's single-user-turn mode.

The effective System Prompt is assembled before query creation from the MetaBot persona, workspace safety rules, local-time context, scoped memory blocks, memory strategy, configured base prompt, skills and MetaApp routing, and remote-service instructions. Changing the persisted System Prompt in the current runner resets `claudeSessionId`; therefore steer must not use that mechanism.

## Chosen Architecture

### One live query

Local turns will use a pushable asynchronous input channel instead of a string prompt. The initial user request is the first SDK user message in that channel. Any accepted steer is appended to the same channel.

The runner must never call `runClaudeCode()` a second time while the active local turn owns an open input channel. This invariant is enforced in the runner, not only by renderer state.

### Dedicated input-channel component

A focused `coworkSteerChannel` component will own:

- the `AsyncIterable<SDKUserMessage>` contract;
- FIFO enqueue behavior;
- delivery promises or acknowledgements;
- clean input closure after accepted messages settle;
- abort behavior for Stop and runtime failure;
- rejection of writes after the channel enters closing or closed state.

This keeps queue and lifecycle logic separate from the already large `coworkRunner.ts` file.

### Atomic turn-submission controller

The renderer will use one submission operation for text entered in an existing session. The main process will make the authoritative decision:

- active standard local session with an open channel: submit as steer;
- session that completed before the request reached main: submit as an ordinary continue turn;
- sandbox session: reject steer with the explicit first-release limitation;
- invalid, stopped, deleted, or A2A session: return a stable error without guessing.

This decision must occur in one main-process control path. Renderer `isStreaming` is presentation state and is not authoritative enough to decide the execution mode.

The result returns the actual mode, such as `steer` or `continue`, so renderer state reflects what occurred.

## Prompt Semantics

The database and UI store the user's original steer text. The runner creates a transient structured user-message envelope only when writing to the SDK input channel. Its semantics are:

- this is a new instruction from the human user that supersedes the task currently in progress;
- stop the current task immediately and switch to this new instruction (interrupt semantics);
- preserve completed work that remains valid;
- adjust pending plans and future actions to follow the new direction;
- do not pretend that an in-flight external side effect can be rolled back.

The envelope is a user message, not a System Prompt or system message. It cannot override workspace safety, identity, permission, or other higher-priority rules. It is never written back into the visible conversation content.

## UI Design

### Composer states

For a running standard local session:

- empty text: show Stop;
- non-empty text: show Send Steer;
- Enter sends steer;
- Shift+Enter inserts a newline;
- textarea remains enabled;
- adding attachments, changing skills, changing model, and changing working directory remain disabled.

For a non-running session, non-empty text uses the ordinary Continue behavior.

For a sandbox session, the first release keeps the running composer unavailable for steer and explains that runtime steer currently requires local execution.

### Timeline presentation

A steer appears immediately as a user message with a lightweight Steer label. The visible status vocabulary is limited to claims the application can verify:

- Waiting for delivery
- Sent to MetaBot
- Send failed
- Cancelled

An internal settled state may be recorded after the SDK produces the corresponding subsequent result, but the UI must not label this as "followed" or "obeyed." The execution trace and final result are the evidence of compliance.

### Text-only first release

Running-turn attachments and configuration changes stay disabled. Applying a new skill prompt or model selection to an already-created query has different lifecycle semantics and would risk implicit System Prompt changes. These capabilities require separate future designs.

## Message State and Idempotency

Each renderer submission receives a UUID before IPC. The UUID is used as the persisted Cowork message ID, allowing the existing primary key to serve as the idempotency key without adding a database column.

The store will expose a narrowly scoped way to insert or retrieve a message by caller-supplied ID. A repeated IPC request with the same ID returns the existing result or resumes its failed delivery attempt; it does not create another timeline entry.

Steer metadata extends the existing JSON metadata shape and does not require a schema migration. It records at least:

- interaction kind: steer;
- delivery status;
- submission ID;
- delivery or failure timestamps where relevant;
- a stable error code for retryable failures.

The lifecycle is:

1. `submitted`: renderer creates the request ID.
2. `queued`: main persists the user message.
3. `delivered`: the live SDK input transport accepts the message.
4. `settled`: a subsequent SDK result settles the accepted input.
5. `failed` or `cancelled`: delivery could not complete or Stop cancelled an undelivered item.

Several messages are persisted and delivered in FIFO order. Newer guidance never silently overwrites older guidance.

## Safe-Boundary Behavior

Steer is soft guidance:

- if the model is thinking or generating, the SDK receives the new user input through its streaming-input protocol;
- if a tool is executing, the tool is not cancelled, and the Agent receives guidance when control returns to an SDK input boundary;
- if the turn has just completed, the atomic submission controller promotes the message to an ordinary continuation;
- Stop aborts the query and remains the only hard-termination action.

The product copy must say "at the nearest safe boundary," not promise instantaneous cancellation or rollback.

## Query Lifecycle

The active session will hold the live query/input-channel state in addition to the existing abort and streaming state. Result accounting must distinguish terminal results for the initial input and any accepted steer inputs.

The input channel stays open while accepted inputs remain unsettled. It closes cleanly once the current input sequence is settled and there are no pending steer submissions. Stop aborts both the channel and query.

The implementation must verify the exact result behavior of SDK `0.2.12` with a deterministic adapter test. Lifecycle bookkeeping belongs behind an adapter so an SDK behavior change does not leak into UI or store code.

## Errors and Recovery

### Delivery failure

If persistence succeeds but channel delivery fails, the current task continues. The message becomes failed and can be retried with the same submission ID.

### Stop

Stop closes the input channel and aborts the active query. Steers that were queued but not delivered become cancelled. Already delivered steer messages remain recorded as delivered because the application cannot truthfully undo that delivery.

### Application crash or restart

The application must not silently replay unresolved steer messages after restart because some may have been partially acted upon before the crash. Startup recovery marks unresolved items as interrupted or failed and allows an explicit retry.

### Completion race

If the live channel closes between renderer submit and main-process handling, the same submission atomically becomes an ordinary Continue turn. The UUID guarantees one visible user message and one execution path.

## Code Boundaries

Expected areas of change are:

- `src/main/libs/coworkSteerChannel.ts`: pushable SDK input channel and steer envelope;
- `src/main/services/coworkTurnSubmission.ts`: atomic steer-versus-continue decision and idempotency;
- `src/main/libs/coworkRunner.ts`: one-query invariant, live channel ownership, steer submission, result settlement, and Stop cleanup;
- `src/main/coworkStore.ts`: caller-supplied message ID and steer metadata updates;
- `src/main/main.ts`: IPC registration and dependency wiring;
- `src/main/preload.ts` and shared Electron/Cowork types: typed submission contract;
- `src/renderer/services/cowork.ts`: renderer service call and returned-mode handling;
- `src/renderer/components/cowork/CoworkPromptInput.tsx`: input-enabled streaming state and Stop/Send switch;
- `src/renderer/components/cowork/CoworkView.tsx`: unified submission flow;
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`: status presentation and local/sandbox capability state;
- i18n resources and focused tests.

A2A guidance code and sandbox agent-runner protocol are not modified in this release.

## Verification

### Automated tests

- Input-channel FIFO behavior, enqueue acknowledgement, close, and abort.
- One SDK query for an initial request plus multiple steer inputs.
- No second runner invocation while the live local channel is open.
- Ordered delivery and settlement of consecutive steer messages.
- Stop cancellation of undelivered items and abort of the active query.
- Atomic completion-race promotion to Continue.
- Repeated IPC with one UUID creates one message and one execution path.
- Steer envelope remains runtime-only and does not mutate System Prompt or reset `claudeSessionId`.
- Metadata round-trip through existing SQLite JSON storage.
- Recovery handling for unresolved items without silent replay.
- Composer button states, Enter behavior, disabled configuration controls, and visible delivery labels.
- Stable rejection and explanatory UI for sandbox sessions.
- Existing ordinary Continue, Stop, permission, A2A guidance, and cross-session behavior remain unchanged.

Tests that import Electron-side compiled modules must run `npm run compile:electron` before Node tests.

### Build and manual acceptance

- Run the focused Node tests.
- Run `npm run compile:electron`.
- Run `npm run build`.
- Start a real long-running local Co-Worker task.
- Send multiple steer messages while a tool is running.
- Verify the tool is not cancelled, messages retain FIFO order, only one query owns the turn, and later actions reflect the guidance.
- Verify an empty composer still stops the task.
- Exercise the task-completion race and confirm the input becomes one ordinary Continue turn.
- Confirm sandbox sessions do not expose unsupported steer behavior.

## Future Work

- Add equivalent bidirectional control to the sandbox agent-runner protocol.
- Design safe runtime changes for attachments, skills, models, and working directory.
- Consider richer acknowledgement when the SDK exposes a direct input-consumed event.
