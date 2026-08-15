# DSH Kernel Migration — Phase 1 Plan

Branch: `feat/dsh-phase1` (from `main` @ `acc61fa9`) · Owner doc for the kernel-swap phase.
Input: Phase 0 spike report (`spikes/dsh-phase0/PHASE0_REPORT.md`, 16 verifications green).

## Goal

Run IDBots agent sessions on a DeepSeek Harness (DSH) runtime — consumed strictly as
pinned npm packages, no forks — behind a kernel-agnostic seam, with control-plane parity
for what the Claude Agent SDK provides today, and a per-session rollout switch so both
kernels coexist during migration. Legacy `claudeSessionId` sessions keep the Claude kernel.

## Non-goals (Phase 2 track)

- Rewriting feature modules (memory, Bothub, group tasks, A2A, IM gateways) as cordis plugins.
- Replacing the renderer UI or the `cowork:*` IPC surface (both stay byte-compatible).
- Sandbox-mode sessions on DSH (stay on the Claude kernel until M5 evaluation).
- Subagent UI parity beyond transcript reading (M4 verifies feasibility only).

## Architecture

### Process model (subprocess runtime, crash-isolated like today's per-query `claude` binary)

```
Electron main (existing)
  └── DshKernelAdapter (implements KernelAdapter, manages runtime lifecycle)
        └── spawn node bin.mjs <config>          (dsh-runtime/, packed into resources)
              └── cordis plugin tree:
                    dsh core services (session/agent/agent-loop/tools/llm/system-prompt/token-meter)
                    dsh-session-persistence-jsonl (session root inside app userData, versioned dir)
                    idbots-sdk-server (OURS: jsonrpc server subclass + protocol extensions)
                    idbots-permissions (OURS: canUseTool chain → tools/pre-execute, host-fed policy)
                    idbots-prompt-sections (OURS: promptComposer sections → ctx.systemPrompt)
                    idbots-tools (OURS: existing minimal-shape tool factories → defineTool)
                    llm adapters (deepseek/pi-ai routes generated from provider table)
```

Wire: stdio JSON-RPC via `@deepseek-ai/dsh-sdk-client` (Electron main) ↔
`dsh-runtime` bin. All methods beyond the stock three are ours:
`session/steer`, `session/cancel` (M1), `session/approval/*` (M2).

### In-app seams

1. **`KernelAdapter` interface** — generalize the existing `loadClaudeSdk` test seam
   (`src/main/libs/claudeSdk.ts` is already the single runtime import point). The adapter
   surface mirrors what `coworkRunner` consumes today: start/continue turn, stream events
   (mapped to the existing `CoworkMessage` internal currency), steer, cancel, context
   usage, subagent listing, respond-permission. Claude implementation = current code path
   unchanged; DSH implementation = new `src/main/libs/dshKernel/`.
2. **Event mapping** — DSH `session/event` envelopes (`data`-nested payloads; `request/header`
   carries the full assembled request) map to `CoworkMessage` exactly where
   `handleClaudeEvent` maps SDK events today. The ~1,400-line Anthropic stream parser
   collapses to a much smaller mapping table.
3. **Provider routing** — the SQLite provider table generates runtime config: OpenAI-compatible
   providers → `dsh-llm-pi-ai` hand-declared `openai-completions` routes (verified in Phase 0);
   DeepSeek-native → `dsh-llm-deepseek` (optionally via baseURL). The `OpenAICompatProxy`
   stays for Claude-kernel sessions only. The proxy's DeepSeek-reasoning handling is natively
   covered by DSH's adapter; per-session `tool_result` trimming moves to an `agent/pre-step`
   plugin (verified feasible in M3).
4. **Permissions** — `canUseTool` chain (plan-mode blocking, destructive-op prompts,
   boss/chair/owner session gating, vision gate) ports to `idbots-permissions` as a
   `{ global: true }` `tools/pre-execute` listener (pattern verified in Phase 0, F5).
   Interactive `ask` rides the M2 approval channel.

### Package layout

- `dsh-runtime/` — repo-root subproject (same convention as `sandbox/`): pinned deps
  (`@deepseek-ai/*@0.1.0-rc.6`, npm `next` line — **never `latest`**, Phase 0 F1), runtime bin,
  our runtime-side plugins, and its own tests. Ships inside the app bundle.

## Milestones

Each milestone is an independently verifiable commit unit; every one carries tests and a
buzz journal entry. Phase 0 leftovers (report §4) are folded in.

- **M1 — Runtime scaffold + wire control plane** *(this branch starts here)*
  `dsh-runtime/` with `bin.mjs`, `idbots-sdk-server` (subclass of the stock server adding
  `session/steer` + `session/cancel`, unknown methods still `-32603`), dev composition with a
  fake LLM fixture, and a wire test proving steer/cancel over stdio end-to-end.
- **M2 — Approval channel** ✅ (delivered): mounts `@deepseek-ai/dsh-user-approval`
  (it owns the `approval` service, audit events, fail-closed semantics — we wrote zero
  approval logic) and bridges its `approval/request` answerer waterfall to the wire:
  `idbots/approval/request` notification → Electron permission dialog →
  `idbots/approval/respond`; `idbots/approval/cancelled` dismisses the dialog when the
  turn aborts. Porting the app-side `enforceToolSafetyPolicy` flow rides M4's adapter.
- **M3 — Provider mapping + prompt sections**: provider table → generated adapter config;
  `promptComposer` named sections → `idbots-prompt-sections`; `agent/pre-step` plugin for
  per-session `tool_result` trimming (replaces the `/s/<sessionId>` proxy route for DSH sessions).
- **M4 — `KernelAdapter` + coworkRunner integration**: adapter interface extraction, DSH
  implementation, session-event → `CoworkMessage` mapping, context usage from
  `request/header`, subagent transcript feasibility (list/read parity check), resume of
  DSH sessions across runtime restarts (JSONL under versioned userData dir).
- **M5 — Rollout + hardening**: per-session kernel flag (DSH default for DeepSeek-compatible
  providers first), stall watchdog port, sandbox-mode decision, Electron packaging of the
  runtime (asar.unpacked, auto-update pinning, Windows dispose-ladder check), real-model
  behavior comparison on group-task and A2A corpora, compaction quality check.

## Risks (carried from Phase 0)

- rc churn: pin exact versions; the wire surface we touch is narrow (client + protocol +
  subclass of one exported class + public events). Budget one upgrade-spike per minor bump.
- Session format v0: DSH session roots live in a versioned directory under userData
  (`dsh-sessions/v0/…`) so a format break never touches Claude-kernel history.
- Behavior drift vs. `preset: 'claude_code'`: M5 comparison gate before defaulting any
  provider to DSH; rollback is the session-level flag.

## Testing strategy

- `dsh-runtime/test/` — self-driving wire tests against the fake LLM fixture (no keys, no network),
  same pattern as the Phase 0 spike; run with plain `node`.
- Adapter unit tests ride the existing `loadClaudeSdk` seam convention (inject a fake kernel).
- Existing `tests/coworkSdkEvents.test.mjs`-style fixtures gain a DSH-envelope variant in M4.
