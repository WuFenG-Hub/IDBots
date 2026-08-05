# Cowork Kernel Evaluation: Claude Agent SDK vs OpenClaw (LobsterAI's Choice)

Date: 2026-08-05
Status: Analysis only — no code changes
Branch: `feat/cowork-kernel-analysis`

## 1. TL;DR

- **Confirmed:** LobsterAI has fully replaced the Anthropic Claude Agent SDK. The old engine (`yd_cowork`, built on `@anthropic-ai/claude-agent-sdk` — the same SDK IDBots still uses at pinned version 0.2.12) was removed on 2026-04-10 (commit `20728acc`).
- **Their replacement:** [OpenClaw](https://github.com/openclaw/openclaw), an open-source agent runtime + gateway, currently pinned at `v2026.6.1`. LobsterAI vendors it (clone tag → apply 27 patches → build from source per platform → bundle gateway → package as `Resources/cfmind`) and talks to it over a token-authenticated WebSocket JSON-RPC protocol on loopback.
- **Our SDK situation:** IDBots pins `@anthropic-ai/claude-agent-sdk@0.2.12` (bundles Claude Code CLI 2.1.12, built 2026-01-17). Latest published SDK is **0.3.221** (updated 2026-08-04), i.e. we are one minor series and ~200 patch releases behind. The SDK is actively maintained but remains closed-source (minified `cli.js` bundle).
- **Migration is feasible but it is a large project.** LobsterAI's integration is ~11.6k lines of runtime adapter + ~1.8k lines of gateway manager + 27 source patches + a 15-script build pipeline, and took ~6 weeks from dual-engine introduction to full removal of the old engine. IDBots has *more* custom surface than LobsterAI did (QEMU sandbox, cross-session A2A, memory/dream systems), so expect equal or greater effort.
- **Cheaper interim option:** upgrade the pinned SDK 0.2.12 → 0.3.x. This buys current Claude Code capabilities without an architecture change, but does not fix the closed-source / minified-bundle concern and re-breaks our two `cli.js` string patches on every bump.

## 2. Evidence: LobsterAI's migration timeline

| Date | Commit | Event |
|---|---|---|
| baseline | `3ab5afbc` | Open-source release still used in-house `yd_cowork` engine on `@anthropic-ai/claude-agent-sdk` (dep + patch-package patch + `claudeSdk.ts` + 3,298-line `coworkRunner.ts`) — nearly identical to IDBots' current design |
| 2026-02-26 | `81d69d83` "support openclaw engine" | OpenClaw added as a second, switchable engine (`openclawEngineManager.ts`, `openclawRuntimeAdapter.ts`, `coworkEngineRouter.ts`, `openclawConfigSync.ts`, architecture doc) |
| 2026-03-06 | `6bb25e2e` | Version-pin + auto-fetch + build-cache machinery for the OpenClaw dependency |
| Mar 2026 | `2e13597f` et al. | Gateway cold-start optimization (gateway-entry patch, esbuild single-file bundle, V8 compile cache): 80–100s → 2–12s |
| Mar–Apr 2026 | multiple | All IM channels (DingTalk, Lark, Discord, Telegram, WeCom, QQ, NIM…) re-implemented as OpenClaw channel plugins |
| **2026-04-10** | **`20728acc`** "移除 yd-cowork 旧引擎链路" | **Claude Agent SDK deleted**: dependency, patch, `ClaudeRuntimeAdapter`, `CoworkRunner`, `claudeSdk.ts` loader; engine type collapsed to `'openclaw'` only (−3,662/+128 lines) |
| 2026-04-15 | `391f30e6`, `4168344a` | Removal spec + final dead-code cleanup; regression test added asserting `claude-agent-sdk` never returns to `package.json` |
| 2026-06-16 | `1d310b06` | OpenClaw runtime upgraded to `v2026.6.1` (10 design docs under `specs/refactors/openclaw-upgrade/`) |

Residue today: only historical names (`claudeSessionId` param, `claude_session_id` SQLite column, `claudeSettings.ts` repurposed as provider-config resolver), one stale dependabot ignore pattern, and the guard test.

## 3. How LobsterAI uses OpenClaw today

### 3.1 Vendoring / build pipeline

Declared in `package.json` (`openclaw.version = v2026.6.1`, `openclaw.repo`, 11 channel plugins). Per-platform pipeline (`openclaw:runtime:<target>`):

`ensure` (git clone pinned tag, depth 1) → `patch` (apply `scripts/patches/v2026.6.1/*.patch`, 27 patches, with sentinel-code validators to detect silent drift) → `build` (`pnpm install --frozen-lockfile && pnpm build`, then `npm pack`, production install with forced platform/arch, `gateway.asar`) → `sync-current` (symlink + extract asar entries for Windows ESM) → `bundle` (esbuild single-file `gateway-bundle.mjs`) → `plugins` (install 11 channel plugins via OpenClaw CLI) → `extensions:local` (copy `openclaw-extensions/*`) → `precompile` (TS→JS to cut first-start cost) → `channel-deps` → `prune`. Result packaged as `Resources/cfmind`.

Build cache keyed on pinned version + sha256 of patch set.

### 3.2 Runtime architecture

- `OpenClawEngineManager` (`src/main/libs/openclawEngineManager.ts`) spawns the gateway as a child process: `gateway --bind loopback --port <port> --token <token>` (default port 18789, scans for free port; 300s boot timeout; restart backoff; 4 GB heap cap). Launcher: Electron `utilityProcess.fork` (macOS/Linux) or `child_process.spawn` with `ELECTRON_RUN_AS_NODE=1` (Windows).
- Electron talks to the gateway **only** via WebSocket JSON-RPC using OpenClaw's own `GatewayClient` loaded from the vendored runtime. RPC surface used: `chat.send`, `chat.abort`, `chat.history`, `sessions.list`, `sessions.patch`, `sessions.subscribe`; events: `chat.side_result`, `sessions.changed`, `exec.approval.requested`, agent stream events.
- `OpenClawRuntimeAdapter` (~11.6k lines) implements their `CoworkRuntime` interface: translates gateway events into Cowork UI events, persists to the same SQLite `CoworkStore`, reconciles gateway history with local transcripts, drives the approval bridge and subagent sessions.
- **LLM calls are made by OpenClaw's native provider stack** (Anthropic/OpenAI/Gemini/DeepSeek/Qwen/Ollama/… wire protocols declared per provider in the generated `openclaw.json`). LobsterAI authors the config; no SDK, no format-translation proxy for mainstream providers.
- Four local OpenClaw extensions fill product gaps:
  - `ask-user-question` — desktop confirmation dialogs via HTTP callback (bypassing limits of `exec.approval`)
  - `mcp-bridge` — exposes LobsterAI-managed MCP servers as native OpenClaw tools (`mcp_<server>_<tool>`) that POST back to the app
  - `lobsterai-model-compat` — custom provider transport profiles (currently Kimi K3)
  - `lobster-media-generation` — image/video/skin tools with long-running job polling
- Requires Node ≥ 24.15 (gateway runtime).

### 3.3 Notable: features LobsterAI had to patch *into* OpenClaw

The 27 patches reveal where OpenClaw didn't natively meet product needs — directly relevant to IDBots' feature list:

- steer/mid-turn input: `openclaw-sessions-queue-steer-rpc.patch` (i.e. steer needed a patch, mirrors our `CoworkSteerChannel`)
- tool-loop safety: `openclaw-terminate-run-on-critical-tool-loop.patch`, `openclaw-aborted-tool-loop-breaker.patch`, `openclaw-stop-loop-after-aborted-tool-run.patch`
- provider quirks: `openclaw-kimi-k3-support.patch`, `openclaw-dashscope-context-cache.patch`, `openclaw-openai-compatible-replay-errors.patch`, `openclaw-codex-missing-content-type-sse.patch`
- session/system-prompt control: `openclaw-session-goal-rpc.patch`, `zz-openclaw-task-cwd-system-prompt.patch`, `openclaw-chat-send-cwd-decoupling.patch`

## 4. IDBots' current Cowork kernel (what a migration must re-home)

Our core is `src/main/libs/coworkRunner.ts` (6.9k lines) + `sandbox/agent-runner/index.js` (1.9k lines, guest daemon for the QEMU VM), both calling `@anthropic-ai/claude-agent-sdk@0.2.12`:

| # | Feature | Current implementation | OpenClaw counterpart / gap |
|---|---|---|---|
| 1 | Agent loop, streaming | SDK `query()` + event iteration in-process (local) / JSON-over-9p (sandbox) | `chat.send` + gateway stream events via adapter |
| 2 | Session resume | `options.resume = claudeSessionId` | Native sessions (`sessionKey`, `sessions.*` RPCs) |
| 3 | Tool permissions | `canUseTool` callback on **every** tool, both backends | `exec.approval.requested` (coarser) + `ask-user-question` extension pattern; per-tool gating must be verified |
| 4 | Mid-turn steer | `CoworkSteerChannel` (bidirectional `AsyncIterable<SDKUserMessage>`) | Requires `sessions-queue-steer-rpc` patch (LobsterAI precedent) |
| 5 | Inline MCP tools (memory, cross-session A2A, metaapp, Bot Browser, MetaID search) | `createSdkMcpServer` + `tool()` inside process | `mcp-bridge` extension pattern (register tool in OpenClaw, HTTP callback into IDBots) |
| 6 | External MCP servers | merged into `options.mcpServers` | Native MCP support in OpenClaw (+ `openclaw-mcp-shared-runtime.patch`) |
| 7 | System prompt composition (persona, memory blocks, skills, experience) | `composeEffectiveSystemPrompt` + `options.systemPrompt` | Config/patch level (`zz-openclaw-task-cwd-system-prompt.patch` suggests this needed patching) |
| 8 | Subagent overrides (Explore/general-purpose) | `options.agents` AgentDefinitions + `cli.js` patch (`model: haiku→inherit`) | OpenClaw subagents (LobsterAI has subagent stores + cleanup patch) |
| 9 | Context budget & compaction | `coworkContextBudget.ts` / `coworkContextCompaction.ts` + retry-on-overflow | Needs re-implementation against gateway session state; OpenClaw has its own cache mechanisms |
| 10 | Multi-provider (OpenAI/Gemini/Ollama/…) | In-app OpenAI-compat→Anthropic translation proxy (80 KB) | **Native** — a real gain; removes the proxy and format-transform stack |
| 11 | QEMU sandbox mode (`agentd` in Alpine VM) | Same SDK inside VM; custom 9p/virtio-serial JSON IPC; host-tool RPC; file sync | **No counterpart.** Must either run an OpenClaw gateway inside the VM, keep a slim SDK runner in the VM, or redesign |
| 12 | Title generation | SDK `unstable_v2_prompt` | Trivial direct LLM call |
| 13 | Packaging | asar-unpacked npm dep; `patch-package` patch (Electron-as-node spawn) + `cli.js` string patches | Vendored runtime build pipeline per platform (`Resources/cfmind`), 27-patch maintenance burden |
| 14 | Error recovery retries (stale resume, DeepSeek history, overflow, multimodal) | Custom logic in runner | Re-implement against gateway events |

Also affected: `coworkStore.ts` survives as-is (LobsterAI kept their equivalent), renderer IPC contract can be preserved if the adapter keeps emitting the same `cowork:stream:*` events.

## 5. Options

### Option A — Migrate to OpenClaw (follow LobsterAI)

**Pros**
- Open-source runtime with active monthly releases (v2026.3.2 → v2026.6.1 within one quarter); no dependence on a closed, minified SDK bundle.
- Native multi-provider stack removes our translation proxy and per-provider error/limit shims.
- Proven Electron integration blueprint available next door (manager, adapter, config sync, patches, build scripts) — we can borrow heavily since both apps share ancestry.
- Gateway model gives session persistence, cron, channels, and future IM connectors nearly for free.

**Cons / risks**
- Largest engineering effort in this list: LobsterAI spent ~6 weeks with a simpler feature surface. Our sandbox VM, A2A cross-session, memory/dream systems all need re-homing.
- We inherit a fork-maintenance burden: 27 patches re-validated on every OpenClaw upgrade (their guard: sentinel-code validators).
- Several of our features map to OpenClaw only via patches (steer, system-prompt control) — we would depend on LobsterAI's patches or write our own.
- Node ≥ 24.15 runtime requirement; packaging complexity increases (per-platform vendored builds).
- OpenClaw license and governance should be verified before committing (not vendored locally to inspect).

### Option B — Upgrade the Claude Agent SDK (0.2.12 → 0.3.x)

**Pros**
- Smallest effort; architecture, sandbox VM, and all 14 features above stay untouched.
- SDK is actively maintained (0.3.221 published 2026-08-04); gets months of Claude Code fixes/features.

**Cons**
- Still closed-source; `cli.js` remains a minified bundle we string-patch (cygpath fallback, Explore model) — every upgrade risks breaking those patches and the event schema we consume defensively.
- Does not address the strategic concern that motivated this evaluation.
- 0.2.x → 0.3.x is a minor-series jump; API/event changes must be audited (esp. `query` options, `canUseTool`, `unstable_v2_prompt`, agent overrides).

### Option C — Hybrid: upgrade SDK now, pilot OpenClaw as second engine

Do Option B immediately for currency, then replicate LobsterAI's dual-engine phase: introduce OpenClaw behind the existing `executionMode`/engine config, migrate session types incrementally (standard → browser → A2A), keep the sandbox VM on whatever runner works best, and remove the SDK only when parity is proven. This mirrors exactly the path LobsterAI validated (dual engine 2026-02-26 → single engine 2026-04-10) and limits risk, at the cost of maintaining two engines during transition.

## 6. Recommendation

1. **Short term:** Option B — upgrade to a current `@anthropic-ai/claude-agent-sdk` 0.3.x in a throwaway branch to measure breakage (patches, event schema, `unstable_v2_prompt`). Low cost, high information value either way.
2. **Strategic track:** Option C pilot — clone LobsterAI's vendoring pipeline and adapter skeleton, stand up the OpenClaw gateway inside IDBots with one session type, and verify the four hardest mappings: (a) per-tool permission gating, (b) steer RPC, (c) inline memory/A2A tools via mcp-bridge, (d) sandbox VM story.
3. **Decision gate:** after the pilot, compare patch-maintenance cost vs SDK-upgrade friction and decide on full migration.

## 7. Open questions

- OpenClaw license/governance and whether `v2026.6.1` → newer upgrades are backward-compatible for our patch set.
- Can LobsterAI's 27 patches and build scripts be reused as-is (they were written by the same upstream team we forked from)?
- Sandbox VM direction: gateway-in-VM vs slim-runner-in-VM vs dropping VM mode for OpenClaw's own sandboxing.
- Node 24 requirement impact on our packaged Electron (currently the SDK child process uses Electron-as-node).
- Whether renderer IPC (`cowork:stream:*`) can be kept byte-compatible so the UI layer needs zero changes.

## 8. Key references

**LobsterAI** (`/Users/tusm/Documents/MetaID_Projects/LobsterAI`)
- `package.json:10-68` (openclaw pin/plugins), `:112-126` (runtime pipeline)
- `scripts/patches/v2026.6.1/` (27 patches), `scripts/apply-openclaw-patches.cjs`
- `src/main/libs/openclawEngineManager.ts`, `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`, `src/main/libs/openclawConfigSync.ts`
- `openclaw-extensions/{ask-user-question,mcp-bridge,lobsterai-model-compat,lobster-media-generation}/`
- `docs/architecture-openclaw-gui-cowork.md`, `specs/refactors/remove-yd-cowork-engine/2026-04-15-remove-yd-cowork-engine-design.md`, `specs/refactors/openclaw-upgrade/`
- Migration commits: `81d69d83` (2026-02-26), `20728acc` (2026-04-10), `1d310b06` (2026-06-16)

**IDBots**
- `src/main/libs/coworkRunner.ts:903` (CoworkRunner), `:3749` (local run), `:4870` (sandbox run)
- `sandbox/agent-runner/index.js` + `sandbox/agent-runner/package.json` (SDK 0.2.12)
- `patches/@anthropic-ai+claude-agent-sdk+0.2.12.patch`, `scripts/patch-claude-sdk-cli.js`
- `docs/superpowers/specs/2026-07-13-cowork-runtime-steer-design.md`
