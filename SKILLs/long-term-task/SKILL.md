---
name: long-term-task
description: Create and define a long-term task (长期任务) — a persistent, cross-session decomposition of a fuzzy, multi-day/multi-week goal into ordered sub-projects with acceptance criteria. Use when the user wants to start something that cannot be finished in one session and will hit blocking points (owner decisions, external conditions). MUST be entered when the user says they want to start/open a long-term task. Not for one-session work (just do it in the current cowork turn), multi-bot short jobs (use metabot-group-task), scheduled automation (use scheduled-task), or on-chain multi-bot collaborative decompositions (that is a MetaTask — use the MetaTask tools instead).
official: true
---

# Long-Term Task — Creation & Requirement Alignment

A **long-term task** is a persistent task decomposition that survives sessions:
an ordered list of sub-projects, each with explicit acceptance criteria, which
you (the TwinBot) then drive over days or weeks — checking in via the
heartbeat, opening discussion sessions, collecting evidence, and asking the
owner to accept each sub-project.

## Why this skill exists (read this first)

Users state long-term goals fuzzily ("发布 AI 互联网的整体概念并冷启动"). The
single most common failure mode is charging ahead on a one-line ask and
building the wrong thing for weeks — this project has a real scar from exactly
that (a whole kanban feature built from one sentence, later discarded).
**Alignment before creation is the watershed** between a useful long-term task
and wasted work. Never skip it, never rush it.

## Step 0 — Route the request (before anything else)

Decide where the ask belongs. If genuinely unclear, your FIRST question is the
routing question:

| Shape | Route |
| --- | --- |
| Finishable in a few turns, single bot | Just do it in this cowork session |
| Short job needing several bots | Group task (metabot-group-task) |
| Recurring / time-triggered | Scheduled task (scheduled-task) |
| Days–weeks, blocking points, one owner (the user) | **Long-term task — this skill** |
| On-chain decomposition claimed by many bots across the network | MetaTask tools (not this skill) |

If it's not a long-term task, say so and route — do not create one anyway.

## Step 1 — Research deeply, BEFORE any question

The owner should never be asked for facts you could have found. Before the
first question, run a real investigation and open with a **research digest**:

- **Search the MetaWeb** (pins, protocols, MetaApps) for everything adjacent:
  existing implementations, prior art, reusable protocols. Do not stop at the
  first hit — vary the queries; a known-to-exist piece of prior art that your
  digest misses is a skill failure.
- **Open and study what you find**: read the pins, open the MetaApps, read the
  code/docs when reachable. "X exists" is worthless without "X works like this,
  we can reuse / must avoid …".
- **Survey local capabilities**: which bots/workers/skills/infra could carry
  each suspected sub-project, and rough cost/feasibility.
- Produce **preliminary technical directions** per suspected sub-project area —
  one line each is fine, but they must exist; "we'll figure it out later" is
  not research.

Open the conversation with this digest (cite pin ids / links), then go
straight into Question 1. If genuinely nothing exists, say which searches you
ran — a claim of "no prior art" must name its evidence too.

## Step 2 — Grill: ONE question per round, multiple choice + recommendation

Question mechanics (from the grilling and superpowers/brainstorming patterns):

- **Exactly one question per message.** Never batch questions. Wait for the
  answer before the next round. A long-term task is defined over many short
  rounds, not one interrogation wall.
- Keep an internal **design tree**: know which open decision is most valuable
  next (its answer unblocks the most downstream decisions) and ask that one.
  Don't ask about details that a still-open upstream decision would moot.
- **Every question is a multiple choice** with 2–4 options. **Your recommended
  option comes first, marked, with one-line reasoning.** Other options follow
  with their trade-offs.
- Always end with the escape: the owner may answer with their own free-text
  idea instead of any option. "按推荐来" must be a valid, complete answer —
  an undecided owner can delegate the call to you safely.
- **Text Q&A only**: ask in prose, the owner answers in prose. Never present
  UI option panels as the decision mechanism.
- **Visual aids just-in-time**: when a question is genuinely clearer shown than
  told (a lobby layout, a protocol flow), make an HTML prototype/sketch/table
  for THAT question — don't front-load visuals, don't skip them when they'd
  prevent a misunderstanding.

Topics the grilling must converge on (order them by the design tree, not by
this list):

1. The goal in one paragraph, including the **done-ness definition** of the
   whole task (what does "this long-term task is complete" look like?).
2. The **sub-project split**: concrete, independently verifiable chunks. Test
   each candidate: observable deliverable? clear producer? too coarse (split)
   or too fine (merge)?
3. **Acceptance criteria per sub-project** — checkable, one per line. "官网做
   好了" is not a criterion; "官网可访问且可注册、视觉与原型一致" is.
4. **Dependencies and order** — what must be accepted before what.
5. **Preferred execution channel** per sub-project: `delegate_bot` /
   `group_task` / `owner_external` (the user arranges it outside) /
   `owner_together` (you and the user work it in a session).
6. Likely **waits**: external deliveries, owner decisions, dates — they become
   `wait_note`/`wait_until` later; name them now.

## Step 3 — Create the draft

Only when the split is concrete and the user has seen the full picture:

```
longterm_task_create({
  title,
  goal,                    // includes the whole-task done-ness definition
  subtasks: [              // ordered; dependencies by 1-based ordinal
    { title, description, acceptanceCriteria: [...], dependsOnOrdinals: [...],
      preferredChannel, notes },
    ...
  ],
  definitionSessionId,     // this session's id, for traceability
})
```

This creates a **draft** (`defining` stage) — visible on the board's
"Defining" column, not yet driven.

## Step 4 — Present the full split, then activate

Present the created split in chat as a compact table (ordinal / title /
acceptance criteria / dependencies / channel) and ask explicitly for a final
verdict, e.g. "确认就这样拆分吗？要改哪一项直接说。" Only after the owner
confirms **in prose**:

```
longterm_task_activate({ taskId })
```

Never activate on your own initiative — activation is the owner's sign-off.
A change request sends you back to Step 2 for that branch of the tree.

## Resuming an interrupted definition

Drafts persist. If the user comes back to a half-defined task, call
`longterm_task_list`, find the `defining` one, `longterm_task_get` it, and
resume the grilling from where it stopped — never start a duplicate draft.

## After activation

Driving the task (beginning sub-projects, waiting, proposing acceptance,
journalling) is the `longterm-task-exec` skill's discipline. Creation ends at
activation.
