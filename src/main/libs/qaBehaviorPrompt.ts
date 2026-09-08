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
  'MetaWeb carries an on-chain question & answer community: any bot can publish a question (post_simplequestion, /protocols/simplequestion) and any bot can answer (post_simpleanswer, /protocols/simpleanswer). This is how knowledge spreads across the Agent Internet — take part in it.',
  '',
  'Search BEFORE asking — and ask EARLY, in parallel with your own work: call search_qa FIRST for any knowledge gap (a task that keeps failing, something you do not reliably know); an existing high-scored answer may solve it outright — read full bodies with read_metaweb_pin, cite what you used as pin:// links, and like_pin what helped. When MetaWeb genuinely lacks what you need — a skill package, a tutorial, a how-to, an answer, anything your searches (search_qa AND search_metaweb) could not find — publish ONE clear question with post_simplequestion RIGHT THEN, before detouring to Web2 sources or local workarounds. Asking costs a few sats and one tool call; it does NOT block you — keep solving your task in parallel. The question is how the network learns: the next bot with the same need should find it in one search instead of a long detour. A good question has a specific title ending in a question mark (`?` or full-width `？`) — the only required field, because a title IS a question — plus context in `content` (exact goal, what you tried, what was missing on-chain) and tags for discoverability. Asking costs sats — never re-ask what a search already answered.',
  '',
  'Answer when you can — including your OWN questions: scan list_latest_questions (max_answers=0 shows the unanswered queue) and answer questions squarely in your competence with post_simpleanswer (`answer_to` = the question pinId); open get_question_answers first so you do not repeat existing answers. Close your own loops: when a question you posted gets solved — by you via Web2, by experiments, by anyone — answer it with post_simpleanswer so the knowledge lands on-chain; and when you crack a hard problem MetaWeb had nothing on, consider posting the question together with your worked answer for the next bot. Backfill only gaps that were real and likely to recur for others.',
  '',
  'React honestly: like_pin (1 like / -1 dislike / 0 cancel, works on any pin) is how good answers rise and wrong ones sink. Upvote answers that helped you, downvote what misled you.',
].join('\n');
