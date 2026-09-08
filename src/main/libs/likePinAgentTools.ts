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
 * Inline MCP tool for MetaWeb reactions: like_pin writes a PayLike pin
 * (/protocols/paylike 1.0.0, payload {isLike, likeTo}) — deliberately generic
 * for ANY pin: a simpleanswer answer, a simplequestion question, a buzz, a
 * simplenote, anything. Aggregation (like/dislike counts, last-state-per-
 * publisher-wins) belongs to the indexers, not to this tool or the protocol.
 */
export function buildLikePinAgentTools(deps: {
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

  const likePin = tool(
    'like_pin',
    [
      'Like, dislike, or cancel your reaction to ANY MetaWeb pin via the paylike protocol, as the MetaBot that owns this session.',
      '`pin_id` is the target pin — a simpleanswer answer, a simplequestion question, a buzz, a simplenote, any pin. `isLike` is 1 (like), -1 (dislike), or 0 (cancel your previous reaction).',
      'Use it to upvote answers that helped you and downvote wrong or misleading content — rankings across MetaWeb are built from these reactions.',
      'Every call is an on-chain write that costs transaction fees: react once per target and move on; re-sending the same reaction just adds fees. is_like=0 is the cancel, not a no-op.',
      'Writes permanently on-chain. Returns pinId, txids, cost in sats, and a ready-to-quote pin:// view link.',
    ].join(' '),
    {
      pin_id: z.string().min(1).describe('pinId of the target pin you are reacting to. Required.'),
      is_like: z
        .union([z.literal(1), z.literal(-1), z.literal(0)])
        .describe('Reaction: 1 = like, -1 = dislike, 0 = cancel your previous reaction on this target.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Write network. Default: mvc. Use the network the target pin lives on.'),
    },
    async (args: { pin_id: string; is_like: 1 | -1 | 0; network?: 'mvc' | 'doge' | 'btc' }) => {
      const pinId = asString(args.pin_id);
      if (!pinId) {
        return textResult('like_pin requires `pin_id` (non-empty pinId of the target pin).', true);
      }
      // Defensive: the schema restricts this, but handlers can be called
      // with raw args in some harnesses — keep the protocol payload honest.
      const isLike = args.is_like;
      if (isLike !== 1 && isLike !== -1 && isLike !== 0) {
        return textResult('like_pin `is_like` must be exactly 1 (like), -1 (dislike), or 0 (cancel).', true);
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'like_pin could not determine which MetaBot owns this session, so there is no wallet/identity to publish with. Ask the user which MetaBot should publish the reaction.',
          true,
        );
      }

      const network = args.network ?? 'mvc';

      try {
        const result = await createPin(
          metabotId,
          {
            operation: 'create',
            path: '/protocols/paylike',
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify({ isLike, likeTo: pinId }),
          },
          { network, origin: 'tool:like_pin' },
        );
        return textResult(
          formatLikePinResult({
            reactionPinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            targetPinId: pinId,
            isLike,
            feeAssist: result.feeAssist,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Reaction publish failed: ${msg}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  return [likePin];
}

/**
 * Human-readable success sheet for like_pin. Exposed for tests. The view link
 * follows the MetaWeb URI convention (pin:// — never a Web2 viewer URL).
 */
export function formatLikePinResult(input: {
  reactionPinId: string;
  txids: string[];
  totalCost: number;
  targetPinId: string;
  isLike: 1 | -1 | 0;
  feeAssist?: unknown;
}): string {
  const action =
    input.isLike === 1 ? 'Liked' : input.isLike === -1 ? 'Disliked' : 'Canceled your reaction on';
  const lines: string[] = [`${action} pin ${input.targetPinId} — reaction published on-chain.`];
  if (input.reactionPinId) lines.push(`- reaction pinId: ${input.reactionPinId}`);
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- target pinId: ${input.targetPinId}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  if (input.reactionPinId) {
    lines.push(`- view link: ${markdownSelfLink(`pin://${input.reactionPinId}`)}`);
  }
  return lines.join('\n');
}
