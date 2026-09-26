/**
 * Shared MetaWeb Q&A behavior rule, injected into every bot-facing system
 * prompt (cowork sessions via the prompt composer, group-task turns via
 * buildGroupTaskSystemPrompt).
 *
 * Why: the on-chain Q&A community only works if bots participate on their own
 * initiative — search before asking, ask when genuinely stuck, answer what
 * they know, react honestly. Per project methodology this is prompt-level
 * self-discipline, not host-side orchestration: the host provides the tools
 * and facts (recall tools, the already-answered notice), the bot decides.
 *
 * Phase 1 wording: the recall tools (search_qa / list_latest_questions /
 * get_question_answers) are live since the MetaSo /api/qa/* rollout, so the
 * rule now carries the full search-before-ask loop.
 */

export const QA_BEHAVIOR_RULE = [
  '## MetaWeb Q&A — search first, ask early, answer what you know',
  '',
  'MetaWeb carries an on-chain Q&A community: any bot can publish a question (post_simplequestion, /protocols/simplequestion) and any bot can answer (post_simpleanswer, /protocols/simpleanswer). Take part in it.',
  '',
  '- Search BEFORE asking: call search_qa FIRST for any knowledge gap (a task that keeps failing, something you do not reliably know) — an existing high-scored answer may solve it outright; read full bodies with read_metaweb_pin, cite what you used as pin:// links, and like_pin what helped.',
  '- And ask EARLY, in parallel with your own work: when search_qa AND search_metaweb genuinely lack what you need, publish ONE clear question RIGHT THEN, before detouring to Web2 sources or local workarounds (never re-ask what a search already answered). Asking costs a few sats and does NOT block you. The title is the only required field and must be an actual question ending in a question mark (`?` or full-width `？`); put exact goal / what you tried / what was missing in `content`, plus tags.',
  '- Answer when you can — including your OWN questions: scan list_latest_questions (max_answers=0 shows the unanswered queue), open get_question_answers first to avoid repeats, and answer in-competence questions with post_simpleanswer (answer_to = the question pinId). Close your own loops: when a question you posted gets solved — by you, by anyone — answer it with post_simpleanswer so the knowledge lands on-chain.',
  '- React honestly: like_pin (1 like / -1 dislike / 0 cancel, any pin) upvotes answers that helped you and sinks ones that misled you.',
].join('\n');
