import { z } from 'zod';
import type {
  CreateMetaBotOnChainResult,
  DeleteMetaBotResult,
  ManagedMetabotSummary,
  LlmProviderOption,
  UpdateMetaBotInput,
  UpdateMetaBotResult,
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
// Result formatters (machine-readable sheets the Twin can relay to the user)
// ---------------------------------------------------------------------------

function formatProviders(providers: LlmProviderOption[]): string {
  if (providers.length === 0) {
    return 'Available LLM providers: NONE (the user has no model provider configured yet — ask them to add one in Settings > Model Providers first).';
  }
  const lines = providers.map((p) => `- ${p.id} (label: ${p.label})`);
  return `Available LLM providers (pass the id as llm_id):\n${lines.join('\n')}`;
}

function formatBotLine(m: ManagedMetabotSummary): string {
  const bits: string[] = [];
  bits.push(`id=${m.id}`);
  bits.push(m.type);
  bits.push(m.enabled ? 'enabled' : 'disabled');
  if (m.llm_id) bits.push(`llm=${m.llm_id}`);
  if (m.fallback_llm_id) bits.push(`fallback=${m.fallback_llm_id}`);
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
  lines.push('The new bot is a Worker by default. Tell the user they can keep chatting with you; the new bot appears in My Bots.');
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
  return `MetaBot (id=${id}) deleted. If the deleted bot was the Twin, Twin status was transferred to the earliest remaining bot.`;
}

// ---------------------------------------------------------------------------
// Tool builder
// ---------------------------------------------------------------------------

/**
 * Inline MCP tools that let the Twin Bot manage the local MetaBot roster:
 * list, create, update, and delete. Registered ONLY for Twin sessions in
 * coworkRunner (isTwinSession gate) — Worker bots never see these tools.
 *
 * Every tool delegates to services/metabotManageService.ts, the same code the
 * manual UI uses, so Twin-assisted management is identical to hand-editing.
 */
export function buildMetabotManageAgentTools(deps: {
  tool: SdkToolFactory;
  control: MetabotManageControl;
}): unknown[] {
  const { tool, control } = deps;

  const metabotList = tool(
    'metabot_list',
    [
      'List every local MetaBot with its editable fields (id, name, Twin/Worker type, enabled, llm, role, bio, goal, chat skills) plus the LLM providers available for new/edited bots. Twin Bot only.',
      'Use BEFORE creating a bot (to show the user which LLM brains they can pick from) and to resolve a bot the user names by its display name into a metabot_id before updating or deleting it.',
      'When NOT to use: do not call this just to identify yourself (you already know your own identity); and do not call it in a tight loop — call once, then act on the returned ids.',
      'Rules: the metabot_id returned here is the exact value metabot_update and metabot_delete expect. The Twin is the single bot whose type is "twin". Provider ids in the available-provider list are the values metabot_create expects as llm_id.',
      'Returns one line per bot plus the available LLM provider list.',
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
    [
      'Create ONE new local MetaBot (a Worker by default) end-to-end: generate its on-chain wallet, register its identity on-chain, and add it to My Bots. Twin Bot only.',
      'Use when the user asks to create / add / hire a new bot, assistant, employee, agent, or AI (e.g. "帮我创建一个新员工", "add a new assistant").',
      'When NOT to use: do not create a bot without first collecting a name AND an llm_id from the user (both are required) — call metabot_list to show the available llm_id choices and ask; and do not use this to edit an existing bot (use metabot_update) or to restore a bot from a mnemonic.',
      'Rules: name and llm_id are required; everything else (fallback_llm_id, role, soul, goal, bio, avatar) is optional and can be set later via metabot_update. Creation is chain-first — it can take a few seconds and may publish partially; the result reports txids and any partial status. The new bot is always a Worker (the machine keeps exactly one Twin).',
      'Returns the created bot id/name/type, its on-chain globalMetaID, and any partial-publish or subsidy notes.',
    ].join(' '),
    {
      name: z.string().min(1).describe('Display name for the new bot (required).'),
      llm_id: z
        .string()
        .min(1)
        .describe('LLM brain provider id for the new bot (required) — one of the ids metabot_list reports as available.'),
      fallback_llm_id: z
        .string()
        .optional()
        .describe('Optional secondary provider key retried once if the primary LLM fails.'),
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
      fallback_llm_id?: string;
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
      const result = await control.create({
        name,
        llm_id: llmId,
        fallback_llm_id: args.fallback_llm_id ? asString(args.fallback_llm_id) : null,
        role: args.role,
        soul: args.soul,
        goal: args.goal,
        bio: args.bio,
        avatar: args.avatar,
      });
      return textResult(formatCreateResult(result), !result.success);
    },
  );

  const metabotUpdate = tool(
    'metabot_update',
    [
      'Update ONE existing local MetaBot\'s editable fields: basic info (name, avatar, bio, enabled, Twin/Worker type), persona (role, soul, goal), LLM (llm_id, fallback_llm_id), chat skills, and A2A auto-reply knobs. Twin Bot only.',
      'Use when the user asks to rename, re-describe, re-persona, enable/disable, switch the LLM brain of, or otherwise edit an existing bot. Resolve the target with metabot_list first (the user usually names it by display name).',
      'When NOT to use: do not update without a confirmed metabot_id; do not edit fields the user did not ask to change (pass only the fields to change); and homepage composition + signed owner-binding are not supported by this tool yet — tell the user to set those in My Bots > Edit > Advanced.',
      'Rules: metabot_id is required. Pass only the fields that should change; omitted fields keep their current value. Transferring Twin status (metabot_type="twin") demotes the current Twin automatically. Changed info pins are re-published on-chain (best-effort); the result reports txids and any partial status. A2A knobs and enabled/type are local-only (no on-chain publish).',
      'Returns the updated bot name/id and the on-chain sync outcome.',
    ].join(' '),
    {
      metabot_id: z.number().int().positive().describe('id of the bot to update (from metabot_list).'),
      name: z.string().optional().describe('New display name.'),
      avatar: z.string().optional().describe('New avatar (data URL or http(s) URL), or empty string to clear.'),
      bio: z.string().optional().describe('New public bio.'),
      enabled: z.boolean().optional().describe('Enable or disable the bot.'),
      metabot_type: z
        .enum(['twin', 'worker'])
        .optional()
        .describe('Promote to Twin (demotes the current Twin) or demote to Worker.'),
      role: z.string().optional().describe('New role/title.'),
      soul: z.string().optional().describe('New persona/soul description.'),
      goal: z.string().optional().describe('New goal statement.'),
      llm_id: z.string().optional().describe('New primary LLM provider id (from metabot_list available providers).'),
      fallback_llm_id: z.string().optional().describe('New secondary provider key, or empty string to clear.'),
      allow_chat_skills: z
        .array(z.string())
        .optional()
        .describe('Full replacement list of skill ids allowed in this bot\'s private chats.'),
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
      // Forward only the fields the caller actually provided.
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
        'fallback_llm_id',
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
      if (provided === 0) {
        return textResult(
          'metabot_update received no fields to change. Pass at least one editable field (name, bio, role, llm_id, enabled, ...).',
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
      'Permanently delete ONE local MetaBot (DB row + on-chain identity is abandoned; the append-only wallet record is retained). Twin Bot only.',
      'Use when the user clearly asks to delete / remove / fire a specific bot. Resolve the target via metabot_list first, and CONFIRM the exact bot name with the user before calling this — deletion is irreversible.',
      'When NOT to use: do not delete without explicit user confirmation of the exact bot; do not delete yourself (the Twin) unless the user insists and understands another bot will be promoted to Twin; and never delete the last remaining bot (the tool refuses that to keep the machine usable).',
      'Rules: metabot_id is required. If the deleted bot was the Twin, Twin status transfers automatically to the earliest remaining bot. Experience/memory rows produced by the deleted bot are preserved as historical record.',
      'Returns a confirmation, or an error (e.g. last-bot guard, not found).',
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

  return [metabotList, metabotCreate, metabotUpdate, metabotDelete];
}
