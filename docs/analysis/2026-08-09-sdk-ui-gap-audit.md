# Claude Agent SDK 0.3.221 — UI Integration Gap Audit

Date: 2026-08-09
Branch: `feat/sdk-todo-panel`
Method: extracted the full SDK 0.3.221 type surface (`sdk.d.ts` + native CLI binary),
then grepped IDBots (`coworkRunner.ts`, renderer services/components) for each
capability. Goal: find SDK features that exist but are **not adapted in the UI**,
following the same pattern as the todo/task panel (SDK supports it, UI never surfaced it).

## 0. Context

The previous roadmap (`2026-08-05-sdk-0.3-integration-status-and-roadmap.md`) already
covers 17 completed integrations. This audit re-checks everything against the current
SDK and adds the todo/task panel (`6903d28a`) to the completed list.

## 1. Confirmed gaps — SDK has it, IDBots UI does not

### 1.1 Events the SDK emits but the runner drops silently

`coworkRunner.handleClaudeEvent` only handles system subtypes
`init / status / api_retry / model_refusal_fallback / model_refusal_no_fallback /
task_started / task_updated / task_progress / task_notification / background_tasks_changed`
plus top-level `tool_progress` (subagent only), `prompt_suggestion`, `result`, `auth_status`.
Everything below falls through and is discarded.

| SDK event | Type | What it carries | Value to surface | Effort |
|---|---|---|---|---|
| `rate_limit_event` | top-level | claude.ai plan rate-limit windows (only for direct Anthropic accounts) | Medium — show "approaching plan rate limit" once; proxy providers unaffected | Low |
| `system/subtype: thinking_tokens` | system | estimated thinking-token usage delta | Medium — add to UsageStatsChip / context ring | Low |
| `system/subtype: permission_denied` | system | tool denied inside a subagent + decision reason | Medium — show denial reason in SubagentPanel row (currently invisible) | Low |
| `system/subtype: notification` | system | generic CLI notification (`key/text/priority`) | Medium — map to IDBots toast / system bubble | Low |
| `system/subtype: informational` | system | info/notice/suggestion/warning render levels | Low–Medium — render as system message (currently 1 hit = dropped) | Low |
| `system/subtype: compact_boundary` | system | context compaction happened (`trigger`, `pre_tokens`, `post_tokens`, duration) | Medium-High — "Context compacted (pre X → post Y)" is reassuring UX after long sessions | Low |
| `system/subtype: session_state_changed` | system | `idle / running / requires_action` | Low — IDBots already infers running state | Low |
| `system/subtype: files_persisted` | system | file-checkpoint persistence results | Only if we adopt checkpointing (1.4) | Low |
| `conversation_reset` | top-level | conversation reset (e.g. after overflow) | Low — show system note | Low |
| `system/subtype: commands_changed / memory_recall / mirror_error / worker_shutting_down / local_command_output / plugin_install / hook_*` | various | mostly diagnostic/internal | Low — ignore | — |

### 1.2 Query/control methods never called from IDBots

The runner only calls `getContextUsage()` (local mode) and uses `abortController.abort()`
for stop. The following Query methods are unused:

| Query method | What it enables | Value | Effort |
|---|---|---|---|
| `setModel(model?)` | **mid-session live model switch** (same provider path) | High — ModelSelector today only affects the next session; live switch is a visible "wow" | Medium |
| `stopTask(taskId)` / `backgroundTasks(toolUseId?)` | stop a runaway subagent / background a foreground task from the UI | High — SubagentPanel currently observes only, no controls | Medium |
| `reconnectMcpServer()` / `toggleMcpServer()` / `setMcpServers()` / `mcpServerStatus()` | live per-session MCP lifecycle (fix a dead server without restarting) | Medium-High — MCP manager UI is global/static; no session-level controls | Medium-High |
| `interrupt()` (typed receipts) | graceful stop with `interrupt_receipt_v1` / `cancel_queued` instead of hard abort | Medium — robustness of Stop button | Medium |
| `rewindFiles(userMessageId)` | restore files to a checkpoint (needs `fileCheckpointingEnabled`) | High but risky — file-snapshot UX + storage decision | High |
| `getPlan()` | read the plan-mode plan document | Low-Medium — TodoPanel already covers step visibility | Low |
| `setMaxThinkingTokens()` | live thinking-budget change | Low-Medium — effort toggle exists but per-query | Low |
| `reloadSkills()` / `reloadPlugins()` | hot reload of skills/plugins | Low — IDBots uses static prompt blocks | Low |
| `supportedModels()` / `supportedAgents()` | feature-detect models/agents | Low — model list comes from app config | Low |
| `applyFlagSettings()` / `reinitialize()` | dynamic mid-session reconfig / transport recovery | Low | Low |
| `setMcpPermissionModeOverride()` | per-server MCP permission override | Low | Low |
| `accountInfo()` | account/auth info | Low | Low |
| `onUserDialog` / `onElicitation` | MCP servers can ask the user questions (elicitation) | Low-Medium — IDBots has its own AskUserQuestion wizard; different mechanism | Medium |

### 1.3 Options never passed to the SDK

| Option | Effect | Value | Notes |
|---|---|---|---|
| `betas: ['context-1m-2025-08-07']` | 1M-context beta for compatible models | Medium (quick win) | Anthropic-specific; only for direct Anthropic provider path, NOT through the OpenAI-compat proxy |
| `fileCheckpointingEnabled` | enables file snapshots + `rewindFiles` | High (with 1.2 rewindFiles) | needs product decision |
| `outputFormat` / `jsonSchema` | structured machine-readable results | Low until a concrete consumer exists (e.g. scheduled-task outputs) | — |
| `forwardSubagentText` | live subagent text deltas | Low (deliberate: flood; post-hoc transcripts already exist) | — |
| `teammateMode` / `remoteControlAtStartup` | Agent Teams / remote-control bridge | Out of scope — IDBots has its own group-task system | — |
| `autoCompactEnabled` | CLI-side auto context compaction | Low — IDBots has its own compaction handling | — |
| `showTurnDuration` / `showMessageTimestamps` | cosmetic CLI output | Low — IDBots renders its own | — |

### 1.4 Tools / metadata the renderer does not special-case

| Surface | SDK detail | Current IDBots | Value |
|---|---|---|---|
| `tool_use_meta` (0.3.179) | display-friendly tool names, MCP icon URLs | Renderer shows raw `metadata.toolName` | Low — cosmetic |
| `tool_result_meta` (0.3.216) | classification: denied / interrupted / cancelled | Renderer only shows `is_error` | Medium — could show "Permission denied" vs "Cancelled" distinctly |
| `ReportFindings` | structured code-review findings array | Not rendered; falls to generic tool card | Medium — if/when IDBots ships SDK-native code-review workflows |
| top-level `tool_progress` | long-running top-level tool heartbeat (elapsed time) | Dropped (only subagent task rows use it) | Low-Medium — e.g. long Bash shows no elapsed time |
| `Workflow` tool | parallel multi-agent orchestration lanes | Task panel covers via task events | Already covered |

## 2. Recommended next steps (ranked)

1. **Subagent panel controls — `stopTask()` / `backgroundTasks()`** (1.2): highest value-to-effort;
   users can kill runaway background work from the UI. Needs IPC + runner wiring + sandbox caveat.
2. **Surface dropped events** (1.1): `compact_boundary` → system message, `notification` →
   toast, `permission_denied` → subagent row detail, `thinking_tokens` → usage chip. All low effort,
   batch as one commit.
3. **Mid-session model switch — `setModel()`** (1.2): visible wow; scope to same-provider switch
   (provider change still needs a new session).
4. **Live MCP session controls** (1.2): reconnect/toggle/mcp_call from the session UI.
5. **`betas` 1M context** (1.3): one-liner behind the direct-Anthropic path only.
6. **Defer**: file checkpointing/`rewindFiles`, structured output, elicitation, Agent Teams,
   remote control (documented in §4 of the living roadmap).

## 3. Verification notes

- Audit ran against `@anthropic-ai/claude-agent-sdk@0.3.221` (`sdk.d.ts`, `sdk.mjs`,
  `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`).
- "Dropped" claims verified by grepping `coworkRunner.ts` for each subtype/event type:
  unhandled values fall through `handleClaudeEvent` without emitting.
- `getContextUsage` is the only Query method used; `abortController.abort()` is the only stop path.
