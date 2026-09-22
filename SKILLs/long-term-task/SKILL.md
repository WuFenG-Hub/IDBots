---
name: long-term-task
description: Create and define a long-term task (长期任务) — a persistent, cross-session decomposition of a fuzzy, multi-day/multi-week goal into ordered sub-projects with acceptance criteria. Use when the user wants to start something that cannot be finished in one session and will hit blocking points (owner decisions, external conditions). Not for one-session work (just do it in the current cowork turn), multi-bot short jobs (use metabot-group-task), scheduled automation (use scheduled-task), or on-chain multi-bot collaborative decompositions (that is a MetaTask — use the MetaTask tools instead).
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

Decide where the ask belongs. Ask one clarifying question if genuinely unclear;

| Shape | Route |
| --- | --- |
| Finishable in a few turns, single bot | Just do it in this cowork session |
| Short job needing several bots | Group task (metabot-group-task) |
| Recurring / time-triggered | Scheduled task (scheduled-task) |
| Days–weeks, blocking points, one owner (the user) | **Long-term task — this skill** |
| On-chain decomposition claimed by many bots across the network | MetaTask tools (not this skill) |

If it's not a long-term task, say so and route — do not create one anyway.

## Step 1 — Grill (interview the owner until the boundary is explicit)

Method: work a **design tree in frontier rounds** (the "grilling" pattern):

- Every decision branches into dependent decisions. Each round, ask the whole
  **frontier** — every question whose prerequisites are already settled —
  numbered, each with **your recommended answer**.
- A question whose answer depends on an open question belongs to a later round.
- **Facts are YOUR job, never the user's.** Before asking anything you could
  look up (codebase state, existing projects, chain state, prior art), look it
  up with your tools first; only decisions go to the user.
- **Text Q&A only**: ask in prose; the user answers in prose. Never present
  option panels/buttons as the decision mechanism — text answers carry more
  signal. (Buttons in the task UI deep-link into the conversation; they are
  not how decisions are made.)
- **Use alignment media when it sharpens the boundary**: an HTML prototype, a
  sketch, a comparison table. Show, don't just tell, when the shape matters.

Topics the grilling must converge on:

1. The goal in one paragraph, including the **done-ness definition** of the
   whole task (what does "this long-term task is complete" look like?).
2. The **sub-project split**: concrete, independently verifiable chunks. Test
   each candidate: does it have an observable deliverable? is it clear who/what
   produces it? is it too coarse (split) or too fine (merge)?
3. **Acceptance criteria per sub-project** — checkable, one per line. "官网做好
   了" is not a criterion; "官网可访问且可注册、视觉与原型一致" is.
4. **Dependencies and order** — what must be accepted before what.
5. **Preferred execution channel** per sub-project: `delegate_bot` /
   `group_task` / `owner_external` (the user arranges it outside) /
   `owner_together` (you and the user work it in a session).
6. Anything likely to **wait**: external deliveries, owner decisions, dates —
   they become `wait_note`/`wait_until` later, name them now.

Expect several rounds. Days of alignment are cheaper than weeks of drift.

## Step 2 — Create the draft

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

## Step 3 — Present and activate

Present the created split in chat as a compact table (ordinal / title /
acceptance criteria / dependencies / channel). Ask explicitly: "确认就这样拆
分吗？要改哪一项直接说。" Only after the owner confirms **in prose**:

```
longterm_task_activate({ taskId })
```

Never activate on your own initiative — activation is the owner's sign-off.

## Resuming an interrupted definition

Drafts persist. If the user comes back to a half-defined task, call
`longterm_task_list`, find the `defining` one, `longterm_task_get` it, and
resume the grilling from where it stopped — never start a duplicate draft.

## After activation

Driving the task (beginning sub-projects, waiting, proposing acceptance,
journalling) is the `longterm-task-exec` skill's discipline. Creation ends at
activation.
