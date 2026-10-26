# Daily Report v2 — Proposal (align before implementing)

Branch: `feat/daily-report-v2` · Owner review requested 2026-10-26 · Demo: [demo.html](./demo.html) (real 24h data, hand-written one-liners standing in for the LLM output).

## 1. Diagnosis — why the current report scores 4–5/10

Evidence: the manual report of 2026-10-26 (session `32d9cbb9-…`, window 10-25 08:00 → 10-26 01:21) audited against the real 24h DB state (10-25 00:00 → 10-26 01:21).

| # | Problem | Root cause in code |
| --- | --- | --- |
| 1 | **"What each bot did" is entirely missing.** Real day: 20/20 bots active, 66 sessions, 11,431 local messages, 25 scheduled runs, 222 DMs — none of it narrated. | `DAILY_REPORT_BRAIN_PROMPT_ZH/EN` explicitly forbids per-bot narration ("绝对不要叙述…每个 Bot 的日记式流水"). The owner wants per-bot one-liners, not diaries — the prompt banned the wrong thing. |
| 2 | **Per-bot counts table is meaningless** (sessions / runs / DMs / group msgs per bot). "loop: 0 sessions, 1 run, 52 DMs" says nothing about what loop did. | `buildDailyReportBotRollupMarkdown` — counts only. `botDigests` (dream summaries) are collected but brain-input-only, and dream digests for the report day usually don't exist yet at 08:00 (most bots dream later). |
| 3 | **HTML report duplicates the markdown verbatim** (same prose + same tables), and the chat renders both (markdown bubble + iframe card for the `file://…html` link). | `buildDailyReportHtml` renders the same deterministic sections + the same brain prose; `MarkdownContent.tsx:146` renders local `.html` links as a report card. |
| 4 | **No "what's coming next".** Boss wants: yesterday recap → decisions needed today → today's outlook. | Collector has no `upcoming` bucket: `scheduled_tasks.next_run_at_ms`, open orchestrations, and active long-term tasks are never read. |
| 5 | **Prose covers only owner orchestrations + long-term + follow-ups**; the fleet's actual work (sessions incl. a2a/browser/group_task/longterm types, surf战报, online chats) never reaches the brain as narratable material. | `humanSessions` bucket only counts sessions with HUMAN-submitted messages; bot-autonomous sessions (the majority) are invisible. |

Not broken (keep): the scheduler/window/skip/retry pipeline (`dailyReportService`), the deterministic follow-up deep links, fail-soft buckets, locale handling, "report always ships" degradation.

## 2. New format — EA-style boss briefing (one page, decision-first)

Reference: standard executive-assistant daily briefs (schedule → top priorities/decisions → risks → today). See [EA Campus](https://theeacampus.com/blog/executive-briefing), [Notion executive briefing template](https://www.notion.com/templates/executive-briefing-meeting).

### 2.1 Chat markdown (the 10-second scan; Twin session message)

```markdown
**昨日总览** — 2–4 sentences naming the main lines with outcomes (LLM).

**各 Bot 一句话** — one line per ACTIVE bot (LLM distills from facts):
- **AI_Sunny**：移动端额度耗尽 A 方案真机验收通过，挖出充值页套餐列表故障；…
- **Eleven**：双片交付：45s《梦的沉淀》+ 48s 官宣片 v2；迎新邀约。…

**需要你拍板** — deterministic follow-up deep links (kept) + LLM-surfaced blockers
with a suggested action each (🔴/🟡 priority), e.g. 充值页密钥失效 / 转账被拒挂起单.

**今日预告** — deterministic: upcoming 24h scheduled fires (time · name · bot,
collapsed to the notable ones + total), open orchestrations awaiting review,
active long-term progress one-liner.
```

Changes vs today: the counts table is DELETED; per-bot one-liners replace it; a
"今日预告" section is ADDED; blockers get suggested actions, not just titles.

### 2.2 HTML visual report (different content, not a duplicate)

Self-contained file, inline SVG only (no external deps — must stay openable from `file://`):

1. KPI row — active bots X/Y, active sessions, local messages, scheduled runs (all-success badge), online msgs.
2. Headline strip — ONE sentence (the brain's opening), not the full prose.
3. 24h activity chart — dual-series bar/line (local messages per 2h + online msgs).
4. **Per-bot card grid** — avatar dot, name, one-liner (same distilled line as markdown), activity meter + session/msg count chips.
5. Needs-you cards — color-coded by priority, deep links, suggested action.
6. Main-line progress — progress bars (long-term %, group tasks done, open reviews chips).
7. Today agenda — timeline of upcoming fires.

The full prose and the raw tables no longer appear in the HTML at all.

### 2.3 Division of labor (the anti-duplication rule)

- **Markdown = words to scan**: overview prose, per-bot one-liners, decisions, agenda summary.
- **HTML = visuals + navigation**: numbers, charts, meters, deep links.
- The only shared strings are the per-bot one-liners and item titles (a line of text in chat vs a card in the page). Everything else is disjoint by construction.

## 3. Implementation plan

### Phase 1 — Collector: two new fact buckets (`dailyReportCollector.ts`)

- `botActivity[]` (≤20 bots, activity-score sorted): per bot — `botName`, `isTwin`,
  `sessions[]` (≤3 by message volume in window; title / session_type / msgs /
  `lastAssistantExcerpt` ≤160 chars — surf sessions already end with a JSON
  `summary` blob, an ideal excerpt), `scheduledRuns[]` (names + statuses),
  `externalChats[]` (peer name + DM count + last-message excerpt),
  `openTeam[]` (active-in-window memberships), `chainInteractions[]`
  (path-derived kind + count + last summary), `groupMessages`.
  - Source: `cowork_sessions` joined to `cowork_messages` in window across ALL
    session types AND all visibility states (worker sessions are
    `hidden_from_session_list` but are the bots' main work — verified on the
    real DB: 25 of 63 active sessions in the 10-25 window were hidden, and 9
    bots had NO visible session at all), keyed by `metabot_id`; excludes the
    daily-report sessions themselves and archived rows.
- `upcoming{}`: scheduled tasks with `next_run_at_ms` in (windowEnd, +24h)
  (time/name/bot), open orchestrations (status planning/running/review, title +
  status), active long-term tasks (title/stage/%).
- `hourlyActivity{}`: 12×2h message buckets (local + online) for the visual
  timeline chart.
- Budget: `DAILY_REPORT_MAX_FACTS_JSON_BYTES` 20KB → **80KB** (one idle-time
  call/day; per-turn context constraint untouched — this is a background job).
  History: the approved-then-implemented 48KB and then 64KB both turned out
  too tight — a real full day (20 bots = the system-wide cap, 60+ sessions,
  dream digests landed) needs ~60-70KB, and tight budgets forced the cap
  ladder to drop entire bots or narrated sessions, defeating the
  one-line-per-active-bot contract. At 80KB the real 10-25 day fits at 62KB
  with every bot at its full 3 sessions and 160-char excerpts (no rung fires).
  botDigests were REMOVED entirely (owner call 2026-10-26): mostly absent at
  the 08:00 fire time and fully covered by botActivity. The ladder still
  trims per-item text first; bot-dropping stays the last resort.

### Phase 2 — Generator: new prompt, new markdown, new HTML (`dailyReportGenerator.ts`)

- Rewrite the brain contract (zh/en in their own languages): three parts —
  ① overview 2–4 sentences naming main lines; ② **one line per active bot**
  ("干了什么 + 结果/产出", 20–40 chars, NO laundry list, merge trivial bots into
  one grouped line is allowed); ③ blockers needing the owner with a suggested
  action each, ONLY from facts. Keep: locale-native, no ids/links invented,
  bounded length (~raise maxTokens 1200 → 2000).
- Deterministic markdown: follow-up deep-link list (kept as-is) + 今日预告
  (upcoming bucket) appended after the prose; counts table removed.
- HTML: rebuilt per §2.2; new `buildDailyReportHtml` with inline SVG builders
  (bar chart, meters, progress bars) — deterministic, escaping preserved.
- Fallback (no brain): deterministic per-bot lines from session titles
  (strip `[编排任务]`-style prefixes, join top-2 titles + "N 会话 M 消息") so the
  report always carries the fleet section.

### Phase 3 — Tests

- Collector shaping tests for the two new buckets (canned rows, caps, fail-soft).
- Generator golden tests: markdown section order/omission, HTML contains chart/card
  scaffolds and NOT the prose tables, fallback bot-lines, locale strings.
- Update existing dailyReport tests that assert the counts table / old prompt.

Estimated diff surface: `dailyReportCollector.ts` (+~200), `dailyReportGenerator.ts` (rewrite of brief/html builders + prompt, ~±300), `dailyReportService.ts` (pass-through only), tests (+~300). No schema changes; no renderer changes (the iframe card already renders the new HTML).

## 4. Decisions for the owner (blockers before implementation)

1. **Markdown/HTML split as proposed?** (HTML drops prose+tables entirely, becomes visuals; markdown drops the counts table.)
2. **Per-bot one-liners by LLM** from (session titles + last-assistant excerpts + run names + DM counts) — acceptable that "what was discussed inside a conversation" is inferred from title + last message only (full transcripts would blow the budget)? Alternative: also feed the dream digest when it exists.
3. **Facts budget 20KB → 48KB** for the once-daily brain call — OK? (Idle-time LLM tokens are fine per standing constraint; nothing per-turn changes.)
4. **今日预告 deterministic** (raw schedule lines) vs LLM-polished one-paragraph? (Recommend: deterministic list — it is a schedule, accuracy over prose.)
5. Anything to ADD/REMOVE from the four markdown sections (总览 / 各Bot一句话 / 需要你拍板 / 今日预告)?
