# Assistant Mode — Remaining Work Handoff

Date: 2026-10-13
Status: Phase 1 + first polish round shipped to `main`. This document hands off the remaining work to the next dev agent.

> **2026-10-13 update (branch `feat/assistant-phase2-ux`)** — the following landed on that branch (not yet merged):
> - Acceptance-report UX fixes: the inline activity indicator is now visible through the ENTIRE running turn (it used to step aside while reply text streamed, leaving multi-minute tool windows looking idle), narration bubbles settle verbatim (a bubble's text never rewrites after it appeared — streamed buffer wins over the assembled message text), and the indicator reflects api_retry/requesting transport status (runtime-status messages are merged into its activity list by timestamp).
> - Phase 2 item 1 (delegation copy): assistant-mode wording for the delegation-blocking banner + disabled composer, and sidebar rows strip the `[编排任务] `/`[Orchestration Task] ` prefix (render-only; stored titles untouched). `useChatExperienceMode` hook extracted for reuse.
> - Phase 2 item 2 (Bot Browser panel): panel bot answers render in `.assistant-bubble` and streaming shows the inline AssistantActivityIndicator. Decision: A2A chat keeps its own IM-style bubbles (its thinking/tool gating was already in place); a full A2A restyle is deferred pending acceptance feedback.
> - Cosmetic nit 4b: light-mode user bubble gains a hairline inset ring (`.cowork-user-bubble`) against the neutral chat background.
> - Remaining from the list below: item 3 (per-model narration safeguard — only if acceptance shows it's needed) and nit 4c (effort 'off' quality).

## 1. What "assistant mode" is

A chat experience mode switch in **Settings → General** (`chatExperienceMode`: `'professional' | 'assistant'`, default `'assistant'`). Target: non-technical users — the bot should feel like a living personal assistant, not an engineering console.

- **Professional mode** = the original experience (full reasoning blocks, tool-call cards, "Worked for" collapse, bottom streaming bar). It must stay **pixel-identical**; every assistant-mode change is gated behind the mode flag.
- **Assistant mode** = fast first reply, narration bubbles, hidden thinking/tools, boss-report style, neutral-gray chat surface, bot-avatar activity indicator.

## 2. Shipped so far (all merged to `main`)

| Area | Key commits | What landed |
|---|---|---|
| Mode switch + config | `154e4a5e` | `AppConfig.chatExperienceMode`, Settings → General two-card picker, i18n, `getPersistedChatExperienceMode()` in `src/main/libs/claudeSettings.ts` |
| Narration as bubbles | `26a223b4`, `167c4a0a` | DSH event mapper `assistantModeProvider` flag: commentary/narration surfaces as normal chat messages tagged `metadata.narration`; raw reasoning (`metadata.isThinking`) and tool calls hidden in assistant mode |
| Assistant prompt section | `98f61541`, `a723448d` | `src/main/libs/assistantModePrompt.ts` (`ASSISTANT_MODE_PROMPT`, section order 55, mounted only for assistant-mode owner chats via `isAssistantModeOwnerChatSession` in `coworkRunner.ts`). Hard rules: user's language for everything visible, ~2-4 milestone narrations max, no self-talk, conclusion-first boss reports, HTML visual reports for structural content |
| Reasoning effort | `42e81ae2`, `9949a950` | Assistant-mode sessions default to effort `'off'` (session pick wins; old sessions keep their override); effort chip displays "off" for unpicked assistant sessions |
| Activity indicator | `f36a7ef9`, `48e31411`, `01c8ecd3`, `24c0540e` | `AssistantActivityIndicator.tsx`: bot avatar breathing ring + shimmer status text, single inline indicator at the reply position, state-matched phrases (thinking/writing/using tools/retrying + idle rotation) |
| Bubbles & surface | `ed5c5862`, `16eb79a9`, `1aecbea8`, `8ea430db`, `b1023c48` | `.assistant-bubble` neutral gray (color-mix on `--cowork-chat-bg`), `max-w-[min(646px,82%)]`, 4px rhythm; cowork chat background = neutral `--cowork-chat-bg` (`#FAFAFA` light / `#1B1B1D` dark) |
| Hover actions | `faf99ccc` | Only the turn's final reply bubble has a hover toolbar (below the bubble); narration bubbles have none (`findDeliveryAssistantIndex` in `assistantTurnPresentation.js`) |
| HTML reports | `400e1959`, `29f73a2d` | Local `.html` links open in the cowork sidebar (sandboxed iframe, srcDoc) instead of the external browser; assistant mode renders them as distinct report cards |
| Resilience | `f7d38c52` | One-shot auto-continue when a DeepSeek turn dies on malformed tool-call JSON (`isMalformedToolCallDshTurnError` in `coworkAssistantReply.ts`) |

## 3. Architecture map (where things live)

- **Mode storage**: `app_config.chatExperienceMode` (sqlite kv via `SqliteStore`); renderer reads via `configService` + `localStore.onChanged` on `CONFIG_KEYS.APP_CONFIG`; main reads via `getPersistedChatExperienceMode()`.
- **Prompt gating**: `composeEffectiveSystemPrompt(..., assistantMode)` — call sites pass `isAssistantModeOwnerChatSession(sessionId)`: standard type, no `autoOrigin`, `sourceChannel === 'cowork_ui'`. Group tasks / A2A / IM / heartbeat / schedule / orchestration never get the assistant prompt.
- **Narration pipeline**: `dsh-runtime` stream → `src/main/libs/dshKernel/dshEventMapper.ts` (per-decision `assistantMode` getter; commentary → text slot + `metadata.narration`, reasoning → thinking slot) → `coworkRunner` → IPC → Redux `coworkSlice` → `CoworkSessionDetail.tsx` render filters (`isVisibleAssistantTurnItem`, `getVisibleAssistantItems`).
- **Effort chain**: `runDshSessionLocal` in `coworkRunner.ts` — `session override ?? (assistantMode ? 'off' : brain ?? persisted ?? model default)`.
- **Tests**: `tests/dshKernelEventMapper.test.mjs`, `tests/coworkComposerEffortDefault.test.mjs`, `tests/coworkAssistantModePromptGate.test.mjs`, `tests/coworkAssistantNarrationSurvival.test.ts`, `tests/coworkAssistantDeliveryIndex.test.mjs`, `tests/markdownContentHtmlReportCard.test.tsx` — mostly wired into `pnpm run test:ui-regressions`. `tests/*` is git-ignored by default; new test files need a `.gitignore` negation entry.

## 4. Remaining work

### Phase 2 — assistant-mode experience completion

1. **Delegation / handoff copy in assistant mode.** Today: amber banner "Waiting for remote service result…" (`CoworkSessionDetail.tsx` `delegationBlocking` banner), orchestration sessions appear as `[编排任务] …` titles in the sidebar, delegation control messages are hidden but state leaks through engineering-flavored strings. Wanted: assistant-mode wording like "已交给 XX 处理，好了会告诉你" (localized, no jargon); decide whether the disabled-composer state needs friendlier copy too. Files: `CoworkSessionDetail.tsx` (banner ~`delegationWaitingForResult`), `src/renderer/services/i18n.ts`, possibly `orchestratorCoworkBridge.ts` for session titles.
2. **Bot Browser panel & A2A surface alignment.** `BotBrowserCoworkPanel` already filters to minimal messages but does not get the assistant-mode bubbles/indicator/report-card treatment; A2A chat (`A2AMessageItem.tsx`) hides thinking/tools in assistant mode but keeps its own bubble styling. Decide how far assistant mode extends beyond the main cowork chat, then align.
3. **Per-model narration quality.** The prompt rules help, but some routes (e.g. GLM reasoning-channel narration, weaker models) may still produce jargon-y or wrong-language narration lines. Consider a light renderer-side safeguard (e.g. collapse narration that is obviously code/JSON) only if acceptance shows it's needed.
4. **Known cosmetic nits**: (a) during provider api-retry the inline indicator shows idle-rotation phrases instead of "retrying" (sdkRuntimeStatus messages are filtered before turns are built — passing them through is a small, contained change); (b) the user bubble (`#FFFFFF`) is faint against the new `#FAFAFA` chat background in light mode — consider a subtle border or slightly darker user-bubble fill; (c) `effort 'off'` trades quality for speed on hard tasks — revisit if users complain about answer quality.

### Phase 3 — broader non-technical-user work (scope separately before starting)

5. **IM channels (DingTalk/Feishu/Telegram/Discord) and group-task copy**: engineering-flavored strings reach mobile users; assistant-style wording pass across `src/main/services/groupTaskPrompts.ts`, `privateChatOrderCowork.ts`, IM gateway reply templates.
6. **Onboarding & empty states** for non-technical users (first-run greeting exists via `onboardingGreeting.ts`; evaluate whether the whole first-launch flow matches the assistant positioning).

### Separate track (already handed off)

7. **Upstream root fix for malformed DeepSeek tool-call JSON** — being handled in worktree `.worktrees/dsh-deepseek-tool-input-repair` (`fix/dsh-deepseek-tool-input-repair` branch): tolerant JSON repair in `@deepseek-ai/dsh-llm-deepseek` via the kernel-patch mechanism (`scripts/dsh-kernel-patches/`). The host-side one-shot auto-continue (`f7d38c52`) stays as backstop.

## 5. Working rules for the next agent

- Read `AGENTS.md` first. Branch from `main` with a same-named worktree under `.worktrees/<name>` — a plain directory on the internal disk (the former SSD symlink and its `core.filemode false` step no longer apply); `pnpm install` in the new worktree.
- Node must be **>=24 <25** (`~/.nvm/versions/node/v24.13.1/bin` on PATH works; the default Node 20 crashes pnpm 11).
- Professional mode must stay pixel-identical; gate everything behind the mode flag; never change message persistence for display purposes (assistant-mode filtering is render-only by design).
- After touching `dsh-runtime` deps: `pnpm --dir dsh-runtime install` then `node scripts/apply-dsh-kernel-patches.cjs`; gate = `pnpm run check:dsh-deps`.
- Verification floor per commit: `npx tsc --noEmit`, `pnpm run lint`, `pnpm run compile:electron`, `pnpm run test:ui-regressions` (+ any suite you touched).
- One commit per independent change, `<type>: <description>` messages; post an on-chain dev-journal entry via the `metabot-post-buzz` skill after each commit; merge to `main` with `git merge --no-ff` only when the user asks; never push without an explicit instruction; remove the worktree when the branch is merged and closed out.
- UI copy is bilingual: add keys to both `zh` and `en` blocks in `src/renderer/services/i18n.ts`.
