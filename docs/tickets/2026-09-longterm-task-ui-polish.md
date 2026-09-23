# Long-term task UI polish batch (P1 acceptance feedback)

Status: **pending** — collected during the owner's P1 acceptance run on
`feat/tracking-tasks`; fix as one batch after the P1 heartbeat feel is signed
off (before/with P2).

Source: owner feedback 2026-09-22, live task `ltt_c7f775ec-6465-4fa5-9ad0-bb1e66d9e3d0`
(链上 MetaBot 联机游戏中心) on the worktree dev instance.

## 1. Task id + copy affordance on the detail page

Add the task id (small, low-key) next to the task title with a copy-icon
button that copies the id to the clipboard — for exactly the "here's the task
id" conversations. Style deliberately unobtrusive.

## 2. Heartbeat nudge prompt must follow the user's locale

`buildNudgePrompt` (src/main/services/longTermAdvanceService.ts) is a fixed
English template that lands as a user-role message in the longterm session.
Chinese-locale owners should see the hand-off message in Chinese; non-Chinese
locales stay English. Read the user's language setting on the main side
(settings/kv) and render the prompt per locale (zh template vs en template);
keep the trailing "reply in the owner's language" instruction in the matching
language. (Note: this is a fixed template from our code, not LLM output — so
it is a code-level i18n fix.)

## 3. Subtask id + copy affordance in the sub-project detail

Same as #1, for the selected sub-project's id (the detail panel header).
Low-key style.

## 4. Bound session should be a link that jumps to it

The detail page's 关联会话 currently renders the raw session id (or 暂无).
Make it a link/button that navigates straight to that cowork session (find the
existing session-navigation mechanism — cowork slice select + view switch —
and reuse it; hide or keep 暂无 when unbound).

## 5. Accept/reject buttons must only appear for `waiting_owner`

Currently the detail panel shows 验收通过 / 打回重做 also while a sub-project
is `in_progress` — odd, and reject from `in_progress` is actually refused by
the store (VALIDATION), so the button would error on click. Fix: show the two
verdict buttons only when status is `waiting_owner` (i.e. the TwinBot proposed
acceptance with evidence). The store keeps accepting direct owner acceptance
from `in_progress` for the tool path; the UI simply stops offering it.

## 6. Participant bot avatars on card + detail page

Show the bots participating in a task as a small avatar stack (【头像1】【头像2】…)
on the task card, and the same (with names on hover/click) on the detail page.

Derivation note (implementation): participants = the TwinBot (bound session's
metabot_id) ∪ workers delegated from this task's sessions (orchestration rows
whose source_session_id is one of the task's bound session ids →
steps.assignee_metabot_id) ∪ group-task members when a sub-project ran through
the group_task channel (group_tasks.source_session_id link). Derive read-time
in the main process; renderer renders avatar + tooltip name only.
