import { z } from 'zod';
import type {
  TrackedClosureAckInput,
  TrackedClosureAckResult,
  TrackedPendingClosureList,
} from '../services/trackedTaskBoard';

/**
 * Twin-side closure-execution tools (long-task board v1.2, task #86 §6).
 *
 * The closing conclusion on a card is an INSTRUCTION, not a note: the Twin's
 * routine sweep reads the queue with `list_pending_card_closures` and reports
 * what it did with `acknowledge_card_closure`. Both tools are thin wrappers over
 * `TrackedTaskBoardService.listPendingClosures` / `.acknowledgeClosure` — the
 * queue derivation lives in ONE place, so a second implementation here would be
 * the defect this design exists to prevent.
 *
 * Safety is structural, not advisory: the service refuses a destructive
 * conclusion that carries no `confirmationRef` (`CONFIRMATION_REQUIRED`, zero
 * writes). The tool never overrides that — it passes the refusal through
 * untouched, because "the conclusion said to delete it" is not a confirmation.
 *
 * Registered for EVERY cowork surface (the routine sweep is an ordinary cowork
 * session, so a surf-only marker would hide the tool exactly where it is needed).
 */

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
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

/**
 * Control surface the host (main.ts) provides. Both methods delegate straight to
 * the board service; the host injects the live service instance so the agent
 * layer holds no database handle of its own.
 */
export interface TrackedTaskClosureAgentControl {
  listPendingClosures(input: { limit?: number }): TrackedPendingClosureList;
  acknowledgeClosure(input: TrackedClosureAckInput): TrackedClosureAckResult;
}

export function buildTrackedTaskClosureAgentTools(deps: {
  tool: SdkToolFactory;
  control: TrackedTaskClosureAgentControl;
}): unknown[] {
  const { tool, control } = deps;

  const listPendingCardClosures = tool(
    'list_pending_card_closures',
    'List the closing conclusions that still have to be executed on the long-task board. Each item is an INSTRUCTION written onto a card: execute it verbatim (file a new card or dispatch work when needed), then call acknowledge_card_closure with how you handled it and the evidence. Read-only — calling it never changes a card.',
    {
      limit: z.number().optional().describe('Max items to return (default 50, hard cap 200). `count` is always the full queue size.'),
    },
    async (args: { limit?: number }) => {
      try {
        const list = control.listPendingClosures({ limit: args.limit });
        return textResult(JSON.stringify(list, null, 2));
      } catch (error) {
        return textResult(
          `Failed to read the pending-closure queue: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    },
  );

  const acknowledgeCardClosure = tool(
    'acknowledge_card_closure',
    'Mark one card conclusion as executed and file the receipt on the SAME card. Required for every item returned by list_pending_card_closures — a conclusion processed without a receipt leaves the card in a state nobody can audit. The receipt must state how it was handled plus its evidence, or use the explicit no-op marker when nothing had to be done. If the conclusion asks for a destructive action (delete / transfer / publish / any irreversible change), it must first go through the existing safety confirmation and the resulting reference must be passed as confirmationRef; without it this call is refused and no state is written.',
    {
      cardId: z.string().min(1).describe('The card id from list_pending_card_closures (its `cardId` field)'),
      receipt: z.string().min(1).describe('How it was handled + the evidence, or the explicit no-op marker when no action was required. Max 1000 chars.'),
      evidenceUri: z.string().optional().describe('Evidence for the handling: a pin:// URI, a commit sha, or another verifiable identifier.'),
      confirmationRef: z.string().optional().describe('Only for destructive conclusions: the identifier of the EXISTING safety-gate approval (owner confirmation pin / approval record id). Never invent one.'),
    },
    async (args: {
      cardId?: string;
      receipt?: string;
      evidenceUri?: string;
      confirmationRef?: string;
    }) => {
      try {
        const cardId = String(args.cardId ?? '').trim();
        if (!cardId) return textResult('`cardId` is required.', true);
        // `processedBy` is fixed to 'twin': this tool IS the Twin's channel, and
        // letting the model claim the owner did it would corrupt the audit.
        const result = control.acknowledgeClosure({
          taskId: cardId,
          processedBy: 'twin',
          receipt: String(args.receipt ?? ''),
          evidenceUri: args.evidenceUri ?? null,
          confirmationRef: args.confirmationRef ?? null,
        });
        if (!result.ok) {
          return textResult(
            `Refused (${result.code ?? 'ERROR'}): ${result.error ?? 'no detail'}`,
            true,
          );
        }
        return textResult(JSON.stringify(result, null, 2));
      } catch (error) {
        return textResult(
          `Failed to acknowledge the closure: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    },
  );

  return [listPendingCardClosures, acknowledgeCardClosure];
}
