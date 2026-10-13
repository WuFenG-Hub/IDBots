# AI Internet Preference Loop — Implementation Plan Overview

> **For agentic workers:** This file is the index. Implement ONE phase file at a time (`-p1-` … `-p5-`), in order. Inside a phase file use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans; steps use checkbox (`- [ ]`) syntax.

**Goal:** Let N MetaBots build competing human-facing MetaApps under one MetaTask, let humans (and shadow AI judges) pick the winner with sealed pairwise ballots, and publish distilled, evidence-backed lessons on-chain that future builders retrieve — with no change to the MetaTask protocol.

**Architecture:** A new protocol family `/protocols/preference/{round,commit,reveal,lesson}` (normative: `docs/metaid_protocols/09-preference.md`) with a pure deterministic TypeScript tally engine in `src/main/services/preference/`. Chain I/O reuses the MetaTask collector pattern and the existing pin writers (bot: `createPin`; human: `createPinForIdentity`). Bots use new agent tools; humans use a compare-review panel in the MetaTask tab. A competitive MetaTask links to a round through a terminal `LESSON` node whose rubric requires `parentrefs.UI` to equal the round winner.

**Tech Stack:** Electron 40 main process (TypeScript, CommonJS build to `dist-electron/`), sql.js-compatible `SqliteDatabase`, zod (agent tool schemas), React 18 + Tailwind (renderer), `node:test` tests against compiled output, Python 3 for MetaTask spec scripts.

**Companion design:** `docs/superpowers/specs/2026-10-14-ai-internet-preference-loop-design.md` (background, methodology, pilot, decisions register).

## Global Constraints

- The protocol doc `docs/metaid_protocols/09-preference.md` (v1.0.0) is normative. If code and doc disagree, stop and report the conflict to the planner; do not pick one silently.
- Node `>=24 <25`. pnpm only. Never run `npm install` / `npm ci` anywhere in the repo. Scripts run as `pnpm run <script>`.
- Every phase runs on its own branch + worktree created from `main` (names in the phase map below). Never branch from another feature branch. Never push. Never merge; the planner merges after acceptance.
- Worktree setup on the exFAT SSD, immediately after `git worktree add`: `git config extensions.worktreeConfig true` and `git -C .worktrees/<name> config --worktree core.filemode false`; then `pnpm install` inside the worktree. Do not delete `._*` files.
- `tests/` is gitignored: stage test files with `git add -f`.
- TypeScript strong typing: no `any` in new code (use `unknown` + narrowing). 2-space indent, single quotes, semicolons. Code comments in English, only for constraints the code cannot show.
- Engine code is pure: integer arithmetic only, no `Date.now()`, no I/O, no randomness (time and data are inputs).
- Canonical JSON is `canonJ` and hashing is `sha256Hex` from `src/main/services/metatask/canon.ts`. Do not write a second canonicalizer.
- User-facing strings: English + Chinese keys in `src/renderer/services/i18n.ts`. Theme via CSS variables (`var(--bg-main)`, `var(--bg-panel)`, `var(--text-primary)`, `var(--color-primary)`); no new `dark:` utilities. No `window.confirm` / `window.alert`.
- Database: new tables only, `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, idempotent on every start. Never delete or reset user data. The sealed-ballot table is a record of user data, not a cache.
- Commits: one commit per task, message `<type>: <short description>` (`feat|fix|refactor|docs|chore`). Before each commit run the task's tests plus `pnpm run compile:electron` (0 errors) and `pnpm run lint` (0 errors/warnings). After each commit post an English development-journal buzz with Codex's `metabot-post-buzz` skill (not `SKILLs/metabot-post-buzz`).
- Before handing a phase back: `pnpm run compile:electron`, `pnpm run build:skills`, `pnpm run lint`, `node --test tests/*.test.mjs`, and `pnpm run test:preference` all green (P4 also `pnpm run build`, the renderer type check; P5 runs `test:preference` only if P1 has merged, since P1 adds that script, and runs its own handoff checklist); paste the tail of each output into the handoff note.

---

## Prerequisite (planner)

P0. The planner reviews and merges branch `docs/preference-loop` (protocol draft, design, these plans) into `main` with `git merge --no-ff`. Phase branches are created from `main` only after that merge, so every phase sees the normative docs.

## Phase map

| Phase | Plan file | Branch / worktree | Deliverable | Depends on |
|---|---|---|---|---|
| P1 | `2026-10-14-preference-loop-p1-tally-engine.md` | `feat/preference-p1-engine` / `.worktrees/preference-p1-engine` | Schemas, commit sealing, pure tally engine, lesson validity, canonical round, conformance vectors | P0 |
| P2 | `2026-10-14-preference-loop-p2-chain-io.md` | `feat/preference-p2-chain-io` / `.worktrees/preference-p2-chain-io` | Collector, event cache + sealed-ballot store, service (read/write/auto-reveal), human + bot writers, main wiring, heartbeat | P1 merged |
| P3 | `2026-10-14-preference-loop-p3-agent-tools-skills.md` | `feat/preference-p3-tools` / `.worktrees/preference-p3-tools` | 6 agent tools, cowork wiring, new judge skill, `metabot-metaapp` + `metatask-wizard` updates | P2 merged |
| P4 | `2026-10-14-preference-loop-p4-compare-review-ui.md` | `feat/preference-p4-ui` / `.worktrees/preference-p4-ui` | IPC/preload, renderer service + helpers, compare panel, round list, MetaTask entry point, i18n | P2 merged (its mainnet Task 8 also needs P3 merged) |
| P5 | `2026-10-14-preference-loop-p5-pilot-kit.md` | `feat/preference-p5-pilot` / `.worktrees/preference-p5-pilot` | Q&A UI v2 builder pack, task drafts, UI gate + LESSON gate spec scripts with self-tests, round arguments, owner runbook | P0 only (Python, no app code); the launch needs P1–P4 merged and shipped |

P3 and P4 may run in parallel after P2 merges (they touch disjoint files except `main.ts`, where each adds its own block; the second to merge rebases). P5 may run any time after P0, in parallel with P1–P4.

## File structure (all phases)

```
src/main/services/preference/
  constants.ts        P1  paths, version, engine id, bounds, regexes, writer-side timing constants
  types.ts            P1  protocol + tally types (P2 keeps ballot-row types in store.ts and view types in service.ts)
  schemas.ts          P1  parse/validate round, commit, reveal envelope, ballot, lesson
  sealing.ts          P1  newBallotSalt(), ballotCommitHash()
  engine.ts           P1  compareOrderKey, resolveRound, statusAt, tallyRound
  lesson.ts           P1  checkLesson, verifyLessonPin, canonicalRoundForSubject
  collector.ts        P2  collectPreferenceEvents() over the four pools
  store.ts            P2  PreferenceStore: event cache, sealed ballots, compare telemetry
  service.ts          P2  PreferenceService: refresh, list/status/search, open/commit/lesson, revealDue
  userWriter.ts       P2  createUserPreferenceWriter() (human identity, serialized, UTXO threading)
  ipc.ts              P4  createPreferenceIpcHandlers(), toHumanRoundView() (no authors, salts, or bot ballots)
src/main/services/metatask/collector.ts   P2  export contentRecoveryUrl + recoverTruncatedBodies (no behavior change)
src/main/libs/preferenceAgentTools.ts     P3  buildPreferenceAgentTools() — 6 tools
src/main/libs/coworkRunner.ts             P3  preferenceTools option + registration
src/main/main.ts                          P2 getters/heartbeat; P3 tool wiring; P4 IPC + push event
src/main/preload.ts                       P4  window.electron.preference
src/renderer/types/preference.ts          P4  renderer mirror types
src/renderer/types/electron.d.ts          P4  preference API typing
src/renderer/services/preference.ts       P4  thin IPC wrapper
src/renderer/components/preference/
  preferencePairs.js          P4  pure helpers (pair schedule, ballot mapping) — node-testable
  PreferenceComparePanel.tsx  P4  side-by-side blind compare + ballot form + status view
  PreferenceSealConfirmModal.tsx P4  React confirmation modal (no window.confirm)
  PreferenceRoundsSection.tsx P4  "Preference rounds" list on the MetaTask board + per-task round buttons
src/renderer/components/metatask/MetaTaskDetail.tsx   P4  "Judge round" entry button
src/renderer/services/i18n.ts                         P4  preference.* keys (en + zh)
SKILLs/metaapp-preference-judge/SKILL.md   P3  new skill (judge + distiller)
SKILLs/skills.config.json                  P3  register the new skill
SKILLs/metabot-metaapp/SKILL.md            P3  lessons-first section, routing step, checklist item
SKILLs/metatask-wizard/SKILL.md            P3  taste-heavy routing → UI + LESSON shape
scripts/preference-build-vectors.mjs       P1  writes tests/fixtures/preference/tally-vectors.json
scripts/preference-vectors.mjs             P1  replays the fixture, prints CANONICAL_SHA256
scripts/preference-pilot/qanda-v2/         P5  builder pack, drafts template + embed script, UI/LESSON gate specs, self-test, round args, runbook
tests/fixtures/preference/scenarios.mjs    P1  shared scenario builders + expectation checker
tests/fixtures/preference/toolHarness.mjs  P3  real PreferenceService + fake chain for agent-tool tests
tests/fixtures/preference/tally-vectors.json P1 frozen conformance vectors
tests/preference*.test.mjs                 P1–P4
package.json                               P1 adds test:preference + vector scripts; later phases append test files
```

## Cross-phase contracts (exact names)

These names are fixed by P1/P2. Later phases import them verbatim.

```ts
// constants.ts
export const PREFERENCE_PROTOCOL_ROOT = '/protocols/preference';
export const PREFERENCE_SEGMENTS = ['round', 'commit', 'reveal', 'lesson'] as const;
export type PreferenceSegment = (typeof PREFERENCE_SEGMENTS)[number];
export const preferencePoolPath: (segment: PreferenceSegment) => string;
export const PREFERENCE_PIN_VERSION = '1.0.0';
export const PREFERENCE_TALLY_ENGINE = 'idbots-preference-tally/1.0.0';
export const COMMIT_CUTOFF_SEC = 1800;   // writer refuses commits within 30 min of commitCloseAt
export const REVEAL_DELAY_SEC = 1800;    // host reveals no earlier than commitCloseAt + 30 min
export const PILOT_CANDIDATE_CAP = 6;

// types.ts (P1)
PreferenceChainEvent, JudgeKind, JudgeClass, PairPick, RoundCandidate, RoundJudge, RoundDimension,
RoundBody, BallotPair, Ballot, CommitBody, RevealEnvelope, LessonPrinciple, LessonBody,
TallyStatus, TallyRankingEntry, TallyJudgeEntry, TallyOutput, TallyDiagnostics, TallyResult

// schemas.ts
export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };
parseRound(body: unknown, roundTimestampSec: number): ParseResult<RoundBody>
parseCommit(body: unknown): ParseResult<CommitBody>
parseRevealEnvelope(body: unknown): ParseResult<RevealEnvelope>
checkBallot(ballot: unknown, round: RoundBody): ParseResult<Ballot>
parseLesson(body: unknown): ParseResult<LessonBody>

// sealing.ts
newBallotSalt(): string
ballotCommitHash(input: { round: string; judge: string; salt: string; ballot: unknown }): string

// engine.ts
compareOrderKey(a: PreferenceChainEvent, b: PreferenceChainEvent): number
resolveRound(events: readonly PreferenceChainEvent[], roundPinId: string): RoundResolution
tallyRound(events: readonly PreferenceChainEvent[], roundPinId: string, options: { nowSec: number }): TallyRoundResult

// lesson.ts
checkLesson(body: unknown, tally: TallyResult): LessonVerdict
verifyLessonPin(events: readonly PreferenceChainEvent[], lessonPinId: string, nowSec: number): LessonVerdict
canonicalRoundForSubject(events, subject: { taskid: string; node: string; rootAuthor: string }, nowSec: number): CanonicalRoundResolution

// service.ts (P2)
export type PreferenceSigner = { type: 'user' } | { type: 'metabot'; metabotId: number };
class PreferenceService {
  refresh(reason: string): Promise<{ ok: boolean; eventCount: number; error: string | null }>;
  listRounds(filter?: { judge?: string; taskid?: string }): PreferenceRoundSummary[];
  roundStatus(roundPinId: string, options?: { lessonPinId?: string }): PreferenceRoundView | { error: string };
  canonicalRound(subject: { taskid: string; node: string; rootAuthor: string }): CanonicalRoundResolution;
  searchLessons(query?: { category?: string[]; limit?: number }): PreferenceLessonView[];
  openRound(signer: PreferenceSigner, body: unknown): Promise<{ pinId: string } | { error: string }>;
  commitBallot(signer: PreferenceSigner, roundPinId: string, ballot: unknown): Promise<{ pinId: string; ballotId: string } | { error: string }>;
  publishLesson(signer: PreferenceSigner, body: unknown): Promise<{ pinId: string } | { error: string }>;
  revealDue(): Promise<{ attempted: number; revealed: number; failed: number; expired: number }>;
  hasActiveBallots(): boolean;
  recordTelemetry(roundPinId: string, pairKey: string, seconds: number): void;
}
```

## Planner acceptance gates

The planner checks these on the handed-back branch before merging. A phase is rejected if any box fails; the dev agent fixes on the same branch.

**P1 — engine**
- [ ] `pnpm run test:preference` green; `node scripts/preference-vectors.mjs` prints `ALL VECTORS PASS` and a `CANONICAL_SHA256` equal to the one stored in the fixture.
- [ ] The fixture holds the 19 vectors listed in the P1 plan (they cover all 17 items of protocol §8).
- [ ] Spot-check by hand: vector `agreement` reports A1 `agreementBP` 6000, H1 6666, H3 4000.
- [ ] `engine.ts`, `schemas.ts`, `lesson.ts` contain no `Date`, `Math.random`, `fetch`, `fs`, or float math (`grep -nE "Date|random|fetch|require\\('fs'|\\.toFixed|parseFloat"` returns nothing).
- [ ] No file outside `src/main/services/preference/`, `scripts/preference-*.mjs`, `tests/`, `package.json` changed.

**P2 — chain I/O**
- [ ] `pnpm run test:metatask` still green (collector export refactor is behavior-neutral).
- [ ] Ballot store survives app restart (test re-opens the store on the same DB); salts never appear in any IPC/tool view type.
- [ ] Auto-reveal tests cover: not before `commitCloseAt + REVEAL_DELAY_SEC`; idempotent; retries ≤ 5 then `reveal_failed`; re-reveal when the confirmed reveal landed at or before `commitCloseAt`; expiry after `revealCloseAt`.
- [ ] Human writer serializes writes and threads `spentOutpoints` / `changeUtxo` like `syncUserIdentityToChain`.
- [ ] Heartbeat handler `preference.reveal` does no network work when `hasActiveBallots()` is false.

**P3 — tools + skills (includes the first mainnet run)**
- [ ] Tool unit tests green; every tool refuses before any chain write on invalid input.
- [ ] Throwaway mainnet round (category `test:preference-smoke`, 2 candidates = two existing MetaApp pins, 2 local bots as `ai` judges, `decision.kinds: ["ai"]`, `minBallots: 2`, `commitHours: 2`, `revealHours: 2` — 2 h is the shortest commit window the writer accepts, because of the 30 min confirmation margin): open → both bots commit → host auto-reveals → `preference_round_status` shows `decided` with a `tallyHash` → a lesson is published and reported valid. Record all pinIds in the handoff note.
- [ ] `preference_round_status` never shows candidate authors or another local judge's sealed ballot, and shows reasons only after the commit window closes (unit tests).
- [ ] `metabot-metaapp` and `metatask-wizard` diffs read correctly in context (planner reads the rendered files).

**P4 — compare review UI**
- [ ] Second throwaway round with the local human identity as the only `human` judge (`minBallots: 1`): the owner judges every pair in the panel, confirms in the modal, the commit pin appears, the host reveals after close, and the panel shows the final tally.
- [ ] Left/right order differs between two judges for the same round (unit test on `buildPairSchedule`), builder identities never rendered, own-candidate pairs never shown, and the IPC view never contains a salt or a MetaBot-signed sealed ballot (`tests/preferenceIpc.test.mjs`).
- [ ] `pnpm run build` (renderer type check) green.
- [ ] All new strings exist in both `en` and `zh`; no `dark:` utilities added; light and dark themes screenshot-checked.

**P5 — pilot kit**
- [ ] `python3 scripts/metatask-wizard/validate-task-draft.py scripts/preference-pilot/qanda-v2/task-drafts.json` prints `TASK DRAFT READY` with exactly two WARNs: the `UI` weight 7000 > 4000 (deliberate) and the `ARTIFACT_PIN:qanda-v2-pack` placeholder, which the owner backfills at launch (then one WARN).
- [ ] `python3 scripts/preference-pilot/qanda-v2/selftest-gates.py --require-render` prints `SELFTEST GREEN` with 35 `ok` lines — the six headless-browser render cases ran, not skipped.
- [ ] `embed-specs.py --check` reports the drafts are fresh.
- [ ] The two live smoke runs (P5 Task 2 Step 3, Task 3 Step 3) match the plan's expected output.
- [ ] `git diff --stat main` lists only `scripts/preference-pilot/qanda-v2/*`.
- [ ] Runbook and builder pack reviewed by the planner against design §6.

## Handoff note (dev agent → planner)

At the end of a phase, reply with: branch name and head commit; one line per commit; the verification command outputs (tails); every deviation from the plan with the reason; open questions. Do not merge, push, or delete the worktree — the planner does that after acceptance.

## Decisions that block phases

The owner confirmed D2–D11 (design §10) on 2026-10-14, and the plans implement them. If the owner later changes one, the planner updates the affected plan before the phase starts: D2/D3 → P2 writers + P4; D4/D5 → P1 engine + P2 reveal timing; D6/D7 → P1; D8 → P3 tools + P5 rubrics; D9 → P3 lesson tools; D10 → P5; D11 → P4 + P5 rubric.
