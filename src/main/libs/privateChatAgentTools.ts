import { z } from 'zod';

/**
 * Control surface the host (main.ts) provides for the send_private_chat tool.
 * Backed by the same create-pin pipeline the retired metabot-chat-privatechat
 * skill drove through RPC: resolve the peer's on-chain chatpubkey, derive the
 * ECDH shared secret, AES-encrypt the plaintext, and broadcast one
 * /protocols/simplemsg pin. All crypto and wallet handling stays host-side;
 * this tool handler is thin.
 */
export type PrivateChatControl = {
  send(input: {
    metabotId: number;
    toGlobalMetaId: string;
    content: string;
    replyPin?: string;
  }): Promise<{ txids: string[]; pinId: string }>;
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

/**
 * Inline MCP tool that sends one encrypted private MetaWeb message
 * (/protocols/simplemsg) to a globalMetaId. Registered for every cowork
 * surface when the host provides PrivateChatControl (see coworkRunner).
 * Replaces the external metabot-chat-privatechat skill; the on-chain
 * semantics (chatpubkey lookup, ECDH+AES encryption, pin tuple) are owned by
 * the host control and unchanged.
 */
export function buildPrivateChatAgentTools(deps: {
  tool: SdkToolFactory;
  control: PrivateChatControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const sendPrivateChat = tool(
    'send_private_chat',
    [
      'Send ONE encrypted private MetaWeb message (/protocols/simplemsg) to a globalMetaId. Pass the target and plaintext; the host resolves the peer chatpubkey, encrypts ECDH+AES, and broadcasts.',
      'Use when the user asks to DM or privately message someone on MetaWeb (idq1...), or a remote Bot/MetaBot asks for one private chat message.',
      'The message is on-chain and permanent — do NOT send content the user did not ask for.',
      'NOT for group chat (use group_chat) or public posts (use post_buzz).',
      'Returns pinId, txids, and a browser pin link.',
    ].join(' '),
    {
      to: z.string().min(1).describe('Target globalMetaId (idq1...)'),
      content: z
        .string()
        .min(1)
        .describe('Plaintext message; host encrypts ECDH+AES before broadcast'),
      reply_pin: z
        .string()
        .optional()
        .describe('Pin id of the message being replied to, when this is a reply.'),
    },
    async (args: { to: string; content: string; reply_pin?: string }) => {
      const to = asString(args.to);
      if (!to) {
        return textResult('send_private_chat requires `to` (the target globalMetaId, idq1...).', true);
      }
      const content = asString(args.content);
      if (!content) {
        return textResult('send_private_chat requires `content` (the plaintext message).', true);
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'send_private_chat could not determine which MetaBot owns this session, so there is no wallet/identity to send with. Ask the user which MetaBot should send the message.',
          true,
        );
      }

      try {
        const result = await control.send({
          metabotId,
          toGlobalMetaId: to,
          content,
          replyPin: asString(args.reply_pin) || undefined,
        });
        return textResult(
          [
            'Private message sent.',
            `- pinId: ${result.pinId}`,
            `- txids: ${(result.txids ?? []).join(', ')}`,
            `- pin link: https://openagentinternet.org/browser/pin/${result.pinId}`,
          ].join('\n'),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Private message send failed: ${msg}`, true);
      }
    }
  );

  return [sendPrivateChat];
}
