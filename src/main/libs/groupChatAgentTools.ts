import { z } from 'zod';
import type { AssignGroupChatTaskParams } from '../services/assignGroupChatTaskService';

/**
 * Control surface the host (main.ts) provides for the group_chat tool.
 * Replaces the retired metabot-chat-groupchat skill script: orchestrate maps
 * onto assignGroupChatTask() (local group_chat_tasks row), join_group and
 * send_group_message ride the same create-pin pipeline the skill drove
 * through RPC (/protocols/simplegroupjoin and /protocols/simplegroupchat,
 * AES-encrypted content). All crypto and wallet handling stays host-side;
 * this tool handler is thin.
 */
export type GroupChatControl = {
  resolveMetabotIdByName(name: string): number | null;
  getMetabotDisplayName(metabotId: number): string | null;
  assignTask(params: AssignGroupChatTaskParams): { success: boolean; message: string; error?: string };
  joinGroup(input: {
    metabotId: number;
    groupId: string;
    referrer?: string;
    k?: string;
    network?: 'mvc' | 'doge' | 'btc';
  }): Promise<{ txids: string[]; pinId: string; totalCost?: number }>;
  sendGroupMessage(input: {
    metabotId: number;
    groupId: string;
    content: string;
    nickName?: string;
    replyPin?: string;
    channelId?: string;
    mention?: string[];
    network?: 'mvc' | 'doge' | 'btc';
  }): Promise<{ txids: string[]; pinId: string; totalCost?: number }>;
};

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
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

function formatPinResult(title: string, result: { txids: string[]; pinId: string }): string {
  return [
    title,
    `- pinId: ${result.pinId}`,
    `- txids: ${(result.txids ?? []).join(', ')}`,
    `- pin link: [pin://${result.pinId}](pin://${result.pinId})`,
  ].join('\n');
}

type GroupChatAction = 'orchestrate' | 'join_group' | 'send_group_message';
type GroupChatNetwork = 'mvc' | 'doge' | 'btc';

/**
 * Inline MCP tool covering the three group-chat capabilities of the retired
 * metabot-chat-groupchat skill. Registered for every cowork surface when the
 * host provides GroupChatControl (see coworkRunner).
 */
export function buildGroupChatAgentTools(deps: {
  tool: SdkToolFactory;
  control: GroupChatControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const groupChat = tool(
    'group_chat',
    [
      'MetaWeb group-chat operations for one MetaBot. Pick the action by intent:',
      'action "orchestrate": configure or refresh an autonomous group-chat reply task (local group_chat_tasks row: reply on @mention, random interjection, Boss/supervisor instructions). Local only — it does NOT join the group on-chain.',
      'action "join_group": on-chain SimpleGroupJoin (/protocols/simplegroupjoin, state 1). Pass the protocol key field `k` for a private group.',
      'action "send_group_message": send ONE group message (/protocols/simplegroupchat); pass plaintext `content` — the host AES-encrypts it before broadcast.',
      'To both join and keep chatting, call join_group first, then orchestrate.',
      'group_id is the on-chain group pin id; never invent it — ask the user when unknown. target_metabot_name selects the acting MetaBot (case-insensitive); omit it to use the MetaBot that owns this session.',
      'On-chain pins are permanent — do NOT join groups or post messages the user did not ask for. For private 1:1 messages use send_private_chat; for public posts use post_buzz.',
    ].join(' '),
    {
      action: z
        .enum(['orchestrate', 'join_group', 'send_group_message'])
        .describe('orchestrate = configure/refresh the autonomous reply task; join_group = SimpleGroupJoin; send_group_message = one AES-encrypted group message (SimpleGroupChat).'),
      group_id: z.string().min(1).describe('On-chain group pin id (hex). Required for every action.'),
      target_metabot_name: z
        .string()
        .optional()
        .describe('Acting MetaBot name (case-insensitive). Omit to use the MetaBot that owns this session.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Chain override for join_group / send_group_message. Defaults to mvc.'),
      reply_on_mention: z
        .boolean()
        .optional()
        .describe('orchestrate: reply when @mentioned. Default true.'),
      random_reply_probability: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('orchestrate: random interjection probability 0-1. Default 0.1.'),
      cooldown_seconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('orchestrate: cooldown between replies, seconds. Default 15.'),
      context_message_count: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('orchestrate: recent messages kept as context, 1-500. Default 30.'),
      discussion_background: z.string().optional().describe('orchestrate: discussion background brief.'),
      participation_goal: z.string().optional().describe('orchestrate: what the MetaBot should achieve in the group.'),
      supervisor_globalmetaid: z.string().optional().describe('orchestrate: Boss identity globalMetaId.'),
      original_prompt: z.string().optional().describe('orchestrate: original user instruction, stored for traceability.'),
      referrer: z
        .string()
        .optional()
        .describe('join_group: inviter MetaID; omit or empty for public groups.'),
      k: z
        .string()
        .optional()
        .describe('join_group: encrypted key field for private groups (per SimpleGroupJoin protocol).'),
      content: z
        .string()
        .min(1)
        .optional()
        .describe('send_group_message: plaintext message; the host AES-encrypts it before broadcast.'),
      nick_name: z
        .string()
        .optional()
        .describe('send_group_message: in-group nickname; omit to use the MetaBot display name.'),
      reply_pin: z.string().optional().describe('send_group_message: pin id of the message being replied to.'),
      channel_id: z.string().optional().describe('send_group_message: channel id within the group.'),
      mention: z
        .array(z.string())
        .optional()
        .describe('send_group_message: MetaID list to @mention.'),
    },
    async (args: {
      action: GroupChatAction;
      group_id: string;
      target_metabot_name?: string;
      network?: GroupChatNetwork;
      reply_on_mention?: boolean;
      random_reply_probability?: number;
      cooldown_seconds?: number;
      context_message_count?: number;
      discussion_background?: string;
      participation_goal?: string;
      supervisor_globalmetaid?: string;
      original_prompt?: string;
      referrer?: string;
      k?: string;
      content?: string;
      nick_name?: string;
      reply_pin?: string;
      channel_id?: string;
      mention?: string[];
    }) => {
      const groupId = asString(args.group_id);
      if (!groupId) {
        return textResult('group_chat requires `group_id` (the on-chain group pin id). Do not invent one — ask the user.', true);
      }

      // Common MetaBot resolution: explicit target_metabot_name wins; otherwise
      // fall back to the MetaBot that owns this cowork session.
      const metabotName = asString(args.target_metabot_name);
      let metabotId: number | undefined;
      if (metabotName) {
        const resolved = control.resolveMetabotIdByName(metabotName);
        if (resolved == null) {
          return textResult(`Unknown MetaBot name: ${metabotName}`, true);
        }
        metabotId = resolved;
      } else {
        metabotId = resolveMetabotId(sessionId);
        if (metabotId == null) {
          return textResult(
            'group_chat could not determine which MetaBot owns this session. Pass target_metabot_name to pick the acting MetaBot.',
            true,
          );
        }
      }

      const network: GroupChatNetwork = args.network ?? 'mvc';

      if (args.action === 'orchestrate') {
        const displayName = control.getMetabotDisplayName(metabotId);
        const targetName = metabotName || asString(displayName);
        if (!targetName) {
          return textResult(
            'group_chat orchestrate needs `target_metabot_name` because the session MetaBot display name could not be resolved.',
            true,
          );
        }
        try {
          const params: AssignGroupChatTaskParams = {
            target_metabot_name: targetName,
            group_id: groupId,
            reply_on_mention: args.reply_on_mention ?? true,
            random_reply_probability: args.random_reply_probability ?? 0.1,
            cooldown_seconds: args.cooldown_seconds ?? 15,
            context_message_count: args.context_message_count ?? 30,
            discussion_background: asString(args.discussion_background) || undefined,
            participation_goal: asString(args.participation_goal) || undefined,
            supervisor_globalmetaid: asString(args.supervisor_globalmetaid) || undefined,
            original_prompt: asString(args.original_prompt) || undefined,
          };
          const result = control.assignTask(params);
          if (!result.success) {
            return textResult(result.error || 'assign group chat task failed', true);
          }
          return textResult(result.message);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return textResult(`orchestrate failed: ${msg}`, true);
        }
      }

      if (args.action === 'join_group') {
        try {
          const result = await control.joinGroup({
            metabotId,
            groupId,
            referrer: asString(args.referrer) || undefined,
            k: asString(args.k) || undefined,
            network,
          });
          return textResult(formatPinResult('Joined group on-chain (SimpleGroupJoin).', result));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return textResult(`Join group failed: ${msg}`, true);
        }
      }

      // send_group_message
      const content = asString(args.content);
      if (!content) {
        return textResult('group_chat send_group_message requires `content` (the plaintext message).', true);
      }
      const nickName = asString(args.nick_name) || control.getMetabotDisplayName(metabotId) || undefined;
      const mention = Array.isArray(args.mention)
        ? args.mention.map(asString).filter(Boolean)
        : [];
      try {
        const result = await control.sendGroupMessage({
          metabotId,
          groupId,
          content,
          nickName,
          replyPin: asString(args.reply_pin) || undefined,
          channelId: asString(args.channel_id) || undefined,
          mention: mention.length ? mention : undefined,
          network,
        });
        return textResult(formatPinResult('Group message sent (SimpleGroupChat).', result));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Send group message failed: ${msg}`, true);
      }
    }
  );

  return [groupChat];
}
