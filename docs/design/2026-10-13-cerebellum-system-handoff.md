# Cerebellum System — Architecture & Handoff

Date: 2026-10-13 · Status: MVP live on `main` (merged, not pushed) · Owner-facing docs live in `Settings > Model > Cerebellum`

This document is the handoff for the next development agent. It explains what the "cerebellum" (小脑) system is, what has been built, the design rules that must not be broken, and where it goes next.

---

## 1. What the cerebellum is

IDBots MetaBots have two model categories, mirroring Kahneman's fast/slow thinking:

| | Brain (大脑) | Cerebellum (小脑) |
|---|---|---|
| Role | Generative LLM: reasons, writes, executes | Fast decision model: ranks, gates, selects |
| First provider | Existing providers (DeepSeek, Anthropic, ...) | TypeSafe **JEV** (`jev-latest`), the first "System One" model |
| API | OpenAI/Anthropic-style chat | `POST {baseUrl}/v1/systemone` — a `state` + typed `questions` |
| Question types | — | `noul` (yes/no → 0–1 probability), `choice` (≤255 options + distribution), `score` (≤10 levels) |
| Output | Free text | Calibrated probabilities; **never generates text** |
| Pricing | input+output tokens | **input tokens only, $0.042/Mtok**, output free |

Key JEV properties (from docs.typesafe.ai): all questions in one request are evaluated **in parallel and independently** against one shared state; English question instructions work best (CJK state content is fine); 1.5s-class latency; it is literal, cannot count or compare dates, and its stated probabilities are calibrated across groups (not per-case truth) — so every consumer needs a fallback path.

**Product rule: the cerebellum is strictly optional.** With it disabled or misconfigured, every feature behaves exactly as before. It is an enhancement layer, never a dependency.

## 2. What has been built (all on `main`)

### 2.1 Settings & configuration

- `src/renderer/components/Settings.tsx` — the Model settings page has two sub-tabs: **Brain** (existing provider UI, untouched) and **Cerebellum**: enable toggle (default OFF), provider selector (single `TypeSafe JEV` entry, array-shaped for more), API key, base URL (default `https://api.typesafe.ai`), model (default `jev-latest`), and a Test Connection button.
- **Privacy notice** on the panel (zh+en): enabling the cerebellum may send memories/conversation excerpts to the cloud provider; entirely user-controlled.
- Config persists under a new top-level `AppConfig.cerebellum` key (`src/renderer/config.ts`) — deliberately NOT inside the `providers` map, so no provider-migration registry is involved.
- `src/main/libs/cerebellumConfig.ts` — `resolveCerebellumConfig(appConfig)`: the single main-process seam. Returns a normalized config or `null` (disabled / missing / malformed / empty key). **All call sites read through this; never call JEV without it.**
- `src/renderer/services/cerebellumConnection.ts` — connection test against `GET {baseUrl}/v1/models` via `window.electron.api.fetch` (→ main `session.defaultSession.fetch`, **follows the system proxy**).

### 2.2 The cerebellum client module

- `src/main/cerebellum/memoryRank.ts` — pure, Electron-free:
  - `rankMemoriesWithCerebellum({ config, fetchImpl, currentUserText, memories, timeoutMs? })` → `Map<id, noul> | null`. **Never throws.** Returns `null` on: HTTP non-200, network error, abort/timeout (default `CEREBELLUM_MEMORY_RANK_TIMEOUT_MS = 1500`), malformed payload, or **answer coverage < 80%** (`CEREBELLUM_MEMORY_MIN_ANSWER_COVERAGE`, because a partial noul map would rank unscored entries' lexical scores (≥1) above every noul (≤1)).
  - Constants: `CEREBELLUM_MEMORY_MAX_CANDIDATES = 200`, `CEREBELLUM_MEMORY_MIN_POOL = 12`.
  - One tunable English Noul instruction template (`CEREBELLUM_MEMORY_RANK_INSTRUCTIONS`) — instructions reference state by backticked dot-index path (`memories[i].text`), state carries the user's original (often Chinese) text.

### 2.3 Live integration #1 — per-turn memory recall re-ranking

- `src/main/memory/memoryPromptBlocks.ts` — `RankScopedMemoryEntriesInput.relevanceScoreById?: ReadonlyMap<string, number>`; `rankEntries` uses the map score instead of the lexical score for present ids (lexical kept otherwise); guaranteed-importance tier untouched. `buildScopedMemoryPromptBlocksDetailed(input)` returns `{ xml, injectedIds }` (injected = entries surviving ranking + char budget).
- `src/main/libs/coworkRunner.ts` — `CoworkRunnerOptions.cerebellumMemoryRanker` DI callback; `buildScopedMemoryPromptBlocksXml` (now async) fetches pools, dedupes by id, and when the ranker exists + user text non-blank + pool ≥ 12, awaits one rank call; logs `coworkLog('INFO', 'memory:cerebellumRank', { sessionId, pooled, ranked, latencyMs, used })`. Any null/throw → pure lexical.
- `src/main/main.ts` — module-level `createCerebellumMemoryRanker()`: lazy `resolveCerebellumConfig(getStore().get('app_config'))` per call (Settings edits apply next turn, no restart) + `session.defaultSession.fetch` bound. **This fetch injection is mandatory**: bare Node fetch gets HTTP 451 (region-blocked) for some networks; the Electron net stack follows the system proxy.

### 2.4 Group-task working memory (the "群任务忘事" fix)

Diagnosis (see `groupTaskDaemon` internals): assignments were only chat text inside a 20-message window; orchestration objectives and delivery deadlines were durable but never rendered; skill turns had **zero** memory reads (`disableMemoryUpdates: true` blacked out reads+writes while the daemon withheld its block on a false premise).

- `src/main/services/groupTaskWorkingState.ts` — pure `buildGroupTaskWorkingStateBlock(input)`: `<taskWorkingState>` from live steps/attempts + armed delivery clocks, overdue-first ordering, ≤12 entries / ≤2000 chars. Injected into the shared `volatileContext` of `buildTurnSystemPrompt` → every group-task turn (plain, skill, chair planning/report) sees it.
- `src/main/services/orchestratorCoworkBridge.ts` + `main.ts` — group-task skill turns now pass `memoryReadOnly: true` instead of `disableMemoryUpdates: true` (reads restored, writes stay off; the paid-order mode). New `memory_read_only_automation` system-prompt profile in `coworkRunner.ts` keeps the write-inviting Memory STRATEGY section unmounted.
- `src/main/services/groupTaskDaemon.ts` — owner-scope memory block now mounts on **both** paths; optional `cerebellumMemoryRanker` dep re-ranks the daemon block (same contract/limits). `buildScopedMemoryBlockFor` returns `string | Promise<string>` — **fully synchronous when the ranker is unwired**: the daemon tick's detached-job interleaving is timing-sensitive and one added microtask hop deterministically tripped the silent-chair re-drive test. Keep this shape.
- Private-chat and OpenTeam guest daemon bindings deliberately still use the blackout (external-facing sessions; flip only with a privacy review).

### 2.5 Related fixes & tooling

- `fix/memory-last-used-touch` — `last_used_at` now bumps only for memories actually rendered into a prompt (was: the whole 120–200-row candidate pool), fixing pool ordering and the hygiene decay clock. Same treatment for `knowledge_recall`'s category post-filter.
- `scripts/cerebellum-memory-eval.mjs` — offline A/B harness: faithful port of the lexical ranker vs a live JEV re-rank, embedded Chinese sample (24 memories × 10 queries), `--db` read-only export from a real `idbots.sqlite` (schema-tolerant), `--queries` labeled sets, `--dry-run` (prints what would leave the machine, zero API calls). First live run: **recall@5 lexical 3/10 vs cerebellum 9/10**, ~250 ms/query, ≈$0.0002/query.

### 2.6 Verification toolkit

- Logs: `<userData>/logs/cowork.log`, tags `memory:cerebellumRank` (per-turn activity) and `memory:promptBlocks` (pool/injected counts).
- Tests: `tests/cerebellumMemoryRank.test.mjs` (16), `tests/cerebellumConfig.test.mjs`, `tests/groupTaskWorkingState.test.mjs`, `tests/groupTaskSkillTurnMemoryReadOnly.test.mjs`, plus renderer suites `cerebellumConnection.test.ts` / `config.test.ts`. Many main-process suites import **compiled** code from `dist-electron/main/` — run `pnpm run compile:electron` after every `src/main` change.
- Known pre-existing failures (fail on base commits too, unrelated): `tests/skillTurnTimeoutRecovery.test.mjs`, `tests/privateChatSkillTurnDeliveryInvariant.test.mjs`, `tests/privateChatSkillTurnPolicy.test.mjs` — their mock stores miss `setSessionAutoOrigin` / `getRecentA2AThreadMessages` added by earlier commits.

## 3. Design rules (do not break)

1. **Never block a turn on the cerebellum.** 1.5 s hard timeout, null on any failure, silent lexical/code fallback. The cerebellum must be droppable mid-flight with zero user-visible effect.
2. **Never call JEV without `resolveCerebellumConfig`** and never log memory text or the API key.
3. **`fetchImpl` must be `session.defaultSession.fetch`** (system proxy). Bare Node fetch is region-blocked (HTTP 451).
4. Keep question instructions in **English**; keep the user's original-language text in `state`.
5. Don't ask JEV what code can compute (counting, dates, thresholds) — compose atomic judgments in code instead.
6. The `enabled` toggle is the user's global consent for sending memory content to the provider; new call sites must not widen what is sent beyond what the notice describes without a new notice.
7. Repo conventions (AGENTS.md): pnpm only (Node 24 via nvm: `export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"`); worktree-per-branch from `main`; `git merge --no-ff` into main; dev journal on-chain via the `metabot-post-buzz` skill after every commit; never push unless asked.

## 4. Roadmap — where the cerebellum goes next

Ranked by expected value. Each row names the concrete seam.

| # | Use case | Seam | Notes |
|---|---|---|---|
| 1 | **Memory write gate** | `src/main/libs/coworkMemoryJudge.ts` (`judgeTurnMemoryExtraction` / `judgeMemoryCandidate`) — JEV Noul "is this turn worth remembering?" as a cheap pre-filter; LLM still does extraction (JEV cannot generate) | Directly reduces brain-LLM calls; mirrors TypeSafe's basic-memory cookbook (gate at P≥0.5) |
| 2 | **Skill / MetaApp shortlist** | catalog injection at `coworkRunner.ts` `buildVolatileContextPrompt` (`skillsCatalogMode === 'volatile'`, ~line 5950); `skillManager.buildCoworkSkillPromptParts` | Cookbook measured wrong-loads 16.8%→7.3% on a 182-skill roster: wide Choice rank → top-3 re-read → one-line suggestion. Keep the catalog text byte-stable for prefix caching |
| 3 | **Volatile block gating** | `buildVolatileContextPrompt` — 8 blocks; one request, 8 Nouls "does this turn need block X?" | Cuts per-turn tokens and context rot; system-prompt head stays byte-stable |
| 4 | **Knowledge hot-layer ranking** | `src/main/metaidKnowledgeStore.ts` (~899) — currently newest-8 by `updated_at DESC`, zero relevance | Same `relevanceScoreById` pattern as memories |
| 5 | **Group-chat reply decision** | `src/main/services/cognitiveOrchestrator.ts` (~1087–1136) — today mention + random probability | Cheap relevance Noul; watch false-positive chattiness, tune with the gate nouls pattern |
| 6 | **privateChatDaemon re-rank** | `privateChatDaemon.ts` `buildPrivateReplyMemoryPromptBlocks` (~1960) — same DI dep as groupTaskDaemon | Wiring exists (`createCerebellumMemoryRanker`); also reconsider its blackout flag per privacy review |
| 7 | **MetaWeb two-layer refinement** (owner's idea) | backend returns coarse-grained candidates → bot-side cerebellum picks precise answers | Cloud-side first pass could also be JEV; design for provider swap from day one |
| 8 | **Dream triage** | `dreamService.ts` fragment pre-filter; `memoryHygieneService` deep-consolidation proposals (JEV proposes, LLM confirms) | Nightly/batch — latency-insensitive, cost-sensitive |
| 9 | **Task-done verification** | scheduled-task output / group-task deliverable checks | "Did this actually happen?" Noul on evidence |
| 10 | **Surf path selection** | `surfService.ts` candidate pins/links scoring | Nightly, batch |

Cross-cutting: validate every new question on real Chinese data first (Playground → `cerebellum-memory-eval.mjs` pattern); prefer top-k ranking over absolute thresholds (observed inflation of "generally useful" memories); tune thresholds per action risk; rate limits (80 rps, dynamic) are a non-issue for desktop use but batch pipelines need backoff.

## 5. Operational quick reference

- Turn it on: `Settings > Model > Cerebellum` → paste key → Test Connection → toggle on. Applies next turn, no restart.
- Confirm activity: `tail -f "$HOME/Library/Application Support/IDBots/logs/cowork.log" | grep -A 6 cerebellumRank` (`used:true` = ranking engaged; `used:false` with pooled ≥ 12 = fell back).
- Eval on real data: `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<proxy> TYPESAFE_API_KEY=<key> node scripts/cerebellum-memory-eval.mjs eval --db <idbots.sqlite> --metabot-id <id> --max-memories 200 --queries q.json` (add `--dry-run` first to preview what leaves the machine).
- Cost envelope: ~200 candidates ≈ 8K input tokens ≈ **$0.0003 per ranked turn**; output free.

## 6. On-chain dev journals (trace)

Merge journals: cerebellum MVP `0cba64a9…i0`; group-task working memory `937ad63c…i0`. Per-commit journals were posted for every commit on both feature lines (see the Buzz UI or the commit messages).
