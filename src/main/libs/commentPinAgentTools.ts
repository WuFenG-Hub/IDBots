import { z } from 'zod';
import type { ChainWriteCreatePin } from './postBuzzAgentTools';
import { markdownSelfLink } from './metawebUri';
import { chainWriteFailureDetail, feeAssistReceiptLines } from './chainFeeAssistReceipt';

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

/**
 * Inline MCP tool for MetaWeb comments: comment_pin writes a PayComment pin
 * (/protocols/paycomment, payload {commentTo, content, contentType}) — the
 * thread-reply primitive for any pin: a buzz, a simplenote article, a
 * question, an answer. Deliberately narrower than omni_cast (which can cast
 * ANY protocol tuple): autonomous sessions such as MetaWeb surf get this tool
 * instead, so their write surface stays comment-shaped.
 */
export function buildCommentPinAgentTools(deps: {
  tool: SdkToolFactory;
  createPin: ChainWriteCreatePin;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, createPin, sessionId, resolveMetabotId } = deps;

  function asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  function textResult(text: string, isError = false) {
    return {
      content: [{ type: 'text' as const, text }],
      ...(isError ? { isError: true } : {}),
    };
  }

  const commentPin = tool(
    'comment_pin',
    [
      'Comment on ANY MetaWeb pin via the paycomment protocol, as the MetaBot that owns this session.',
      '`pin_id` is the target pin — a buzz, a simplenote article, a simplequestion question, a simpleanswer answer, any pin. Your comment joins its public thread.',
      'Comment only when you genuinely add something: an experience, a correction, a real answer to a sub-question. Empty praise and generic agreement are chain spam.',
      'Every call is an on-chain write that costs transaction fees: comment once per target and move on.',
      'Writes permanently on-chain. Returns pinId, txids, cost in sats, and a ready-to-quote pin:// view link.',
    ].join(' '),
    {
      pin_id: z.string().min(1).describe('pinId of the target pin you are commenting on. Required.'),
      content: z.string().min(1).describe('Comment body. Plain text or markdown; must not be empty.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Write network. Default: mvc. Use the network the target pin lives on.'),
    },
    async (args: { pin_id: string; content: string; network?: 'mvc' | 'doge' | 'btc' }) => {
      const pinId = asString(args.pin_id);
      if (!pinId) {
        return textResult('comment_pin requires `pin_id` (non-empty pinId of the target pin).', true);
      }
      const content = asString(args.content);
      if (!content) {
        return textResult('comment_pin requires non-empty `content`.', true);
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'comment_pin could not determine which MetaBot owns this session, so there is no wallet/identity to publish with. Ask the user which MetaBot should publish the comment.',
          true,
        );
      }

      const network = args.network ?? 'mvc';

      try {
        const result = await createPin(
          metabotId,
          {
            operation: 'create',
            path: '/protocols/paycomment',
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify({ commentTo: pinId, content, contentType: 'text/markdown' }),
          },
          { network, origin: 'tool:comment_pin' },
        );
        return textResult(
          formatCommentPinResult({
            commentPinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            targetPinId: pinId,
            feeAssist: result.feeAssist,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Comment publish failed: ${msg}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  return [commentPin];
}

/** Human-readable success sheet for comment_pin. Exposed for tests. */
export function formatCommentPinResult(input: {
  commentPinId: string;
  txids: string[];
  totalCost: number;
  targetPinId: string;
  feeAssist?: unknown;
}): string {
  const lines: string[] = [`Commented on pin ${input.targetPinId} — comment published on-chain.`];
  if (input.commentPinId) lines.push(`- comment pinId: ${input.commentPinId}`);
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- target pinId: ${input.targetPinId}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  if (input.commentPinId) {
    lines.push(`- view link: ${markdownSelfLink(`pin://${input.commentPinId}`)}`);
  }
  return lines.join('\n');
}
