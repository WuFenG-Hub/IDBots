# System Prompt Composition: DSH vs IDBots — Deep-Dive Analysis

Date: 2026-08-14
Branch: `feat/system-prompt-composition`
Goal: learn from DeepSeek Harness (`dsh`, `/Users/tusm/Documents/MetaID_Projects/deepseek-harness`) how a programmable, composable system-prompt architecture works, compare it with IDBots' organically-grown prompt assembly, and derive an actionable target architecture (fewer tokens, higher cache hit rate, fewer layer conflicts).

---

## 1. How DSH composes system prompts

DSH is a Cordis-based monorepo where "everything is a plugin". The prompt system is two packages: `packages/core/system-prompt` (the registry + assembler) and `packages/context/agent-instructions` (AGENTS.md workspace instructions).

### 1.1 One registry, four contribution kinds

`ctx.systemPrompt` (`packages/core/system-prompt/src/index.ts`) is a service that collects four kinds of contributions from any plugin:

| Kind | API | Renders into |
|---|---|---|
| **Sections** | `ctx.systemPrompt.section({ name, order, text, complete? })` | the system prompt (stable) |
| **Contexts** | `ctx.systemPrompt.context({ name, order, text })` | a **user-role runtime snapshot** (dynamic) |
| **Tools** | `ctx.systemPrompt.tools(provider)` | the API `tools` parameter |
| **Variables** | `ctx.systemPrompt.variable(name, provider)` | `{{name}}` interpolation in sections |

Sections and contexts are the same shape (name + order + static-or-function text); the difference is only **where the text lands**. The doc literally calls `PromptContext` "the cache-safe counterpart to `PromptSection`" (`docs/subsystems/system-prompt.md`).

### 1.2 The order-number namespace (the composition grid)

Sections are sorted by `order` and joined with blank lines; empty sections are dropped at render. The convention (JSDoc on `PromptSection.order`):

```
-100  harness:identity    "You are an AI agent powered by DeepSeek Harness."   (ONE line)
 -99  harness:source      dev-only: where the dsh checkout lives
 -98  (web-app section)   product-level context added by the web bundle
   0  deployment:persona  THE persona slot (config.persona, or shadowed by a preset)
  50  plan:policy         mode-conditional (empty text when plan mode inactive)
100-199  tool:*           one section PER TOOL, owned by the tool's plugin
```

Real registrations found in the tree: `tool:read`=100, `tool:write`=101, `tool:edit`=102, `tool:glob`=103, `tool:grep`=104, `tool:bash`/`tool:pwsh`=105, `tool:terminal`=106, `tool:jobs`=106, `tool:web-search`=110, `tool:web-fetch`=111, `tool:lsp`=112, `tool:session-query`=113, `tool:cordis`=115, `tool:workflow`=115, `tool:ralph`=116.

Key properties:

- **Tool guidance is owned by the tool plugin and colocated with it.** The `read` tool's whole prompt section is one sentence: *"Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files."* (`packages/fs/tool-fs/src/read.ts:70-74`). If the plugin isn't loaded, its section vanishes — the prompt can never carry guidance for an inactive tool, and there is no central monolith file to forget to update.
- **Section text can be a function of the assembly context** (`agent`, `signal`), so a section can return `''` to disappear (plan mode does exactly this at `packages/plan/plan-mode/src/index.ts:225-232`).
- **Names are owner-namespaced** (`harness:`, `deployment:`, `tool:`, `plan:`), duplicates throw at registration.

### 1.3 Replacement by shadowing, not by appending

`ScopedLayers` gives every agent/session its own layer. A scoped section **shadows a global section with the same name** — nearest scope wins. The persona slot is the canonical use:

- The registry itself registers `deployment:persona` (order 0) from `config.persona`.
- The `@deepseek-ai/dsh-persona` preset package registers a section with **the same name** (`PERSONA_SECTION = 'deployment:persona'`, imported, not restated — the comment explicitly warns two hardcoded copies would "drift into a preset whose persona silently lands beside the deployment's instead of shadowing it") inside an agent scope.
- Result: a preset *replaces* the deployment persona for that one agent. Name collision = replacement; different names = addition. Duplication is structurally impossible.
- Subagents get per-child personas the same way ("scoped shadowing persona section", `packages/subagent/subagent-fork-in-process`).

There is also a disciplined full-replacement escape hatch: a section with `complete: true` becomes the **sole** section after assembly (tools/contexts/variables still resolve), and **two effective complete sections fail hard**. So "replace everything" exists, but it is exclusive and loud.

### 1.4 The caching architecture (the most transferable idea)

- The **system prompt is built only from stable sections** — byte-identical across turns as long as registrations don't change.
- All dynamic state (sandbox policy state, etc.) registers as **contexts**. At each step, `renderContextSections` resolves them and `RuntimeContextProjection` (`packages/core/agent-loop/src/runtime-context.ts:64-75`) compares the joined snapshot to the last committed one **and only emits a user-role message when the text actually changed**. Clearing emits an explicit "Current runtime context: none. Earlier runtime-context snapshots no longer apply."
- Each emitted snapshot is prefixed: *"Current runtime context. This snapshot supersedes earlier runtime-context snapshots."* — so stale state in history can't fight fresh state.
- Net effect: system prompt (the expensive prefix) never changes per turn → provider prefix cache keeps hitting; dynamic state rides the cheap tail as durable user messages.
- Determinism is deliberate: tools default to **lexicographic order with a locale-independent comparator** ("identical on every machine"), or an explicit `toolOrder` config with a required `<unlisted-tools>` rest marker; unknown names fail loudly at assembly. The request header (system + tools) is canonicalized and change-logged per session (`request/header` events with reason `initial`/`resume`/`change`).

### 1.5 Strictness and invariants

- `{{variable}}` interpolation is **strict**: malformed, unknown, or undefined references throw with the owning section's name (`interpolate()`, index.ts:258-295). Silent empty substitutions cannot happen.
- A separate **invariant companion** (`system-prompt/src/invariant.ts`) validates every assembly (unique names, string texts, valid variable names) as a prepend waterfall listener — prompt contracts are testable.
- A scope-filtered **waterfall event** `system-prompt/assemble` lets other plugins post-process one scope's assembly; a registered complete section is restored afterwards, so listeners cannot hijack the prompt.

### 1.6 Workspace instructions (AGENTS.md) never touch the system prompt

`packages/context/agent-instructions` loads AGENTS.md-compatible files as **durable user messages** (source kind `agent-instructions`, baseline identity derived from cwd+project root):

- Budget-capped (`maxBytes`, `maxSourceBytes`), candidate-file list configurable.
- **Versioned and reconciled**: `read`/`write`/`edit` tool executions on instruction files queue an inbox refresh; changes are rendered as scoped add/remove diffs ("changes"), not full reloads.
- Baseline replacement is identity-tracked: switching project roots replaces the previous baseline explicitly.

---

## 2. IDBots' current prompt architecture

### 2.1 Assembly-site inventory

IDBots has **no single assembly point**. Each channel hand-rolls its own concatenation:

| # | Channel | Builder | Composition (in order) |
|---|---|---|---|
| 1 | Cowork local (SDK) | `coworkRunner.ts` `composeEffectiveSystemPrompt` (:4340) + callers | `[SDK claude_code preset] + append(persona XML, Twin orchestration, Twin roster, workspace safety, projects, memory strategy, base=[metaApp routing + skills routing + global config.systemPrompt], cron priority guard)` |
| 2 | Group chat | `cognitiveOrchestrator.ts` `buildSystemPrompt` (:215) | hardcoded Chinese `[System Role]/[Current Mission]/[Strict Rules]/[Chat Context]` — **chat history lives inside the system prompt** |
| 3 | Group task | `groupTaskPrompts.ts` + `groupTaskDaemon.ts` `buildTurnSystemPrompt` (:1905) | persona block + task/env/roster/playbook (~40 rules) stable; time+experience+cognition in volatile tail |
| 4 | A2A private chat | `privateChatDaemon.ts` `buildPrivateReplySystemPrompt` (:800) | `You are <name>, a private-chat MetaBot` + Role/Soul/Goal/Bio + 4 rules (+ one-off variants: wait notice, seller ack, rating) |
| 5 | IM | `imCoworkHandler.ts` `buildSystemPromptWithSkills` (:365), `imChatHandler.ts` | `[im_session_tools, skillsPrompt, global config.systemPrompt]` — **no bot persona at all** |
| 6 | Twin worker delegation | `twinOrchestrationService.ts` (:283) | one-line English worker prompt ("Use your own persona…") |
| 7 | Cron / scheduler | `sdkCronHostTrigger.ts` (:618), `scheduler.ts` (:295) | `[skillsPrompt, config.systemPrompt]` |

Persona shape is implemented **four different ways**: coworkRunner's XML-tag block (`buildMetabotPersonaBlock` :4138), privateChatDaemon's plain `Role:/Soul:/Goal:/Bio:` block, groupTaskPrompts' block (whose comment admits it "Mirrors buildPrivateReplySystemPrompt's shape" — i.e. known duplication), and cognitiveOrchestrator's Chinese 人设 sentence. IM includes none.

### 2.2 What IDBots already gets right (keep these)

The cowork path has independently converged on DSH's core caching ideas, in places with more engineering:

- **Stable/volatile split**: `composeEffectiveSystemPrompt`'s comment states the invariant ("first bytes byte-identical across turns… any change nukes the entire prefix"), and per-turn state rides the user message (`buildVolatileContextPrompt` :4414 — the "Reasonix pattern" comment at :5922). This is DSH's sections-vs-contexts distinction, rediscovered.
- **Volatile dedup**: `applyVolatileDedup` skips re-injecting a tail section whose bytes equal last turn's, with dedup state bound to the SDK session generation (:4459-4472) — the analog of DSH's changed-only snapshot projection, arguably better (DSH still re-sends the snapshot when any part changes).
- **Drift forensics**: `trackSystemPromptHash` (:4382) labels cache misses `system_prompt_drift` when the effective prompt changed without a known reset event.
- **Continue-session policy**: `coworkPromptStrategy.ts` keeps the persisted prompt when the skill-id set is unchanged, so live-catalog drift can't silently rewrite the prefix; a deliberate skill-set change is the only path to a new prompt.
- **Preset+append instead of replace** (coworkRunner :6311-6330): keeps the SDK's battle-tested coding layer and appends IDBots layers last, so IDBots rules win conflicts.
- **Per-channel profiles** (`SystemPromptProfile` :1182) already compress blocks (`service_order_a2a` = compact safety/time, no memory blocks).

### 2.3 The problems (where DSH's model would help)

**P1 — No shared section namespace → duplication & drift.** Five assembly points each pick their own order, shape, and language. Persona is duplicated 4×; "reply in the same language as the user" exists in ≥3 builders; the skills block re-implements routing precedence *by prose cross-reference* ("only after applying any higher-priority MetaApp routing rules already present in the system prompt") instead of by position.

**P2 — Identity conflicts ("prompt 打架").** A cowork bot session carries the `claude_code` preset identity ("You are Claude Code…") *plus* the metabot persona XML; group chat demands "绝不能承认自己是 AI 或语言模型" while the cowork preset openly identifies as a coding agent; the same bot is a "Web3 数字生命" in groups, a "private-chat MetaBot" in A2A, and nobody in IM. Layer order resolves most fights in practice (appended text wins), but nothing structural prevents two identity blocks from coexisting — exactly what DSH's single shadowed persona slot prevents.

**P3 — Cache discipline is per-site, not systemic.** Cowork and group task have the stable/volatile split; the cognitive orchestrator rebuilds the whole system prompt **including chat history** every turn (a stateless OpenAI-compat call, so every group-chat reply is a full-prefix cache miss by construction); IM/private one-shots rebuild everything per call. DSH's rule — "dynamic state never touches the system prompt" — exists only where someone noticed the pain.

**P4 — Tool/skill guidance weight.** DSH budgets one sentence per tool, owned by the tool. IDBots has a 17-rule central `## Skills (mandatory)` block (skillManager :1001-1026) injected on every skills-enabled session regardless of how many skills are active, plus medium-weight custom tool descriptions (~30 tools, ~150-300 words each) riding the tools parameter on every request.

**P5 — Silent composition failures.** Persona fields render literally as `Role: (empty)`; nothing fails when a builder returns garbage. DSH's strict `{{variable}}` interpolation + assembly invariants make prompt breakage loud and testable.

**P6 — Language mixing in prompts.** Chinese blocks (cron guard, cognitive orchestrator, group-chat user messages) and English blocks (group-task playbook, Twin role) coexist in the same products; AGENTS.md's convention is English-first.

### 2.4 Token & cache ledger (qualitative)

- Every cowork bot session pays for the full `claude_code` preset (~10k+ tokens of coding guidance) even for non-coding channels (IM chat, group tasks, Twin orchestration) — that's the price of the preset+append decision; it buys quality for coding tasks but is pure overhead for chat-flavored bots.
- The skills block + MetaApp routing + tool descriptions are stable per session, so they cache — but they are paid on the *first* turn of every new session, and sessions are created frequently (per IM conversation, per group task, per delegation).
- The group-chat path re-sends everything every turn with zero cache reuse.

---

## 3. What to learn from DSH (and what not to)

### Adopt

1. **A single ordered-section composer with a fixed order namespace** — one module every channel funnels through. Sections are `(name, order, text?)` with owner-namespaced names; empty texts drop; duplicates throw. This kills P1/P2 at the root: one persona slot (order 0), channel layers shadow base sections by name, identity can't double-render.
2. **Stable sections vs volatile contexts as a first-class distinction** — generalize what coworkRunner/group task already do: one `buildVolatileContext()` tail for every channel; system prompts stable by construction. Move group-chat history out of the system prompt (into the user turn) so even the stateless path can hit DeepSeek's automatic prefix cache across turns.
3. **Per-tool one-sentence guidance colocated with the tool registration** — shrink the 17-rule central skills block; each builtin tool/skill family owns a ≤3-line section that is only registered when the tool is actually enabled for that session. Keep medium-weight material in tool descriptions only where the model genuinely needs it at call time.
4. **Strict interpolation + assembly invariants** — compose via `{{variable}}` with fail-fast on unknown/empty; add a unit-test invariant that asserts section uniqueness, order stability, and "no dynamic text in stable sections" (a byte-stability test over two consecutive assemblies).
5. **Deterministic ordering everywhere** — fixed section order table; tools/skills entries sorted deterministically (already order-insensitive in `coworkPromptStrategy`'s skill-set comparison — extend the same determinism to rendered text).

### Do NOT adopt

- **The Cordis plugin runtime, scoped layers, waterfalls, event-driven registration.** DSH needs runtime composition because it is a plugin *platform* (third parties inject prompt parts at runtime). IDBots is an application with a fixed, compile-time-known set of channels and tools. A static TypeScript composer (~150-250 lines) captures the architecture's value without the machinery.
- **The `complete` full-replacement escape hatch beyond what exists.** IDBots already has its disciplined version (preset+append vs string-replace); adding a second replacement mechanism would increase, not decrease, conflict surface.

### Tradeoffs to decide explicitly

- **Keep the `claude_code` preset for coding-flavored sessions, consider a slim IDBots base prompt for chat-flavored channels** (IM/private/group/Twin orchestration turns that don't code). This is the single biggest token lever, but it forfeits the default's tool-use discipline — needs A/B measurement before rolling out.
- **One persona builder, channel-flavored via sections, not four builders**: the persona *facts* (name/role/soul/goal/bio + on-chain IDs) come from one section; channel framing ("you are in a group task…", "you are on Telegram…") is a separate section. This also fixes IM's missing persona for free.

---

## 4. Proposed target architecture (for this branch)

### Phase 1 — Section composer, no behavior change
- New `src/main/libs/promptComposer.ts`: ordered named sections, owner-namespaced (`idbots:`, `persona:`, `channel:`, `safety:`, `tool:`, `skill:`), fixed order table, shadow-by-name for channel overrides, strict `{{variable}}` rendering, dev-time duplicate/empty checks.
- Rewire the existing builders as section providers; `composeEffectiveSystemPrompt` becomes a thin call. Group task / private chat / IM / cognitive orchestrator keep their exact current output bytes at first (verified by snapshot tests) — pure refactor.

### Phase 2 — Unify persona + close channel gaps
- One `persona:*` section from the metabots row used by all channels; channel framing sections replace the per-builder preamble duplication. IM gains persona; group chat switches from its Chinese template to the shared grid (translating per AGENTS.md language rules); the four persona builders collapse to one.

### Phase 3 — Cache + token diet
- Group-chat path: history moves to the user turn; system prompt becomes per-(bot,group)-stable → prefix cache starts working.
- Skills routing block: per-active-skill one-liners instead of the 17-rule monolith; MetaApp routing precedence expressed by section order, deleting the prose cross-references.
- Measure: token count of first-turn prompt per channel (before/after), cache-miss labels from `trackSystemPromptHash` extended to all channels.
- Optional A/B: slim base prompt vs `claude_code` preset for non-coding channels.

### Phase 4 — Guardrails
- Byte-stability unit test: two consecutive assemblies of the same session state must be identical; any volatile value in a stable section fails CI.
- Migration notes for persisted sessions (`cowork_sessions.systemPrompt`) following the existing `resolveContinueSystemPrompt` policy.

---

## 5. Key source references

DSH:
- Registry/assembler: `packages/core/system-prompt/src/index.ts` (sections/contexts/tools/variables, PERSONA_SECTION, strict interpolate, orderTools)
- Invariants: `packages/core/system-prompt/src/invariant.ts`
- Persona preset (shadow semantics): `packages/preset/persona/src/index.ts`
- Changed-only context snapshots: `packages/core/agent-loop/src/runtime-context.ts`; consumption in `agent-loop/src/agent.ts:230-247,337`
- Tool-owned sections (one-sentence style): `packages/fs/tool-fs/src/read.ts:70`, `shell/tool-bash/src/index.ts:236`, `plan/plan-mode/src/index.ts:225`
- AGENTS.md as user messages: `packages/context/agent-instructions/src/index.ts`, `files.ts`, `state.ts`
- Design docs: `docs/subsystems/system-prompt.md`

IDBots:
- Stable composer + comments: `src/main/libs/coworkRunner.ts:4340-4404` (compose + hash tracking), `:5922-5936` (Reasonix volatile tail), `:4414-4472` (volatile builder + dedup), `:6311-6330` (preset+append), `:1182-1210` (profiles), `:4138` (persona XML), `:4183-4219` (Twin layers)
- Continue policy: `src/main/libs/coworkPromptStrategy.ts`
- Skills block: `src/main/skillManager.ts:1001-1026`
- Group chat: `src/main/services/cognitiveOrchestrator.ts:215-281`
- Group task: `src/main/services/groupTaskPrompts.ts`, `groupTaskDaemon.ts:1895-1935`
- Private chat: `src/main/services/privateChatDaemon.ts:800-823`
- IM: `src/main/im/imCoworkHandler.ts:365-400`
- Twin worker: `src/main/services/twinOrchestrationService.ts:283`
