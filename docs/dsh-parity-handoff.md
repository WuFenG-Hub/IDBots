# DSH Kernel Migration — Handoff Document

Last updated: 2026-08-16 (session 3) · Branch: `feat/dsh-p1-parity` (unpushed; P0 merged to main as `0ffbd3e4`) · Author: ZCode sessions 2026-08-15~16
Companion memory: `dsh-phase1-m1-progress` (project memory, auto-recalled)

## 1. Where we are

IDBots runs a **dual-kernel architecture**: cowork sessions run either on the
Claude Agent SDK (original path, untouched) or on **DSH (DeepSeek Harness)**
via `dsh-runtime/` — a self-composed Cordis plugin runtime consumed strictly
as pinned npm packages (`@deepseek-ai/*@0.1.0-rc.6`, zero forks). Phase 1
(26 commits on `feat/dsh-phase1`, merged as `946361a7`) plus a soak-fix
series on main is complete and live-verified: kernel swap, full tool surface,
skills (bash-executed), permission chain, compaction, retry, session-scoped
provider routing, subagents + panel, kernel-switch UI, electron-builder
packaging, persona-owned prompts, volatile context injection.

Flag `dshKernelEnabled` is **default off**; the UI toggle (Claude/DSH pills in
the cowork prompt controls) governs NEW sessions; existing sessions pin their
kernel via the `dsh:` session-handle prefix.

## 2. Architecture map (files that matter)

| Path | Role |
|---|---|
| `dsh-runtime/` | The runtime subproject: bin.mjs, plugins/, lib/generate-runtime-config.mjs, own node_modules (pinned), own test suite (8 files) |
| `dsh-runtime/plugins/idbots-sdk-server.mjs` | THE wire server (subclasses stock `HarnessSdkJsonRpcServer`). Owns: steer/cancel/ensure (resume-first), approval bridge (M2), host-tool bridge, policy gate, subagent lineage + list/messages |
| `dsh-runtime/lib/generate-runtime-config.mjs` | Provider table → bootable JSON composition. Providers UNION accumulates; sections/hostTools ride `session/ensure` (agent-scoped), NOT the config |
| `src/main/libs/dshKernel/` | `dshKernel.ts` (spawn bin via ELECTRON_RUN_AS_NODE=1, notification pump, respond methods), `dshEventMapper.ts` (session events → CoworkMessage contract; NO user echo), `types.ts` |
| `src/main/libs/coworkDshTurn.ts` | `DshTurnHub` — one runtime multiplexed across sessions. Keyed by DSH session id for events, cowork↔dsh maps for steer/cancel/tools; pinnedDshIds survive turns; quiesce-before-restart; fatal-only turn settlement |
| `src/main/libs/coworkRunner.ts` | `runDshSessionLocal` (turn runner), `buildSessionInlineTools` (494-line shared tool builder — BOTH kernels), `buildDshHostTools` (passthrough + zod normalization), `evaluateDshToolPolicy` (permission port), `resolveSessionDshRoute` (3-tier model resolution) |
| `src/main/libs/coworkKernelRouting.ts` | Flag + openai-compat eligibility + `dsh:` stickiness |
| `src/main/libs/claudeSettings.ts` | `resolveDshProviderRoute` (direct-upstream route + API-root URL derivation via proxy's builders), `isDshKernelEnabled` |
| `src/renderer/components/cowork/KernelSelector.tsx` | UI toggle + per-session kernel badge |
| `electron-builder.json` | dsh-runtime ships as extraResource (218MB, Resources/dsh-runtime) |

## 3. Current work: structural parity audit (user-directed methodology)

**Method**: compare `runClaudeCodeLocal` vs `runDshSessionLocal` stage by
stage; structural diffs find subtle gaps that soak testing misses. Finding #1
(volatile context injection missing on DSH) was found and fixed this way
(`3af9cf99`).

### Backlog, prioritized (the next session's work queue)

**Done in session 2 (branch `feat/dsh-p0-parity`, all tests green):**

1. ✅ **P0 — Bridged-tool image blocks** (`7d867694`): `idbots/tool/respond`
   carries `images: [{data, mediaType, name?}]`; new
   `dsh-runtime/plugins/idbots-attachment-store.mjs` implements the abstract
   `AttachmentStore` seam (content-addressed sha256 files under
   `<sessionRoot>/attachments`, magic-byte + dimension validation for
   png/jpeg/webp/gif); the host-tool proxy renders DSH image blocks. Routes
   declare `input: ['text','image']` from `resolveCurrentModelLimits`
   (`supportsVision`); the server-side gate degrades to a text note on
   text-only routes (an image there would poison durable history — pi-ai
   refuses it on every continuation). Bonus: mounting the store activates
   DSH's native `read_image` tool for workspace sessions.
2. ✅ **P0 — Empty terminal turn auto-continue** (`893a365b`): the event
   mapper flags `turn/end` with `emptyTerminal` (clean stop, no text/tool
   activity); `runDshSessionLocal` auto-continues once with the shared
   `EMPTY_TERMINAL_TURN_CONTINUE_PROMPT`, second consecutive empty turn falls
   back to idle + diagnostic (`reportEmptyTerminalTurn`).
3. ✅ **P0 — User-configured MCP servers** (`7c589c3d`): generator maps each
   user server to one `dsh-mcp-client` entry (stdio → command/args/env,
   sse/http → streamable-http); hub option `mcpServersProvider` accumulates a
   config-level union like providers; runner feeds it from
   `mcpServerProvider`. Tools surface as `mcp__<server>__<tool>`.
4. ✅ **Audit bonus — turn memory updates** (`49e2b8ed`): structural diff
   found `applyTurnMemoryUpdatesForSession` never ran on DSH completions —
   DSH sessions fed no experience extraction. Now called before `complete`.

**Done in session 3 (branch `feat/dsh-p1-parity`, first three P1 items):**

5. ✅ **P1 — Prompt image attachments** (`bad15dab`): new `idbots/prompt` wire
   extension (text + images → store commit → [text, ...image blocks] user
   message, route-gated like tool images); host reads image files from the
   attachment marker lines (store media types + size cap; others stay path
   references); auto-continue does not re-send them. Text-file attachment
   contents still ride as path references the model reads with its tools —
   full text-attachment injection parity is NOT done (claude CLI reads them
   into context; deferred as low value vs. tool reads).
6. ✅ **P1 — AskUserQuestion** (`cd9fb648`): `dsh-user-questions` service +
   `dsh-tool-ask-user` mounted; provider registered by idbots-sdk-server
   (`idbots/ask/request` / `idbots/ask/respond`); host renders through the
   SAME AskUserQuestion modal (question-text keys ↔ wire ids mapping, deny →
   declined custom answer); full-trust low-risk auto-answer parity via
   `tryAutoAnswerLowRiskQuestion`.
7. ✅ **P1 — Vision gate + repeated-read dedup** (`3c884e2e`): read/read_image
   joined the policy-gated set; `evaluateDshToolPolicy` runs the shared pure
   `evaluateReadImageGuard` (N1 non-vision image block, N2 unchanged re-read
   dedup via the shared readFiles registry). read_image passes as 'read'.
   Also: `c4984c85` fixed a latent interleave-test race (two concurrent turns
   on ONE DSH session id clobbered the controller — passes were timing luck).

**Remaining backlog (next session):**

8. **P1 — Stall watchdog**: claude path has `localTurnStallWatchdog`; add a
   turn-level timeout for DSH (hub.runTurn race with timeout → cancel).
9. **P2 — Subagent live task rows**: panel currently shows post-hoc entries
   only; map `subagent.started/finished` → the renderer's task Redux channel
   (find the task event channel in main.ts).
10. **P2 — DSH plugin install flow** (Phase 2 opener): npm-install into
    `userData/dsh-plugins`, absolute-path entries via `extraEntries`,
    persisted list in app_config, config-change auto-restart already works.
    Use it to mount official non-overlapping packages: web, fs-search,
    time-context, jobs, terminal (needs node-pty). Deliberately NOT mounting:
    dsh-skill/dsh-schedule/dsh-plan-mode/dsh-cmdline (overlap with IDBots
    systems — IDBots stays authoritative).
11. **P2 — Behavioral foundation decision**: claude path sits on the full
    claude_code preset; DSH has DSH tool docs + our ~10-line guidance. If
    soak shows quality gaps on complex tasks, distill an IDBots behavioral
    layer (see memory `claude-code-prompt-engineering-techniques`).
12. **P2 — Windows** (pwsh composition), compaction long-session soak,
    group-task/IM live testing.

## 4. Hard-won contracts (do not relearn these)

- **Resume-first**: `agents.create` never consults the persisted log; ensure
  must resume first (`session "<id>" not found` = fresh-create signal).
- **Tools must settle on abort** (`exec.signal`) or the whole turn drain hangs.
- **Runtime shutdown**: `client.close()` owns the kill ladder; dropping the
  reference leaks the child (keepalive interval pins the parent).
- **Error channels**: per-event handler failures are contained (log-only);
  ONLY pump-fatal errors settle in-flight turns. Mixing them killed turns.
- **Config stability**: per-session data (sections/hostTools) must NEVER enter
  the runtime config — config diff = restart = kills in-flight turns.
  Providers accumulate as a union; restarts wait for quiescence.
- **zod schemas**: three conventions arrive (instance, raw-shape `{key:
  ZodType}`, bare `{}`); normalize at the bridge (`z.toJSONSchema` draft-7,
  wrap non-object as `{type:'object',properties:{}}`).
- **thinkingFormat compat**: openai-completions protocol ONLY.
- **URL shapes**: derive pi-ai API-root via the proxy's builders
  (`buildOpenAIResponsesURL` deepseek-host-root rule, chat `/v1/...`).
- **Mapper never echoes user/message** (submission path records user bubbles).
- **DSH session teardown**: `removeActiveSession` after completion (else next
  input classifies as a dangling steer); re-register at turn start.
- **npm**: pin `next` tag / exact `0.1.0-rc.6` — `latest` dist-tags are stale
  and ERESOLVE-conflict.

## 5. Testing infrastructure & gotchas

- App-side: `npm run test:dsh` (rimraf dist → compile:electron → 5 test
  files → dsh-runtime suite). dsh-runtime: `cd dsh-runtime && npm test`
  (11 files now — attachment-store, mcp-bridge, ask-bridge joined;
  mock-gateway based, no keys needed).
- **Run node --test with `--test-concurrency=1`** for the cowork suites;
  parallel files flake on ports.
- **Session fixtures must clean their userData BEFORE the run** — a hung run
  never reaches finally, and resume-first adopts poisoned logs forever
  (self-poisoning hang loop; fixed in both fixtures 2026-08-16).
- Orphan processes (mock servers on 487xx ports, runtime-bin) from killed
  runs poison later runs: `pkill -f runtime-bin; lsof -ti :4879x | xargs kill`.
- Dev instance: `npm run electron:dev:dsh` (port 5185, isolated
  `.dev-userdata-dsh`, UI toggle is the single truth source — env override
  removed). Real-instance logs: `~/Library/Application Support/IDBots/logs/cowork.log`;
  DSH session logs: `~/Library/Application Support/IDBots/dsh-sessions/v0/`.
- Packaging: full chain `npm run build && npm run compile:electron && npx
  cross-env CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --dir`;
  verify `release/mac-arm64/IDBots.app/Contents/Resources/dsh-runtime/`.
- python patch scripts MUST assert anchors (silent no-ops burned us 3×).

## 6. Workflow rules (from AGENTS.md, still binding)

Branch+worktree per feature from main; small commits (`feat|fix|refactor|docs|chore:`);
post an English dev-journal buzz via the `metabot-post-buzz` skill for every
commit; no push without instruction; merge with `--no-ff`; direct-to-main
only for small soak fixes (precedent set this session).

## 7. Suggested opening move for the next session

P0 (merged to main as `0ffbd3e4`) and the first three P1 items (§3 items
5–7, on `feat/dsh-p1-parity`) are DONE — the branch awaits merge review.
Next: (8) the DSH stall watchdog, the last P1 item — claude path reference is
`localTurnStallWatchdog` in runClaudeCodeLocal; a hub.runTurn race with a
timeout → cancel should carry it. Then the P2 tier. Watch out when testing:
orphan mock/runtime processes on 487xx poison later runs (`lsof -ti :4879x |
xargs kill; pkill -f cordis.runtime`), and the interleave-test race fix
(c4984c85) documents why two concurrent turns must never share one DSH
session id.
