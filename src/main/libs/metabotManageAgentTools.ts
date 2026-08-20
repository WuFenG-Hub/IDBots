import { z } from 'zod';
import {
  applyChatSkillOp,
  type CreateMetaBotOnChainResult,
  type DeleteMetaBotResult,
  type ManagedMetabotSummary,
  type LlmProviderOption,
  type UpdateMetaBotInput,
  type UpdateMetaBotResult,
} from '../services/metabotManageService';

/**
 * Control surface the host (main.ts) provides for the metabot_manage tools.
 * Every method delegates to the shared core functions in
 * services/metabotManageService.ts — the exact same code the manual UI IPC
 * handlers call — so a bot created/edited/deleted by the Twin runs through
 * identical logic (wallet generation, gas subsidy, on-chain pin publishing,
 * rollback) as one managed by hand.
 */
export type MetabotManageControl = {
  create(input: {
    name: string;
    llm_id: string;
    fallback_llm_id?: string | null;
    role?: string;
    soul?: string;
    goal?: string | null;
    bio?: string | null;
    avatar?: string | null;
    metabot_type?: 'twin' | 'worker';
  }): Promise<CreateMetaBotOnChainResult>;
  update(id: number, input: UpdateMetaBotInput): Promise<UpdateMetaBotResult>;
  delete(id: number): Promise<DeleteMetaBotResult>;
  list(): ManagedMetabotSummary[];
  listProviders(): LlmProviderOption[];
};

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>,
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------------
// Homepage composition (mirrors the UI's MetaBotHomepageSection.composeHomepageForSave)
// ---------------------------------------------------------------------------

/** Structured homepage intent the Twin passes to metabot_update. */
export type MetabotHomepageToolInput =
  | { source: 'default'; pin?: string; contentType?: string }
  | { source: 'metafile'; pin: string; contentType?: string }
  | { source: 'metaapp'; pin: string; contentType?: string };

const stripMetaScheme = (value: string, scheme: 'metaapp://' | 'metafile://'): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().startsWith(scheme) ? trimmed.slice(scheme.length).trim() : trimmed;
};

/**
 * Compose the final homepage JSON string (or null) the same way the manual UI
 * does. `null` or `{ source: 'default' }` clears the homepage back to the
 * default template; metafile/metaapp sources validate the pin (no whitespace,
 * no "://") and produce the `{uri,renderer,contentType}` blob the DB expects.
 * Throws on an invalid pin.
 */
export function composeHomepageForTool(input: MetabotHomepageToolInput | null): string | null {
  if (input === null || input.source === 'default') return null;
  const pin = stripMetaScheme(input.pin ?? '', input.source === 'metafile' ? 'metafile://' : 'metaapp://');
  if (!pin || /\s/u.test(pin) || /:\/\//.test(pin)) {
    throw new Error(
      `${input.source} homepage requires a valid pin (no whitespace, no "://").`,
    );
  }
  if (input.source === 'metafile') {
    const contentType = (input.contentType ?? '').trim() || 'application/octet-stream';
    return JSON.stringify({ uri: `metafile://${pin}`, renderer: 'auto', contentType });
  }
  return JSON.stringify({ uri: `metaapp://${pin}`, renderer: 'metaapp', contentType: 'application/vnd.metaapp' });
}

// ---------------------------------------------------------------------------
// Result formatters (machine-readable sheets the Twin can relay to the user)
// ---------------------------------------------------------------------------

function formatProviders(providers: LlmProviderOption[]): string {
  if (providers.length === 0) {
    return 'Available LLM providers: NONE (the user has no model provider configured yet — ask them to add one in Settings > Model Providers first).';
  }
  const lines = providers.map((p) => {
    const models = (p.models ?? []).map((m) => m.id).join(', ');
    return `- ${p.id} (label: ${p.label}${models ? `; models: ${models}` : '; no models configured'})`;
  });
  return [
    'Available LLM providers and their models (pass a MODEL id as llm_id, optionally with llm_provider set to the provider id and llm_effort as off/low/high/max):',
    ...lines,
  ].join('\n');
}

function formatBotLine(m: ManagedMetabotSummary): string {
  const bits: string[] = [];
  bits.push(`id=${m.id}`);
  bits.push(m.type);
  bits.push(m.enabled ? 'enabled' : 'disabled');
  if (m.llm_id) bits.push(`llm=${m.llm_id}${m.llm_effort ? ` effort=${m.llm_effort}` : ''}`);
  if (m.fallback_llm_id) bits.push(`fallback=${m.fallback_llm_id}${m.fallback_llm_effort ? ` effort=${m.fallback_llm_effort}` : ''}`);
  if (m.role) bits.push(`role=${m.role}`);
  const extra: string[] = [];
  if (m.bio) extra.push(`bio=${truncate(m.bio, 80)}`);
  if (m.goal) extra.push(`goal=${truncate(m.goal, 80)}`);
  if (m.allow_chat_skills.length) extra.push(`chatSkills=[${m.allow_chat_skills.join(',')}]`);
  return `- ${m.name} — ${bits.join(', ')}${extra.length ? ` (${extra.join('; ')})` : ''}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatCreateResult(result: CreateMetaBotOnChainResult): string {
  if (!result.success || !result.metabot) {
    return `MetaBot creation failed: ${result.error ?? 'unknown error'}`;
  }
  const m = result.metabot;
  const lines = [
    `MetaBot created: ${m.name} (id=${m.id}, type=${m.metabot_type}, llm=${m.llm_id ?? 'n/a'}).`,
    `Identity registered on-chain (globalMetaID: ${m.globalmetaid ?? 'n/a'}).`,
  ];
  if (result.chainPartial) {
    lines.push(`Note: on-chain publish was partial — ${result.chainError ?? 'some non-critical pins were not confirmed'}. The bot exists and works locally; the user can re-sync from My Bots if needed.`);
  }
  const subsidy = result.subsidy;
  if (subsidy && !subsidy.success) {
    lines.push(`Note: gas subsidy was not applied (${subsidy.error ?? 'reason unknown'}); creation proceeded with the bot's own wallet.`);
  }
  if (m.metabot_type === 'twin') {
    lines.push('The new bot is the user\'s Twin Bot (their personal on-chain digital twin). Tell the user their first Twin Bot is ready and appears in My Bots; new tasks can now be assigned to it.');
  } else {
    lines.push('The new bot is a Worker by default. Tell the user they can keep chatting with you; the new bot appears in My Bots.');
  }
  return lines.join('\n');
}

function formatUpdateResult(result: UpdateMetaBotResult): string {
  if (!result.success || !result.metabot) {
    return `MetaBot update failed: ${result.error ?? 'unknown error'}`;
  }
  const m = result.metabot;
  if (!result.sync || result.sync.skipped) {
    return `Updated ${m.name} (id=${m.id}). Change applied locally (no on-chain sync needed for this field).`;
  }
  const sync = result.sync;
  if (sync.success) {
    const tx = sync.txids && sync.txids.length ? ` (txids: ${sync.txids.join(', ')})` : '';
    return `Updated ${m.name} (id=${m.id}) and published the change on-chain${tx}.`;
  }
  // Local write succeeded but chain sync failed/partial.
  return `Updated ${m.name} (id=${m.id}) locally, but on-chain sync ${sync.canSkip ? 'was partial' : 'failed'}: ${sync.error ?? 'unknown error'}. The bot works locally; the user can re-sync from My Bots.`;
}

function formatDeleteResult(id: number, result: DeleteMetaBotResult): string {
  if (!result.success) {
    return `MetaBot deletion failed (id=${id}): ${result.error ?? 'unknown error'}`;
  }
  return `MetaBot (id=${id}) deleted. If the deleted bot was the Twin, Twin status was transferred to the earliest remaining non-welcome bot (if any).`;
}

export type ChatSkillOp = { action: 'add' | 'remove'; skill: string };

function formatGetInfoResult(bot: ManagedMetabotSummary | undefined, id: number): string {
  if (!bot) {
    return `MetaBot ${id} not found.`;
  }
  const skills = bot.allow_chat_skills;
  if (skills.length === 0) {
    return `MetaBot ${bot.name} (id=${bot.id}) chatSkills whitelist is empty.`;
  }
  return [
    `MetaBot ${bot.name} (id=${bot.id}) chatSkills whitelist (${skills.length}):`,
    ...skills.map((skill) => `- ${skill}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool builder
// ---------------------------------------------------------------------------

/** Which operator persona the tool suite is registered for. */
export type MetabotManageViewer = 'twin' | 'welcome' | 'standard';

/**
 * Inline MCP tools that let bots manage the local MetaBot roster.
 *
 * - viewer 'twin' (default): the full list/create/update/delete suite plus
 *   metabot_getinfo, registered for Twin sessions.
 * - viewer 'welcome': a reduced list+create suite for the built-in Welcome
 *   Bot during initial setup.
 * - viewer 'standard': chat-skill whitelist update + metabot_getinfo, so a
 *   Worker in an ordinary Chat can install a skill onto itself without the
 *   Twin-only create/delete tools.
 *
 * Every mutating tool delegates to services/metabotManageService.ts, the same
 * code the manual UI uses.
 */
export function buildMetabotManageAgentTools(deps: {
  tool: SdkToolFactory;
  control: MetabotManageControl;
  viewer?: MetabotManageViewer;
}): unknown[] {
  const { tool, control } = deps;
  const isWelcomeViewer = deps.viewer === 'welcome';
  const isStandardViewer = deps.viewer === 'standard';
  const audience = isWelcomeViewer
    ? 'Welcome Bot during initial setup (this machine has no Twin Bot yet).'
    : isStandardViewer
      ? 'Available in ordinary Chat sessions. Use chat_skill_op to add or remove a single chat skill; use metabot_getinfo to read the whitelist back.'
      : 'Twin Bot only.';

  const metabotList = tool(
    'metabot_list',
    [
      `List local MetaBots (id, name, twin/worker type, enabled, llm, role, chat skills) and available LLM providers/models. ${audience}`,
      'Call before metabot_create to pick llm_id, or to map a display name to the metabot_id metabot_update/metabot_delete need. Call once; do not loop or self-identify.',
      isWelcomeViewer
        ? 'Provider-list model ids are the llm_id values metabot_create expects; add llm_provider when a model id appears under several providers. The first bot you create becomes the user\'s Twin Bot.'
        : 'The Twin is the single bot whose type is "twin". Provider-list model ids are the llm_id values metabot_create expects; add llm_provider when a model id appears under several providers.',
    ].join(' '),
    {},
    async () => {
      const [bots, providers] = [control.list(), control.listProviders()];
      if (bots.length === 0) {
        return textResult(`No local MetaBots found.${providers.length ? '' : ''}\n\n${formatProviders(providers)}`);
      }
      const lines = bots.map(formatBotLine);
      return textResult(
        [`Local MetaBots (${bots.length}):`, ...lines, '', formatProviders(providers)].join('\n'),
      );
    },
  );

  const metabotCreate = tool(
    'metabot_create',
    isWelcomeViewer
      ? [
          `Create the user's first local MetaBot: on-chain wallet + identity, My Bots entry. ${audience}`,
          'Use when the user asks to create/set up their first Bot or Twin. While no Twin exists it becomes the first Twin Bot, else a Worker.',
          'Ask for a name if none given. llm_id must come from metabot_list — never invent one (confirm if several providers; just use the free MetaID one if alone). Other fields optional (persona later in My Bots). Chain-first: may take seconds; result reports id/name/type, globalMetaID, txids, partial/subsidy notes.',
        ].join(' ')
      : [
          'Create ONE new local MetaBot (always a Worker) end-to-end: wallet, on-chain identity, My Bots entry. Twin Bot only.',
          'Use when the user asks to create/add a bot, assistant, employee, or agent. Not for editing an existing bot (use metabot_update) or restoring from a mnemonic.',
          'Rules: name and llm_id required; never invent llm_id — pick a model id from metabot_list (add llm_provider if listed under several providers). Other fields optional, settable later via metabot_update. Chain-first: may take seconds; result reports id/name/type, globalMetaID, txids, and partial/subsidy notes.',
        ].join(' '),
    {
      name: z.string().min(1).describe('Display name for the new bot (required).'),
      llm_id: z
        .string()
        .min(1)
        .describe('LLM brain for the new bot (required) — a MODEL id from the metabot_list provider/model report.'),
      llm_provider: z
        .string()
        .optional()
        .describe('Provider id the model belongs to (from metabot_list). Pass when the same model id appears under multiple providers.'),
      llm_effort: z
        .enum(['off', 'low', 'high', 'max'])
        .optional()
        .describe('Reasoning effort for the primary brain. Omit to follow the model default.'),
      fallback_llm_id: z
        .string()
        .optional()
        .describe('Optional fallback brain model id, used when the primary brain is unavailable or fails.'),
      fallback_llm_provider: z
        .string()
        .optional()
        .describe('Provider id for the fallback brain model.'),
      fallback_llm_effort: z
        .enum(['off', 'low', 'high', 'max'])
        .optional()
        .describe('Reasoning effort for the fallback brain. Omit to follow the model default.'),
      role: z.string().optional().describe('Optional short role/title (e.g. "Translator").'),
      soul: z.string().optional().describe('Optional persona/soul description guiding the bot\'s behavior.'),
      goal: z.string().optional().describe('Optional goal statement.'),
      bio: z.string().optional().describe('Optional public bio shown on the bot profile.'),
      avatar: z
        .string()
        .optional()
        .describe('Optional avatar as a data URL or http(s) URL. Omit to use the default avatar.'),
    },
    async (args: {
      name: string;
      llm_id: string;
      llm_provider?: string;
      llm_effort?: string;
      fallback_llm_id?: string;
      fallback_llm_provider?: string;
      fallback_llm_effort?: string;
      role?: string;
      soul?: string;
      goal?: string;
      bio?: string;
      avatar?: string;
    }) => {
      const name = asString(args.name);
      const llmId = asString(args.llm_id);
      if (!name) return textResult('metabot_create requires a non-empty `name`.', true);
      if (!llmId) {
        const providers = control.listProviders();
        return textResult(
          `metabot_create requires an \`llm_id\`. ${formatProviders(providers)}`,
          true,
        );
      }
      const createInput: {
        name: string;
        llm_id: string;
        llm_provider?: string;
        llm_effort?: string;
        fallback_llm_id: string | null;
        fallback_llm_provider?: string;
        fallback_llm_effort?: string;
        role?: string;
        soul?: string;
        goal?: string;
        bio?: string;
        avatar?: string;
        metabot_type?: 'twin' | 'worker';
      } = {
        name,
        llm_id: llmId,
        ...(args.llm_provider ? { llm_provider: asString(args.llm_provider) } : {}),
        ...(args.llm_effort ? { llm_effort: asString(args.llm_effort) } : {}),
        fallback_llm_id: args.fallback_llm_id ? asString(args.fallback_llm_id) : null,
        ...(args.fallback_llm_provider ? { fallback_llm_provider: asString(args.fallback_llm_provider) } : {}),
        ...(args.fallback_llm_effort ? { fallback_llm_effort: asString(args.fallback_llm_effort) } : {}),
        role: args.role,
        soul: args.soul,
        goal: args.goal,
        bio: args.bio,
        avatar: args.avatar,
      };
      if (isWelcomeViewer) {
        // Bootstrap invariant: while the machine has no Twin, the bot the
        // Welcome Bot creates becomes the user's first Twin Bot; afterwards
        // every Welcome-Bot creation is a plain Worker like the Twin's own.
        createInput.metabot_type = control.list().some((m) => m.type === 'twin')
          ? 'worker'
          : 'twin';
      }
      const result = await control.create(createInput);
      return textResult(formatCreateResult(result), !result.success);
    },
  );

  const metabotUpdate = tool(
    'metabot_update',
    isStandardViewer
      ? [
          'Update ONE local MetaBot\'s chat-skill whitelist only. Available in ordinary Chat sessions.',
          'metabot_id required. chat_skill_op adds/removes ONE skill (action "add"|"remove", skill = name from list_installed_skills) without replacing the list; allow_chat_skills replaces the whole list — prefer chat_skill_op. No other fields: not for rename, persona, or delete.',
          'No confirmation prompt. Returns updated bot name/id and on-chain sync outcome.',
        ].join(' ')
      : [
          'Update ONE existing local MetaBot: rename, persona, LLM, enabled, chat skills, homepage, a2a. Twin Bot only.',
          'metabot_id required (resolve names via metabot_list); pass only changed fields; omitted keep values.',
          'metabot_type "twin" is allowed only when no Twin currently exists; the Welcome Bot can never become Twin. The current Twin may demote itself to "worker". chat_skill_op adds/removes one skill (no confirmation); allow_chat_skills replaces the list — never pass both. homepage null or "default" resets.',
          'Owner (boss_global_metaid) NOT settable here — user sets it in My Bots > Edit; never attempt. Info-pin edits re-publish on-chain (best-effort, reports txids/partial); a2a/enabled/type stay local.',
        ].join(' '),
    {
      metabot_id: z.number().int().positive().describe('id of the bot to update (from metabot_list, or the current bot\'s id).'),
      name: z.string().optional().describe('New display name.'),
      avatar: z.string().optional().describe('New avatar (data URL or http(s) URL), or empty string to clear.'),
      bio: z.string().optional().describe('New public bio.'),
      enabled: z.boolean().optional().describe('Enable or disable the bot.'),
      metabot_type: z
        .enum(['twin', 'worker'])
        .optional()
        .describe('Promote to Twin only when none exists, or demote the current Twin to Worker. The Welcome Bot cannot become Twin.'),
      role: z.string().optional().describe('New role/title.'),
      soul: z.string().optional().describe('New persona/soul description.'),
      goal: z.string().optional().describe('New goal statement.'),
      llm_id: z.string().optional().describe('New primary brain — a MODEL id from the metabot_list provider/model report.'),
      llm_provider: z.string().optional().describe('Provider id the primary brain model belongs to; empty string clears it.'),
      llm_effort: z.enum(['off', 'low', 'high', 'max']).optional().describe('New reasoning effort for the primary brain; omit to keep, null/empty resets to the model default.'),
      fallback_llm_id: z.string().optional().describe('New fallback brain model id, or empty string to clear.'),
      fallback_llm_provider: z.string().optional().describe('Provider id for the fallback brain model; empty string clears it.'),
      fallback_llm_effort: z.enum(['off', 'low', 'high', 'max']).optional().describe('New reasoning effort for the fallback brain; omit to keep, null/empty resets to the model default.'),
      allow_chat_skills: z
        .array(z.string())
        .optional()
        .describe('Full replacement list of skill ids allowed in this bot\'s private chats. Prefer chat_skill_op for a single add/remove.'),
      chat_skill_op: z
        .object({
          action: z.enum(['add', 'remove']).describe('Add or remove one skill without replacing the rest of the whitelist.'),
          skill: z.string().min(1).describe('Skill name or skill id (from list_installed_skills / SKILL.md name).'),
        })
        .optional()
        .describe('Incremental chat-skill whitelist change. Does not prompt for confirmation.'),
      homepage: z
        .object({
          source: z
            .enum(['default', 'metafile', 'metaapp'])
            .describe('Homepage source. "default" resets to the default template; "metaapp" points at a MetaApp pin; "metafile" points at an uploaded MetaFile.'),
          pin: z
            .string()
            .optional()
            .describe('The metaapp pin or metafile pin (without the metaapp:// / metafile:// prefix). Omit for source "default".'),
          contentType: z
            .string()
            .optional()
            .describe('MIME type for a metafile homepage; defaults to application/octet-stream. Ignored for metaapp/default.'),
        })
        .nullable()
        .optional()
        .describe('Homepage override (structured), or null to reset to the default template.'),
      a2a_max_incoming_turns: z
        .number()
        .int()
        .optional()
        .describe('Max incoming turns per A2A private-chat session before auto-bye (e.g. 20/30/50/80/100/150/200).'),
      a2a_bye_cooldown_ms: z
        .number()
        .int()
        .optional()
        .describe('Cooldown (ms) after an auto-bye before an A2A chat may reopen (e.g. 60000/300000/600000/1800000/3600000).'),
      a2a_auto_reply_enabled: z
        .boolean()
        .optional()
        .describe('Whether this bot auto-replies in A2A private chats.'),
    },
    async (args: Record<string, unknown>) => {
      const id = Number(args.metabot_id);
      if (!Number.isInteger(id) || id <= 0) {
        return textResult('metabot_update requires a positive integer `metabot_id`.', true);
      }
      const chatSkillOp = args.chat_skill_op as ChatSkillOp | undefined;
      if (isStandardViewer) {
        const extraKeys = Object.keys(args).filter((key) => (
          key !== 'metabot_id'
          && key !== 'chat_skill_op'
          && key !== 'allow_chat_skills'
          && args[key] !== undefined
        ));
        if (extraKeys.length > 0) {
          return textResult(
            `Ordinary Chat sessions may only change chat skills via metabot_update (got extra fields: ${extraKeys.join(', ')}). Use chat_skill_op.`,
            true,
          );
        }
      }
      if (chatSkillOp && args.allow_chat_skills !== undefined) {
        return textResult(
          'metabot_update cannot take both chat_skill_op and allow_chat_skills. Use chat_skill_op for a single add/remove.',
          true,
        );
      }
      const input: UpdateMetaBotInput = {};
      const passthrough: Array<keyof UpdateMetaBotInput> = [
        'name',
        'avatar',
        'bio',
        'enabled',
        'metabot_type',
        'role',
        'soul',
        'goal',
        'llm_id',
        'llm_provider',
        'llm_effort',
        'fallback_llm_id',
        'fallback_llm_provider',
        'fallback_llm_effort',
        'allow_chat_skills',
        'a2a_max_incoming_turns',
        'a2a_bye_cooldown_ms',
        'a2a_auto_reply_enabled',
      ];
      let provided = 0;
      for (const key of passthrough) {
        if (args[key] !== undefined) {
          (input as Record<string, unknown>)[key as string] = args[key];
          provided += 1;
        }
      }
      if (chatSkillOp) {
        const action = chatSkillOp.action === 'remove' ? 'remove' : 'add';
        const skill = asString(chatSkillOp.skill);
        if (!skill) {
          return textResult('metabot_update chat_skill_op requires a non-empty `skill`.', true);
        }
        const bot = control.list().find((item) => item.id === id);
        if (!bot) {
          return textResult(`MetaBot ${id} not found.`, true);
        }
        input.allow_chat_skills = applyChatSkillOp(bot.allow_chat_skills, { action, skill });
        provided += 1;
      }
      // Homepage needs structured→JSON composition before it is forwarded.
      if (args.homepage !== undefined) {
        try {
          input.homepage = composeHomepageForTool(args.homepage as MetabotHomepageToolInput | null);
        } catch (error) {
          return textResult(
            `metabot_update homepage error: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
        provided += 1;
      }
      if (provided === 0) {
        return textResult(
          'metabot_update received no fields to change. Pass at least one editable field (name, bio, role, llm_id, enabled, homepage, chat_skill_op, ...).',
          true,
        );
      }
      const result = await control.update(id, input);
      return textResult(formatUpdateResult(result), !result.success);
    },
  );

  const metabotDelete = tool(
    'metabot_delete',
    [
      'Permanently delete ONE local MetaBot (DB row removed; on-chain identity abandoned; wallet record kept). Twin Bot only.',
      'Use only when the user clearly asks to delete/remove a specific bot; resolve via metabot_list and CONFIRM the exact name first — irreversible.',
      'metabot_id required. Do not delete yourself (the Twin) unless the user insists; deleting the last remaining bot is refused. Twin deletion transfers Twin status to the earliest remaining non-welcome bot (if any); experience/memory rows are preserved.',
    ].join(' '),
    {
      metabot_id: z.number().int().positive().describe('id of the bot to delete (from metabot_list).'),
    },
    async (args: { metabot_id: number }) => {
      const id = Number(args.metabot_id);
      if (!Number.isInteger(id) || id <= 0) {
        return textResult('metabot_delete requires a positive integer `metabot_id`.', true);
      }
      const result = await control.delete(id);
      return textResult(formatDeleteResult(id, result), !result.success);
    },
  );

  const metabotGetinfo = tool(
    'metabot_getinfo',
    [
      'Read ONE local MetaBot\'s information. This period covers list_bot_chat_skills: return the bot\'s chatSkills whitelist so you can verify a chat_skill_op add/remove.',
      'Use after metabot_update(chat_skill_op) to confirm the skill is (or is no longer) on the whitelist. metabot_id is required.',
      'When NOT to use: do not use this to list every bot (Twin uses metabot_list for that); this is a focused read of one bot\'s chat skills.',
      'Returns the whitelist as one skill per line, or an empty-whitelist note.',
    ].join(' '),
    {
      action: z
        .enum(['list_bot_chat_skills'])
        .optional()
        .describe('Read operation. Defaults to list_bot_chat_skills.'),
      metabot_id: z.number().int().positive().describe('id of the bot to read.'),
    },
    async (args: { action?: 'list_bot_chat_skills'; metabot_id: number }) => {
      const id = Number(args.metabot_id);
      if (!Number.isInteger(id) || id <= 0) {
        return textResult('metabot_getinfo requires a positive integer `metabot_id`.', true);
      }
      const bot = control.list().find((item) => item.id === id);
      if (!bot) {
        return textResult(`MetaBot ${id} not found.`, true);
      }
      return textResult(formatGetInfoResult(bot, id));
    },
  );

  if (isWelcomeViewer) {
    // The Welcome Bot only needs discovery + creation during initial setup;
    // update/delete stay Twin-only so the free-quota guide cannot mutate or
    // remove existing bots.
    return [metabotList, metabotCreate];
  }
  if (isStandardViewer) {
    return [metabotUpdate, metabotGetinfo];
  }
  return [metabotList, metabotCreate, metabotUpdate, metabotDelete, metabotGetinfo];
}
