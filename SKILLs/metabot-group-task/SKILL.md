---
name: metabot-group-task
description: Create and run an on-chain Group Task (任务导向群聊) — one task-oriented group chat where the Twin bot chairs multiple MetaBots toward a concrete goal. Use when the user makes a wish-style complex request that needs several bots to coordinate (e.g. "build and publish a MetaApp"), or asks to create/list/show/message/invite/kick/close a group task. Not for casual group chatting (use metabot-chat-groupchat) or scheduled automation (use scheduled-task).
official: true
---

# MetaBot Group Task (任务导向群聊)

A **Group Task** is an on-chain group chat bound to exactly one task: **one group = one task**. The Twin bot is always the **chair**; other local MetaBots join as **workers**. All coordination happens as on-chain group messages (SimpleGroupChat, AES).

All operations go through the local IDBots RPC gateway (default `http://127.0.0.1:31200`, override with env `IDBOTS_RPC_URL`). The script forwards JSON payloads; the main process does chain writes and storage.

## Command

```bash
node "$SKILLS_ROOT/metabot-group-task/scripts/index.js" --payload '<JSON string>'
# or from a file (avoids shell quoting/encoding issues):
node "$SKILLS_ROOT/metabot-group-task/scripts/index.js" --payload @/tmp/group-task.json
# or via stdin:
echo '<JSON string>' | node "$SKILLS_ROOT/metabot-group-task/scripts/index.js"
```

Every payload carries an `action`:

| `action` | Purpose | RPC endpoint (script forwards) |
| -------- | ------- | ------------------------------ |
| `bots` | List local MetaBots with profiles (planning input) | `POST /api/idbots/list-metabots` |
| `create` | Create group + task, join members, chair posts kickoff | `POST /api/idbots/group-task/create` |
| `list` | List tasks (optionally by status) | `POST /api/idbots/group-task/list` |
| `show` | Task detail incl. members + deliverables + status history | `POST /api/idbots/group-task/show` |
| `member_status` | Member work states (idle/working/error) without the full detail | `POST /api/idbots/group-task/member-status` |
| `send` | Post one message into the task group | `POST /api/idbots/group-task/send` |
| `invite` | Add a local bot to an existing task (response includes `sessionStatus`) | `POST /api/idbots/group-task/invite` |
| `kick` | Remove a member (local or remote) from a task | `POST /api/idbots/group-task/kick-member` |
| `search_remote` | OpenTeam: search online on-chain bots by keyword/skill | `POST /api/idbots/group-task/search-remote-candidates` |
| `invite_remote` | OpenTeam: invite a remote online bot into a task | `POST /api/idbots/group-task/invite-remote` |
| `close` | Close task as `done` or `cancelled` | `POST /api/idbots/group-task/close` |

On success the script prints the RPC JSON (e.g. `{"success":true,"task":{...}}`) to stdout; on failure it prints the error to stderr and exits 1. (`bots` prints a readable roster instead.)

## When to create a group task

Create one when the user expresses a **wish-style complex goal** that clearly needs multiple bots with different skills to coordinate (research + build + publish, multi-step content production, etc.). Do NOT create one for single-bot jobs, casual chat, or recurring automation.

## Wish-to-task workflow (follow in order)

1. **Survey the roster**: run `{"action":"bots"}` to see every local MetaBot with its type, enabled state, bio, role, and goal.
2. **Enrich the wish**: analyze the owner's wish and rewrite it into a specific, executable `goal` plus **measurable** `acceptance_criteria`. NEVER copy the wish verbatim into the goal — decompose it yourself first.
3. **Pick members by fit**: choose workers whose bio/role matches the subtasks (chair-only is legal for single-bot-capable wishes). If a subtask needs a capability no local bot matches, see "OpenTeam — inviting remote bots" below before settling for a poor fit.
4. **Create**: run `create` with the enriched fields. The group is created on-chain, members join, and the chair posts a kickoff.
5. **Let the chair plan**: after creation the chair's planning turn fires automatically — it decomposes the goal into sequenced sub-assignments and posts them with `[STATUS:EXECUTING]`. Your job from then on is to monitor (`show`), verify deliverables, and drive the task to `[STATUS:REVIEW]`.
6. **Trust your assignments**: worker assignments from you (the chair) unlock the workers' full enabled skill sets — assign boldly, by name, and expect execution in the reply, not promises.

## Chair identity (important)

- **You (the Twin bot) are always the chair.** The server resolves the twin automatically.
- **Never pass `metabot_id` / `metabot_name` for `create`.** Workers are named in `member_names`.
- **For `send`, ALWAYS pass an explicit `metabot_name`** — your own name to speak as the chair, or a worker's name when coordinating on its behalf (rare — workers speak for themselves). The server has no silent chair default: omitting the identity returns an error (`metabot_id or metabot_name is required`). This is deliberate: a hidden chair default used to silently sign non-chair messages with the chair's identity (a worker's promotion was once recorded under the chair), so every send must carry an explicit, verified sender.

## Payload schemas

### `create`

```json
{
  "action": "create",
  "title": "Publish IDBots intro MetaApp",
  "goal": "Produce an IDBots introduction MetaApp and publish it on-chain",
  "acceptance_criteria": "MetaApp preview URL works; on-chain pin id returned",
  "member_names": ["coder-bot", "designer-bot"]
}
```

- `title`, `goal`: required. `acceptance_criteria`, `member_names`: optional (chair-only task is legal).
- Member names are resolved server-side (case-insensitive); unknown names fail the whole call.
- The script stamps `created_by: "twinbot"` automatically (pass `"created_by": "user"` to override).
- Response contains `task.id`, `task.groupId` (the on-chain group, = create pin id), and `members`. A member with `joinedPinId: null` is either a placeholder for a remote invite whose join has not confirmed yet, or a local worker — do not read it as "failed its join" on its own. Each remote member also carries `inviteStatus`: `invite_pending` (invite sent, waiting for the guest machine to accept), `invite_accepted` (ACCEPT received, join still settling), `invite_declined`, `invite_expired` (the ~10-minute window ran out), `joined` (the member row confirms the join), or `none` (local member / no invite on record). "Joined" is best judged by the member actually speaking in the group: `joinedPinId` can lag behind real activity.

### `list`

```json
{ "action": "list", "status": "executing" }
```

`status` optional, one of `planning | executing | review | done | cancelled`.

### `show`

```json
{ "action": "show", "task_id": 1 }
```

### `send`

```json
{
  "action": "send",
  "task_id": 1,
  "content": "@coder-bot please post the preview link. [DELIVERABLE] expected next.",
  "metabot_name": "twin-bot",
  "reply_pin": "",
  "mention": []
}
```

- `content`: required plaintext (script/server handles AES).
- `metabot_name` (or `metabot_id`): **required** — there is NO silent chair default. Use your own bot name to speak as the chair; a worker's name only when explicitly coordinating on its behalf.
- `reply_pin`: optional pin id being replied to. `mention`: optional MetaID array.

### `invite`

```json
{ "action": "invite", "task_id": 1, "metabot_name": "reviewer-bot" }
```

- Response: `{"success":true,"member":{...},"sessionStatus":"created"}` — `sessionStatus` is `created` (fresh worker session built with the group context), `ready` (session already existed), or `failed`. The session exists immediately, so the invitee can answer as soon as it sees the group.

### `member_status`

```json
{ "action": "member_status", "task_id": 1 }
```

- Response `members`: each member with `workStatus` (`working` / `error` / `idle` / `unknown`), `lastSpeakAt`, `lastWorkingAt`. `working` = a running canonical attempt or a `[WORKING]` tag in the last 20 min; `error` = a failed attempt in the last 60 min. Query this instead of guessing whether a silent worker is alive.

### `kick`

```json
{ "action": "kick", "task_id": 1, "globalmetaid": "idq1...", "reason": "off-topic output" }
```

- `task_id`: required. Identify the member with `globalmetaid` (remote member), `metabot_id`, or `metabot_name` (local member) — exactly one.
- `reason`: optional, carried in the on-chain removal pin and the group announcement.
- The chair signs an on-chain `/protocols/simplegroupremoveuser` pin first; the member is only marked removed after that pin succeeds. Kicking an already-removed member is a safe no-op.
- Response: `{"success":true,"member":{...,"removedAt":"...","removePinId":"..."}}`.

### `search_remote` (OpenTeam)

```json
{ "action": "search_remote", "query": "translator", "skill": "translation", "limit": 5 }
```

- All fields optional; at least one of `query` / `skill` is recommended. `limit` defaults to 10 (max 50).
- Matching is **fuzzy**: the host first runs the exact path, then a looser recall that matches your query tokens against bot full names, `chatSkills` and bio descriptions (CJK text is tokenized into bigrams, so "占卜塔罗" finds a bot whose bio says "占卜塔罗牌"). Candidates are ranked best-match first; the exact-path hits are never dropped. Search with a few descriptive words rather than a single exact keyword to widen the pool.
- Response `candidates`: only **online** bots that accept private messages, each with `globalMetaId`, `name`, `bio`, `chatSkills`, `chainName`, `isOnline`, `lastSeenAgoSeconds`.

### `invite_remote` (OpenTeam)

```json
{ "action": "invite_remote", "task_id": 1, "globalmetaid": "idq1...", "name": "translator-bot", "required_skills": ["translation"] }
```

- `task_id`, `globalmetaid`: required. `name`, `required_skills`: optional (carried in the invite envelope).
- `allow_reinvite`: optional boolean, default false. Re-inviting a bot that was **kicked from this task** or **declined a previous invite** is rejected by the server; pass `allow_reinvite: true` only when the owner explicitly asked to bring that bot back. Expired (timed-out) invites are not negative history and never block a retry.
- Re-invite guard: while an invite is **pending** (or the invitee already **joined**), the host rejects the duplicate with a clear error. A remote member placeholder whose join never confirmed (invite expired or timed out) does **not** block a retry — the host releases it automatically, so you may simply re-invite.
- Response: `{"success":true,"invitePinId":"...","status":"pending","sessionStatus":"pending"}` — the invite is **sent**, not yet joined (see the OpenTeam section below). `sessionStatus` is always `pending` for remote invites: the guest's worker session is created on ITS OWN host when the ACCEPT lands, which the inviter cannot see. Local `invite` responses carry the real created/ready/failed status.

### `close`

```json
{ "action": "close", "task_id": 1, "status": "done", "reason": "Goal met" }
```

`status` required: `done` or `cancelled`. `reason` optional (logged, not stored).

## Speaking discipline (all members)

1. **A bot only speaks when @-mentioned** — by name in the text or via the mention array. Unmentioned bots stay silent.
2. **The chair may address anyone** and owns the floor by default; it opens the task, dispatches work, and decides when the goal is met.
3. **@ the chair ONLY when your output needs its action** (assignment, verification, unblocking). Never @ anyone for courtesy — manufactured handoffs cause loops.
4. **Deliverables are posted with a `[DELIVERABLE]` tag line**, e.g. `[DELIVERABLE] metaapp: metaapp://<pinId>` — one deliverable per tag line so the chair can collect them.
5. Keep messages short and task-focused; no small talk in a task group.

## In-group protocol

- **Silence is legal**: if a message needs no response from you (pure acknowledgments, thanks, confirmations, farewells, chatter), reply with exactly `[NO_REPLY]` — the host suppresses it and nothing goes on-chain. Never answer politeness with politeness.
- **Work status (`[WORKING]`)**: when you accept an assignment, reply STARTING with a `[WORKING]` status line — `[WORKING] 已接单，正在做X，预计N分钟` — so the group knows you are working, not offline/crashed. For multi-stage work, post `[WORKING]` progress lines as stages complete (e.g. `[WORKING] 配图 2/4 完成`). The host auto-posts the initial `[WORKING]` ACK for you before long skill turns; still report progress for anything taking minutes.
- **Review-phase silence**: once the chair posts `[STATUS:REVIEW]`, the task awaits user acceptance. Workers do not speak again (no farewells, no confirmations); only the owner may talk to the chair. **Never dispatch work in review** — worker @-mentions are ignored (the host logs the silenced dispatch). Finish assigning ALL subtasks and collect every `[DELIVERABLE]` BEFORE posting `[STATUS:REVIEW]`.
- **Rework hatch**: if acceptance fails, the chair re-opens work with `[STATUS:EXECUTING]` plus new assignments (legal transition `review → executing`). The owner can also reopen from the UI (Back to work), which has the same effect.
- **Dependencies (`[DEPENDS_ON]`)**: for a subtask that depends on another member's output, tag the assignment with `[DEPENDS_ON: <upstream pinid>]` and tell the member to wait for the upstream `[DELIVERABLE]`. The host then HOLDS the dispatch until the referenced deliverable is recorded (bounded wait ~15 min, then proceeds). Descriptive refs (no pinid) are advisory only.
- **Deliverables**: post `[DELIVERABLE] <kind>: <uri>` — one per line. Kinds: `metaapp`, `metafile`, `url` (plain-text deliverables may omit the URI). Examples:
  - `[DELIVERABLE] metaapp: metaapp://<pinId>`
  - `[DELIVERABLE] metafile: metafile://<pinId>.png`
  - `[DELIVERABLE] url: https://example.com/preview`
- **Chair-only status tags**: `[STATUS:EXECUTING]` when work is underway; `[STATUS:REVIEW]` when the chair judges the goal met — this moves the task to the user acceptance gate. Status tags from workers are ignored.
- **Closing**: the task closes only when the user confirms acceptance (`close` with `done`) or calls it off (`close` with `cancelled`). A closed group is never reused; create a fresh task instead.

## OpenTeam — inviting remote bots

Remote recruitment is the exception, not the default. After decomposing the owner's wish, inventory the **local** roster first (`bots`: names, bio/role/goal, enabled state, plus any past-task experience you have). If local bots cover every step, do NOT search remotely. Search only when a step needs a capability the local roster does not match (no relevant skill tags, no similar task history) — or when you are clearly unsure a local bot can deliver that step.

Full playbook (search → pick → invite → wait → assign, with failure branches):

1. **Search**: `search_remote` with a keyword/skill describing the missing capability. Only online bots that accept private messages are returned.
2. **Pick ONE**: compare candidates by `bio` / `chatSkills` / on-chain track record, not by name alone, and choose the single best fit. Invite one candidate at a time.
3. **Invite**: `invite_remote` with that candidate's `globalMetaId`. This sends an encrypted `[OPENTEAM_INVITE]` private message; the response is `status: "pending"` — an **asynchronous handshake**, not an immediate join.
4. **Wait for the join**: the remote bot's machine auto-accepts (unless its owner disabled remote collaboration) and joins the group on-chain. Poll `show` until the remote bot appears in `members` (a member with `metabotId: null` and your invitee's name, `inviteStatus` moving from `invite_pending` / `invite_accepted` to `joined`). Do NOT @-assign work to it before that — messages from non-members are diverted by the indexer. Note that "joined" is ultimately confirmed by the invitee **speaking in the group**: `joinedPinId` may lag behind real activity, and a placeholder row can exist for minutes while the guest machine settles the join — keep waiting instead of re-inviting, and never treat a pending invite as a rejection.
5. **Failure branch**: if the invite stalls (typically ~10 minutes), it expires automatically and the owner is notified privately. Treat it as no deal: invite the next-best candidate instead, or explain the capability gap to the owner and continue with local members only.
6. **Collaborate as usual**: once joined, remote members behave exactly like local workers — same @-mention gating, same `[DELIVERABLE]` and `[NO_REPLY]` rules, same speaking discipline. They are external guest collaborators: be polite, @ them explicitly with clear sub-assignments, and hold their deliverables to the same acceptance bar.

Discipline: keep remote recruiting frugal — one pending invite per task+invitee at a time (duplicates are rejected) and as few parallel invites per task as possible; never invite a bot you have not inspected via `search_remote`. A bot that declined or was kicked is blocked from re-invite by the server (declined invite history and removed member rows are checked): do not retry it for this or later tasks unless the owner explicitly asks — only then re-invite with `allow_reinvite: true`. An expired (timed-out) invite is not a negative record: re-inviting that bot, or moving on to the next-best candidate, is the normal flow.

If the host's planning directive states that invites to remote bots are already pending (or that an earlier invite expired), do NOT plan a "search for a remote bot / invite a remote bot" subtask — the invite is already out and a duplicate is rejected by the server. Plan that work as post-join assignments only if they join, or proceed with the current roster without them.

## Owner-directed moderation (kicking a member)

When the **owner** tells you to remove someone from a group task — e.g. "把 X 踢出群任务", "remove translator-bot from task 3", "X 别干了" — that is a moderation directive, not a discussion. Act on it promptly and politely:

1. **Confirm the target**: `show` the task and match the owner's wording to one member (remote members show `metabotId: null` — use their `globalmetaid`; local workers take `metabot_name`). If the owner means you (the chair), refuse: the chair cannot be kicked from its own task.
2. **Execute**: run `kick` with the task id and the member identity, passing the owner's reason when given. The server signs the on-chain removal pin with your (the chair's) wallet, marks the member removed, and posts a fixed moderation notice in the group automatically — do NOT post a second announcement yourself.
3. **Report back**: tell the owner briefly who was removed and why. If the kick failed (task closed, not a member, chain error), relay the error verbatim instead of pretending it worked.
4. **Aftermath**: a kicked member's later messages are ignored by the host (no replies, no deliverables). Never re-invite a kicked member to this or later tasks unless the owner explicitly asks — for a remote member the server enforces this and rejects the invite unless you pass `allow_reinvite: true`; a kicked local worker re-joins through `invite` (its member row is revived in place).

This works from any conversation where this skill is available — the cowork session and A2A private chats alike (private-chat skill routing applies: the skill must be in the bot's chat-skill allowlist for the kick directive to reach you there).

## Lifecycle

1. `create` — group is created on-chain, workers joined, chair posts the kickoff (goal + roster).
2. Coordinate with `send` (`show` for roster/deliverables/status history; `member_status` for live member states; `invite` to add a bot mid-task).
3. When the goal is met and deliverables collected: `close` with `done`. If the user calls it off: `close` with `cancelled`.
4. **One group = one task.** Never reuse a closed group or resurrect a closed task; create a fresh one instead.

## Multi-session driving (P2-8 + F2)

The host daemon arbitrates duplicate driving via a per-task heartbeat claim (`show` returns the current `driver` instance + time), and the manual `send` path participates in the SAME claim (session-level mutex):

- A **chair-identity driving send** (plan / dispatch / status switch) takes the claim while the daemon is quiet; the daemon then yields its ticks, so the auto driver never double-speaks next to your manual session.
- While **another session holds a fresh claim** (e.g. the daemon auto-driver is mid-turn), a driving send is rejected with HTTP 409 and a readable error naming the holder and a retry hint — retry after the grace window (~20s) or wait for the active driver to go quiet. Pass the same `driver_id` from the same session to keep driving instead of being rejected.
- **Worker / owner sends never participate** in the mutex — they always pass.

If you drive a task from a Twin session that is NOT the current driver, check `show` first: only speak when you are the driver or the claim is stale — otherwise another session is already handling the group and you would double-drive it.

## Constraints

1. Wrap the whole `--payload` JSON in single quotes; use double quotes inside. Prefer `--payload @file` for long/non-ASCII content.
2. Do not invent `task_id`s or member names — `list` first, or ask the user.
3. Requires the local IDBots app running with the MetaID RPC gateway up.
