# Preference Loop P1 — Tally Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the pure, deterministic `/protocols/preference` core — payload schemas, commit sealing, the Copeland tally, lesson validity, the canonical-round rule — plus frozen conformance vectors.

**Architecture:** Six small modules under `src/main/services/preference/` with no I/O. Tests run against the compiled `dist-electron/` output. A shared scenario module builds synthetic chains (with real commit hashes) and carries hand-authored expectations; a generator freezes them into a JSON fixture that a replay script checks, including a canonical digest of every engine output.

**Tech Stack:** TypeScript (main-process build), `node:crypto`, `node:test`.

**Index / acceptance gate:** `docs/superpowers/plans/2026-10-14-preference-loop-00-overview.md` (P1 gate). **Normative spec:** `docs/metaid_protocols/09-preference.md`.

## Global Constraints

- `docs/metaid_protocols/09-preference.md` (v1.0.0) is normative. On any conflict, stop and report it to the planner.
- Node `>=24 <25`; pnpm only; never `npm install` / `npm ci`; run scripts as `pnpm run <script>`.
- Branch `feat/preference-p1-engine`, worktree `.worktrees/preference-p1-engine`, created from `main`. Never push, never merge.
- `tests/` is gitignored: stage test files with `git add -f`.
- Strong typing, no `any`; 2-space indent, single quotes, semicolons; English comments only where the code cannot show a constraint.
- Engine modules (`schemas.ts`, `engine.ts`, `lesson.ts`) are pure: integer math only, no `Date`, no randomness, no I/O.
- Canonical JSON = `canonJ`, hash = `sha256Hex`, both from `src/main/services/metatask/canon.ts`.
- One commit per task, `<type>: <short description>`. Before each commit: the task's tests, `pnpm run compile:electron` (0 errors), `pnpm run lint` (0 errors/warnings). After each commit: an English dev-journal buzz with Codex's `metabot-post-buzz` skill.
- Phase handoff: `pnpm run compile:electron`, `pnpm run build:skills`, `pnpm run lint`, `node --test tests/*.test.mjs`, `pnpm run test:preference` all green.

---

## File structure

| File | Responsibility |
|---|---|
| `src/main/services/preference/constants.ts` | Paths, versions, engine id, bounds, regexes, writer-side timing constants |
| `src/main/services/preference/types.ts` | Protocol payload types and tally output types |
| `src/main/services/preference/schemas.ts` | Parse + validate round / commit / reveal envelope / ballot / lesson |
| `src/main/services/preference/sealing.ts` | Salt generation and the commit hash |
| `src/main/services/preference/engine.ts` | Order key, round resolution, status, `tallyRound` |
| `src/main/services/preference/lesson.ts` | Lesson validity, lesson-pin verification, canonical round for a subject |
| `tests/fixtures/preference/scenarios.mjs` | Synthetic chain builders, 19 scenarios with hand-authored expectations, `checkScenario` |
| `tests/preferenceSchemas.test.mjs` | Schema tests |
| `tests/preferenceSealing.test.mjs` | Commit-hash vector tests |
| `tests/preferenceEngine.test.mjs` | Scenario + invariance tests |
| `tests/preferenceLesson.test.mjs` | Lesson + canonical-round tests |
| `scripts/preference-build-vectors.mjs` | Writes `tests/fixtures/preference/tally-vectors.json` |
| `scripts/preference-vectors.mjs` | Replays the fixture, prints `CANONICAL_SHA256`, exits 1 on any mismatch |
| `package.json` | `test:preference`, `preference:vectors`, `preference:vectors:build` scripts |

---

### Task 0: Worktree

- [ ] **Step 1: Create the worktree from `main`**

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots
git worktree add .worktrees/preference-p1-engine -b feat/preference-p1-engine main
git config extensions.worktreeConfig true
git -C .worktrees/preference-p1-engine config --worktree core.filemode false
cd .worktrees/preference-p1-engine
pnpm install
test -f docs/metaid_protocols/09-preference.md && echo "protocol doc present"
```

Expected: `protocol doc present`. If it is missing, `docs/preference-loop` has not been merged yet — stop and tell the planner.

All later paths are relative to `.worktrees/preference-p1-engine`.

---

### Task 1: Constants, types, and schemas

**Files:**
- Create: `src/main/services/preference/constants.ts`
- Create: `src/main/services/preference/types.ts`
- Create: `src/main/services/preference/schemas.ts`
- Create: `tests/fixtures/preference/scenarios.mjs` (helpers only in this task; scenarios are added in Task 3)
- Test: `tests/preferenceSchemas.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: everything in the "Cross-phase contracts" block of the overview for `constants.ts`, `types.ts`, `schemas.ts`; test helpers `pid`, `gid`, `saltOf`, `ROUND_AT`, `COMMIT_CLOSE`, `REVEAL_CLOSE`, `FINAL_NOW`, `TWIN`, `B1..B3`, `H1..H3`, `A1`, `P1`, `CANDIDATES`, `DEFAULT_JUDGES`, `roundBody`, `pair`, `ballot`.

- [ ] **Step 1: Write the test helpers**

Create `tests/fixtures/preference/scenarios.mjs`:

```js
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Loaded lazily so schema tests run before sealing.ts exists. */
const sealing = () => require('../../../dist-electron/main/services/preference/sealing.js');

export const pid = (n) => `${n.toString(16).padStart(64, '0')}i0`;
export const gid = (name) => `idq1${name}`.padEnd(42, '0');
export const saltOf = (n) => n.toString(16).padStart(64, '0');

export const ROUND_AT = 1_792_000_000;
export const COMMIT_CLOSE = ROUND_AT + 86_400;
export const REVEAL_CLOSE = COMMIT_CLOSE + 86_400;
export const FINAL_NOW = REVEAL_CLOSE + 7_201;

export const TWIN = gid('twin1');
export const B1 = gid('builder1');
export const B2 = gid('builder2');
export const B3 = gid('builder3');
export const H1 = gid('human1');
export const H2 = gid('human2');
export const H3 = gid('human3');
export const A1 = gid('ai1');
export const P1 = gid('public1');

export const CANDIDATES = [
  { id: 'c1', ref: pid(1), artifact: `metaapp://${pid(11)}`, author: B1 },
  { id: 'c2', ref: pid(2), artifact: `metaapp://${pid(12)}`, author: B2 },
  { id: 'c3', ref: pid(3), artifact: `metaapp://${pid(13)}`, author: B3 },
];

export const DEFAULT_JUDGES = [
  { id: H1, kind: 'human' },
  { id: H2, kind: 'human' },
  { id: H3, kind: 'human' },
  { id: A1, kind: 'ai' },
];

export const roundBody = (over = {}) => ({
  title: 'Q&A UI v2',
  category: ['ui:qa-community'],
  candidates: CANDIDATES,
  judges: DEFAULT_JUDGES,
  decision: { kinds: ['human'], minBallots: 2 },
  dimensions: [{ id: 'visual', label: 'Visual quality' }],
  commitCloseAt: COMMIT_CLOSE,
  revealCloseAt: REVEAL_CLOSE,
  ...over,
});

export const pair = (a, b, pick, extra = {}) => ({ a, b, pick, reason: `${a} vs ${b}: ${pick}`, ...extra });
export const ballot = (...pairs) => ({ pairs });

export { sealing };
```

- [ ] **Step 2: Write the failing schema tests**

Create `tests/preferenceSchemas.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CANDIDATES, ROUND_AT, ballot, pair, pid, roundBody } from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { parseRound, parseCommit, parseRevealEnvelope, checkBallot, parseLesson } = require(
  '../dist-electron/main/services/preference/schemas.js',
);

const parsedRound = () => {
  const result = parseRound(roundBody(), ROUND_AT);
  assert.equal(result.ok, true, result.reason);
  return result.value;
};

test('valid round parses and normalizes optional lists', () => {
  const result = parseRound(roundBody({ dimensions: undefined }), ROUND_AT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.dimensions, []);
  assert.deepEqual(result.value.tasks, []);
  assert.equal(result.value.subject, undefined);
});

test('round bounds and uniqueness are enforced', () => {
  const cases = [
    [{ candidates: CANDIDATES.slice(0, 1) }, 'round:candidates'],
    [{ candidates: [CANDIDATES[0], { ...CANDIDATES[1], id: 'c1' }] }, 'round:candidate-duplicate'],
    [{ candidates: [CANDIDATES[0], { ...CANDIDATES[1], artifact: 'https://x' }] }, 'round:candidate-shape'],
    [{ judges: [{ id: CANDIDATES[0].author, kind: 'robot' }] }, 'round:judge-shape'],
    [{ decision: { kinds: [], minBallots: 1 } }, 'round:decision'],
    [{ decision: { kinds: ['human'], minBallots: 0 } }, 'round:decision'],
    [{ category: ['UI:Bad'] }, 'round:category'],
    [{ commitCloseAt: ROUND_AT + 3599 }, 'round:windows'],
    [{ revealCloseAt: roundBody().commitCloseAt + 3599 }, 'round:windows'],
    [{ subject: { taskid: 'not-a-pin', node: 'UI' } }, 'round:subject'],
  ];
  for (const [over, reason] of cases) {
    assert.deepEqual(parseRound(roundBody(over), ROUND_AT), { ok: false, reason }, JSON.stringify(over));
  }
});

test('commit and reveal envelopes check shapes only', () => {
  assert.equal(parseCommit({ round: pid(1), hash: 'a'.repeat(64) }).ok, true);
  assert.deepEqual(parseCommit({ round: pid(1), hash: 'A'.repeat(64) }), { ok: false, reason: 'commit:shape' });
  assert.equal(parseRevealEnvelope({ round: pid(1), commit: pid(2), salt: 'b'.repeat(64), ballot: {} }).ok, true);
  assert.deepEqual(parseRevealEnvelope({ round: pid(1), commit: pid(2), salt: 'b'.repeat(63), ballot: {} }), {
    ok: false,
    reason: 'reveal:shape',
  });
});

test('ballot validity follows protocol §4 rule 4', () => {
  const round = parsedRound();
  assert.equal(checkBallot(ballot(pair('c1', 'c2', 'a', { dims: { visual: 'tie' } })), round).ok, true);
  const cases = [
    [ballot(pair('c1', 'c1', 'a')), 'ballot:pair-candidates'],
    [ballot(pair('c1', 'c9', 'a')), 'ballot:pair-candidates'],
    [ballot(pair('c1', 'c2', 'a'), pair('c2', 'c1', 'b')), 'ballot:pair-duplicate'],
    [ballot(pair('c1', 'c2', 'left')), 'ballot:pick'],
    [ballot({ a: 'c1', b: 'c2', pick: 'a', reason: '   ' }), 'ballot:reason'],
    [ballot({ a: 'c1', b: 'c2', pick: 'a', reason: 'x'.repeat(1001) }), 'ballot:reason'],
    [ballot(pair('c1', 'c2', 'a', { dims: { speed: 'a' } })), 'ballot:dims'],
    [{ pairs: [] }, 'ballot:pairs'],
  ];
  for (const [value, reason] of cases) {
    assert.deepEqual(checkBallot(value, round), { ok: false, reason }, JSON.stringify(value));
  }
});

test('ballot normalization drops unknown keys but keeps dims and note', () => {
  const round = parsedRound();
  const result = checkBallot({ pairs: [{ ...pair('c1', 'c2', 'b'), extra: 1 }], note: 'n' }, round);
  assert.deepEqual(result, { ok: true, value: { pairs: [pair('c1', 'c2', 'b')], note: 'n' } });
});

test('lesson shape', () => {
  const lesson = {
    round: pid(1),
    category: ['ui:qa-community'],
    summary: 'Dense feeds won.',
    principles: [{ text: 'Show five questions per screen.', conditions: 'Desktop readers.', uncertainty: '', evidence: [pid(9)] }],
    exemplars: { preferred: 'c3', rejected: ['c1'] },
    tallyHash: 'c'.repeat(64),
  };
  assert.equal(parseLesson(lesson).ok, true);
  assert.deepEqual(parseLesson({ ...lesson, exemplars: { preferred: 'c3', rejected: ['c3'] } }), {
    ok: false,
    reason: 'lesson:exemplars',
  });
  assert.deepEqual(parseLesson({ ...lesson, principles: [{ ...lesson.principles[0], evidence: [] }] }), {
    ok: false,
    reason: 'lesson:evidence',
  });
  assert.deepEqual(parseLesson({ ...lesson, principles: [{ ...lesson.principles[0], text: 'too short' }] }), {
    ok: false,
    reason: 'lesson:principle-shape',
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm run compile:electron && node --test tests/preferenceSchemas.test.mjs`
Expected: FAIL with `Cannot find module '../dist-electron/main/services/preference/schemas.js'`.

- [ ] **Step 4: Write `constants.ts`**

```ts
export const PREFERENCE_PROTOCOL_ROOT = '/protocols/preference';
export const PREFERENCE_SEGMENTS = ['round', 'commit', 'reveal', 'lesson'] as const;
export type PreferenceSegment = (typeof PREFERENCE_SEGMENTS)[number];
export const preferencePoolPath = (segment: PreferenceSegment): string => `${PREFERENCE_PROTOCOL_ROOT}/${segment}`;

export const PREFERENCE_PIN_VERSION = '1.0.0';
export const PREFERENCE_TALLY_ENGINE = 'idbots-preference-tally/1.0.0';

export const FINALITY_GRACE_SEC = 7200;
export const MIN_WINDOW_SEC = 3600;
export const MAX_CANDIDATES = 8;
export const MAX_JUDGES = 32;
export const MAX_PAIRS = 28;

/** Writer-side, non-normative: keeps confirmations clear of the window edges. */
export const COMMIT_CUTOFF_SEC = 1800;
export const REVEAL_DELAY_SEC = 1800;
export const PILOT_CANDIDATE_CAP = 6;

export const PIN_ID_RE = /^[0-9a-f]{64}i[0-9]+$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const GLOBAL_META_ID_RE = /^idq1[0-9a-z]{20,80}$/;
export const CANDIDATE_ID_RE = /^[a-z0-9]{1,8}$/;
export const DIMENSION_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
export const CATEGORY_TAG_RE = /^[a-z0-9-]+(:[a-z0-9-]+)?$/;
export const ARTIFACT_RE = /^(metaapp|pin|metafile):\/\/\S+$/;
```

- [ ] **Step 5: Write `types.ts`**

```ts
import type { PreferenceSegment } from './constants';

export interface PreferenceChainEvent {
  pinId: string;
  path: PreferenceSegment;
  /** globalMetaId of the signer. */
  author: string;
  /** -1 while unconfirmed. */
  height: number;
  txIndex: number;
  timestampMs: number;
  body: Record<string, unknown>;
}

export type JudgeKind = 'human' | 'ai';
export type JudgeClass = 'deciding' | 'shadow' | 'public';
export type PairPick = 'a' | 'b' | 'tie';

export interface RoundCandidate {
  id: string;
  ref: string;
  artifact: string;
  author: string;
}

export interface RoundJudge {
  id: string;
  kind: JudgeKind;
}

export interface RoundDimension {
  id: string;
  label: string;
}

export interface RoundBody {
  title: string;
  brief?: string;
  category: string[];
  subject?: { taskid: string; node: string };
  candidates: RoundCandidate[];
  judges: RoundJudge[];
  decision: { kinds: JudgeKind[]; minBallots: number };
  dimensions: RoundDimension[];
  tasks: string[];
  commitCloseAt: number;
  revealCloseAt: number;
}

export interface BallotPair {
  a: string;
  b: string;
  pick: PairPick;
  reason: string;
  dims?: Record<string, PairPick>;
}

export interface Ballot {
  pairs: BallotPair[];
  note?: string;
}

export interface CommitBody {
  round: string;
  hash: string;
}

export interface RevealEnvelope {
  round: string;
  commit: string;
  salt: string;
  ballot: Record<string, unknown>;
}

export interface LessonPrinciple {
  text: string;
  conditions: string;
  uncertainty: string;
  evidence: string[];
}

export interface LessonBody {
  round: string;
  category: string[];
  summary: string;
  principles: LessonPrinciple[];
  exemplars: { preferred: string; rejected: string[] };
  tallyHash: string;
}

export type TallyStatus = 'collecting' | 'revealing' | 'settling' | 'decided' | 'no_decision';

export interface TallyRankingEntry {
  id: string;
  ref: string;
  copeland: number;
  points: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface TallyJudgeEntry {
  id: string;
  kind: JudgeKind | 'public';
  class: JudgeClass;
  commit: string;
  reveal: string;
  pairs: number;
  agreeN: number;
  agreeHits: number;
  agreementBP: number;
}

export interface TallyOutput {
  engine: string;
  round: string;
  status: TallyStatus;
  winner: string | null;
  ranking: TallyRankingEntry[];
  ballots: { deciding: number; shadow: number; public: number };
  judges: TallyJudgeEntry[];
  dimensions: Record<string, Record<string, number>>;
  evidence: string[];
}

export interface TallyDiagnostics {
  ignored: { pinId: string; reason: string }[];
  /** Unix seconds the tally was evaluated at. Never hashed. */
  evaluatedAt: number;
}

export interface TallyResult {
  output: TallyOutput;
  /** Present only for final tallies (decided / no_decision). */
  tallyHash: string | null;
  diagnostics: TallyDiagnostics;
}
```

- [ ] **Step 6: Write `schemas.ts`**

```ts
import {
  ARTIFACT_RE,
  CANDIDATE_ID_RE,
  CATEGORY_TAG_RE,
  DIMENSION_ID_RE,
  GLOBAL_META_ID_RE,
  HEX64_RE,
  MAX_CANDIDATES,
  MAX_JUDGES,
  MAX_PAIRS,
  MIN_WINDOW_SEC,
  PIN_ID_RE,
} from './constants';
import type {
  Ballot,
  BallotPair,
  CommitBody,
  JudgeKind,
  LessonBody,
  LessonPrinciple,
  PairPick,
  RevealEnvelope,
  RoundBody,
  RoundCandidate,
  RoundDimension,
  RoundJudge,
} from './types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(reason: string): ParseResult<T> => ({ ok: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Lengths count Unicode code points, so CJK text is measured by characters. */
const charLength = (value: string): number => Array.from(value).length;

const isText = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && charLength(value.trim()) >= min && charLength(value) <= max;

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);

const isJudgeKind = (value: unknown): value is JudgeKind => value === 'human' || value === 'ai';

export const isPairPick = (value: unknown): value is PairPick => value === 'a' || value === 'b' || value === 'tie';

export function parseCategory(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  const tags: string[] = [];
  for (const tag of value) {
    if (!matches(tag, CATEGORY_TAG_RE) || tag.length > 64 || tags.includes(tag)) return null;
    tags.push(tag);
  }
  return tags;
}

export function parseRound(body: unknown, roundTimestampSec: number): ParseResult<RoundBody> {
  if (!isRecord(body)) return fail('round:not-object');
  const {
    title,
    brief,
    category: rawCategory,
    subject: rawSubject,
    candidates: rawCandidates,
    judges: rawJudges,
    decision: rawDecision,
    dimensions: rawDimensions,
    tasks: rawTasks,
    commitCloseAt,
    revealCloseAt,
  } = body;
  if (!isText(title, 1, 200)) return fail('round:title');
  if (brief !== undefined && !isText(brief, 0, 4000)) return fail('round:brief');
  const category = parseCategory(rawCategory);
  if (!category) return fail('round:category');

  let subject: RoundBody['subject'];
  if (rawSubject !== undefined) {
    if (!isRecord(rawSubject)) return fail('round:subject');
    const { taskid, node } = rawSubject;
    if (!matches(taskid, PIN_ID_RE) || !isText(node, 1, 64)) return fail('round:subject');
    subject = { taskid, node };
  }

  if (!Array.isArray(rawCandidates) || rawCandidates.length < 2 || rawCandidates.length > MAX_CANDIDATES) {
    return fail('round:candidates');
  }
  const candidates: RoundCandidate[] = [];
  for (const candidate of rawCandidates) {
    if (!isRecord(candidate)) return fail('round:candidate-shape');
    const { id, ref, artifact, author } = candidate;
    if (
      !matches(id, CANDIDATE_ID_RE)
      || !matches(ref, PIN_ID_RE)
      || !matches(artifact, ARTIFACT_RE)
      || !matches(author, GLOBAL_META_ID_RE)
    ) {
      return fail('round:candidate-shape');
    }
    if (candidates.some((existing) => existing.id === id || existing.ref === ref)) return fail('round:candidate-duplicate');
    candidates.push({ id, ref, artifact, author });
  }

  if (!Array.isArray(rawJudges) || rawJudges.length < 1 || rawJudges.length > MAX_JUDGES) return fail('round:judges');
  const judges: RoundJudge[] = [];
  for (const judge of rawJudges) {
    if (!isRecord(judge)) return fail('round:judge-shape');
    const { id, kind } = judge;
    if (!matches(id, GLOBAL_META_ID_RE) || !isJudgeKind(kind)) return fail('round:judge-shape');
    if (judges.some((existing) => existing.id === id)) return fail('round:judge-duplicate');
    judges.push({ id, kind });
  }

  if (!isRecord(rawDecision)) return fail('round:decision');
  const { kinds, minBallots } = rawDecision;
  if (!Array.isArray(kinds) || kinds.length < 1) return fail('round:decision');
  const decisionKinds: JudgeKind[] = [];
  for (const kind of kinds) {
    if (!isJudgeKind(kind) || decisionKinds.includes(kind)) return fail('round:decision');
    decisionKinds.push(kind);
  }
  if (!isInt(minBallots) || minBallots < 1 || minBallots > MAX_JUDGES) return fail('round:decision');

  const dimensions: RoundDimension[] = [];
  if (rawDimensions !== undefined) {
    if (!Array.isArray(rawDimensions) || rawDimensions.length > 6) return fail('round:dimensions');
    for (const dimension of rawDimensions) {
      if (!isRecord(dimension)) return fail('round:dimensions');
      const { id, label } = dimension;
      if (!matches(id, DIMENSION_ID_RE) || !isText(label, 1, 48)) return fail('round:dimensions');
      if (dimensions.some((existing) => existing.id === id)) return fail('round:dimensions');
      dimensions.push({ id, label });
    }
  }

  const tasks: string[] = [];
  if (rawTasks !== undefined) {
    if (!Array.isArray(rawTasks) || rawTasks.length > 5) return fail('round:tasks');
    for (const task of rawTasks) {
      if (!isText(task, 1, 300)) return fail('round:tasks');
      tasks.push(task);
    }
  }

  if (!isInt(commitCloseAt) || !isInt(revealCloseAt)) return fail('round:windows');
  if (commitCloseAt < roundTimestampSec + MIN_WINDOW_SEC || revealCloseAt < commitCloseAt + MIN_WINDOW_SEC) {
    return fail('round:windows');
  }

  return ok({
    title,
    ...(brief !== undefined ? { brief } : {}),
    category,
    ...(subject ? { subject } : {}),
    candidates,
    judges,
    decision: { kinds: decisionKinds, minBallots },
    dimensions,
    tasks,
    commitCloseAt,
    revealCloseAt,
  });
}

export function parseCommit(body: unknown): ParseResult<CommitBody> {
  if (!isRecord(body)) return fail('commit:not-object');
  const { round, hash } = body;
  if (!matches(round, PIN_ID_RE) || !matches(hash, HEX64_RE)) return fail('commit:shape');
  return ok({ round, hash });
}

export function parseRevealEnvelope(body: unknown): ParseResult<RevealEnvelope> {
  if (!isRecord(body)) return fail('reveal:not-object');
  const { round, commit, salt, ballot } = body;
  if (!matches(round, PIN_ID_RE) || !matches(commit, PIN_ID_RE) || !matches(salt, HEX64_RE) || !isRecord(ballot)) {
    return fail('reveal:shape');
  }
  return ok({ round, commit, salt, ballot });
}

export function checkBallot(ballot: unknown, round: RoundBody): ParseResult<Ballot> {
  if (!isRecord(ballot)) return fail('ballot:not-object');
  const { pairs: rawPairs, note } = ballot;
  if (!Array.isArray(rawPairs) || rawPairs.length < 1 || rawPairs.length > MAX_PAIRS) return fail('ballot:pairs');
  if (note !== undefined && !isText(note, 0, 2000)) return fail('ballot:note');
  const candidateIds = new Set(round.candidates.map((candidate) => candidate.id));
  const dimensionIds = new Set(round.dimensions.map((dimension) => dimension.id));
  const seen = new Set<string>();
  const pairs: BallotPair[] = [];
  for (const rawPair of rawPairs) {
    if (!isRecord(rawPair)) return fail('ballot:pair-shape');
    const { a, b, pick, reason, dims: rawDims } = rawPair;
    if (typeof a !== 'string' || typeof b !== 'string' || a === b || !candidateIds.has(a) || !candidateIds.has(b)) {
      return fail('ballot:pair-candidates');
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return fail('ballot:pair-duplicate');
    seen.add(key);
    if (!isPairPick(pick)) return fail('ballot:pick');
    if (!isText(reason, 1, 1000)) return fail('ballot:reason');
    let dims: Record<string, PairPick> | undefined;
    if (rawDims !== undefined) {
      if (!isRecord(rawDims)) return fail('ballot:dims');
      dims = {};
      for (const [dimensionId, value] of Object.entries(rawDims)) {
        if (!dimensionIds.has(dimensionId) || !isPairPick(value)) return fail('ballot:dims');
        dims[dimensionId] = value;
      }
    }
    pairs.push({ a, b, pick, reason, ...(dims ? { dims } : {}) });
  }
  return ok({ pairs, ...(note !== undefined ? { note } : {}) });
}

export function parseLesson(body: unknown): ParseResult<LessonBody> {
  if (!isRecord(body)) return fail('lesson:not-object');
  const { round, category: rawCategory, summary, principles: rawPrinciples, exemplars, tallyHash } = body;
  if (!matches(round, PIN_ID_RE)) return fail('lesson:round');
  const category = parseCategory(rawCategory);
  if (!category) return fail('lesson:category');
  if (!isText(summary, 1, 1200)) return fail('lesson:summary');
  if (!Array.isArray(rawPrinciples) || rawPrinciples.length < 1 || rawPrinciples.length > 12) {
    return fail('lesson:principles');
  }
  const principles: LessonPrinciple[] = [];
  for (const principle of rawPrinciples) {
    if (!isRecord(principle)) return fail('lesson:principle-shape');
    const { text, conditions, uncertainty, evidence } = principle;
    if (!isText(text, 10, 400) || !isText(conditions, 1, 300) || !isText(uncertainty, 0, 300)) {
      return fail('lesson:principle-shape');
    }
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 20) return fail('lesson:evidence');
    const cited: string[] = [];
    for (const pinId of evidence) {
      if (!matches(pinId, PIN_ID_RE) || cited.includes(pinId)) return fail('lesson:evidence');
      cited.push(pinId);
    }
    principles.push({ text, conditions, uncertainty, evidence: cited });
  }
  if (!isRecord(exemplars)) return fail('lesson:exemplars');
  const { preferred, rejected } = exemplars;
  if (!matches(preferred, CANDIDATE_ID_RE) || !Array.isArray(rejected) || rejected.length > MAX_CANDIDATES - 1) {
    return fail('lesson:exemplars');
  }
  const rejectedIds: string[] = [];
  for (const id of rejected) {
    if (!matches(id, CANDIDATE_ID_RE) || id === preferred || rejectedIds.includes(id)) return fail('lesson:exemplars');
    rejectedIds.push(id);
  }
  if (!matches(tallyHash, HEX64_RE)) return fail('lesson:tallyHash');
  return ok({ round, category, summary, principles, exemplars: { preferred, rejected: rejectedIds }, tallyHash });
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceSchemas.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 8: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/constants.ts src/main/services/preference/types.ts src/main/services/preference/schemas.ts
git add -f tests/fixtures/preference/scenarios.mjs tests/preferenceSchemas.test.mjs
git commit -m "feat: add preference protocol constants, types, and schemas"
```

---

### Task 2: Commit sealing

**Files:**
- Create: `src/main/services/preference/sealing.ts`
- Test: `tests/preferenceSealing.test.mjs`

**Interfaces:**
- Consumes: `canonJ`, `sha256Hex` from `src/main/services/metatask/canon.ts`.
- Produces: `newBallotSalt(): string` (64 lowercase hex), `ballotCommitHash(input: { round: string; judge: string; salt: string; ballot: unknown }): string`.

- [ ] **Step 1: Write the failing test**

The expected hash below was computed independently in Python (`json.dumps(o, ensure_ascii=False, sort_keys=True, separators=(',', ':'))` + SHA-256) and matches the existing `canonJ`.

Create `tests/preferenceSealing.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ballotCommitHash, newBallotSalt } = require('../dist-electron/main/services/preference/sealing.js');

const INPUT = {
  round: `${'0'.repeat(63)}1i0`,
  judge: `idq1human1${'0'.repeat(32)}`,
  salt: 'ab'.repeat(32),
  ballot: { pairs: [{ a: 'c1', b: 'c2', pick: 'a', reason: '左侧更清晰 clearer hierarchy' }] },
};

test('commit hash matches the cross-language vector', () => {
  assert.equal(ballotCommitHash(INPUT), 'abd17de74b2571515363d839b7b8e6a447ee9c3703b6ec674bc343c145f28484');
});

test('commit hash ignores key order and binds the judge', () => {
  const reordered = { ballot: { pairs: [{ reason: INPUT.ballot.pairs[0].reason, pick: 'a', b: 'c2', a: 'c1' }] } };
  assert.equal(ballotCommitHash({ ...INPUT, ...reordered }), ballotCommitHash(INPUT));
  assert.notEqual(ballotCommitHash({ ...INPUT, judge: `idq1human2${'0'.repeat(32)}` }), ballotCommitHash(INPUT));
});

test('salts are 32 random bytes in lowercase hex', () => {
  const a = newBallotSalt();
  const b = newBallotSalt();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm run compile:electron && node --test tests/preferenceSealing.test.mjs`
Expected: FAIL with `Cannot find module '../dist-electron/main/services/preference/sealing.js'`.

- [ ] **Step 3: Write `sealing.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { canonJ, sha256Hex } from '../metatask/canon';

export const newBallotSalt = (): string => randomBytes(32).toString('hex');

export const ballotCommitHash = (input: { round: string; judge: string; salt: string; ballot: unknown }): string =>
  sha256Hex(canonJ({ round: input.round, judge: input.judge, salt: input.salt, ballot: input.ballot }));
```

- [ ] **Step 4: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceSealing.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/sealing.ts
git add -f tests/preferenceSealing.test.mjs
git commit -m "feat: add preference ballot commit sealing"
```

---

### Task 3: Tally engine + scenarios

**Files:**
- Create: `src/main/services/preference/engine.ts`
- Modify: `tests/fixtures/preference/scenarios.mjs` (append chain builder, scenarios, checker)
- Test: `tests/preferenceEngine.test.mjs`

**Interfaces:**
- Consumes: `parseRound`, `parseCommit`, `parseRevealEnvelope`, `checkBallot` (Task 1); `ballotCommitHash` (Task 2); `FINALITY_GRACE_SEC`, `PREFERENCE_TALLY_ENGINE`.
- Produces:
  - `compareOrderKey(a, b): number` — `(height, txIndex, timestampMs, pinId)` ascending.
  - `type RoundResolution = { ok: true; event: PreferenceChainEvent; round: RoundBody } | { ok: false; reason: string }` and `resolveRound(events, roundPinId): RoundResolution`.
  - `statusAt(round: RoundBody, nowSec: number, decidingBallots: number): TallyStatus`.
  - `type TallyRoundResult = { ok: true; result: TallyResult } | { ok: false; reason: string }` and `tallyRound(events, roundPinId, { nowSec }): TallyRoundResult`.
  - Diagnostic reason codes: `commit:unconfirmed`, `commit:shape`, `commit:not-object`, `commit:before-round`, `commit:after-close`, `commit:no-author`, `commit:superseded`, `reveal:unconfirmed`, `reveal:shape`, `reveal:not-object`, `reveal:before-commit-close`, `reveal:after-close`, `reveal:not-effective-commit`, `reveal:duplicate`, `reveal:hash-mismatch`, plus every `ballot:*` code from `checkBallot`.
  - Test exports from `scenarios.mjs`: `chain()`, `C3_BEST`, `C1_BEST`, `SCENARIOS`, `checkScenario(result, expect): string[]`.

Every expectation below was derived by hand from protocol §5, not by running the engine.

- [ ] **Step 1: Append builders, scenarios, and the checker to `tests/fixtures/preference/scenarios.mjs`**

```js
/** A synthetic chain: pins get strictly increasing heights in creation order. */
export function chain() {
  let serial = 100;
  const events = [];
  const add = (path, body, author, atSec, over = {}) => {
    serial += 1;
    const event = {
      pinId: pid(serial),
      path,
      author,
      height: over.height ?? 200_000 + serial,
      txIndex: 0,
      timestampMs: atSec * 1000,
      body,
    };
    events.push(event);
    return event;
  };
  const openRound = (over = {}) => add('round', roundBody(over), TWIN, ROUND_AT).pinId;
  const vote = (roundPinId, judge, ballotValue, opts = {}) => {
    const salt = saltOf(serial + 1);
    const hash = sealing().ballotCommitHash({ round: roundPinId, judge, salt, ballot: ballotValue });
    const commit = add('commit', { round: roundPinId, hash }, judge, opts.commitAt ?? COMMIT_CLOSE - 7_200, opts.commitOver);
    const reveal = add(
      'reveal',
      { round: roundPinId, commit: commit.pinId, salt, ballot: opts.revealBallot ?? ballotValue },
      judge,
      opts.revealAt ?? COMMIT_CLOSE + 600,
      opts.revealOver,
    );
    return { commit, reveal };
  };
  return { events, add, openRound, vote };
}

/** c3 > c2 > c1 */
export const C3_BEST = ballot(pair('c1', 'c3', 'b'), pair('c2', 'c3', 'b'), pair('c1', 'c2', 'b'));
/** c1 > c2 > c3 */
export const C1_BEST = ballot(pair('c1', 'c3', 'a'), pair('c2', 'c3', 'a'), pair('c1', 'c2', 'a'));

const AGREE = ballot(pair('c1', 'c2', 'a'), pair('c1', 'c3', 'b'), pair('c2', 'c3', 'b'));
const DISSENT = ballot(pair('c1', 'c2', 'b'), pair('c1', 'c3', 'b'), pair('c2', 'c3', 'a'));
const SHADOW = ballot(pair('c1', 'c2', 'a'), pair('c1', 'c3', 'b'), pair('c2', 'c3', 'tie'));

const NO_DECISION_ONE_BALLOT = {
  status: 'no_decision',
  winner: null,
  ballots: { deciding: 1, shadow: 0, public: 0 },
  hashed: true,
};

/** H1 votes C3_BEST normally; H2's vote is broken as described by `h2`. */
const oneBrokenVote = (id, h2, ignoredReasons, h2Ballot = C3_BEST) => ({
  id,
  nowSec: FINAL_NOW,
  build() {
    const c = chain();
    const round = c.openRound();
    c.vote(round, H1, C3_BEST);
    c.vote(round, H2, h2Ballot, h2);
    return { round, events: c.events };
  },
  expect: { ...NO_DECISION_ONE_BALLOT, ignoredReasons },
});

const basicWinner = () => {
  const c = chain();
  const round = c.openRound();
  c.vote(round, H1, C3_BEST);
  c.vote(round, H2, C3_BEST);
  return { round, events: c.events };
};

const unfinished = (id, nowSec, status) => ({
  id,
  nowSec,
  build: basicWinner,
  expect: { status, winner: null, rankingIds: ['c3', 'c2', 'c1'], ballots: { deciding: 2, shadow: 0, public: 0 }, hashed: false },
});

export const SCENARIOS = [
  {
    id: 'basic-winner',
    nowSec: FINAL_NOW,
    build: basicWinner,
    expect: {
      status: 'decided',
      winner: 'c3',
      rankingIds: ['c3', 'c2', 'c1'],
      ballots: { deciding: 2, shadow: 0, public: 0 },
      ranking: { c3: { copeland: 4, points: 8, wins: 2, losses: 0, ties: 0 } },
      evidenceCount: 2,
      hashed: true,
    },
  },
  {
    // Copeland 2/2/2 (a cycle); points c1 5, c3 4, c2 3.
    id: 'tiebreak-points',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      c.vote(round, H1, ballot(pair('c1', 'c2', 'a'), pair('c2', 'c3', 'a'), pair('c1', 'c3', 'b')));
      c.vote(round, H2, ballot(pair('c1', 'c2', 'a'), pair('c2', 'c3', 'tie'), pair('c1', 'c3', 'tie')));
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c1',
      rankingIds: ['c1', 'c3', 'c2'],
      ranking: { c1: { copeland: 2, points: 5 }, c3: { copeland: 2, points: 4 }, c2: { copeland: 2, points: 3 } },
      hashed: true,
    },
  },
  {
    // All ties: copeland 2 and points 2 everywhere, so ref ascending decides.
    id: 'tiebreak-ref',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound({ decision: { kinds: ['human'], minBallots: 1 } });
      c.vote(round, H1, ballot(pair('c1', 'c2', 'tie'), pair('c1', 'c3', 'tie'), pair('c2', 'c3', 'tie')));
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c1',
      rankingIds: ['c1', 'c2', 'c3'],
      ranking: { c1: { copeland: 2, points: 2, ties: 2 } },
      hashed: true,
    },
  },
  {
    // B1 authored c1 and is also a deciding judge: only its c2/c3 pair counts.
    // c2 and c3 then tie on copeland 3 and points 4; ref pid(2) < pid(3).
    id: 'conflict-of-interest',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound({ judges: [...DEFAULT_JUDGES, { id: B1, kind: 'human' }] });
      c.vote(round, B1, C1_BEST);
      c.vote(round, H1, C3_BEST);
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c2',
      rankingIds: ['c2', 'c3', 'c1'],
      ballots: { deciding: 2, shadow: 0, public: 0 },
      judges: [{ id: B1, class: 'deciding', pairs: 1 }, { id: H1, class: 'deciding', pairs: 3 }],
      hashed: true,
    },
  },
  oneBrokenVote('commit-after-close', { commitAt: COMMIT_CLOSE + 1 }, ['commit:after-close', 'reveal:not-effective-commit']),
  oneBrokenVote('reveal-before-close', { revealAt: COMMIT_CLOSE }, ['reveal:before-commit-close']),
  oneBrokenVote('reveal-after-close', { revealAt: REVEAL_CLOSE + 1 }, ['reveal:after-close']),
  oneBrokenVote('hash-mismatch', { revealBallot: C1_BEST }, ['reveal:hash-mismatch']),
  {
    // H1 re-commits; the reveal of the first commit is ignored, the second counts.
    id: 'recommit-latest-wins',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      const { ballotCommitHash } = sealing();
      const first = saltOf(901);
      const second = saltOf(902);
      const commit1 = c.add('commit', { round, hash: ballotCommitHash({ round, judge: H1, salt: first, ballot: C3_BEST }) }, H1, COMMIT_CLOSE - 10_000);
      const commit2 = c.add('commit', { round, hash: ballotCommitHash({ round, judge: H1, salt: second, ballot: C1_BEST }) }, H1, COMMIT_CLOSE - 5_000);
      c.add('reveal', { round, commit: commit1.pinId, salt: first, ballot: C3_BEST }, H1, COMMIT_CLOSE + 600);
      c.add('reveal', { round, commit: commit2.pinId, salt: second, ballot: C1_BEST }, H1, COMMIT_CLOSE + 700);
      c.vote(round, H2, C1_BEST);
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c1',
      rankingIds: ['c1', 'c2', 'c3'],
      ballots: { deciding: 2, shadow: 0, public: 0 },
      ignoredReasons: ['commit:superseded', 'reveal:not-effective-commit'],
      hashed: true,
    },
  },
  oneBrokenVote('duplicate-pair', {}, ['ballot:pair-duplicate'], ballot(pair('c1', 'c2', 'a'), pair('c2', 'c1', 'b'))),
  oneBrokenVote('unknown-candidate', {}, ['ballot:pair-candidates'], ballot(pair('c1', 'c9', 'a'))),
  oneBrokenVote('unconfirmed-ignored', { revealOver: { height: -1 } }, ['reveal:unconfirmed']),
  {
    id: 'public-never-decides',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      c.vote(round, H1, C3_BEST);
      c.vote(round, P1, C1_BEST);
      return { round, events: c.events };
    },
    expect: {
      status: 'no_decision',
      winner: null,
      ballots: { deciding: 1, shadow: 0, public: 1 },
      judges: [{ id: H1, class: 'deciding' }, { id: P1, kind: 'public', class: 'public' }],
      evidenceCount: 1,
      hashed: true,
    },
  },
  {
    id: 'below-min-ballots',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      c.vote(round, H1, C3_BEST);
      return { round, events: c.events };
    },
    expect: { ...NO_DECISION_ONE_BALLOT, rankingIds: ['c3', 'c2', 'c1'] },
  },
  {
    // Only deciding dims count: c3 gets 2 (H1 "b" on c1/c3) + 1 (H1 tie on c2/c3); c2 gets 1.
    id: 'dimensions',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound();
      c.vote(round, H1, ballot(
        pair('c1', 'c3', 'b', { dims: { visual: 'b' } }),
        pair('c2', 'c3', 'tie', { dims: { visual: 'tie' } }),
        pair('c1', 'c2', 'b'),
      ));
      c.vote(round, H2, C3_BEST);
      c.vote(round, A1, ballot(pair('c1', 'c3', 'a', { dims: { visual: 'a' } })));
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c3',
      rankingIds: ['c3', 'c2', 'c1'],
      ballots: { deciding: 2, shadow: 1, public: 0 },
      dimensions: { visual: { c1: 0, c2: 1, c3: 3 } },
      evidenceCount: 3,
      hashed: true,
    },
  },
  {
    // Full P: c1>c2 4:2, c3>c1 6:0, c3>c2 4:2.
    // A1 (shadow, full P): 3 strict pairs, hits c1/c2 + c1/c3, tie pick misses -> 6000.
    // H1 (leave-one-out = H2+H3): only c1/c3 strict, hit -> 6666.
    // H3 (leave-one-out = H1+H2): 3 strict pairs, 1 hit -> 4000.
    id: 'agreement',
    nowSec: FINAL_NOW,
    build() {
      const c = chain();
      const round = c.openRound({ decision: { kinds: ['human'], minBallots: 3 } });
      c.vote(round, H1, AGREE);
      c.vote(round, H2, AGREE);
      c.vote(round, H3, DISSENT);
      c.vote(round, A1, SHADOW);
      return { round, events: c.events };
    },
    expect: {
      status: 'decided',
      winner: 'c3',
      rankingIds: ['c3', 'c1', 'c2'],
      ballots: { deciding: 3, shadow: 1, public: 0 },
      judges: [
        { id: A1, kind: 'ai', class: 'shadow', agreeN: 3, agreeHits: 2, agreementBP: 6000 },
        { id: H1, class: 'deciding', agreeN: 1, agreeHits: 1, agreementBP: 6666 },
        { id: H3, class: 'deciding', agreeN: 3, agreeHits: 1, agreementBP: 4000 },
      ],
      hashed: true,
    },
  },
  unfinished('status-collecting', COMMIT_CLOSE, 'collecting'),
  unfinished('status-revealing', COMMIT_CLOSE + 1, 'revealing'),
  unfinished('status-settling', REVEAL_CLOSE + 7_200, 'settling'),
];

/** Returns human-readable mismatches; an empty array means the expectation holds. */
export function checkScenario(result, expect) {
  const problems = [];
  const out = result.output;
  const eq = (label, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      problems.push(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
    }
  };
  eq('status', out.status, expect.status);
  eq('winner', out.winner, expect.winner ?? null);
  if (expect.rankingIds) eq('rankingIds', out.ranking.map((entry) => entry.id), expect.rankingIds);
  if (expect.ballots) eq('ballots', out.ballots, expect.ballots);
  for (const [id, fields] of Object.entries(expect.ranking ?? {})) {
    const entry = out.ranking.find((candidate) => candidate.id === id);
    for (const [key, value] of Object.entries(fields)) eq(`ranking.${id}.${key}`, entry?.[key], value);
  }
  for (const wanted of expect.judges ?? []) {
    const entry = out.judges.find((judge) => judge.id === wanted.id);
    for (const [key, value] of Object.entries(wanted)) eq(`judges.${wanted.id}.${key}`, entry?.[key], value);
  }
  if (expect.dimensions) eq('dimensions', out.dimensions, expect.dimensions);
  if (expect.evidenceCount !== undefined) eq('evidenceCount', out.evidence.length, expect.evidenceCount);
  for (const reason of expect.ignoredReasons ?? []) {
    if (!result.diagnostics.ignored.some((item) => item.reason === reason)) problems.push(`ignored: missing ${reason}`);
  }
  eq('hashed', result.tallyHash !== null, expect.hashed);
  return problems;
}
```

- [ ] **Step 2: Write the failing engine tests**

Create `tests/preferenceEngine.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  C3_BEST,
  COMMIT_CLOSE,
  FINAL_NOW,
  H1,
  H2,
  P1,
  ROUND_AT,
  SCENARIOS,
  chain,
  checkScenario,
} from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { tallyRound } = require('../dist-electron/main/services/preference/engine.js');
const { canonJ, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');

for (const scenario of SCENARIOS) {
  test(`scenario ${scenario.id}`, () => {
    const { round, events } = scenario.build();
    const tally = tallyRound(events, round, { nowSec: scenario.nowSec });
    assert.equal(tally.ok, true, tally.reason);
    assert.deepEqual(checkScenario(tally.result, scenario.expect), []);
  });
}

test('tallyHash is sha256(canonJ(output)) and spam pins cannot change it', () => {
  const c = chain();
  const round = c.openRound();
  c.vote(round, H1, C3_BEST);
  c.vote(round, H2, C3_BEST);
  const clean = tallyRound(c.events, round, { nowSec: FINAL_NOW });
  c.add('commit', { round, hash: 'not-hex' }, P1, COMMIT_CLOSE - 100);
  c.add('reveal', { round, commit: 'x', salt: 'y', ballot: {} }, P1, COMMIT_CLOSE + 100);
  const spammed = tallyRound(c.events, round, { nowSec: FINAL_NOW });
  assert.equal(clean.result.tallyHash, sha256Hex(canonJ(clean.result.output)));
  assert.equal(spammed.result.tallyHash, clean.result.tallyHash);
  assert.deepEqual(spammed.result.diagnostics.ignored.map((item) => item.reason).sort(), ['commit:shape', 'reveal:shape']);
});

test('input order does not change the tally', () => {
  const { round, events } = SCENARIOS.find((scenario) => scenario.id === 'agreement').build();
  const forward = tallyRound(events, round, { nowSec: FINAL_NOW });
  const backward = tallyRound([...events].reverse(), round, { nowSec: FINAL_NOW });
  assert.equal(backward.result.tallyHash, forward.result.tallyHash);
});

test('invalid or unconfirmed rounds are reported, not tallied', () => {
  const invalid = chain();
  const badRound = invalid.openRound({ commitCloseAt: ROUND_AT + 60 });
  assert.deepEqual(tallyRound(invalid.events, badRound, { nowSec: FINAL_NOW }), { ok: false, reason: 'round:windows' });
  const pending = chain();
  const pendingRound = pending.openRound();
  pending.events[0].height = -1;
  assert.deepEqual(tallyRound(pending.events, pendingRound, { nowSec: FINAL_NOW }), { ok: false, reason: 'round:unconfirmed' });
  assert.deepEqual(tallyRound([], 'missing', { nowSec: FINAL_NOW }), { ok: false, reason: 'round:not-found' });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm run compile:electron && node --test tests/preferenceEngine.test.mjs`
Expected: FAIL with `Cannot find module '../dist-electron/main/services/preference/engine.js'`.

- [ ] **Step 4: Write `engine.ts`**

```ts
import { canonJ, sha256Hex } from '../metatask/canon';
import { FINALITY_GRACE_SEC, PREFERENCE_TALLY_ENGINE } from './constants';
import { checkBallot, parseCommit, parseRevealEnvelope, parseRound } from './schemas';
import { ballotCommitHash } from './sealing';
import type {
  BallotPair,
  JudgeClass,
  PairPick,
  PreferenceChainEvent,
  RoundBody,
  TallyDiagnostics,
  TallyJudgeEntry,
  TallyOutput,
  TallyRankingEntry,
  TallyResult,
  TallyStatus,
} from './types';

type PointMatrix = Record<string, Record<string, number>>;

interface CountedBallot {
  author: string;
  commitPinId: string;
  revealPinId: string;
  judgeClass: JudgeClass;
  kind: TallyJudgeEntry['kind'];
  pairs: BallotPair[];
}

export type RoundResolution =
  | { ok: true; event: PreferenceChainEvent; round: RoundBody }
  | { ok: false; reason: string };

export type TallyRoundResult = { ok: true; result: TallyResult } | { ok: false; reason: string };

const byteCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const compareOrderKey = (a: PreferenceChainEvent, b: PreferenceChainEvent): number =>
  a.height - b.height || a.txIndex - b.txIndex || a.timestampMs - b.timestampMs || byteCompare(a.pinId, b.pinId);

const toSec = (ms: number): number => Math.floor(ms / 1000);

const isConfirmed = (event: PreferenceChainEvent): boolean => event.height >= 0;

export function resolveRound(events: readonly PreferenceChainEvent[], roundPinId: string): RoundResolution {
  const event = events.find((candidate) => candidate.path === 'round' && candidate.pinId === roundPinId);
  if (!event) return { ok: false, reason: 'round:not-found' };
  if (!isConfirmed(event)) return { ok: false, reason: 'round:unconfirmed' };
  const parsed = parseRound(event.body, toSec(event.timestampMs));
  return parsed.ok ? { ok: true, event, round: parsed.value } : { ok: false, reason: parsed.reason };
}

export function statusAt(round: RoundBody, nowSec: number, decidingBallots: number): TallyStatus {
  if (nowSec <= round.commitCloseAt) return 'collecting';
  if (nowSec <= round.revealCloseAt) return 'revealing';
  if (nowSec <= round.revealCloseAt + FINALITY_GRACE_SEC) return 'settling';
  return decidingBallots >= round.decision.minBallots ? 'decided' : 'no_decision';
}

const zeroMatrix = (ids: readonly string[]): PointMatrix => {
  const matrix: PointMatrix = {};
  for (const i of ids) {
    matrix[i] = {};
    for (const j of ids) if (j !== i) matrix[i][j] = 0;
  }
  return matrix;
};

const addPick = (matrix: PointMatrix, a: string, b: string, pick: PairPick): void => {
  if (pick === 'a') matrix[a][b] += 2;
  else if (pick === 'b') matrix[b][a] += 2;
  else {
    matrix[a][b] += 1;
    matrix[b][a] += 1;
  }
};

const subtract = (total: PointMatrix, part: PointMatrix | undefined): PointMatrix => {
  if (!part) return total;
  const out: PointMatrix = {};
  for (const i of Object.keys(total)) {
    out[i] = {};
    for (const j of Object.keys(total[i])) out[i][j] = total[i][j] - part[i][j];
  }
  return out;
};

const strictWinner = (matrix: PointMatrix, x: string, y: string): string | null =>
  matrix[x][y] > matrix[y][x] ? x : matrix[x][y] < matrix[y][x] ? y : null;

const pickedId = (pair: BallotPair): string | null => (pair.pick === 'a' ? pair.a : pair.pick === 'b' ? pair.b : null);

export function tallyRound(
  events: readonly PreferenceChainEvent[],
  roundPinId: string,
  options: { nowSec: number },
): TallyRoundResult {
  const resolved = resolveRound(events, roundPinId);
  if (!resolved.ok) return resolved;
  const { event: roundEvent, round } = resolved;
  const ignored: TallyDiagnostics['ignored'] = [];
  const skip = (pinId: string, reason: string): void => {
    ignored.push({ pinId, reason });
  };

  const related = events
    .filter((event) => (event.path === 'commit' || event.path === 'reveal') && event.body.round === roundPinId)
    .sort(compareOrderKey);

  const effectiveCommit = new Map<string, { pinId: string; hash: string }>();
  for (const event of related) {
    if (event.path !== 'commit') continue;
    if (!isConfirmed(event)) { skip(event.pinId, 'commit:unconfirmed'); continue; }
    const parsed = parseCommit(event.body);
    if (!parsed.ok) { skip(event.pinId, parsed.reason); continue; }
    if (compareOrderKey(event, roundEvent) <= 0) { skip(event.pinId, 'commit:before-round'); continue; }
    if (toSec(event.timestampMs) > round.commitCloseAt) { skip(event.pinId, 'commit:after-close'); continue; }
    if (!event.author) { skip(event.pinId, 'commit:no-author'); continue; }
    const previous = effectiveCommit.get(event.author);
    if (previous) skip(previous.pinId, 'commit:superseded');
    effectiveCommit.set(event.author, { pinId: event.pinId, hash: parsed.value.hash });
  }

  const judgeKinds = new Map(round.judges.map((judge) => [judge.id, judge.kind] as const));
  const authorOf = new Map(round.candidates.map((candidate) => [candidate.id, candidate.author] as const));
  const ballots: CountedBallot[] = [];
  const revealed = new Set<string>();
  for (const event of related) {
    if (event.path !== 'reveal') continue;
    if (!isConfirmed(event)) { skip(event.pinId, 'reveal:unconfirmed'); continue; }
    const parsed = parseRevealEnvelope(event.body);
    if (!parsed.ok) { skip(event.pinId, parsed.reason); continue; }
    const at = toSec(event.timestampMs);
    if (at <= round.commitCloseAt) { skip(event.pinId, 'reveal:before-commit-close'); continue; }
    if (at > round.revealCloseAt) { skip(event.pinId, 'reveal:after-close'); continue; }
    const commit = effectiveCommit.get(event.author);
    if (!commit || commit.pinId !== parsed.value.commit) { skip(event.pinId, 'reveal:not-effective-commit'); continue; }
    if (revealed.has(event.author)) { skip(event.pinId, 'reveal:duplicate'); continue; }
    const expected = ballotCommitHash({
      round: roundPinId,
      judge: event.author,
      salt: parsed.value.salt,
      ballot: parsed.value.ballot,
    });
    if (expected !== commit.hash) { skip(event.pinId, 'reveal:hash-mismatch'); continue; }
    const checked = checkBallot(parsed.value.ballot, round);
    if (!checked.ok) { skip(event.pinId, checked.reason); continue; }
    revealed.add(event.author);
    const kind = judgeKinds.get(event.author);
    const judgeClass: JudgeClass = kind === undefined ? 'public' : round.decision.kinds.includes(kind) ? 'deciding' : 'shadow';
    const pairs = checked.value.pairs.filter(
      (pair) => authorOf.get(pair.a) !== event.author && authorOf.get(pair.b) !== event.author,
    );
    ballots.push({
      author: event.author,
      commitPinId: commit.pinId,
      revealPinId: event.pinId,
      judgeClass,
      kind: kind ?? 'public',
      pairs,
    });
  }

  const ids = round.candidates.map((candidate) => candidate.id);
  const deciding = zeroMatrix(ids);
  const ownContribution = new Map<string, PointMatrix>();
  for (const counted of ballots) {
    if (counted.judgeClass !== 'deciding') continue;
    const own = zeroMatrix(ids);
    for (const pair of counted.pairs) {
      addPick(deciding, pair.a, pair.b, pair.pick);
      addPick(own, pair.a, pair.b, pair.pick);
    }
    ownContribution.set(counted.author, own);
  }

  const countClass = (judgeClass: JudgeClass): number =>
    ballots.filter((counted) => counted.judgeClass === judgeClass && counted.pairs.length > 0).length;
  const ballotCounts = { deciding: countClass('deciding'), shadow: countClass('shadow'), public: countClass('public') };

  const ranking: TallyRankingEntry[] = round.candidates
    .map((candidate) => {
      let wins = 0;
      let losses = 0;
      let ties = 0;
      let points = 0;
      for (const other of ids) {
        if (other === candidate.id) continue;
        const mine = deciding[candidate.id][other];
        const theirs = deciding[other][candidate.id];
        points += mine;
        if (mine > theirs) wins += 1;
        else if (mine < theirs) losses += 1;
        else ties += 1;
      }
      return { id: candidate.id, ref: candidate.ref, copeland: 2 * wins + ties, points, wins, losses, ties };
    })
    .sort((x, y) => y.copeland - x.copeland || y.points - x.points || byteCompare(x.ref, y.ref));

  const status = statusAt(round, options.nowSec, ballotCounts.deciding);

  const judges: TallyJudgeEntry[] = ballots
    .map((counted) => {
      const reference = counted.judgeClass === 'deciding' ? subtract(deciding, ownContribution.get(counted.author)) : deciding;
      let agreeN = 0;
      let agreeHits = 0;
      for (const pair of counted.pairs) {
        const winner = strictWinner(reference, pair.a, pair.b);
        if (winner === null) continue;
        agreeN += 1;
        if (pickedId(pair) === winner) agreeHits += 1;
      }
      return {
        id: counted.author,
        kind: counted.kind,
        class: counted.judgeClass,
        commit: counted.commitPinId,
        reveal: counted.revealPinId,
        pairs: counted.pairs.length,
        agreeN,
        agreeHits,
        agreementBP: Math.floor((10000 * (agreeHits + 1)) / (agreeN + 2)),
      };
    })
    .sort((x, y) => byteCompare(x.id, y.id));

  const dimensions: Record<string, Record<string, number>> = {};
  for (const dimension of round.dimensions) {
    const points: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const counted of ballots) {
      if (counted.judgeClass !== 'deciding') continue;
      for (const pair of counted.pairs) {
        const value = pair.dims?.[dimension.id];
        if (value === 'a') points[pair.a] += 2;
        else if (value === 'b') points[pair.b] += 2;
        else if (value === 'tie') {
          points[pair.a] += 1;
          points[pair.b] += 1;
        }
      }
    }
    dimensions[dimension.id] = points;
  }

  const evidence = ballots
    .filter((counted) => counted.judgeClass !== 'public' && counted.pairs.length > 0)
    .map((counted) => counted.revealPinId)
    .sort(byteCompare);

  const output: TallyOutput = {
    engine: PREFERENCE_TALLY_ENGINE,
    round: roundPinId,
    status,
    winner: status === 'decided' ? ranking[0].id : null,
    ranking,
    ballots: ballotCounts,
    judges,
    dimensions,
    evidence,
  };
  const final = status === 'decided' || status === 'no_decision';
  return {
    ok: true,
    result: {
      output,
      tallyHash: final ? sha256Hex(canonJ(output)) : null,
      diagnostics: { ignored, evaluatedAt: options.nowSec },
    },
  };
}
```

Note: `events.filter(...)` returns a new array, so `.sort` never mutates the caller's input.

- [ ] **Step 5: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceEngine.test.mjs`
Expected: PASS (19 scenario tests + 3 invariance tests). If a scenario fails, re-derive its expectation by hand from protocol §5 before touching the engine; if the hand derivation agrees with the engine, report the scenario comment as wrong to the planner.

- [ ] **Step 6: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/engine.ts
git add -f tests/fixtures/preference/scenarios.mjs tests/preferenceEngine.test.mjs
git commit -m "feat: add deterministic preference tally engine"
```

---

### Task 4: Lesson validity and canonical round

**Files:**
- Create: `src/main/services/preference/lesson.ts`
- Test: `tests/preferenceLesson.test.mjs`

**Interfaces:**
- Consumes: `parseLesson` (Task 1); `compareOrderKey`, `resolveRound`, `tallyRound` (Task 3).
- Produces:
  - `type LessonVerdict = { ok: true; lesson: LessonBody } | { ok: false; reason: string }`
  - `checkLesson(body: unknown, tally: TallyResult): LessonVerdict` — reasons `lesson:*` from `parseLesson`, plus `lesson:round-mismatch`, `lesson:round-not-decided`, `lesson:tally-hash-mismatch`, `lesson:preferred-not-winner`, `lesson:unknown-rejected`, `lesson:evidence-not-in-tally`.
  - `verifyLessonPin(events, lessonPinId, nowSec): LessonVerdict` — adds `lesson:not-found` and any `round:*` reason.
  - `type CanonicalRoundResolution = { state: 'decided'; roundPinId: string; result: TallyResult } | { state: 'pending'; roundPinId: string } | { state: 'none' }`
  - `canonicalRoundForSubject(events, subject: { taskid: string; node: string; rootAuthor: string }, nowSec: number): CanonicalRoundResolution` (protocol §7).

- [ ] **Step 1: Write the failing tests**

Create `tests/preferenceLesson.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { C3_BEST, FINAL_NOW, H1, H2, REVEAL_CLOSE, ROUND_AT, chain, pid, roundBody } from './fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { tallyRound } = require('../dist-electron/main/services/preference/engine.js');
const { canonicalRoundForSubject, checkLesson, verifyLessonPin } = require(
  '../dist-electron/main/services/preference/lesson.js',
);

const decidedRound = () => {
  const c = chain();
  const round = c.openRound();
  const h1 = c.vote(round, H1, C3_BEST);
  c.vote(round, H2, C3_BEST);
  const tally = tallyRound(c.events, round, { nowSec: FINAL_NOW }).result;
  const lesson = {
    round,
    category: ['ui:qa-community'],
    summary: 'Judges preferred the denser feed.',
    principles: [{
      text: 'Show five or more questions per screen.',
      conditions: 'Browse-first readers on desktop.',
      uncertainty: 'Two judges only.',
      evidence: [h1.reveal.pinId],
    }],
    exemplars: { preferred: 'c3', rejected: ['c1'] },
    tallyHash: tally.tallyHash,
  };
  return { c, round, tally, lesson, h1 };
};

test('a lesson matching the final tally is valid', () => {
  const { c, lesson } = decidedRound();
  assert.equal(checkLesson(lesson, tallyRound(c.events, lesson.round, { nowSec: FINAL_NOW }).result).ok, true);
  const pin = c.add('lesson', lesson, H1, REVEAL_CLOSE + 9_000);
  assert.equal(verifyLessonPin(c.events, pin.pinId, FINAL_NOW).ok, true);
});

test('lesson rejections', () => {
  const { tally, lesson, h1 } = decidedRound();
  const cases = [
    [{ ...lesson, exemplars: { preferred: 'c2', rejected: [] } }, 'lesson:preferred-not-winner'],
    [{ ...lesson, tallyHash: 'f'.repeat(64) }, 'lesson:tally-hash-mismatch'],
    [{ ...lesson, round: pid(999) }, 'lesson:round-mismatch'],
    [{ ...lesson, exemplars: { preferred: 'c3', rejected: ['c7'] } }, 'lesson:unknown-rejected'],
    [{ ...lesson, principles: [{ ...lesson.principles[0], evidence: [h1.commit.pinId] }] }, 'lesson:evidence-not-in-tally'],
  ];
  for (const [body, reason] of cases) assert.deepEqual(checkLesson(body, tally), { ok: false, reason });
});

test('a lesson against an unfinished round is rejected', () => {
  const { c, lesson } = decidedRound();
  const early = tallyRound(c.events, lesson.round, { nowSec: REVEAL_CLOSE }).result;
  assert.deepEqual(checkLesson(lesson, early), { ok: false, reason: 'lesson:round-not-decided' });
});

test('canonical round: earliest root-author round that did not end no_decision', () => {
  const subject = { taskid: pid(500), node: 'UI' };
  const c = chain();
  const failed = c.openRound({ subject });
  c.vote(failed, H1, C3_BEST);
  c.add('round', roundBody({ subject }), H1, ROUND_AT);
  const second = c.openRound({ subject });
  c.vote(second, H1, C3_BEST);
  c.vote(second, H2, C3_BEST);
  const query = { ...subject, rootAuthor: c.events[0].author };
  const final = canonicalRoundForSubject(c.events, query, FINAL_NOW);
  assert.equal(final.state, 'decided');
  assert.equal(final.roundPinId, second);
  assert.deepEqual(canonicalRoundForSubject(c.events, query, REVEAL_CLOSE), { state: 'pending', roundPinId: failed });
  assert.deepEqual(canonicalRoundForSubject(c.events, { ...query, node: 'OTHER' }, FINAL_NOW), { state: 'none' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm run compile:electron && node --test tests/preferenceLesson.test.mjs`
Expected: FAIL with `Cannot find module '../dist-electron/main/services/preference/lesson.js'`.

- [ ] **Step 3: Write `lesson.ts`**

```ts
import { compareOrderKey, resolveRound, tallyRound } from './engine';
import { parseLesson } from './schemas';
import type { LessonBody, PreferenceChainEvent, TallyResult } from './types';

export type LessonVerdict = { ok: true; lesson: LessonBody } | { ok: false; reason: string };

export type CanonicalRoundResolution =
  | { state: 'decided'; roundPinId: string; result: TallyResult }
  | { state: 'pending'; roundPinId: string }
  | { state: 'none' };

export function checkLesson(body: unknown, tally: TallyResult): LessonVerdict {
  const parsed = parseLesson(body);
  if (!parsed.ok) return parsed;
  const lesson = parsed.value;
  const { output, tallyHash } = tally;
  if (lesson.round !== output.round) return { ok: false, reason: 'lesson:round-mismatch' };
  if (output.status !== 'decided' || tallyHash === null) return { ok: false, reason: 'lesson:round-not-decided' };
  if (lesson.tallyHash !== tallyHash) return { ok: false, reason: 'lesson:tally-hash-mismatch' };
  if (lesson.exemplars.preferred !== output.winner) return { ok: false, reason: 'lesson:preferred-not-winner' };
  const candidateIds = new Set(output.ranking.map((entry) => entry.id));
  if (!lesson.exemplars.rejected.every((id) => candidateIds.has(id))) return { ok: false, reason: 'lesson:unknown-rejected' };
  const evidence = new Set(output.evidence);
  for (const principle of lesson.principles) {
    if (!principle.evidence.every((pinId) => evidence.has(pinId))) return { ok: false, reason: 'lesson:evidence-not-in-tally' };
  }
  return { ok: true, lesson };
}

export function verifyLessonPin(events: readonly PreferenceChainEvent[], lessonPinId: string, nowSec: number): LessonVerdict {
  const event = events.find((candidate) => candidate.path === 'lesson' && candidate.pinId === lessonPinId);
  if (!event) return { ok: false, reason: 'lesson:not-found' };
  const roundPinId = typeof event.body.round === 'string' ? event.body.round : '';
  const tally = tallyRound(events, roundPinId, { nowSec });
  if (!tally.ok) return { ok: false, reason: tally.reason };
  return checkLesson(event.body, tally.result);
}

export function canonicalRoundForSubject(
  events: readonly PreferenceChainEvent[],
  subject: { taskid: string; node: string; rootAuthor: string },
  nowSec: number,
): CanonicalRoundResolution {
  const rounds = events
    .filter((event) => event.path === 'round' && event.author === subject.rootAuthor)
    .sort(compareOrderKey);
  for (const event of rounds) {
    const resolved = resolveRound(events, event.pinId);
    if (!resolved.ok) continue;
    const roundSubject = resolved.round.subject;
    if (!roundSubject || roundSubject.taskid !== subject.taskid || roundSubject.node !== subject.node) continue;
    const tally = tallyRound(events, event.pinId, { nowSec });
    if (!tally.ok) continue;
    const { status } = tally.result.output;
    if (status === 'no_decision') continue;
    if (status === 'decided') return { state: 'decided', roundPinId: event.pinId, result: tally.result };
    return { state: 'pending', roundPinId: event.pinId };
  }
  return { state: 'none' };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm run compile:electron && node --test tests/preferenceLesson.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
pnpm run lint
git add src/main/services/preference/lesson.ts
git add -f tests/preferenceLesson.test.mjs
git commit -m "feat: add preference lesson validity and canonical round rule"
```

---

### Task 5: Conformance vectors and scripts

**Files:**
- Create: `scripts/preference-build-vectors.mjs`
- Create: `scripts/preference-vectors.mjs`
- Create (generated): `tests/fixtures/preference/tally-vectors.json`
- Modify: `package.json` (`scripts` block, next to `test:metatask`)

**Interfaces:**
- Consumes: `SCENARIOS`, `checkScenario` (Task 3); `tallyRound`; `canonJ`, `sha256Hex`; `PREFERENCE_TALLY_ENGINE`, `PREFERENCE_PIN_VERSION`.
- Produces: fixture shape `{ version: 1, protocol, protocolVersion, engine, note, canonicalSha256, vectors: [{ id, nowSec, round, events, expect }] }`; `pnpm run test:preference` (later phases append test files to it); `pnpm run preference:vectors`; `pnpm run preference:vectors:build`.

The fixture holds 19 vectors covering all 17 items of protocol §8 (status transitions use `basic-winner` plus the three `status-*` vectors; "below minBallots" has its own vector and is also exercised by the six broken-vote vectors).

- [ ] **Step 1: Write the generator `scripts/preference-build-vectors.mjs`**

```js
#!/usr/bin/env node
/**
 * Regenerates tests/fixtures/preference/tally-vectors.json from the scenario
 * builders. Expectations are hand-authored in scenarios.mjs; canonicalSha256
 * locks the full engine output. Run after `pnpm run compile:electron`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, checkScenario } from '../tests/fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { tallyRound } = require('../dist-electron/main/services/preference/engine.js');
const { canonJ, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');
const { PREFERENCE_PIN_VERSION, PREFERENCE_TALLY_ENGINE } = require('../dist-electron/main/services/preference/constants.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'tests', 'fixtures', 'preference', 'tally-vectors.json');

const vectors = [];
const outputs = [];
for (const scenario of SCENARIOS) {
  const { round, events } = scenario.build();
  const tally = tallyRound(events, round, { nowSec: scenario.nowSec });
  if (!tally.ok) throw new Error(`${scenario.id}: ${tally.reason}`);
  const problems = checkScenario(tally.result, scenario.expect);
  if (problems.length > 0) throw new Error(`${scenario.id}: ${problems.join('; ')}`);
  vectors.push({ id: scenario.id, nowSec: scenario.nowSec, round, events, expect: scenario.expect });
  outputs.push({ id: scenario.id, output: tally.result.output, tallyHash: tally.result.tallyHash });
}

const fixture = {
  version: 1,
  protocol: '/protocols/preference',
  protocolVersion: PREFERENCE_PIN_VERSION,
  engine: PREFERENCE_TALLY_ENGINE,
  note: 'Generated by scripts/preference-build-vectors.mjs. Edit tests/fixtures/preference/scenarios.mjs and regenerate; never edit by hand.',
  canonicalSha256: sha256Hex(canonJ(outputs)),
  vectors,
};
fs.writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors to ${path.relative(process.cwd(), target)}`);
console.log(`CANONICAL_SHA256 ${fixture.canonicalSha256}`);
```

- [ ] **Step 2: Write the replay runner `scripts/preference-vectors.mjs`**

```js
#!/usr/bin/env node
/** Replays the frozen preference tally vectors against the compiled engine. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkScenario } from '../tests/fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { tallyRound } = require('../dist-electron/main/services/preference/engine.js');
const { canonJ, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'tests', 'fixtures', 'preference', 'tally-vectors.json'), 'utf8'),
);

let failures = 0;
const outputs = [];
for (const vector of fixture.vectors) {
  const tally = tallyRound(vector.events, vector.round, { nowSec: vector.nowSec });
  if (!tally.ok) {
    failures += 1;
    console.log(`FAIL ${vector.id}: ${tally.reason}`);
    continue;
  }
  const problems = checkScenario(tally.result, vector.expect);
  if (problems.length > 0) {
    failures += 1;
    console.log(`FAIL ${vector.id}: ${problems.join('; ')}`);
  } else {
    console.log(`PASS ${vector.id}`);
  }
  outputs.push({ id: vector.id, output: tally.result.output, tallyHash: tally.result.tallyHash });
}

const digest = sha256Hex(canonJ(outputs));
console.log(`CANONICAL_SHA256 ${digest}`);
if (digest !== fixture.canonicalSha256) {
  failures += 1;
  console.log(`FAIL canonical digest differs from the fixture (${fixture.canonicalSha256})`);
}
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ALL VECTORS PASS');
```

- [ ] **Step 3: Add the package scripts**

In `package.json` `scripts`, directly after the `"test:metatask"` line, add:

```json
    "test:preference": "pnpm run compile:electron && node --test tests/preferenceSchemas.test.mjs tests/preferenceSealing.test.mjs tests/preferenceEngine.test.mjs tests/preferenceLesson.test.mjs && node scripts/preference-vectors.mjs",
    "preference:vectors": "node scripts/preference-vectors.mjs",
    "preference:vectors:build": "pnpm run compile:electron && node scripts/preference-build-vectors.mjs",
```

- [ ] **Step 4: Verify the runner fails without a fixture**

Run: `pnpm run compile:electron && node scripts/preference-vectors.mjs`
Expected: FAIL with `ENOENT` for `tally-vectors.json`.

- [ ] **Step 5: Generate the fixture, then replay**

Run: `pnpm run preference:vectors:build && pnpm run test:preference`
Expected: the build prints `wrote 19 vectors` and a `CANONICAL_SHA256`; the test run ends with 19 `PASS` lines, the same `CANONICAL_SHA256`, and `ALL VECTORS PASS`.

- [ ] **Step 6: Tamper check (do not commit this change)**

Edit one `expect.winner` in `tests/fixtures/preference/tally-vectors.json` by hand, run `pnpm run preference:vectors`, and confirm it exits 1 with a `FAIL` line. Restore it with `git checkout -- tests/fixtures/preference/tally-vectors.json` if it was already staged, or rerun `pnpm run preference:vectors:build`.

- [ ] **Step 7: Phase verification**

```bash
pnpm run compile:electron
pnpm run build:skills
pnpm run lint
node --test tests/*.test.mjs
pnpm run test:preference
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add scripts/preference-build-vectors.mjs scripts/preference-vectors.mjs package.json
git add -f tests/fixtures/preference/tally-vectors.json
git commit -m "test: add preference tally conformance vectors"
```

Then write the handoff note described in the overview, including the `CANONICAL_SHA256` value.
