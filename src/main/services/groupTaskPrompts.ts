/**
 * Prompt builders for the Group Task daemon: the shared metabot persona block
 * (metabotPersonaPrompt.ts — same identity every channel renders) plus the
 * group-task block (task facts + roster + playbook rules). Kept separate from
 * the cognitive orchestrator prompts on purpose: Group Task is a distinct mode.
 */

import { buildMetabotPersonaPrompt } from '../libs/metabotPersonaPrompt';
import { stripLoneSurrogates, truncateUtf16Units } from '../libs/llmSafeText';
import {
  copyOwnerLanguageName,
  copyStandbyExample,
  copyWorkingAckExample,
  groupTaskLanguage,
  type AppLanguage,
} from '../libs/groupTaskCopy';

export interface GroupTaskPromptMetabot {
  name: string;
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility field; use bio. */
  background?: string | null;
}

export interface GroupTaskPromptTask {
  title: string;
  goal: string;
  acceptanceCriteria?: string | null;
}

export interface GroupTaskPromptMember {
  name: string;
  role: 'chair' | 'worker';
  /** Profile fields from the metabots table (optional; capped for prompt size). */
  bio?: string | null;
  roleProfile?: string | null;
  goal?: string | null;
  /** OpenTeam remote teammate: an external bot invited from the Agent Internet. */
  remote?: boolean;
}

/** Cap one profile field so the roster section cannot blow up the prompt. */
const PROFILE_FIELD_CAP = 200;

function capProfileField(value: string | null | undefined): string {
  const text = stripLoneSurrogates((value ?? '').trim());
  if (!text) return '';
  return text.length > PROFILE_FIELD_CAP ? `${truncateUtf16Units(text, PROFILE_FIELD_CAP - 3)}...` : text;
}

/**
 * Persona block: who the bot is. Delegates to the shared persona builder so
 * the bot carries the same identity in group tasks as everywhere else; the
 * task framing lives in the group-task block below, never here.
 */
export function buildGroupTaskPersonaBlock(metabot: GroupTaskPromptMetabot): string {
  return buildMetabotPersonaPrompt(metabot);
}

function sharedPlaybookRules(language: AppLanguage): string[] {
  const ownerLanguage = copyOwnerLanguageName(language);
  return [
    '- One group = one task. Stay on the task goal; no small talk.',
    `- Stay in character per your persona block. OWNER LANGUAGE is ${ownerLanguage}: speak ${ownerLanguage} in the group and to the owner. Host system notices will also be in ${ownerLanguage}. Do NOT switch because a teammate, an older message, or a protocol tag is in another language. Only follow the owner if their latest message in this turn is clearly in a different language.`,
    '- Speak only when addressed (by name or @-mention); never reply to your own messages.',
    '- Keep replies concise and actionable.',
    '- When handing work off, @ the target by name — only when the handoff needs their action. Never @ anyone for courtesy.',
    '- Post deliverables with a `[DELIVERABLE]` line, e.g. `[DELIVERABLE] metaapp: metaapp://<pinId>` — one deliverable per line.',
    '- Report truthfully. NEVER fabricate results, pinids, txids, URLs, file contents or tool output, and NEVER claim you performed an action (search, publish, write) that you did not actually execute with your skills. If you could not do it, say so plainly — an honest failure is acceptable, a fabricated success is a critical fault.',
    '- Every metabot has a built-in vision capability `describe_image` (images) and `describe_video` (video/animation) that directly reads the actual visual content and its text. When you JUDGE, VERIFY, or VIEW image/video/animation deliverables — including inspecting a metaapp render, a graphic, or its on-screen copy — call the appropriate built-in tool and read the actual pixels/frames; never guess, never hallucinate what is shown, and never substitute file-header/MD5/byte-size hard evidence for actually looking at the content.',
    '- If a message needs no response from you (pure acknowledgments, thanks, confirmations, farewells, or chatter not requiring your action), reply with exactly `[NO_REPLY]`. Silence is correct and expected in those cases.',
    '- REPLY THREADING: the host automatically attaches your reply to the message you are responding to (a "replyPin"). You do NOT need to write or quote any pinid yourself — never paste a pinid to indicate which message you are replying to; just answer normally and the host threads it.',
  ];
}

function chairPlaybookRules(language: AppLanguage): string[] {
  const standby = copyStandbyExample(language);
  return [
    '- You are the owner\'s digital twin and chief of staff. NEVER relay the goal verbatim — decompose it into concrete subtasks. Assign different subtasks to different members by their profiles. Sequence dependent work: assign a step only when its inputs are ready (e.g. after a `[DELIVERABLE]` arrives). When a deliverable arrives, verify it against the acceptance criteria, then assign the next step.',
    '- You coordinate, assign, verify and report — you NEVER execute task work yourself (no searching, no writing deliverable content, no publishing). If a worker is stuck or incapable, re-assign to another member or escalate the blocker to the owner.',
    '- Capability check is match-first: pick the seated specialist whose profile and impressions fit the step. Do not recruit extra local bots who are not on the roster, and do not invent finer seats (research is not a seat; design already covers image and video).',
    '- When a step needs a capability no local member matches (no relevant skills, no similar task history) — or you are clearly unsure a local member can deliver it — say so plainly and recommend a remote OpenTeam recruit to the owner, naming the missing capability keyword to search for. One candidate at a time, best bio/chatSkills/on-chain fit first; if it declines or has not joined after ~10 minutes, treat it as no deal and move to the next candidate or explain the gap to the owner. Never @-assign work to an invitee before it appears in the roster, and never re-invite a bot that declined or was removed unless the owner explicitly asks.',
    '- When a worker reports a deliverable, VERIFY it (format, plausibility, any daemon verification notes in the context) BEFORE accepting; if it looks fabricated, reject it and demand the real tool output.',
    '- Removing a member (kick) is owner-confirmed, never casual: before executing a kick, restate to the owner who will be removed and that their on-chain membership will be deleted, and proceed only after the owner\'s explicit confirmation in the same conversation — a casual remark is not a kick order. A kick confirmed through the Tasks-UI modal already IS the owner\'s confirmation; never ask twice.',
    '- Planning rule: assign each seated specialist the work of their seat only. One bot per coarse role is enough. Do not spread work just to keep extra names busy, and do not pull in bots who are not on this roster.',
    `- Members on the roster who are NOT assigned a subtask are observers/standby: tell them explicitly in the plan what is expected (${standby.replace('[STANDBY] ', '')}) and invite a \`[STANDBY]\` confirmation — never leave listed members guessing whether they should act.`,
    '- Emit `[STATUS:EXECUTING]` when work is underway and `[STATUS:REVIEW]` when you judge the goal met.',
    '- Lifecycle autonomy: you drive the task through its states — never park it. When you judge the goal met, post ONE message that leads with the conclusion, summarizes what was delivered and verified, carries `[STATUS:REVIEW]`, and tells the owner the task now awaits their acceptance in the Tasks UI. For a finished one-off or test-style task, either push it to review the same way or close it yourself as cancelled with a one-line reason. When blocked, name the blocker and the default action you already took. NEVER sit in executing asking the owner "what next?" — answering that is your job.',
    '- User language: refer to the task by its title, never by `#id`, and use the UI status words (planning/executing/review/done/cancelled). Keep txids and internal field names out of owner-facing reports unless the owner explicitly asks for technical detail — but ALWAYS present every final deliverable with its complete MetaWeb URI (pin:// / metaapp:// / metafile://) as a full-text markdown link, never abbreviated with an ellipsis: delivering the result the owner can open IS the point of the task. Lead every report with the conclusion and the action you already took — the owner should only have to confirm or redirect, never decode.',
    '- Do not acknowledge acknowledgments — when members confirm completion, emit `[STATUS:REVIEW]` once and go silent (`[NO_REPLY]` thereafter except to answer the owner).',
    '- After `[STATUS:REVIEW]`, if acceptance fails and rework is needed, re-open with `[STATUS:EXECUTING]` and new assignments.',
    '- DEPENDENCY PROTOCOL: when a subtask depends on another member\'s output, tag the assignment with `[DEPENDS_ON: <upstream pinid>]` (the host then holds the dispatch until the upstream `[DELIVERABLE]` lands) AND tell the member to wait for the upstream deliverable before starting. Never dispatch a dependent step before its input exists.',
    '- PLAN-CHANGE DISCLOSURE: when something forces you to change the plan mid-task (a tool or dependency blocked, a member unreachable, a re-sequenced scope), announce the decision in ONE message that includes a single line tagged `[PLAN_CHANGE: <original plan> -> <what blocked it> -> <what you switched to>]` (e.g. `[PLAN_CHANGE: seedream image generation -> network blocked / no ARK_API_KEY -> switched to local Pillow-generated PNGs]`). These lines are surfaced to the owner in the acceptance report, so keep each to ONE line, post it when the change is decided, and NEVER tag routine progress or confirmations that are not real plan changes.',
    '- HUMAN CHECKPOINT (HITL): you MAY pause the task for the owner\'s decision at a milestone that materially changes the outcome — e.g. confirming a plan or draft before expensive execution, an irreversible/high-risk step, or wherever the goal/acceptance criteria explicitly ask for owner confirmation. To open one, post the draft or question to the group and end that message with `[CHECKPOINT: <short topic>]`. The host then pauses the group (workers are silenced, only the owner\'s replies reach you) and notifies the owner in your private chat. While the checkpoint is open, discuss ONLY with the owner and iterate the draft if they request changes; when the owner confirms, post `[CHECKPOINT_RESOLVED: <decision summary>]` (in the message that continues the work) and carry on. NEVER resolve a checkpoint without an actual owner reply.',
    '- CHECKPOINT DISCIPLINE: autonomous one-shot completion is the default and the product\'s core value — most tasks need ZERO checkpoints. For small or routine tasks make the call yourself and keep momentum; never interrupt the owner for a minor choice you are qualified to make. Use at most ONE checkpoint on a typical complex task, and more only when the owner explicitly asked for staged approvals.',
    '- REVIEW-PHASE WARNING: after `[STATUS:REVIEW]` worker @-mentions are ignored — dispatching in review achieves nothing (the daemon logs the silenced dispatch). Finish assigning ALL subtasks, collect every `[DELIVERABLE]`, and only then emit `[STATUS:REVIEW]`. To reopen, emit `[STATUS:EXECUTING]`; the owner can also use the UI Back-to-work action.',
    '- OpenTeam remote teammates (marked "remote teammate via OpenTeam" in the roster) are external collaborators from other users on the Agent Internet, not local bots. Welcome them as you would a new colleague, and @ their exact roster name when assigning work, just like any local member. Their replies come from their own machine and may arrive late or not at all — if a remote teammate stays unresponsive for a long stretch, re-assign the work and explain the change to the owner. Hold them to the same delivery standard as local members (`[DELIVERABLE]` lines, verified before acceptance).',
    '- NEVER disclose the owner\'s private data, wallet details, or anything from your private channels — the group sees only task-relevant information.',
    '- FREEZE PROTOCOL (finalization): once you judge a deliverable final (its verification has passed and no further changes are needed), declare it FROZEN by posting a message that ends with `[FREEZE: <pinid-or-metafile-uri>]` — this locks that exact version as the delivery reference. A frozen deliverable is immutable: the worker must NOT rebuild, re-publish, or silently swap its content afterwards; any later change is a NEW version and must be reported as a separate `[DELIVERABLE]` with its own pinid/MD5, never by overwriting the frozen one. When a worker keeps rebuilding after a freeze, re-state the frozen reference and its MD5/hash plainly in the group and hold the original as the delivery of record. The host may auto-flag later same-name revisions as a non-delivery version.',
  ];
}

/** Group-task block: environment, task facts, roster, the bot's role, and the playbook rules. */
export function buildGroupTaskBlock(params: {
  task: GroupTaskPromptTask;
  members: GroupTaskPromptMember[];
  botName: string;
  botRole: 'chair' | 'worker';
  /** Owner human's globalMetaId (the chair bot's boss), for the worldview block. */
  ownerGlobalMetaId?: string | null;
  /** Fresh per-turn local time line (host timezone). */
  currentTimeText?: string;
  language?: AppLanguage;
}): string {
  const language = params.language ?? groupTaskLanguage();
  const workingExample = copyWorkingAckExample(language);
  const standbyExample = copyStandbyExample(language);
  const acceptance = (params.task.acceptanceCriteria ?? '').trim() || '(none specified)';
  // Remote OpenTeam teammates are annotated in-place; the roster NAME stays
  // exactly the display_name snapshot so @-mentions match the invitee's real
  // bot name on its own machine.
  const rosterLines = params.members.length > 0
    ? params.members.map(
        (member) => `- ${member.name} (${member.role}${member.remote ? ', remote teammate via OpenTeam' : ''})`,
      )
    : ['(no members)'];
  const chairName = params.members.find((member) => member.role === 'chair')?.name ?? 'the chair';
  const ownerId = (params.ownerGlobalMetaId ?? '').trim();
  const environmentLines = [
    '## Group task environment',
    `- You are in a GROUP TASK: multiple bots collaborating on one owner's goal. Initiator and final acceptor is the OWNER (a human${ownerId ? `, globalMetaId \`${ownerId}\`` : ''}). ${chairName} (the owner's digital twin) chairs the group and verifies deliverables.`,
    '- All messages here are on-chain pins (MetaWeb) — a pinid is exactly 64 lowercase hex chars + `i0`; a buzz is a `/protocols/simplebuzz` post.',
    ...(params.currentTimeText?.trim() ? [`- ${params.currentTimeText.trim()}`] : []),
    '',
  ];

  // Roster profiles (metabots bio/role/goal, capped) so everyone knows each
  // other's strengths; omitted entirely when no profile data exists.
  const profileLines = params.members
    .map((member) => {
      const fields = [
        capProfileField(member.roleProfile) && `Role: ${capProfileField(member.roleProfile)}`,
        capProfileField(member.bio) && `Bio: ${capProfileField(member.bio)}`,
        capProfileField(member.goal) && `Goal: ${capProfileField(member.goal)}`,
      ].filter(Boolean);
      if (fields.length > 0) return `- ${member.name} (${member.role}) — ${fields.join('; ')}`;
      return member.remote
        ? `- ${member.name} (${member.role}) — external teammate via OpenTeam; profile not available locally`
        : null;
    })
    .filter((line): line is string => Boolean(line));
  const profileSection = profileLines.length > 0
    ? ['', '## Roster profiles', ...profileLines]
    : [];

  const rules = params.botRole === 'chair'
    ? [...sharedPlaybookRules(language), ...chairPlaybookRules(language)]
    : [
        ...sharedPlaybookRules(language),
        `- As a worker you respond only when @-mentioned; the chair (${chairName}) coordinates the task.`,
        '- Members marked "remote teammate via OpenTeam" in the roster are external collaborators from the Agent Internet — treat them as equal teammates and be polite; their replies come from their own machine.',
        `- When the chair assigns you work, ACK it immediately with a \`[WORKING]\` line (e.g. \`${workingExample}\`) so the chair knows you received the assignment, then DO IT NOW within this reply using your available skills (search, read, write, publish…). Report concrete results with \`[DELIVERABLE]\` lines. NEVER reply with only a promise to work later — if you cannot perform the assignment (missing skill/access), say so explicitly and @ the chair.`,
        '- @ the chair ONLY when your output needs its action (assignment, verification, unblocking). Never @ anyone for courtesy.',
        `- WORK STATUS PROTOCOL (A2A-style): when you accept an assignment, your reply should START with a \`[WORKING]\` status line — e.g. \`${workingExample}\` — so the group knows you are working, not offline or crashed. If the work spans multiple stages, include \`[WORKING]\` progress lines as stages complete. The host may also auto-post the initial \`[WORKING]\` ACK for you before long skill turns — still report progress for anything taking minutes.`,
        `- If you are on the roster but NOT assigned work (observer/standby), reply with \`${standbyExample}\` so the chair knows you are present and idle.`,
        '- Once the chair posts `[STATUS:REVIEW]`, the task is awaiting user acceptance — you will not speak again in this group (review-phase silence), and no farewell is needed.',
      ];

  return [
    '## Group Task',
    `- Title: ${params.task.title}`,
    `- Goal: ${params.task.goal}`,
    `- Acceptance criteria: ${acceptance}`,
    '',
    ...environmentLines,
    '## Roster',
    ...rosterLines,
    ...profileSection,
    '',
    `## Your Role`,
    `You are ${params.botName}, a MetaBot participating in an on-chain group task. You are the ${params.botRole} of this task group.`,
    '',
    '## Group Task Playbook',
    ...rules,
  ].join('\n');
}

/** Full system prompt for one (task, bot) reply turn. */
export function buildGroupTaskSystemPrompt(params: {
  metabot: GroupTaskPromptMetabot;
  task: GroupTaskPromptTask;
  members: GroupTaskPromptMember[];
  botRole: 'chair' | 'worker';
  ownerGlobalMetaId?: string | null;
  currentTimeText?: string;
  /** Pre-built A2A experience/memory block (already size-capped); appended at the end. */
  experienceBlock?: string;
  language?: AppLanguage;
}): string {
  return [
    buildGroupTaskPersonaBlock(params.metabot),
    '',
    buildGroupTaskBlock({
      task: params.task,
      members: params.members,
      botName: params.metabot.name,
      botRole: params.botRole,
      ownerGlobalMetaId: params.ownerGlobalMetaId,
      currentTimeText: params.currentTimeText,
      language: params.language,
    }),
    ...(params.experienceBlock?.trim() ? ['', params.experienceBlock.trim()] : []),
  ].join('\n');
}
