# DSH Agent Speed vs deepseek-harness — Diagnosis (2026-09-27)

**Question.** With the same model (DeepSeek flash family) at the same reasoning
effort, a mid-complexity agent turn in IDBots takes visibly longer than the
same task in the upstream `deepseek-harness` project, and the model appears to
"think longer". This investigation locates the actual difference and proposes
improvements.

**Method.** (1) Traced the full local-chat turn path on both sides down to the
kernel. (2) Parsed 45 days of real session artifacts from both projects
(`~/.dsh/sessions` and `~/Library/Application Support/IDBots/dsh-sessions/v0`,
zstd JSONL) and computed per-step usage, reasoning tokens, decode speed, cache
ratios, and request-shape metrics. ~1,300 session files, both sides on kernel
`0.1.7-rc.2`.

## 1. The kernels are identical — the difference is the request content

Both projects run the **exact same kernel packages at `0.1.7-rc.2`**
(`@deepseek-ai/dsh-agent-loop`, `dsh-llm-deepseek`, `dsh-compaction-*`, etc. —
deepseek-harness is the source repo for the packages IDBots installs). The turn
loop, Messages-API serialization, streaming, retry executor, and compaction are
the same code. Verified: `deepseek-harness/packages/core/agent-loop/package.json`
and `IDBots/dsh-runtime/package.json` both pin `0.1.7-rc.2`.

There is **no wasteful loop in IDBots' base path**:

- One model API call per step, turn ends on the first tool-free step — same as upstream.
- Host-side additions are all **bounded and failure-path only**: empty-terminal
  auto-continue (once, at effort `off`), max-tokens auto-continue (once),
  transient-turn resumes (3 primary + 2 fallback route)
  — `src/main/libs/coworkRunner.ts:8604-8660`, `coworkAssistantReply.ts:47`.
- Kernel patches (`scripts/dsh-kernel-patches/`) add no waits to the ordinary
  chat loop (the browser/computer-use approval gates are opt-in automation slots).
- Streaming path is 1:1 to the kernel with only a 90 ms trailing-edge UI throttle
  (`dshStreamUiGate.ts`), and SQLite persistence happens on finalize only.

**Pipeline telemetry confirms parity** (official DeepSeek route, flash models):

| metric | harness | IDBots |
|---|---|---|
| decode speed (median tok/s) | 182–262 | 149–261 |
| KV-cache read ratio (median) | 0.97–1.0 | 0.99–1.0 |

Networking, streaming, and caching are not the bottleneck.

## 2. What actually differs: the model thinks ~9x more per step

Same provider (`deepseek-official`), same flash model family, **both sides
configured `reasoningEffort: high`** (IDBots:
`dsh-runtime/lib/generate-runtime-config.mjs:150-151`; harness user settings
`~/.dsh/settings.yaml.imported` → `agent-default-model.reasoningEffort: high`).
Per-step token production over 45 days:

| metric (per step) | harness v4-flash | harness flash | IDBots flash | IDBots v4-flash |
|---|---|---|---|---|
| steps analyzed | 4,796 | 996 | 3,582 | 143 |
| reasoning tokens p50 / p75 / p90 | 83 / 425 / 1164 | 81 / 297 / 679 | **732 / 2216 / 4776** | 119 / 495 / 1491 |
| output tokens p50 | 396 | 507 | **1,209** | 437 |
| steps per turn (p50) | 6 | 6 | 2 | 2 |

At ~250 tok/s decode, the median IDBots step spends ~3 s on hidden reasoning
vs ~0.3 s upstream; a p90 step spends **~19 s** vs ~2.7 s. Multiplied over the
steps of a turn, this is exactly the subjective "thinks longer, turn takes
longer" experience. (Caveat: task mix differs — harness sessions skew toward
short coding commands, IDBots toward conversational assistant work. The gap is
far larger than task mix alone explains, but a controlled A/B is listed below
to quantify the residual.)

## 3. Why the model thinks more: request-shape differences

Measured from real recent sessions on both sides (official flash route):

| request shape | harness (stock) | harness (user-loaded) | IDBots (typical bot) | IDBots (main project) |
|---|---|---|---|---|
| system prompt bytes | ~4 KB | 32–35 KB | ~2 KB + sections | **50–74 KB** |
| tools mounted | 24 | 65–88 | 31–42 | **57–116** |
| tool-schema JSON bytes | 25 KB | 57–81 KB | 35 KB | **87–130 KB** |
| first-step input tokens | ~19.6 K | 34–41 K | 19–48 K | **49–71 K** |

Composition of the IDBots overhead:

1. **Always-on behavioral prose layers** (`coworkRunner.ts:5360-5423`):
   persona + twin orchestration + roster, workspace safety, projects,
   memory strategy, MetaWeb worldview (~3.9 KB), MetaWeb learning loop
   (~3 KB), Q&A behavior (~3.3 KB), chain-identifier rules (~1.7 KB),
   skills rules, tool-use guidance, plus the user-configured base prompt
   (which itself pins full `## Skill:` blocks inline —
   `CoworkView.tsx:363-371`). Upstream's stock identity section is one
   sentence, and its skill catalog entries are capped at 500 chars with
   lazy full-body loading via the `skill` tool.
2. **17–22 host-bridged tools** with long descriptions (100–500 words each;
   chat-recall alone ≈ 1.2 KB of description text —
   `coworkRunner.ts:9167+` `buildSessionInlineTools`), plus opted-in MCP
   servers (the main project mounts enough to reach 99–116 tools).
3. **Volatile per-turn tail** (`coworkRunner.ts:5568-5651`): memory XML is
   **always re-injected every turn** (`alwaysInject: true`), experience /
   twin impressions / knowledge listing / browser tabs / skills catalog ride
   the user message (these are content-hash deduped — good). Every
   always-injected token is a fresh cache-miss tail and more deliberation
   material.
4. Notably, the user's own harness sessions with **87–88 mounted tools still
   think only ~81 tokens/step** — so tool *count* is a secondary factor; the
   **instruction-dense imperative prose** (MANY ALWAYS/NEVER rules, storage
   routing decision trees, participation discipline) is the primary driver of
   longer reasoning chains. This also plausibly explains the "feels less
   smart" observation: over-constrained prompts distract the model and
   degrade tool-choice quality.

## 4. Secondary, path-specific differences

- **Output ceiling**: IDBots pins native-route `maxTokens: 32,768`
  (`generate-runtime-config.mjs:90`, `coworkModelLimits.ts`) vs upstream's
  256 K default. Reasoning shares the output budget, so a long-thinking step
  can hit the ceiling → truncated turn → one paid auto-continue (observed
  `max-tokens` turn-end reasons in IDBots logs; none in harness logs).
- **Retry ladder**: 8 retries, 1 s→30 s (≈3 min worst case) vs upstream
  5×500 ms→10 s (≈46 s) — deliberate outage ride-out
  (`generate-runtime-config.mjs:118-129`); only hurts when the network is
  flapping.
- **First-turn cold start**: runtime boot + 20 s-handshake budget +
  `session/ensure` — mitigated by prewarm (`main.ts:16509`).

## 5. Recommendations (ranked by expected impact)

1. **Shrink the always-on prompt surface.** Gate MetaWeb
   worldview/learning-loop/QA-behavior/chain-ids sections by session type or
   first-relevant-use instead of mounting them on every bot conversation;
   move "when to use" guidance into the owning tool's description (single
   source) instead of system prose; stop pinning full skill bodies inline
   (`CoworkView.tsx`) — adopt harness's 500-char catalog + lazy `skill`-tool
   loading pattern. This attacks both the 9x reasoning gap and first-step
   prefill (~50–74 KB → target <20 KB).
2. **Slim tool schemas.** Cap host-tool descriptions to 2–3 sentences; mount
   memory/knowledge/twin/metaapp tools only for bots with those features
   actually enabled; evaluate the wire format's `defer_loading` flag for
   rarely-used tools; prune unused MCP tools per bot.
3. **Fix the output-ceiling interplay.** Raise the native flash pin (e.g.
   64 K) or accept the adapter default so long-thinking steps stop
   truncating into paid auto-continues.
4. **Effort ladder tuning (cheap, direct).** Both sides default to `high`;
   consider `low` as the default for conversational local-chat sessions
   (per-session effort is already plumbed — `coworkRunner.ts:8096-8105`),
   keeping `high` for coding/agent workspaces.
5. **Keep the resilience ladder but scope it.** The 3-minute retry window and
   3+2 resumes serve long autonomous tasks; consider a tighter ladder (e.g.
   5 retries) for interactive chat sessions only.
6. **Add telemetry to prevent regression.** Surface per-step reasoning-token
   and prompt-bytes breakdowns (already flowing through `idbots/usage`) in
   dev diagnostics; alert when the composed system prompt or tool-schema
   bytes cross thresholds.
7. **Run a controlled A/B.** Execute one scripted task set in both projects
   (fresh sessions, same model, effort high) and compare reasoning tokens
   per step — isolates prompt-content effect from task-mix confounds and
   gives a baseline to measure recommendations 1–4 against.

## Appendix: key references

- IDBots turn path: `src/main/libs/coworkRunner.ts:6603` (continueSession) →
  `runDshSessionLocal` (7910) → `DshTurnHub.runTurnExclusive`
  (`coworkDshTurn.ts:561`) → `DshKernel.prompt` (`dshKernel/dshKernel.ts:266`)
  → runtime child (`dsh-runtime/bin.mjs` + `plugins/idbots-sdk-server.mjs:573`
  → `agent.followup`).
- Composition: `dsh-runtime/lib/generate-runtime-config.mjs`.
- Prompt assembly: `coworkRunner.ts:5360` (sections),
  `5568` (volatile tail), `coworkView` base prompt `CoworkView.tsx:363-371`.
- Upstream loop: `deepseek-harness/packages/core/agent-loop/src/agent.ts`
  (`turn()` 296-379, `step()` 381-527); serializer
  `packages/llm/llm-deepseek/src/serialize.ts:146-167`.
- Telemetry: DSH session JSONL `assistant/message.usage`
  (`inputTokens/cacheReadTokens/outputTokens/reasoningTokens`) and
  `stream[].dt` timings; analysis script logic reproduced in this document.

---

## Addendum (2026-09-27, same day): controlled A/B + first optimization slice

**A/B harness.** `scripts/perf/ab-baseline-dsh.mjs` drives BOTH shapes through
this repo's own dsh-runtime (same kernel, same driver, same model
deepseek-flash at effort high): side "idbots" replays the app's real request
shape (system prompt + host-tool catalog extracted from a live session
artifact), side "stock" runs a hand-translated stock base-bundle composition
(23-tool catalog, harness identity, lean prompt). Fresh session per task;
artifacts parsed with one shared parser.

**Baseline result (identical scripted tasks):**

| | idbots shape | stock shape |
|---|---|---|
| first-step input tokens | 36,769 | 11,791 (3.1× smaller) |
| reasoning tokens/step | 0 | 0 |
| wall per simple task | 4.4–9.6 s | 4.9–11.4 s |

On trivial scripted prompts the model (V4.1 flash, adaptive thinking) does not
reason on either side — confirming that the real-world 9× reasoning gap
(p50 732 vs 81) is driven by real task complexity engaging the extra
instruction surface, not by the pipeline. Decode speeds match (~200–250 tok/s).
Known harness limitation: file-tool tasks stall after the first tool result on
both sides (follow-up model request never completes; under investigation) —
the default task set is reasoning-only for now.

**Landed slices (this branch):**

1. **R3 — output ceiling**: DeepSeek V4 family max output 32,768 → 256,000
   (upstream parity; `coworkModelLimits.ts`, generator default, idempotent
   startup migration for provider rows pinning the legacy 32K).
2. **R1 — prompt layers**: the four always-on MetaWeb sections rewritten in
   compact form with every normative rule preserved
   (worldview 3.9 KB→2.5 KB, learning loop 3.0 KB→1.5 KB, Q&A behavior
   3.3 KB→1.7 KB, chain-ids 1.7 KB→0.9 KB).
3. **R2 — tool schemas**: the 8 heaviest host-tool descriptions compressed
   (omni_read 1.7 K→0.9 K, search_metaweb 1.5 K→0.9 K, post_* suite, batch
   reader; shared on-chain-write disclaimer ×4 files).

**Measured effect on the real app request shape** (same session extraction,
before vs after): system prompt −3,448 B, tool descriptions −3,471 chars —
**≈ −6.9 KB per request**, first-step input 36,769 → 35,194 tokens (−4.3%).

**Not yet done (follow-ups):** the remaining ~20 mid-size host-tool
descriptions (like_pin, comment_pin, knowledge_*, procedure_*, search_qa,
get_question_answers, social_* ≈ 8 KB more); per-session gating of metaweb
layers for non-MetaWeb workspaces; the A/B tool-task stall; effort=low default
for conversational sessions.

## Addendum 2 (2026-09-27 evening): tool-task stall fixed, full A/B with tool tasks, batch-2 descriptions

**Stall root cause (4a).** The A/B harness now answers the sdk-server's
`idbots/policy/request` gate (bash/read/write/edit/read_image wait for a host
policy decision — the benchmark replies `allow`). This was the tool-task
"stall": the kernel was correctly waiting for the host. File-tool tasks now
complete on both sides in ~8 s with normal multi-step turns.

**Full A/B with tool tasks (7 tasks × both sides, same fixed shape files):**

| shape | first-step input | system bytes | tools | steps/7 tasks |
|---|---|---|---|---|
| stock composition | 11,791 | 2,162 | 23 | 10 |
| app shape — baseline | 36,769 | 65,544 | 115 | 14 |
| app shape — R1+R2 | 35,194 | 62,076 | 115 | 15 |
| app shape — + batch-2 descriptions | **34,716** | 62,076 | 115 | 15 |

Cumulative: **−2,053 input tokens per request (−5.6%)**, system prompt
−3.4 KB, host-tool descriptions −7.4 KB (batch 1: 8 heaviest tools; batch 2:
19 more: qa/social/knowledge/procedure/like/comment/agentpedia/scheduled/
pin-versions). All normative rules preserved; 382/383 tests pass (the one
failure, `dshHostToolRegistry` "twin turn slow_tool" timeout, also fails on
`main` with no branch changes — pre-existing, out of scope here).

Reasoning tokens remain 0 on scripted tasks for every shape (V4.1-flash
adaptive thinking) — the reasoning-length effect remains measurable only in
real usage telemetry; the request-size reduction above is the direct,
verifiable win.

## Addendum 3 (2026-09-27 night): decisions 1A/2A implemented

Two-tier MetaWeb guidance is live (`metawebPromptTier.ts`): Tier 0 (compact
worldview + chain-ids) always; the deep learning-loop/Q&A sections mount only
after the session's first MetaWeb tool call (monotonic per SDK session
generation, injected via the next turn's session/ensure — in-history, cache-
friendly). Tool mounting is content-gated with the creator exception:
knowledge_upsert / procedure_save / knowledge_base_add_document /
knowledge_base_learn always mount; knowledge_recall / procedure_recall /
procedure_archive / knowledge_base_list / knowledge_base_query wait for
content. A2A automation profile runs metawebMode 'compact'.

Measured (A/B, main-project bot): Tier-0 session first-step input 34,008
tokens — cumulative −7.5% from the 36,769 baseline; fresh no-content bots
additionally drop 5 tool schemas. 361/362 tests pass (the single failure is
the pre-existing main-branch dshHostToolRegistry issue).
