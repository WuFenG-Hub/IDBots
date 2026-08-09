# Context Auto-Compaction Enhancement Plan

Date: 2026-08-09
Branch: `feat/context-auto-compact`
Status: Phase 1 in progress (implementation); Phases 2–3 planned, not yet started

## Background

IDBots recently upgraded the underlying Claude Agent SDK from 0.2.12 (Node `cli.js`) to
0.3.221 (native binary runtime). The pre-upgrade custom compaction logic (82% soft threshold,
tier-1 tool-result snipping, tier-2 session reset with a synthetic compacted prompt) still
exists in the codebase, but it is driven by a rough local token estimator and does not
leverage the new SDK's built-in context-compaction capabilities.

Investigation findings (see `2026-08-05-sdk-0.3-feature-opportunities.md` and the 2026-08-09
gap audit for context):

- The SDK/CLI has `autoCompactEnabled` (default **true**), `autoCompactWindow`,
  `precomputeCompactionEnabled`, and a newer **reactive compact** path that performs
  *segmented* compaction (summarize older message groups, preserve the recent tail) instead
  of a full-history reset.
- For models the CLI does not recognize (DeepSeek V4, Qwen, GLM, Gemini, etc.), the CLI's
  context-window resolver falls back to **200K** (`var ulr = 200000`).
- The CLI's auto-compact gate (`LXy`) **skips** models whose auto-compact window source is
  `"auto"` — which is exactly the fallback for unknown models. Therefore the SDK's built-in
  auto-compact never runs for DeepSeek today, matching the observed "context explosion"
  behavior.
- IDBots never passes the model's real context window to the CLI
  (`CLAUDE_CODE_MAX_CONTEXT_TOKENS` unset) nor configures `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  / `settings.autoCompactWindow`. As a side effect, `getContextUsage()` reports a 200K window
  for DeepSeek, so the UI context ring shows a wrong denominator.
- The IDBots estimator (`coworkContextBudget.ts`) undercounts real usage (CJK heuristic only;
  misses SDK system prompt, tool definitions, subagent transcripts), so the 82% trigger often
  never fires before the real 1M limit is hit.

## Goal

Users should get seamless, automatic compaction of old/less-important context as a session
approaches the model's context limit — without thinking about it and without a hard workflow
interruption. If automatic compaction is not possible, provide an explicit UI/command entry
point.

## Phase 1 — Enable SDK built-in auto-compact (local mode)

Scope: make the SDK/CLI own proactive compaction for non-Claude models with known context
windows, at the same ~82% intent as the original custom logic.

### Implementation

1. New module `src/main/libs/coworkSdkAutoCompact.ts`:
   - `shouldEnableSdkAutoCompact(modelLimits)`: true when the model id is not `claude-*`
     prefixed, limits come from a trusted source (`provider-model` / `available-model` /
     `known-model`, not `fallback`), and `contextWindow >= 100_000`.
   - `buildCoworkSdkAutoCompactEnv(modelLimits)`: returns
     - `CLAUDE_CODE_MAX_CONTEXT_TOKENS = contextWindow` (tells the CLI the real window; only
       honored for non-`claude-` models by the CLI itself),
     - `CLAUDE_CODE_AUTO_COMPACT_WINDOW = round((contextWindow - maxOutputTokens) * 0.82)
       + min(maxOutputTokens, 20_000) + 13_000`, clamped to
       `[100_000, min(1_000_000, contextWindow)]` (matches the CLI's parsing bounds and its
       `window - 20K - 13K` threshold math, so the CLI compacts at ~82% of usable input).
2. `coworkRunner.runClaudeCodeLocal`:
   - Apply the env vars right after `IDBOTS_ELECTRON_PATH` is set (local mode only; sandbox
     keeps its existing behavior in this phase).
   - Log when SDK auto-compact is enabled for a session.
3. Conflict handling with the existing IDBots compaction:
   - When SDK auto-compact is active, the SDK compacts in-session at ~82% of the real window
     (resume keeps the same `claudeSessionId`, preserving the recent tail — the seamless
     behavior).
   - IDBots' own proactive compaction (tier-1 snip / tier-2 reset) stays as a **safety net**
     only: raise its trigger to `COWORK_CONTEXT_SAFETY_NET_RATIO = 0.95` of usable input when
     SDK auto-compact is enabled (pass `softThresholdRatio` into `getCoworkContextBudget`).
   - Exception-based retry (`retryWithCompactedContext`) is unchanged — it only fires when the
     provider actually rejects with a context-length error.

### Verification

- Unit tests for the new module (env values for DeepSeek V4 family, Claude models excluded,
  fallback source excluded, >1M windows capped, small windows rejected).
- Compile (`npm run compile:electron`) and run `node --test tests/coworkSdkAutoCompact.test.mjs`
  plus existing `coworkContextBudget` tests.
- Manual acceptance on a DeepSeek V4 session: long conversation → `compact_boundary` system
  message appears around 82% of 1M, session continues without an API error, context ring shows
  ~1M window.

### Risks

- Reactive compact's summary request flows through the OpenAI-compat proxy to DeepSeek; the
  existing `reasoning_content` compatibility retry covers the known DeepSeek failure mode, but
  a live pass is required.
- IDBots' store history is not compacted (only the SDK session is), so the UI transcript keeps
  showing the full history — intended, but confirm UX expectations.
- Precompute (`precomputeCompactionEnabled`) has limited value in IDBots' per-turn subprocess
  model (the process exits between turns) — intentionally not enabled in Phase 1.

## Phase 2 — Better IDBots-side fallback accuracy

Not started. Planned:

- Use the **real** per-turn `input_tokens` already accumulated from the proxy
  (`accumulateResultUsage` in `coworkRunner.ts`) as the primary signal for the IDBots-side
  safety net, instead of the CJK heuristic.
- Optionally drive the trigger from `getContextUsage()` real usage (after Phase 1, its window
  denominator is correct too).
- Re-baseline the estimator (include SDK system prompt/tool overhead) if the real-usage signal
  is unavailable (sandbox mode, first turn).

## Phase 3 — UI / manual control

Not started. Planned:

- Add a "Compact now" action (button/command) that triggers the existing compacted-context
  retry path immediately, with a confirmation system message.
- Settings page entry: enable/disable automatic compaction and configure the threshold ratio
  (default 82%).
- Keep surfacing SDK `compact_boundary` events (already implemented) and, if useful, show the
  compaction delta (pre → post tokens) in the transcript.
