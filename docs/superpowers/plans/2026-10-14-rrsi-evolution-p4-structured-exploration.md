# RRSI Evolution P4 — Structured Exploration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a bot's self-improvement has stalled, and then steer one of the night's practice proposals toward a component the bot has not exercised recently — especially the network-facing ones (skills, remote services, collaboration, MetaApps) — without loosening any risk or approval rule.

**Architecture:** Practice proposals gain a `component` from a fixed vocabulary. A pure module decides from the telemetry rollup and recent proposals whether the bot is stalled, lists the under-explored components, renders a Chinese directive section for the dream prompt, and judges compliance. While stalled, the existing read-only auto-approval drains under-explored proposals first (ordering only). The dream prompt and parser change, so `DREAM_VERSION` goes up by one.

**Tech Stack:** TypeScript main process, sql.js stores, `node:test` against `dist-electron/`.

**Index / acceptance gate:** `docs/superpowers/plans/2026-10-14-rrsi-evolution-00-overview.md` (P4 gate). **Design:** spec §6.4. **Prerequisite:** P1 merged into `main` (P4 may run in parallel with P2/P3; see the overview for the shared files).

## Global Constraints

All constraints in the overview apply. Phase-specific:

- Branch `feat/rrsi-p4-explore`, worktree `.worktrees/rrsi-p4-explore`, from `main`. Never push, never merge.
- Risk classes, the owner-approval rules, `PRACTICE_PROPOSALS_MAX_PER_NIGHT`, and the practice feature flags are **unchanged**. Non-read-only proposals never auto-approve. No new approval is created; only the order of the existing auto-approvals changes.
- Stall detection reads only nights **before** the dreamed date, so a re-run of the same night is deterministic.
- `DREAM_VERSION` goes up by exactly one in this phase (main + 1; 18 when only P1 has bumped), with one `vN:` doc-comment line. The bump lands in Task 2 and covers Task 3 too (same branch, unreleased).
- If P2/P3 merged first, rebase and keep both sides in `runDream`'s telemetry blocks, `package.json`, `.gitignore`, and the report script.
- One commit per task + English dev-journal buzz after each commit.

## Constants (exact)

| Name | Value |
|---|---|
| `PRACTICE_COMPONENTS` | `['memory', 'procedure', 'skill', 'remote_service', 'collaboration', 'metaweb', 'metaapp']` |
| `STRUCTURAL_PRACTICE_COMPONENTS` | `['skill', 'remote_service', 'collaboration', 'metaapp']` |
| `STALL_WINDOW_DAYS` | 7 |
| `STALL_WINDOW_COUNT` | 3 |
| `STALL_MIN_ACTIVE_NIGHTS_PER_WINDOW` | 3 |
| `COLLAPSE_LOOKBACK_DAYS` | 14 |
| `COLLAPSE_MIN_PROPOSALS` | 4 |
| `UNDER_EXPLORED_LOOKBACK_DAYS` | 30 |

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/libs/evolutionExploration.ts` | Create: vocabulary, `normalizePracticeComponent`, `detectEvolutionStall`, `listUnderExploredComponents`, `renderExplorationDirective`, `judgeExplorationCompliance`, `orderPracticeProposalsForApproval` |
| `src/main/libs/predictionLedger.ts` | Add the `export` keyword to the existing `shiftDateKey` (identical to P3's change) |
| `src/main/libs/dreamPrompt.ts` | `component` in the output schema + guidance; `explorationDirective` input section; parse `component`; `DREAM_VERSION` + 1 |
| `src/main/sqliteStore.ts` | `dream_practice_proposals.component TEXT` via `addProposalColumn` |
| `src/main/coworkStore.ts` | `DreamPracticeProposalRecord.component`; insert / select / mapper |
| `src/main/dreamStore.ts` | `listDreamTelemetryDailyRange`; shared row mapper |
| `src/main/services/dreamService.ts` | `evaluateExplorationState`; directive into `dreamExtras`; compliance; approval ordering; `exploration` telemetry on both paths |
| `scripts/rrsi-evolution-report.mjs` | `exploration` section |
| `tests/evolutionExploration.test.mjs` | Create |
| `tests/dreamPrompt.test.mjs`, `tests/rrsiEvolutionReport.test.mjs` | Append / repair |
| `package.json`, `.gitignore` | Append / allowlist the new test file |

---

### Task 0: Worktree and baseline

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots
git worktree add .worktrees/rrsi-p4-explore -b feat/rrsi-p4-explore main
git config extensions.worktreeConfig true
git -C .worktrees/rrsi-p4-explore config --worktree core.filemode false
cd .worktrees/rrsi-p4-explore
pnpm install
test -f src/main/libs/capabilityGateRegularizers.ts && echo "P1 present"
grep -n "export const DREAM_VERSION" src/main/libs/dreamPrompt.ts
```

Expected: `P1 present` and the current version (record it in the baseline file as `DREAM_VERSION_BEFORE`).

- [ ] **Step 2: Baseline** — same commands as P1 Task 0 Step 2, writing `localdocs/rrsi-p4-baseline.txt`.

---

### Task 1: Pure exploration module and stall vectors

**Files:**
- Create: `src/main/libs/evolutionExploration.ts`
- Modify: `src/main/libs/predictionLedger.ts` (`export const shiftDateKey`)
- Test: `tests/evolutionExploration.test.mjs`

**Interfaces:**

```ts
export const PRACTICE_COMPONENTS = ['memory', 'procedure', 'skill', 'remote_service', 'collaboration', 'metaweb', 'metaapp'] as const;
export type PracticeComponent = (typeof PRACTICE_COMPONENTS)[number];
export const STRUCTURAL_PRACTICE_COMPONENTS: readonly PracticeComponent[];
export function normalizePracticeComponent(value: unknown): PracticeComponent | null;

export type ExplorationStallReason = 'no_acceptance' | 'component_collapse';
export interface ExplorationNight { dreamDate: string; emptyDay: boolean; validated: number; promoted: number }
export interface ExplorationProposal { dreamDate: string; component: PracticeComponent | null }
export interface ExplorationStall { stalled: boolean; reason: ExplorationStallReason | null; dominantComponent: PracticeComponent | null }

export function detectEvolutionStall(input: { date: string; nights: readonly ExplorationNight[]; proposals: readonly ExplorationProposal[] }): ExplorationStall;
export function listUnderExploredComponents(input: { date: string; proposals: readonly ExplorationProposal[]; dominantComponent?: PracticeComponent | null }): PracticeComponent[];
export function renderExplorationDirective(input: { reason: ExplorationStallReason; underExplored: readonly PracticeComponent[]; dominantComponent?: PracticeComponent | null }): string;
export function judgeExplorationCompliance(input: { directed: boolean; underExplored: readonly PracticeComponent[]; proposals: ReadonlyArray<{ component: PracticeComponent | null }> }): boolean | null;
export function orderPracticeProposalsForApproval<T extends { component: PracticeComponent | null }>(oldestFirst: readonly T[], input: { stalled: boolean; underExplored: readonly PracticeComponent[] }): T[];
```

**Behavior (exact):**

- `normalizePracticeComponent`: string → `trim().toLowerCase()`; `-` and spaces become `_`; in the vocabulary → that value; else `null`.
- **Windows** (all strictly before `date`; `shiftDateKey` from `predictionLedger.ts`): window `w` (`w = 1…3`) covers `[date − 7w, date − 7w + 6]`, i.e. W1 = `date−7 … date−1`, W2 = `date−14 … date−8`, W3 = `date−21 … date−15`.
- **No acceptance:** every window has ≥ 3 nights with `emptyDay === false`, and the sum of `validated + promoted` over all nights in the three windows is 0.
- **Component collapse:** proposals with `dreamDate` in `[date−14, date−1]` and a non-null component; count ≥ 4 and all share one component → `dominantComponent` = that component.
- Precedence: if both hold, `reason = 'no_acceptance'` (and `dominantComponent` is still reported when collapse also holds). Neither → `{ stalled: false, reason: null, dominantComponent: null }`.
- **Under-explored:** components of `PRACTICE_COMPONENTS` (in vocabulary order) with no proposal whose `dreamDate` is in `[date−30, date−1]`, excluding `dominantComponent`. If that list is empty, return `STRUCTURAL_PRACTICE_COMPONENTS` minus `dominantComponent`.
- **Directive (exact text; labels from the table below):**

```
## 探索提示(你的自我进化最近停滞了:{reasonText})
最近 30 天里你还没有在这些方向上出过练习:{label1}、{label2}…
今晚的 practice_proposals 里,至少一条的 component 要从上面这些方向里选;另一条照常针对记录在案的薄弱点。
出处规则不变:每条提案仍然必须有 target_refs,risk_class 照实填写;找不到有出处的目标时,宁可少出一条,也不要编造。
```

  `reasonText`: `no_acceptance` → `连续三周有活动,但没有新的能力通过验证或固化`; `component_collapse` → `最近两周的练习都集中在 {label of dominantComponent}`.
  Labels: `memory` → `memory(整理与运用记忆)`, `procedure` → `procedure(固定流程)`, `skill` → `skill(调用或组合技能)`, `remote_service` → `remote_service(调用其他 Bot 的付费服务)`, `collaboration` → `collaboration(与其他 Bot 协作完成任务)`, `metaweb` → `metaweb(阅读与引用链上内容)`, `metaapp` → `metaapp(使用或发布 MetaApp)`.
- **Compliance:** `directed === false` → `null`; else `true` iff some proposal's component is in `underExplored` (zero proposals → `false`).
- **Approval ordering:** `stalled === false` → input order unchanged. Otherwise stable partition: proposals whose component is in `underExplored` first, then the rest, each part keeping its input (oldest-first) order.

- [ ] **Step 1: Write the failing test** with `D = '2026-09-01'` and a helper `nights(fromDate, toDate, { emptyEvery?, validatedOn? })`:
  1. *No acceptance:* 21 non-empty nights `2026-08-11 … 2026-08-31`, all zero → `{ stalled: true, reason: 'no_acceptance', dominantComponent: null }`.
  2. *One acceptance breaks it:* same, but `validated: 1` on `2026-08-20` → not stalled.
  3. *Not active enough:* W3 (`2026-08-11 … 2026-08-17`) has only 2 non-empty nights → not stalled; with exactly 3 → stalled.
  4. *Nights on `date` itself are ignored:* a `validated: 1` night dated `2026-09-01` does not break vector 1.
  5. *Collapse threshold:* 4 proposals in `[2026-08-18, 2026-08-31]`, all `memory` → `component_collapse`, dominant `memory`; 3 proposals → not stalled; 4 proposals with one `skill` → not stalled; null components are ignored (4 `memory` + 2 `null` → collapse).
  6. *Both:* vector 1 nights + vector 5 proposals → `reason: 'no_acceptance'`, `dominantComponent: 'memory'`.
  7. *Under-explored:* proposals in the last 30 days with components `memory`, `skill` → `['procedure', 'remote_service', 'collaboration', 'metaweb', 'metaapp']`; with `dominantComponent: 'memory'` the result is the same (memory already excluded); a proposal dated `2026-08-01` (31 days before) does not count as recent; all seven used → structural list.
  8. *Directive:* exact string for `no_acceptance` with `['skill', 'metaapp']`; for `component_collapse` the first line contains `memory(整理与运用记忆)`.
  9. *Normalize:* `'Remote-Service'` → `'remote_service'`, `' metaapp '` → `'metaapp'`, `'wallet'` → `null`, `7` → `null`.
  10. *Compliance:* not directed → `null`; directed + `[{ component: 'skill' }]` with `['skill']` → `true`; directed + `[{ component: 'memory' }]` → `false`; directed + `[]` → `false`.
  11. *Ordering:* oldest-first `[m1(memory), s1(skill), m2(memory), r1(remote_service)]` stalled with `['skill', 'remote_service']` → `[s1, r1, m1, m2]`; not stalled → unchanged.
- [ ] **Step 2: Run to verify it fails.** `pnpm run compile:electron && node --test tests/evolutionExploration.test.mjs`
- [ ] **Step 3: Implement.** No `Date.now()` in the module.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** Append `tests/evolutionExploration.test.mjs` to `test:rrsi`; allowlist it.
- [ ] **Step 6: Commit**

```bash
git add src/main/libs/evolutionExploration.ts src/main/libs/predictionLedger.ts package.json .gitignore
git add -f tests/evolutionExploration.test.mjs
git commit -m "feat: add practice component vocabulary and stall detection"
```

---

### Task 2: `component` on practice proposals (schema, parse, store) and version bump

**Files:**
- Modify: `src/main/libs/dreamPrompt.ts` (output schema ~785–793; practice guidance ~802; parse ~1059–1097; `DreamPracticeProposal` type; `DREAM_VERSION` ~54)
- Modify: `src/main/sqliteStore.ts` (`addProposalColumn('component', 'component TEXT')` ~719)
- Modify: `src/main/coworkStore.ts` (`DreamPracticeProposalRecord` ~968, `DreamPracticeProposalRow`, `insertDreamPracticeProposals` ~7800, the three SELECT lists ~7875 / ~7893 / ~8039, `mapDreamPracticeProposalRow`)
- Test: `tests/evolutionExploration.test.mjs` (append), `tests/dreamPrompt.test.mjs` (append / repair)

**Behavior:**

- Output schema: insert after the `"expected_evidence"` line (so `risk_class` stays last):
  `'      "component": "这条练习锻炼的方向,七选一:memory / procedure / skill / remote_service / collaboration / metaweb / metaapp",'`
- Guidance: append to the practice-proposal paragraph (before its final `没有合适目标就给空数组。`): `每条提案都要填写 component(七选一),写出它实际锻炼的方向;`
- Parse: `component: normalizePracticeComponent(entry.component)` on every proposal; the `DreamPracticeProposal` type gains `component: PracticeComponent | null`.
- Store: the column is nullable with no default; `insertDreamPracticeProposals` accepts `component?: string | null` and writes `normalizePracticeComponent(proposal?.component)`; the record gains `component: PracticeComponent | null` (old rows read `null`).
- `DREAM_VERSION` = previous + 1, with the doc line `v{N}: RRSI P4 — practice proposals carry a component; stalled bots get an exploration directive section.`

- [ ] **Step 1: Write the failing tests:**
  1. `parseDreamOutput` with `practice_proposals[0].component = 'Skill'` → `'skill'`; `'wallet'` → `null`; missing → `null`.
  2. `buildDreamPrompt` output contains `"component": "这条练习锻炼的方向` and the guidance sentence.
  3. Store: insert with `component: 'remote_service'` and with `component: 'nope'` → read back `'remote_service'` and `null`; a row inserted by raw SQL without the column value reads `component: null`; running the `sqliteStore` migration twice is harmless.
  4. `DREAM_VERSION === DREAM_VERSION_BEFORE + 1`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS. `tests/dreamPrompt.test.mjs` assertions that pin the exact schema or version change here by design — update and log them.
- [ ] **Step 5: Commit**

```bash
git add src/main/libs/dreamPrompt.ts src/main/sqliteStore.ts src/main/coworkStore.ts
git add -f tests/evolutionExploration.test.mjs tests/dreamPrompt.test.mjs
git commit -m "feat: record the component each practice proposal exercises"
```

---

### Task 3: Exploration directive in the dream, compliance telemetry

**Files:**
- Modify: `src/main/dreamStore.ts` (`listDreamTelemetryDailyRange` next to `listDreamTelemetryDaily` ~947; extract the row mapper)
- Modify: `src/main/libs/dreamPrompt.ts` (`explorationDirective?: string | null` input; section after the prediction-calibration section ~620)
- Modify: `src/main/services/dreamService.ts` (`evaluateExplorationState`; `dreamExtras.explorationDirective`; the three `buildDreamPrompt` calls ~957 / ~984 / ~1028; telemetry on both paths)
- Test: `tests/evolutionExploration.test.mjs` (append flow section)

**Interfaces:**

```ts
DreamStore.listDreamTelemetryDailyRange(metabotId: number, fromDate: string, toDate: string): DreamTelemetryDaily[]; // inclusive, ascending
// dreamService.ts (private)
evaluateExplorationState(metabotId: number, date: string): { stall: ExplorationStall; underExplored: PracticeComponent[]; directive: string | null };
```

**Behavior:**

- `evaluateExplorationState` (in `try/catch`; on failure `{ stall: not stalled, underExplored: [], directive: null }`):
  - nights = `listDreamTelemetryDailyRange(metabotId, shiftDateKey(date, -21), shiftDateKey(date, -1))` mapped to `{ dreamDate, emptyDay, validated: validationValidated ?? 0, promoted: promotedCount ?? 0 }`;
  - proposals = `listDreamPracticeProposals(metabotId, { limit: 200 })` mapped to `{ dreamDate, component }`;
  - `stall = detectEvolutionStall(...)`; `underExplored = stall.stalled ? listUnderExploredComponents({ date, proposals, dominantComponent: stall.dominantComponent }) : []`; `directive = stall.stalled ? renderExplorationDirective(...) : null`.
- Call it once per run, right after `buildPredictionCalibrationDigest` (~1119), **before** the empty-day branch, so both paths share it.
- Pass `explorationDirective: exploration.directive` through `dreamExtras` into all three `buildDreamPrompt` calls; `buildDreamPrompt` renders it verbatim as its own section when `sourceMode !== 'fragment'` and the text is non-empty. Fragment prompts never carry it.
- Compliance on the non-empty path: `judgeExplorationCompliance({ directed: exploration.directive != null, underExplored, proposals: output.practiceProposals ?? [] })`.
- Telemetry `exploration: { stalled, reason, underExplored, directed, complied }` on both paths; on the empty-day path `directed: false`, `complied: null` (no dream prompt was sent).

- [ ] **Step 1: Write the failing flow tests** (harness):
  1. *Not stalled:* no telemetry history → the dream prompt (fallback call's `system + user`) does not contain `## 探索提示`; `telemetry.exploration` deep-equals `{ stalled: false, reason: null, underExplored: [], directed: false, complied: null }`.
  2. *Stalled, complied:* insert 21 non-empty zero rows into `metabot_dream_telemetry_daily` by raw SQL for the 21 days before D → the dream prompt contains `## 探索提示` and `连续三周有活动`; the fallback returns one proposal with `component: 'skill'` and a `target_refs` entry → `exploration.directed === true`, `complied === true`, `reason === 'no_acceptance'`; the stored proposal has `component: 'skill'`.
  3. *Stalled, not complied:* same history, the proposal's component is `memory` while `memory` was used in the last 30 days (seed one earlier `memory` proposal) → `complied === false`.
  4. *Empty day while stalled:* no activity on D → `exploration.stalled === true`, `directed === false`, `complied === null`.
  5. `listDreamTelemetryDailyRange` returns inclusive bounds in ascending order and ignores other bots.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/dreamStore.ts src/main/libs/dreamPrompt.ts src/main/services/dreamService.ts
git add -f tests/evolutionExploration.test.mjs
git commit -m "feat: direct stalled bots toward under-explored practice components"
```

---

### Task 4: Under-explored proposals approve first while stalled

**Files:**
- Modify: `src/main/services/dreamService.ts` (`processPracticeProposalsAfterDream` ~2008: new parameter; both call sites ~1147 and ~1216)
- Test: `tests/evolutionExploration.test.mjs` (append)

**Behavior:**

- Signature: `processPracticeProposalsAfterDream(metabot, exploration: { stalled: boolean; underExplored: readonly PracticeComponent[] })`.
- Replace the selection with:

```ts
const pending = orderPracticeProposalsForApproval(
  this.deps.coworkStore.listDreamPracticeProposals(metabot.id, { status: 'pending' })
    .reverse()
    .filter((proposal) => proposal.riskClass === 'read_only'),
  { stalled: exploration.stalled, underExplored: exploration.underExplored },
).slice(0, PRACTICE_PROPOSALS_MAX_PER_NIGHT);
```

  The read-only filter runs **before** ordering and slicing, exactly as today; the policy flags and `createPracticeScheduledTask` checks are unchanged.

Note: `underExplored` is computed before tonight's proposals are written, so the components that get the bonus are the ones the bot had not touched in the last 30 days — in practice, tonight's directed proposals.

- [ ] **Step 1: Write the failing tests** (harness with `practiceTasksEnabled` and `practiceAutoApproveReadOnly` on — follow the existing practice-pipeline tests for how the policy is set, and pass a `createPracticeScheduledTask` stub that records calls). Before night D, insert two pending read-only `memory` proposals with `insertDreamPracticeProposals` (dream dates D−2 then D−1, so oldest-first order is D−2, D−1). Night D's dream output proposes `skill` (read_only) and `metaapp` (chain_write).
  1. *Stalled* (21 non-empty zero telemetry rows before D): approved in order `skill`, then `memory` (D−2); `memory` (D−1) stays pending; the `metaapp` chain_write proposal stays pending.
  2. *Not stalled* (no telemetry history): approved `memory` (D−2), then `memory` (D−1) — today's oldest-first behavior; `skill` stays pending.
  3. Total approvals equal `PRACTICE_PROPOSALS_MAX_PER_NIGHT` (2) in both cases, and the stub was called once per approval.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm run test:rrsi` and the existing practice-pipeline test files (`rg -l "processPracticeProposals|practiceAutoApproveReadOnly" tests`) → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/main/services/dreamService.ts
git add -f tests/evolutionExploration.test.mjs
git commit -m "feat: approve under-explored read-only practice first while stalled"
```

---

### Task 5: Report `exploration` section

**Files:** Modify `scripts/rrsi-evolution-report.mjs`; append to `tests/rrsiEvolutionReport.test.mjs`.

**Report shape (added per bot):**

```js
exploration: {
  stalledNights: 0,
  reasons: { no_acceptance: 0, component_collapse: 0 },
  directedNights: 0,
  compliedNights: 0,
  complianceRate: null,        // compliedNights / directedNights, 4 decimals; null when 0/0
  componentMix: { memory: 0, procedure: 0, skill: 0, remote_service: 0, collaboration: 0, metaweb: 0, metaapp: 0, unknown: 0 },  // proposals created in the window
  directedRiskMix: { read_only: 0, interact_local: 0, chain_write: 0 },  // proposals whose dream_date is a directed night
}
```

`componentMix.unknown` counts `component IS NULL`; when the `component` column is missing every proposal counts as `unknown`.

Text line: `  exploration: stalled 5 nights (no_acceptance 5), directed 4, complied 3 → 75.00%; mix skill 2, memory 3, unknown 1; directed risk read_only 3, chain_write 1`.

- [ ] **Step 1: Write the failing test** with telemetry for 4 nights and 5 proposals; assert every field and the line; a DB without the column → all `unknown`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add scripts/rrsi-evolution-report.mjs
git add -f tests/rrsiEvolutionReport.test.mjs
git commit -m "feat: report exploration stalls, compliance and component mix"
```

---

### Task 6: Phase verification and handoff

- [ ] **Step 1:** Run the full verification block from P1 Task 10 (grep target: `src/main/libs/evolutionExploration.ts`).
- [ ] **Step 2:** Confirm exactly one `DREAM_VERSION` change: `git diff main -- src/main/libs/dreamPrompt.ts | grep -c "^+export const DREAM_VERSION"` → `1`, and the new `vN:` line exists.
- [ ] **Step 3:** Self-check the P4 gate in the overview.
- [ ] **Step 4:** Handoff note (overview format), including `localdocs/rrsi-p4-test-changes.md`.
