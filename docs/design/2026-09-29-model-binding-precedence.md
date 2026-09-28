# Model Binding Precedence and Stale-Binding Handling

Date: 2026-09-29
Context: HOST-FIX-RFP 2026-09-28 (the zhipu silent-drop incident) — a group-task
member's turns all failed at model resolution because its binding pointed at a
provider that had been removed from the catalog, and the failure was invisible
to the chair, the member, and the owner for ~30 minutes. This note documents
(D5) which binding wins when several are set, when each takes effect, and how
stale bindings are now surfaced.

## Precedence (highest first)

1. **Session-level pick** — `cowork_sessions.model` + `model_provider`.
   Written only by UI session flows (session creation from the home editor,
   the session-header model picker via `cowork:session:setModel`). Read on
   every turn by `CoworkRunner.resolveSessionDshRoute`.
2. **Bot brain** — `metabots.llm_id` + `llm_provider` (edited under My Bots,
   synced on-chain via `/info/llm`). Re-read live on every turn, so a brain
   edit takes effect on the member's **next** turn — no session restart.
3. **Bot fallback brain** — `metabots.fallback_llm_id` +
   `fallback_llm_provider`, used when the primary route does not resolve
   (returns no route), and by the runtime-outage fallback route.
4. **Global default** — `app_config.model.defaultModel` / `defaultProvider`,
   then the first enabled provider's first model.

A binding is only consulted when every binding above it is absent. In
particular a session-level pick wins over the bot brain **for that session
only**; other sessions of the same bot are untouched.

Which sessions carry a session-level pick:

- Standard/UI sessions and Bot Browser panels: may carry one (the user picked
  a model in the picker).
- Group-task member/chair sessions, A2A/private-chat sessions, scheduled-run
  and service-order observer sessions: **never** set a session-level pick —
  they always run on the bot brain (precedence level 2).

## When a change takes effect

- Session pick change: next turn of that session (the route is re-resolved per
  turn; there is no cached route across turns).
- Bot brain change: next turn of every session that has no session pick.
- Provider catalog change (rename/remove/model-list edit): next turn
  everywhere, plus the startup reconcile below on the next app launch.

## Stale-binding semantics (deliberately NOT silent)

- A stale binding (provider hint names a provider that no longer offers the
  model, or an ambiguous model id with no valid provider pick) is a **hard
  error** at route resolution — it never falls through to the bot fallback
  brain, the global default, or the free-quota relay. Silent substitution is
  what made the original incident undetectable.
- The member's own session shows a readable, actionable error ("model binding
  is stale … re-pick the model …"), embedded with the original resolution
  reason.
- The group-task daemon classifies these errors as model-layer config
  failures: the dispatch is **parked, not dropped** — requeued uncharged,
  surfaced immediately to the origin session and to the chair's host-note
  ledger (once per root cause), and probed on a 5-minute cadence so the parked
  trigger fires automatically once the binding is re-picked. A successful turn
  lifts the park; past 24 h the ordinary charged retry ladder resumes so the
  episode still terminates with a drop + alert.
- At startup, `reconcileStaleModelBindings` scans every stored binding against
  the live catalog: bindings whose model id maps to exactly one enabled
  provider are auto-rebound; unhealable ones (model gone, or ambiguous) are
  logged, flagged in the model pickers (rendered red / "unavailable"), and
  flagged sessions get one `[model-binding]` transcript notice.

## Effort precedence (for completeness)

Session effort override → bot brain effort → persisted global effort → model
default. On the fallback-brain route the *fallback* brain's effort applies.
