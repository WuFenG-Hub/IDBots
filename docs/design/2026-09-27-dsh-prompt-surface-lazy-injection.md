# DSH Prompt Surface — Lazy MetaWeb Layer Injection & Tool-Mount Tightening

**Status:** decisions approved 2026-09-27 (1A tiered-by-default, 2A
creator-exception gating, 3A keep MCP opt-in) — decisions 1 and 2 IMPLEMENTED
on this branch; the MCP usage nudge (3A, settings UX) remains a follow-up.
Measured Tier-0 effect (A/B harness, content-rich main-project bot):
first-step input 34,716 → 34,008 tokens (−708; system prompt −3.0 KB when the
deep sections wait); cumulative from the pre-optimization baseline
36,769 → 34,008 = −7.5%. The tool-mount gating additionally trims ~5 schemas
for fresh bots with no knowledge/KB content (not reflected in the measured
bot, which has content).
**Context:** [2026-09-27 speed diagnosis](../analysis/2026-09-27-dsh-agent-speed-vs-deepseek-harness.md)

## Problem

Real-session telemetry: same provider, model, and effort, IDBots steps produce
~9× more reasoning tokens than upstream (p50 732 vs 81), driven by instruction
density on every request. Already landed on this branch: compact metaweb
prose (R1), description slimming (R2 batches 1+2, 27 tools, −7.4 KB), the
256K output ceiling (R3) — together −5.6% first-step input on the main-project
shape (36,769 → 34,716 tokens; system prompt −3.4 KB).

The remaining big levers are structural: **stop mounting layers and tools the
session never uses**. The main-project shape still ships 115 tools (23 stock
kernel + ~92 host/MCP) and the full MetaWeb behavioral stack to every turn,
including sessions that never touch MetaWeb.

## Proposal

### 1. Lazy full-layer injection (the harness "skill tool" pattern)

Two-tier MetaWeb guidance:

- **Tier 0 (always mounted, compact):** the already-landed compact worldview +
  chain-id rules (~3.4 KB) — enough for the model to know MetaWeb exists,
  cite correctly, and route to the tools it can see.
- **Tier 1 (injected on first relevant use):** the full learning-loop + Q&A
  participation layers + currently-inline protocol walkthroughs. Trigger:
  the first time the session actually calls a MetaWeb tool
  (search_metaweb / read_metaweb_pin / post_* / search_qa / …) or the first
  time the composed prompt references metaweb content (a metaweb pin in
  context). Injection rides the existing per-turn `session/ensure` sections —
  the kernel's `systemPromptUpdate: 'in-history'` appends after the cached
  prefix, so the one-time injection costs one cache-miss tail, not a prefix
  rewrite. Once injected for a session generation, it stays (no flapping).

Implementation sketch: `CoworkRunner` tracks a per-SDK-session
`metawebTier: 0|1` alongside the volatile-dedup state; the DSH tool-call
observer (the same event stream that feeds the origin badge) flips 0→1; the
next `session/ensure` adds the Tier-1 sections. Sessions that never touch
MetaWeb never pay for it.

### 2. Tool-mount tightening

- **Host tools:** mount memory/knowledge/procedure/twin tools only when the
  bot has the feature enabled AND has content (e.g. skip the 7 knowledge_base
  tools for bots whose KBs are all empty and never learned; skip procedure
  tools until the first procedure exists — expose a single
  `procedure_save`… or nothing, with the compact section pointing to the
  memory channel instead).
- **MCP tools:** the main project mounts ~70 MCP tools. Tighten per-bot
  defaults: default to OFF for new bots, keep explicit opt-in per bot
  (mechanism already exists), and consider a "MCP tools used in the last N
  sessions" nudge in settings.
- **`defer_loading`** for the rarely-used tail of the catalog if the
  Messages API honors it on this route (wire format already supports the
  flag; needs a live check).

### Expected effect (estimates from the current shape)

| change | first-step input | notes |
|---|---|---|
| landed slices (R1+R2+R3) | 36,769 → 34,716 | measured |
| + lazy Tier-1 (never-metaweb sessions) | ~34,716 → ~33,500 | −1.2 KB system prose |
| + tool-mount tightening | ~33,500 → 24–28 K | −50 to −80 host/MCP schemas |
| stock composition reference | 11,791 | ceiling for comparison |

The tool-mount tightening is the larger lever; the description bytes are
already slim, so the win is schema count itself (deliberation surface) plus
prefill.

## Decision points (product calls, not implementation)

1. **Default tier for a fresh bot chat:** Tier 0 only (this proposal) vs
   keep full stack for bots flagged "MetaWeb-active" (a bot-level toggle,
   default off?). Recommendation: Tier 0 default; auto-upgrade on first use;
   no user-visible setting initially.
2. **Mount gating for empty memory/KBs:** hide until first content exists vs
   always mount for discoverability (the model cannot call
   knowledge_base_add_document if it is not mounted — hiding tools that CREATE
   first content breaks bootstrapping). Recommendation: always mount the 2–3
   creator tools (knowledge_upsert, procedure_save, knowledge_base_add_document),
   gate the rest on existing content.
3. **MCP defaults:** opt-in per bot (current) vs a global "mount all for the
   primary bot" convenience. Recommendation: keep opt-in, add the usage nudge.

## Risks & mitigations

- Model unaware of MetaWeb capabilities in Tier 0 → Tier 0 keeps the tool
  catalog (tools are visible, descriptions self-describe); only the deep
  behavioral prose waits. The A/B harness can verify equivalence on
  metaweb-task scripts before rollout.
- Late injection changes mid-session system prompt → in-history update is
  cache-friendly and one-shot per session generation; volatile-dedup state
  resets with the session generation as today.
- Hidden-tool bootstrapping → creator-tools exception (decision 2).
- Regression risk → extend the A/B task set with metaweb-shaped tasks and
  gate the rollout on parity of tool-choice accuracy.

## Rollout

1. Implement tiering behind `SystemPromptProfile` (`metawebMode: 'compact' |
   'tiered' | 'full'`, default 'tiered' after the A/B gate, 'full' available).
2. Implement creator-tools exception + content gating (decision 2 as
   recommended).
3. MCP nudge (settings UX, small).
4. Re-run the real-session A/B (`scripts/perf/ab-baseline-dsh.mjs
   --extract-from <new session>`) and the 45-day telemetry diff after a few
   days of dogfood.
