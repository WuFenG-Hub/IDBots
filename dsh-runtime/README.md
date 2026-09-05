# idbots-dsh-runtime

IDBots' DSH agent runtime: a standalone process spawned and supervised by the
Electron main process, speaking newline-delimited JSON-RPC on stdio through
`@deepseek-ai/dsh-sdk-client`. Targets the DeepSeek Harness `0.1.3-alpha.1`
release line. No forks.

## 0.1.3-alpha.1 upgrade notes

- `AttachmentStore.admitPromptContent()` is now the only prompt-admission entry
  point. The IDBots JSON-RPC server calls the store instance method so encoded
  images continue to use the kernel's batch, size, and canonical-base64 checks.
- Session persistence now uses lifecycle-scoped handles, asynchronous agent-loop
  creation, per-session leases, and the v2 JSONL format. Existing v0/v1 logs are
  read through the adjacent-generation migration path; IDBots does not reset user
  session data.
- Continuable subagents now steer a durable parent or child through the
  `send_message(agent_id, message)` control tool. The runtime test fixture follows
  that relationship instead of matching the removed parent-id prompt text.
- Generic file admission, proxy-aware outbound requests, richer model discovery,
  and optional session-log uploads are upstream capabilities worth following in
  the host/UI layer. They are not enabled by this runtime change.

The GitHub tag is available, but as of this upgrade the public npm registry did
not return `0.1.3-alpha.1` package tarballs. `npm ci --prefix dsh-runtime`
therefore remains blocked until DeepSeek publishes the matching package set. The
lockfile and package manifest already target the release so installation can be
re-run without another code change when those tarballs appear.

## Layout

- `bin.mjs` — runtime entrypoint: `boot()` + keep-alive. `node bin.mjs <cordis.yml>`
- `plugins/idbots-sdk-server.mjs` — the stock `HarnessSdkJsonRpcServer` subclassed
  (not forked) with our wire extensions. Agent lookup rides the public
  `agent/created`/`agent/disposed` registry events (registered `global`, since both
  dispatch through the agent's scope carrier). Unknown methods still fall through to
  the stock `-32603`. Wire surface:
  - `session/steer`, `session/cancel` (M1) — control-plane parity
  - `session/ensure` (M4) — resume-first create-or-resume with per-session provider/model
    override (agents.create never consults the persisted log, so resume must be attempted
    first; `session "<id>" not found` is the fresh-create signal)
  - `idbots/approval/respond {id, outcome}` (M2) — answer a pending approval ask;
    notifications `idbots/approval/request {id, sessionId, toolName, callId?, reason?}`
    and `idbots/approval/cancelled {id}` (dismiss the host dialog when the turn aborts)
  - `idbots/ping` — extension presence canary
- Approval ownership: `@deepseek-ai/dsh-user-approval` (pinned npm package) owns the
  `approval` service — audit events (`approval/asked`/`approval/decided` ride the
  session feed), fail-closed semantics, and the scope-filtered `approval/request`
  answerer waterfall. Our server plugin registers the (global) answerer that bridges
  asks to the wire. We wrote zero approval logic.
- `plugins/idbots-prompt-sections.mjs` (M3) — config-driven stable prompt layers on
  `ctx.systemPrompt.section` (the app's promptComposer section list passes through
  verbatim; volatile per-turn context stays on the user-message path as today)
- `plugins/idbots-tool-result-shaping.mjs` (M3) — bounds oversized tool results at
  commit time via `tools/post-execute` (head+tail + marker). This replaces the
  OpenAICompatProxy's per-session tool_result trimming with an architectural
  correction: DSH deep-freezes loop-built requests (`llm/stream` listeners read,
  never rewrite — the request must stay a pure function of the session log), so
  shaping happens where the result is produced, keeping log and model view consistent.
- `lib/generate-runtime-config.mjs` (M3) — provider table → bootable JSON composition.
  All providers ride one `dsh-llm-pi-ai` entry; pi-ai covers all three IDBots
  apiFormats (`openai`→`openai-completions`, `responses`→`openai-responses`,
  `anthropic`→`anthropic-messages`), resolving the Phase 0 Responses-API question.
  Plugin paths are absolute and the bin passes `bareModuleBaseUrl`, so the generated
  config is location-independent (the app writes it into userData). The workspace
  branch also mounts the official `@deepseek-ai/dsh-agent-instructions` plugin:
  AGENTS.md/CLAUDE.md discovered from the session cwd are injected as a user-role
  baseline before the first model request (64 KiB budget, `workspaceInstructions`
  input overrides), the same mechanism the DeepSeek Harness web UI uses.
- `cordis.test.yml` — M1/M2 test composition (core services, JSONL persistence,
  user-approval, fake LLM fixture, fixture tools, our server)
- `test/wire-extension.test.mjs` — steer/cancel wire test (8 checks)
- `test/approval-channel.test.mjs` — approval round-trip wire test (12 checks)
- `test/m3-config.test.mjs` — generated-config E2E against a mock OpenAI gateway:
  sections in the system prompt, real pi-ai tool round trip, shaping bounds the
  60k blob before history (12 checks)
- `test/workspace-instructions.test.mjs` — AGENTS.md/CLAUDE.md injection E2E:
  git-root discovery, empty-repo non-injection, ancestor-chain discovery from a
  sub-cwd, and LLM-request visibility (13 checks)

## Notes for later milestones

- `dsh-user-approval` injects an `approval:policy` runtime-context snapshot as a
  plugin-source user message (`source.kind === 'plugin'`, form `snapshot`). Event →
  `CoworkMessage` mapping in M4 must filter plugin-source messages out of user bubbles
  (the fake-LLM fixture already does).
- Wire tests must register notification waiters BEFORE sending the request that
  triggers them: `waitFor` has no replay buffer, and the runtime can emit the
  notification + `turn/end` faster than the triggering request's response round-trips.
- Session persistence rejects `agents.create` when the sessionId already has an
  on-disk log — dev loops must use fresh session ids (or clean `.test-sessions/`).

## Roadmap

`docs/dsh-phase1-plan.md` — M2 approval channel, M3 provider mapping + prompt
sections, M4 KernelAdapter/coworkRunner integration, M5 rollout + hardening.
Production composition is generated by the Electron main process (M3+); this
directory ships inside the app bundle.

## Run

```bash
npm install
npm test          # 32 checks: steer/cancel (8) + approval (12) + generated config E2E (12)
```
