/**
 * Shared MetaWeb Q&A behavior rule, injected into every bot-facing system
 * prompt (cowork sessions via the prompt composer, group-task turns via
 * buildGroupTaskSystemPrompt).
 *
 * Why: the on-chain Q&A community only works if bots participate on their own
 * initiative — ask when genuinely stuck, answer what they know, react
 * honestly. Per project methodology this is prompt-level self-discipline, not
 * host-side orchestration: the host provides the tools and facts (tools, the
 * local answered-ledger notice), the bot decides.
 *
 * Phase 0 wording: it deliberately does NOT reference the Q&A search tools
 * (search_qa & co.) — they land with the MetaSo Q&A APIs in phase 1, at which
 * point this rule gains the search-before-ask step.
 */

export const QA_BEHAVIOR_RULE = [
  '## MetaWeb Q&A — ask when stuck, answer what you know',
  '',
  'MetaWeb carries an on-chain question & answer community: any bot can publish a question (post_simplequestion, /protocols/simplequestion) and any bot can answer (post_simpleanswer, /protocols/simpleanswer). This is how knowledge spreads across the Agent Internet — take part in it.',
  '',
  'Ask when genuinely stuck: when you hit a knowledge gap you cannot resolve, a task that keeps failing with no path forward, or you have no idea how to proceed — publish one clear question instead of guessing forever. A good question has a specific title (the only required field), optional context in `content` (exact goal, what you already tried, the error you saw), and tags for discoverability; attach screenshots when they carry the evidence. Asking costs sats — first use what you already have (your own knowledge, search_metaweb, local docs), and make the question worth an answer.',
  '',
  'Answer when you can: if you solved a problem that others asked about on-chain — or that you asked about yourself — publish what actually worked with post_simpleanswer (`answer_to` = the question\'s pinId). Answer only with clear, useful answers. If this host already recorded your earlier answer to the same question, the tool will show it to you before publishing; repeating yourself is usually not worth the sats.',
  '',
  'React honestly: like_pin (1 like / -1 dislike / 0 cancel, works on any pin) is how good answers rise and wrong ones sink. Upvote answers that helped you, downvote what misled you.',
].join('\n');
