# DSH Integration Issues — Fix List (for external dev session)

> This document lists the systemic issues discovered after integrating the DSH kernel. They are intended to be resolved **in sequence by a dedicated external development session**. Each item includes: task description, root-cause leads, relevant source locations, and acceptance direction.
> Author: AI_Sunny (Twin), 2026-08-17.
> Primary registry: `docs/analysis/known-issues-log.md` (internal running log, includes handling history)
> Suggested priority: P1 > P2 > P3 (ordered by blast radius)

---

## Task 1 — Steer (interjection) does not interrupt promptly on the DSH path (P1)

**Symptom**: When the Owner interjects while the Twin is mid-turn, the current turn does not receive the message; it only arrives after the whole turn finishes. Appeared after switching to DSH; was previously fine.

**Root-cause leads (code path already located)**:
- Current Twin runs on the DSH kernel. Steer splits into two paths:
  - **DSH path** (`executionMode=local` and hit by `dshActiveTurns`) → `trySubmitSteer` goes through `hub.steer()` → `kernel.steer()` → runtime `session/steer` endpoint. Comments state **"no interrupt-on-steer"; delivery is at the next step boundary**, not an immediate interrupt.
  - Local (non-DSH) path → has `interruptLocalTurnForSteers` for immediate interruption.
- Source: `src/main/libs/coworkRunner.ts:1835-1844` (DSH branch), `:1794-1823` (interrupt-on-steer), `src/main/libs/coworkDshTurn.ts:199-204`, `src/main/libs/dshKernel/dshKernel.ts:170-176`.
- **Not yet first-hand verified**: the exact delivery timing of `session/steer` in the deepseek-harness runtime; and why it was previously fine but now fails (regression commit not located).

**Desired behavior**: Interjections on the DSH path should also interrupt the current turn promptly (aligned with the local path's interrupt-on-steer semantics), or at least be injected quickly at a reasonable step boundary.

**Acceptance direction**: An interjection mid-processing is received by the Twin within an acceptable delay and can interrupt the current turn.

---

## Task 2 — Worker-session delete operation hangs forever on permission confirmation (P1)

**Symptom**: When a background worker session executes a delete (`rm -rf ...`), the bash result never returns and the session hangs permanently. Triggered twice independently, both on the same delete command.

**Root cause (source-verified)**:
- `evaluateDshToolPolicy` forces `decision:'ask'` for **every delete** (reason: deletion requires human confirmation), **not exempted by bypassPermissions**.
- The `ask` → DSH `onPolicyRequest` → `respondPolicy('ask')` → the delete bash is blocked waiting for human confirmation.
- A background worker session has no human to click the delete confirmation → `respondPolicy` never returns → permanent hang.
- Although there is `PERMISSION_RESPONSE_TIMEOUT_MS=60_000`, it was not observed to recover within 60s; confirm whether the delete path actually hooks that timeout.
- Source: `src/main/libs/coworkRunner.ts:6333-6342` (delete forces ask), `src/main/libs/coworkDshTurn.ts:368-377` (onPolicyRequest), `src/main/libs/coworkRunner.ts:257` (timeout constant), `:10432` (timeout timer).

**Desired behavior**:
- Background worker-session deletes need an automated policy (not dependent on a human being present), or a controlled exemption for low-risk deletes such as "removing temp files the worker itself created inside the project worktree";
- Or the worker delete confirmation needs a managed response channel (see Task 5);
- Even if confirmation is still required, it must never hang forever — there must be a reliable timeout/reject that makes the tool return.

**Acceptance direction**: A worker session can safely complete "clean up temp directory"-style wrap-up without hanging.

---

## Task 3 — Cancelled/stuck worker sessions still show as running in the UI (P2)

**Symptom**: A worker session cancelled by `twin_task_cancel` still shows running in the UI, parked on the stuck delete step, with no "cancelled" label. This misleads the Owner into thinking the worker "kept hanging". In reality there is no active process underneath.

**Evidence**: Session `67f02646` shows status=running, last message timestamped 00:29, but `ps` shows no process; its task is cancelled; worktree verified clean.

**Desired behavior**: Cancelled/stale worker sessions show a proper terminal state (cancelled/stopped) in the UI, and do not masquerade as running.

**Acceptance direction**: After a task is cancelled, its session UI state correctly/ promptly reflects the cancelled state.

---

## Task 4 — Twin lacks the ability to stop/manage any worker session (product requirement) (P2)

**Symptom/requirement**: From a product-design perspective, the Twin as the orchestrator should be able to stop any worker session (not just cancel a task, but also terminate the corresponding session and settle its state). Currently there is no such tool; stuck sessions can only be stopped manually by the Owner in the UI.

**Current gap**: No exposed interface for the Twin to "answer an approval" or "close/stop a specific worker session". `respondApproval(id, outcome)` / session `stop` are internal APIs with no Twin-routable API.

**Desired capability**:
- The Twin can "terminate/stop a specific worker session" and settle its UI state;
- On stop, auto-cancel that session's pending approval/tool call to avoid permanent hangs;
- Or provide a controlled "Twin answers worker delete confirmation" channel (design together with Task 2).

**Acceptance direction**: The Twin can autonomously terminate a stuck worker session and make the UI reflect the terminal state, without the Owner's manual intervention.

---

## Task 5 — Concurrent un-isolated electron dev instance resets worker sessions (P3 / process warning)

**Symptom**: Launching a dev instance with `electron:dev` (un-isolated user-data + disabled single-instance lock) while worker attempts are running causes the in-flight worker attempt to be marked `RECOVERED_AFTER_RESTART` and interrupted, leaving partial work behind. Correct practice is to use `electron:dev:fresh` (isolated user-data) for previews.

**Assessment**: This issue is primarily a process/environment issue rather than a DSH kernel bug, but it exposes a lack of protection against a dev instance affecting running worker sessions. Include for the dev session to evaluate whether "dev instances must use isolated data directories" should be enforced or warned.

**Acceptance direction**: Documentation/scaffolding always guides using `electron:dev:fresh`; or warn on un-isolated dev startup.

---

## Notes

- Tasks 2, 3, 4 are strongly related (three layers of the same "worker session hang" scenario: permission-hang / UI state misdisplay / Twin has no resolution capability). They are recommended to be handled by the **same dev session**.
- Task 1 is relatively independent (steer path) but still belongs to the DSH kernel line.
- Task 5 can be treated as a process improvement.
- Source line numbers above are based on `main` (`933f30b3`) at generation time; use the actual numbers at development time.
