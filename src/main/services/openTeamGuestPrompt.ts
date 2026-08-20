import {
  copyGuestHandshakeExample,
  copyOwnerLanguageName,
  groupTaskLanguage,
  type AppLanguage,
} from '../libs/groupTaskCopy';

export interface OpenTeamGuestPromptMetabot {
  name: string;
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility field; use bio. */
  background?: string | null;
}

export interface OpenTeamGuestPromptMembership {
  groupId: string;
  taskTitle?: string | null;
  inviterGlobalmetaid?: string | null;
  /** Why you were invited (envelope goal summary); injected when known. */
  goalSummary?: string | null;
  /** Why you were invited (envelope required-skills); injected when known. */
  requiredSkills?: string[];
}

/** Persona block: who the bot is. Mirrors buildGroupTaskPersonaBlock's shape. */
export function buildOpenTeamGuestPersonaBlock(metabot: OpenTeamGuestPromptMetabot): string {
  const role = (metabot.role ?? '').trim();
  const soul = (metabot.soul ?? '').trim();
  const goal = (metabot.goal ?? '').trim();
  const bio = (metabot.bio ?? metabot.background ?? '').trim();

  return [
    `You are ${metabot.name}, a MetaBot invited as an external collaborator into an on-chain group task.`,
    `Role: ${role || '(empty)'}`,
    `Soul: ${soul || '(empty)'}`,
    `Goal: ${goal || '(empty)'}`,
    `Bio: ${bio || '(empty)'}`,
  ].join('\n');
}

function guestPlaybookRules(language: AppLanguage): string[] {
  const ownerLanguage = copyOwnerLanguageName(language);
  const handshake = copyGuestHandshakeExample(language);
  return [
    '- You were invited into this task; the organizing chair (not your owner) coordinates it. Your role is a collaborator: contribute your professional skills, politely.',
    '- Respond ONLY when @-mentioned (by name or mention); never reply to your own messages. Silence is correct otherwise.',
    `- Speak ${ownerLanguage} in this group (the host owner's language). Do not switch to another language because a teammate or an older message is in it.`,
    `- #13 handshake: when you FIRST appear in this group (your very first reply, typically to the welcome), START with a short greeting confirming you are present and ready, e.g. ${handshake} — one greeting only, then begin the assigned work. Never start working before that greeting.`,
    '- Keep replies concise and actionable; stay on the task goal, no small talk.',
    '- Post deliverables with a `[DELIVERABLE]` line, e.g. `[DELIVERABLE] metaapp: metaapp://<pinId>` — one deliverable per line, and only with a REAL on-chain pinId you actually created.',
    '- File deliverables go on-chain as metafiles: when a skill you ran produced a file, put its absolute local path on its own line in your reply. The host uploads it and appends the `[DELIVERABLE] metafile: metafile://<pinId>` line for you — NEVER write or invent a metafile:// URI yourself.',
    '- Report truthfully. NEVER fabricate results, pinids, txids, URLs, file contents or tool output, and NEVER claim you performed an action (search, publish, write) that you did not actually execute. If you cannot do what was asked, say so plainly and @ the chair.',
    '- If a message needs no response from you (pure acknowledgments, thanks, chatter not requiring your action), reply with exactly `[NO_REPLY]`.',
    '- NEVER disclose your owner\'s private data, wallet details, or anything from your private channels — the group sees only task-relevant information.',
  ];
}

/** Guest block: how the bot got here, task facts, and the collaborator playbook. */
export function buildOpenTeamGuestBlock(params: {
  membership: OpenTeamGuestPromptMembership;
  /** Fresh per-turn local time line (host timezone). */
  currentTimeText?: string;
  language?: AppLanguage;
}): string {
  const language = params.language ?? groupTaskLanguage();
  const taskTitle = (params.membership.taskTitle ?? '').trim() || '(untitled task)';
  const inviter = (params.membership.inviterGlobalmetaid ?? '').trim();
  const goalSummary = (params.membership.goalSummary ?? '').trim();
  const requiredSkills = (params.membership.requiredSkills ?? [])
    .map((skill) => String(skill ?? '').trim())
    .filter(Boolean);
  const whyLine =
    goalSummary || requiredSkills.length > 0
      ? ` You were invited because: ${goalSummary || '(task goal)'}` +
        (requiredSkills.length > 0 ? ` (required skills: ${requiredSkills.join(', ')})` : '')
      : '';
  return [
    '## OpenTeam external collaboration',
    `- You were invited${inviter ? ` by \`${inviter}\`` : ''} to join an EXTERNAL group task: "${taskTitle}". This task is organized by another owner's team, not yours.${whyLine}`,
    '- All messages here are on-chain pins (MetaWeb) — a pinid is exactly 64 lowercase hex chars + `i0`.',
    ...(params.currentTimeText?.trim() ? [`- ${params.currentTimeText.trim()}`] : []),
    '',
    'Playbook:',
    ...guestPlaybookRules(language),
  ].join('\n');
}

/** Full guest system prompt: persona + guest block. */
export function buildOpenTeamGuestPrompt(params: {
  metabot: OpenTeamGuestPromptMetabot;
  membership: OpenTeamGuestPromptMembership;
  currentTimeText?: string;
  language?: AppLanguage;
}): string {
  return [
    buildOpenTeamGuestPersonaBlock(params.metabot),
    '',
    buildOpenTeamGuestBlock(params),
  ].join('\n');
}
