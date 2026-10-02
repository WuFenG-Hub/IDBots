# Bot Home × Bot Internet — Single-Window Composition Proposal

Status: **analysis only, no implementation**. Per owner decision, the GUI rework described here
is not started; this document exists to organize the reasoning, the causal chains, and the
trade-offs so the decision can be made later with full context.

Source sketch: hand-drawn whiteboard photo (owner, 2026-10-03) — left: Bot Home (nav +
conversation + input); right: smart home page (aggregated MetaApp categories) with a persistent
bot entry; both in one interaction window.

---

## 1. Current state (code-verified)

The IDBots renderer is a single Electron window whose main area shows exactly one of two
surfaces at a time:

| Fact | Where |
| --- | --- |
| Two mutually exclusive surfaces, switched by a two-segment control ("Bot Internet" / "Bot Home") | `src/renderer/features/botBrowser/BotBrowserModeSwitch.tsx`; `useBotBrowserShell.ts` (`surfaceMode: 'home' \| 'browser'`, `isBrowserPaneVisible`) |
| Bot Internet has three switchable destinations: `browser` / `gigSquare` / `metaapps` | `types.ts` (`BotInternetPane`) |
| The conversation panel already exists as a component embedded in the sidebar flow | `src/renderer/components/Sidebar.tsx` (`BotBrowserCoworkPanel`, ~line 835) |
| Cross-surface intent plumbing already exists (open a MetaApp, open a bot page, jump back to a home conversation) | `types.ts` (`BotBrowserIntent`: `openMetaApp`, `openBotPage`, `openConversationInHome`) |
| Bridge types for tab content reads (`get-content`, `get-tab-info`) are pre-wired on the IDBots side, awaiting the ABC release | `types.ts` (`BotBrowserTabAction`) |

Conclusion: the composition sketched by the owner requires **no new browser architecture and no
new data sources**. It is a host-side re-layout plus a default-page upgrade, gated on the ABC
tab-events release (see dependencies).

## 2. Target composition

```
+------------------------------------------------------------------------+
| Sidebar |  Bot Home pane            |  Smart home / content pane       |
| (bots,  |  [ conversation stream ]  |  [ aggregated modules ]          |
|  nav,   |                           |    pinned apps & bots            |
|  skills)|                           |    MetaApp categories            |
|         |  [ input ]                |    recent activity / feeds       |
|         |                           |  [ Bot: (o) current actor ]      |
+------------------------------------------------------------------------+
          global activity / media bar (chrome-level, always visible)
```

Dual states, not a forced split:

- **Composed** (default): conversation and content side by side; divider draggable; ratio
  persisted.
- **Drawer collapsed / content full**: conversation collapses to a rail; browser goes full
  width.
- **Legacy fallback**: below a minimum window width the layout falls back to today's
  mutually-exclusive mode switch (the existing behavior is kept as the fallback, not deleted).

## 3. Causal chains (pain → root cause → change → effect → dependency)

| # | Pain (observed) | Root cause (code) | Change | Expected effect | Dependency |
| --- | --- | --- | --- | --- | --- |
| 1 | Conversation and content interleave constantly (see content → ask bot; bot delivers → view it); every interleave costs a mode switch | `surfaceMode` mutual exclusion | Side-by-side layout + drawer collapse | Zero-switch interleave; delivery cards render in view | None hard; materially better with ABC tab events |
| 2 | Entry points scattered across three panes | Navigation organized by destination type (`BotInternetPane`) | Smart home page aggregates categories as modules; `gigSquare`/`metaapps` demoted to home modules | Navigation collapses to "one browser + one conversation" | ABC built-in new-tab template (agent-browser-core issue #3, item 1) |
| 3 | Agent-opened tabs indistinguishable (same app title × N) | Tab title comes only from page `document.title` | `openTab(uri, { label })` + labels in `TabInfo`/events | Task-shaped, legible tab strip | agent-browser-core PR1 (tab context menu + label, in progress) and issue #3 item 3 |
| 4 | Background state invisible (audio playing, session running) | No chrome-level status surface | Global activity/media bar (now playing, running sessions, pending confirmations) | Status becomes first-class without cluttering tabs | Issue #3 item 2; app-session chrome mirror already designed in MetaApp Host Bridge v1.1 |
| 5 | Agent cannot see what the user is reading | No tab read/event channel in released ABC packages | Wire `getTabContent` + `agent-browser:event` into cowork context injection | Sidebar answers about the visible page without copy-paste | agent-browser-core issue #2 (release request) |

## 4. Trade-offs

### Benefits

1. **Zero-switch interleave** — the deepest win; conversation and browsing stop competing for
   the same surface.
2. **Entry consolidation** — three destination panes become modules of one home page; nav
   simplifies to "one browser + one conversation + one status bar".
3. **Agent context for free** — with the composed layout and R1/R2 wired, the sidebar can inject
   the visible page into the agent's context every turn (this is exactly what the 2026-07-25
   R-letter asked for).
4. **Low architectural cost** — every building block exists in the renderer today; the work is
   layout composition, focus policy, and default-page design.

### Costs and risks (each with a mitigation)

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Horizontal space squeeze (sidebar + chat + content) | Three columns on a small window are unusable | Drawer-collapse state, persisted ratio, minimum-width breakpoint falling back to the existing exclusive mode |
| Attention theft | Right-pane updates must never steal focus from the conversation input | Passive right-pane updates + badge/global bar; explicit focus policy (input never loses focus) |
| Confirmation layer discontinuity | System-level dialogs inside a composed UI are a regression | Gate the composed default on the MetaApp Host Bridge basic set (shared PIN-write modal, permissions-request) being integrated host-side |
| Migration cost and habit break | Users know the current two-mode switch | Ship behind a feature flag; keep the legacy mode as fallback; phase the rollout |
| Regression surface grows | Re-layout touches Sidebar/Surface plumbing broadly | Visual acceptance checklist + existing test suite as the gate; layout prototype in a worktree per repo conventions |

## 5. Phased path (proposal only)

- **P0 — prerequisite (ABC side)**: release the tab content/events branch (agent-browser-core
  issue #2); IDBots bumps the pinned package and wires events into the cowork context.
- **P1 — host layout prototype (feature flag)**: composed layout with drawer collapse and
  persisted ratio. Acceptance: manual walkthrough — agent opens a tab, tab events do not steal
  focus, collapse/expand preserves state, narrow window falls back cleanly.
- **P2 — smart home page**: new-tab template with pinned/recent/category modules;
  `gigSquare`/`metaapps` panes demoted. Acceptance: modules configurable; old pane deep links
  still resolve (redirect into home modules).
- **P3 — unified confirmation + global bar**: Host Bridge basic set integrated; global
  activity/media bar ships. Acceptance: sign/pay flows complete inside the composed window;
  background audio/session visible without switching.

## 6. Open questions for the owner

1. Default landing on app start: composed layout or today's Bot Home?
2. Conversation drawer default: expanded or collapsed?
3. Smart home module set (pinned / recent / categories / subscribed feeds) and their order?
4. Minimum window width below which the legacy exclusive mode takes over?
5. Whether the composed layout should also become the standalone ABC runtime default (shared
   core) or stay an IDBots-specific host composition.

## 7. Explicit non-goals of this document

No branches, no code, no GUI edits were made for this proposal (owner decision, 2026-10-03).
The ABC-side asks live in agent-browser-core issues #2 and #3 (+ the in-flight tab management
PR); the host-side work starts only after the owner approves the direction and a phase.
