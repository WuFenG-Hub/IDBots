# MetaWeb Learning Roadmap — Bots That Search, Learn, and Study on the Agent Internet

## Status

Draft v0.1 for owner review, 2026-08-22. Branch `feat/metaweb-learning`, worktree `.worktrees/metaweb-learning`. This round delivers planning documents only; implementation starts after the owner approves this plan.

Locked product decisions (owner, 2026-08-22):

1. This round ships the full evolution plan plus the metaso-p2p backend requirements document (`docs/metaweb-search-backend-requirements.md`); code starts after review.
2. Unified MetaWeb search lands as a **new cross-protocol aggregation API in metaso-p2p** (following the existing `botsearch` aggregator pattern) — not client-side fan-out over the four existing per-protocol endpoints, and not the third-party `metaweb.world` FalkorDB API.
3. **SimpleNote (`/protocols/simplenote`) is the canonical carrier** for tutorials and knowledge articles on MetaWeb.
4. Milestone order is fixed: **M1 search/read tools → M2 guided learning loop → M3 experience memory → M4 autonomous study**.

## 1. Vision

IDBots is an entry point to the Agent Internet (MetaWeb), not another Codex-class agent platform. The product thesis:

- The Web2 internet is built for humans; MetaWeb is built for AIs. Today a user who installs a conventional agent platform must still live in Web2 to learn AI: read AI news, compare skill reviews, install skills one by one, keep the good ones, and read tutorials before the agent can do real work. That human-in-the-middle learning phase is slow and defeats the purpose.
- MetaWeb data is MetaID-structured, chain-verified, and small enough to be high-signal. That makes it feasible — for the first time — for a bot to *itself* discover what to learn, learn it, and act on it, without the owner learning anything first.
- End state: a user installs IDBots and never has to learn "AI knowledge" again. They state their needs; their TwinBot searches MetaWeb, learns the required knowledge and skills, and gets the job done. Each bot's capability boundary grows as MetaWeb content grows.

The mental model we give the bot: **MetaWeb is one big public computer — an external brain, or equivalently the bot's own hard drive** — already stocked with tutorials, knowledge, and skills. Reading it should feel as native as reading a local file.

## 2. Canonical scenarios

- **S1 — "What is IDBots?"** A brand-new user asks their TwinBot what IDBots can do. The bot combines local knowledge (system prompt, bundled playbooks) with an active MetaWeb search. It derives its own keywords ("IDBots tutorial", "MetaBot beginner", "TwinBot 初始化"), gets back 5–10 results with title/summary/pinId across protocols, opens the 1–3 most promising pins, and answers — following tutorial steps itself where applicable.
- **S2 — "Learn to make videos."** The bot searches MetaWeb for video-production tutorials and experience posts, follows the guide (e.g. installs the required skill/plugin from an on-chain `metabot-skill` package), verifies the install, records what worked as an experience, and reports to the owner: "I can now make videos."
- **S3 — "Study game development in your spare time."** During idle/dream time the bot crawls MetaWeb for the topic, distills the articles into a local wiki knowledge base (metabot-create-wiki style), and becomes a domain expert. Publishing the distilled knowledge back on-chain is optional.

## 3. Design principles

- **P1 — MetaWeb-as-disk.** Search/read of MetaWeb are exposed to the LLM as built-in tools at the same abstraction level as `read_file`/`write_file` — not as optional skills the user must install.
- **P2 — Progressive disclosure.** Never dump the whole internet into context. Search returns 5–10 candidates with title + summary + pinId; the bot picks and opens 1–3 pins, mirroring how a human uses a search engine.
- **P3 — Bot-derived keywords.** Keyword lists are never hardcoded. The bot formulates queries from the task at hand; prompts give strategy guidance only ("try 2–3 keyword variations", "if results are poor, broaden/narrow").
- **P4 — Web2 decoupling.** For IDBots/agent/MetaWeb knowledge, MetaWeb is the default source. Web2 search remains available but is not the default path for this domain.
- **P5 — Content is a separate workstream.** We assume dedicated publisher bots continuously seed and refresh content. This plan defines the format conventions they must follow (§8), not the bots themselves.
- **P6 — Reputation-ready.** Every search result carries verified publisher identity, so a reputation layer (M5) can rank and filter without protocol changes.

## 4. Current state (verified 2026-08-22)

### 4.1 What IDBots already has

MetaWeb tools already registered as built-in LLM tools (built in `src/main/libs/*AgentTools.ts`, registered in `coworkRunner.ts` `buildSessionInlineTools`):

| Capability | Tool / surface | Backend |
|---|---|---|
| Search MetaApps | `search_metaapps` (`botBrowserAgentTools.ts`) | `so.metaid.io/api/metaapp/list` |
| Search bots / MetaIDs | `search_metaids`, `metaid_profile` (`metaIdSearchAgentTools.ts`) | `so.metaid.io/api/metaid/list`, `/detail/:identity` |
| Search buzz posts | `search_social_posts`, `social_post_detail`, `social_post_comments` (`socialRecallAgentTools.ts`) | `so.metaid.io/api/social/feed`, `/api/social/post/:pinId` |
| Online skill services | `list_online_services` (`networkServicesAgentTools.ts`) | Gig Square chain sync + presence |
| Low-level pin reads | `omni_read` — 28 actions incl. `pin`, `pin_content`, `pins_by_path`, `buzz_search` (`omniReaderAgentTools.ts`) | `manapi.metaid.io`, `show.now` |
| Writes | `post_buzz` (simplebuzz), `omni_cast` (any protocol pin), `upload_file` (metafile) | local `metaidRpcServer` |
| Skill ops | `skill_tool`: `install_skill` (zip/github/skills.sh/npm), `list_installed_skills`, `read_skill`, `extract_metaapp` (`skillAgentTools.ts`) | — |

Supporting systems already in place:

- **Skill pipeline**: on-chain official/community `/protocols/metabot-skill` listing → metafile ZIP download → install into `userData/SKILLs` (`skillSyncService.ts`, `skillInstallService.ts`, `skillRoots.ts`); skills injected into prompts as an `<available_skills>` catalog (`skillManager.ts`).
- **Prompt composition**: named ordered sections in `src/main/libs/promptComposer.ts`; volatile per-turn blocks for memory, knowledge, experience (`knowledgePromptBlocks.ts`, `experiencePromptBlocks.ts`).
- **Local memory stack** (per-bot SQLite): user memories, knowledge points (`knowledge_recall`/`knowledge_upsert`), dream-distilled experience + self-identity (`dreamFragments.ts`, `experience_recall`), A2A episode recording (`metaidExperience*`), session recall (`conversation_search`).
- **Web2 constraint**: SDK WebSearch/WebFetch are policy-denied by default; bots reach the web only via the web-search skill. MetaWeb reads funnel through `omni_read`.

### 4.2 What metaso-p2p already has

Go + Gin + PebbleDB, deployed as `https://so.metaid.io`, no auth, `{code,data,message}` envelope, cursor-paged lists, `docs/specs/` contract-first workflow.

- Per-protocol keyword search: `/api/social/feed` (buzz full-text), `/api/metaapp/list`, `/api/bot-hub/skill-service/list`, `/api/metaid/list`, `POST /api/bots/search` (ranked bot staffing search).
- Per-protocol detail by pinId for buzz and MetaApp only.
- `internal/aggregator/botsearch` is the working template for a read-only cross-aggregator composed search (CJK-aware tokenization, weighted scoring, opaque cursors).
- All keyword matching is substring scan — **no inverted/text index anywhere**.
- Historical backfill pattern exists (`cmd/metaso-p2p-*-backfill` via MANAPI).

### 4.3 Protocol carriers (from `open-agent-connect/docs/metaid_protocols`)

| Protocol | Path | Knowledge-carrier fit |
|---|---|---|
| SimpleNote | `/protocols/simplenote` | **Canonical tutorial carrier**: `title`, `subtitle`, markdown `content`, `tags[]`, `coverImg`, `attachments[]` |
| SimpleBuzz | `/protocols/simplebuzz` | Announcements, experience logs, dev journals; no title/tags — weak result-list UX |
| MetaApp | `/protocols/metaapp` | Apps + `APP.md` agent-readable doc layer inside the package |
| MetaBot-Skill | `/protocols/metabot-skill` | Skill distribution (name/description/ZIP metafile) |
| skill-service | `/protocols/skill-service` | Service ads; `skillDocument` metafile can hold a full markdown guide |
| skill-service-rate | `/protocols/skill-service-rate` | Closest existing thing to an "experience report" (rating + comment tied to a service) |
| MetaProtocol | `/protocols/metaprotocol` | Protocol registry — "what protocols exist" |
| Remote skill doc | `/file/remote-skill` | Pure markdown knowledge files |

There is no dedicated tutorial/wiki/experience protocol today, and none is needed for M1–M4 given the conventions above.

### 4.4 Gaps

- **G1 — No unified cross-protocol search.** Buzz/apps/services/metaids are four separate endpoints; nothing answers "search all of MetaWeb knowledge" in one call.
- **G2 — No generic pin-read.** Pin content is fetchable per-protocol (buzz, MetaApp) or via low-level `omni_read pin_content` (20k truncation, raw text, caller must know what it's doing). No high-level "open this pinId and give me clean content" path.
- **G3 — SimpleNote is not indexed at all** in metaso-p2p, despite being the best knowledge carrier.
- **G4 — No title/summary projection** for non-note protocols (buzz = body text only), so a unified result list cannot be built without an extraction convention.
- **G5 — No MetaWeb worldview in the system prompt.** The bot is never told that MetaWeb is its external brain or that it should search-first when it lacks knowledge.
- **G6 — The wiki distiller can't ingest MetaWeb.** `metabot-create-wiki` absorbs only a local directory; nothing fetches chosen pins into it.
- **G7 — Experience memory exists but is disconnected from MetaWeb learning** — no structured "experience" record type that captures source pins, steps, and pitfalls from a learning episode.

## 5. Target architecture

```
Owner ↔ TwinBot (LLM session)
          │ built-in tools (same level as read_file/write_file):
          │   search_metaweb(keywords, filters)  → [{protocol,title,summary,pinId,...}]
          │   read_metaweb_pin(pinId)            → clean title + content + attachments
          ▼
IDBots main process
   src/main/services/metawebSearchService.ts   → GET so.metaid.io/api/metaweb/search
   src/main/services/metawebPinService.ts      → GET so.metaid.io/api/metaweb/pin/:pinId
          ▼
metaso-p2p (new `metawebsearch` aggregator + SimpleNote indexing + generic pin dispatch)
          ▼
chain indexers / MANAPI backfill
```

Conventions that make it work:

- **Result contract**: every search hit is `{protocol, pinId, title, summary, tags, publisher{globalMetaId,name}, createdAt, score, links}` regardless of source protocol; per-protocol extraction rules live server-side (see backend requirements doc).
- **Read contract**: `read_metaweb_pin` returns normalized markdown-ish text with a size policy (head + continuation pointer for long bodies) and resolves `metafile://` attachment references to fetchable URLs.
- **Worldview prompt**: a new promptComposer section (§6 M1) teaches the bot the external-brain model, the search→select→open→cite workflow, and keyword-derivation strategy.

## 6. Milestones

### M1 — Search & read tools + worldview (L0+L1)

**Goal**: any bot can search MetaWeb by keyword and read any pin, as natively as reading a local file.

Scope:

- Backend (blocking dependency): R1 unified search API, R2 SimpleNote indexing + backfill, R3 generic pin endpoint — specified in `docs/metaweb-search-backend-requirements.md`.
- IDBots main: `metawebSearchService.ts`, `metawebPinService.ts` (fetch clients, `{code,data}` envelope handling, result normalization, metafile URL resolution, read cache).
- Agent tools: `src/main/libs/metawebLearningAgentTools.ts` exposing `search_metaweb` and `read_metaweb_pin`; register in `coworkRunner.ts` `buildSessionInlineTools` for both Claude and DSH kernels.
- Prompt: new promptComposer section `metaweb-worldview` — external-brain model, when to search (unknown IDBots/agent/MetaWeb topic, "how do I", skill needs), keyword strategy (bot derives its own; 2–3 variations; broad↔narrow), reading discipline (scan titles/summaries, open 1–3 pins, cite pinIds in the answer), honesty rule (if MetaWeb has nothing, say so — never fabricate).
- Graceful degradation: if the search API is unreachable, the bot says MetaWeb search is unavailable and falls back to local knowledge — no silent Web2 substitution.

Acceptance: from a fresh IDBots install, asking the TwinBot "IDBots 能干什么 / how do I make it do X" produces an answer that visibly used `search_metaweb` + `read_metaweb_pin` and cites the pins it read (assuming seeded content).

### M2 — Guided learning loop (L2)

**Goal**: the bot can follow a MetaWeb tutorial end-to-end, including installing what it needs.

Scope:

- Tutorial-execution policy in the worldview section: extract concrete steps from a tutorial pin; when a step requires a skill/plugin, resolve it on-chain (`/protocols/metabot-skill` via existing skill sync / `skill_tool install_skill`) rather than from Web2.
- Install safety: reuse the existing approval flow — installing a skill from a tutorial requires owner approval by default (configurable); the bot must state what, why, and source pinId.
- Verification: after install, `list_installed_skills`/`read_skill` confirm; the bot reports "I learned X" with provenance (source pins).
- Outcome recording: minimal structured note of what was learned (feeds M3).

Acceptance: S2 scenario ("learn to make videos") completes with the video skill installed from MetaWeb, verified, and reported — with zero Web2 searches.

### M3 — Experience memory (L3)

**Goal**: a first-class local "experience" memory type — heavier than a knowledge point, lighter than a skill, no script dependency.

Scope:

- Experience record: `{title, trigger (when to use), steps, pitfalls, sourcePinIds, confidence, useCount, lastUsedAt}` stored per-bot in SQLite (extend `CoworkKnowledgeStore` or sibling store; idempotent migration per database-upgrade-safety rules).
- Tools: `experience_save` (new), upgraded `experience_recall` (query by task similarity); prompt injection of relevant experiences into turns where triggers match (bounded, like knowledge blocks).
- Dream/extraction integration: learning episodes (M2 outcomes) are distilled into experience records at turn end / dream time, deduped against existing records.
- Optional later: publish selected experiences on-chain (SimpleNote/buzz) to feed other bots.

Acceptance: after learning a task once, the bot repeats it later without re-searching MetaWeb, citing its experience record; experiences are inspectable in the knowledge UI.

### M4 — Autonomous study / dreaming (L4)

**Goal**: "study topic X in your spare time" → the bot becomes a local domain expert.

Scope:

- Study jobs: scheduled-task/dream infrastructure triggers a bounded study run (budget: N searches, M pin reads, token cap).
- Ingest bridge (closes G6): fetch chosen pins (note/buzz/markdown metafile, resolving `metafile://`) into a local raw-docs directory, then `metabot-create-wiki` absorb → index → query produces a per-topic wiki skill registered in the bot's skill roots.
- Provenance: the wiki records source pinIds per distilled unit; re-study refreshes incrementally.
- Optional publish: distilled wiki snapshot back on-chain (wiki skill already supports ZIP + snapshot publish).

Acceptance: after "study game development tonight", the bot answers domain questions from its local wiki (offline, no search), and can name the source pins.

### M5 — Reputation & ranking signals (future)

Fold `skill-service-rate` and publisher track record into search ranking; surface publisher reputation in results; let bots rate content they used. Backend ranking change + IDBots display/tooling; no protocol changes required by design (P6).

## 7. Cross-project work split

| Project | Work |
|---|---|
| IDBots (this repo) | M1 tools + services + worldview prompt; M2 learning loop + approval policy; M3 experience store/tools; M4 study jobs + ingest bridge |
| metaso-p2p (backend) | Unified search API, SimpleNote indexing + backfill, generic pin endpoint — per `docs/metaweb-search-backend-requirements.md` |
| open-agent-connect / metabot CLI (optional) | machine-first `pin get --pin-id` so OAC-side agents share the same search→fetch path |
| Content workstream (separate bots) | Seed and maintain tutorials/knowledge per §8 conventions |

## 8. Content supply conventions (for the publisher workstream)

- Tutorials/knowledge articles publish as **SimpleNote** with: meaningful `title`, one-line `subtitle` (used as the search summary), markdown `content`, and `tags` including topic tags, a language tag (`zh`/`en`), and a domain tag (e.g. `idbots`, `skill-guide`, `video`).
- Announce every new/updated article with a short **simplebuzz** quoting the note pinId (buzz = changelog/discovery layer).
- MetaApps keep an up-to-date `APP.md`; skill packages keep an up-to-date `SKILL.md`; skill-services attach a `skillDocument` markdown guide.
- **MetaApp-form tutorials**: search indexes only the pin's `title`/`intro`/`tags` (title carries the highest weight), and `read_metaweb_pin` returns just the `intro` for metaapp pins — the full `APP.md` inside the package is consumed via `skill_tool extract_metaapp`. Publishers MUST put the discovery keywords into `title`/`intro`/`tags`; never rely on the packaged content being searchable.
- Updates use pin modify semantics so `currentPinId` chains stay intact; publisher identity must be a consistent MetaID (reputation input, M5).

## 9. Risks and open questions

- **Content cold start**: M1 acceptance assumes seeded IDBots/basic-agent tutorials; sequencing with the content workstream is the real launch gate, not code.
- **Search quality without an inverted index**: substring scoring may be enough at current corpus size; backend owns the call on when to build a real index (open question in the requirements doc).
- **Token cost**: pin bodies can be long; `read_metaweb_pin` needs a head-first size policy and the prompt must enforce "open few, cite, move on".
- **Install safety (M2)**: auto-installing executable skills from chain content is a trust decision; default to owner approval, revisit with M5 reputation.
- **Empty/encrypted pin content**: some pins return `content: null` (encryption or indexer gaps); tools and prompts must tolerate and skip.
- **Protocol drift**: carrier conventions live in this doc and in the metaprotocol registry; keep both updated when new carriers appear.
