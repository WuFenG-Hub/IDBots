import { z } from 'zod';
import type { MetabotPrediction } from '../dreamStore';
import {
  PREDICTION_RESOLVE_DEFAULT_DAYS,
  PREDICTION_RESOLVE_MAX_DAYS,
  validatePredictionInput,
  type PredictionActionType,
  type PredictionSource,
} from './predictionLedger';
import { formatBotWorkspaceDate } from './botWorkspace';

/**
 * prediction_record — the RSI-Anything P0 write surface (prediction half of
 * the prediction–observation pair). Before a consequential on-chain action the
 * bot records ONE explicit, machine-checkable expectation; the nightly dream
 * reconciles it against the observed outcome (dreamService) and the
 * calibration digest sharpens future judgment. The expectation schema is a
 * closed set per action type and validated deterministically here — a
 * prediction that cannot be machine-checked is refused, never stored.
 */

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

export interface PredictionAgentControl {
  recordPrediction(input: {
    metabotId: number;
    sessionId?: string | null;
    source: PredictionSource;
    actionType: PredictionActionType;
    subjectRef?: string | null;
    predictionText: string;
    expectation: Record<string, unknown>;
    resolveDeadline: string;
  }): MetabotPrediction;
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function buildPredictionAgentTools(deps: {
  tool: SdkToolFactory;
  predictions: PredictionAgentControl;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | null | undefined;
  /** 'surf' inside unattended surf sessions; defaults to 'cowork' elsewhere. */
  defaultSource?: PredictionSource;
}): unknown[] {
  const { tool, predictions, sessionId, resolveMetabotId } = deps;

  const predictionRecord = tool(
    'prediction_record',
    [
      'Record ONE explicit, machine-checkable prediction BEFORE a consequential on-chain action: a buzz post or comment you are about to publish (expected reception), a MetaTask submission you are about to send (expected review pass), or a service delivery you are about to complete (expected order completion).',
      'Your nightly dream reconciles every pending prediction against the observed outcome and carries your calibration (hit rate, recent misses) into future reviews — honest predictions are how your judgment improves.',
      'The expectation is a CLOSED schema per action_type: for buzz_post / metaweb_comment use { metric: "likes" | "comments" | "interactions", op: ">=", value: <integer >= 1> }; for metatask_submission use { metric: "review_pass", value: true }; for service_delivery use { metric: "order_completed", value: true }. Anything else is refused.',
      'subject_ref: the pinId for a post/comment when you already know it (otherwise omit — the dream reconciler attributes your next matching own write), "rootPinId:nodeId" for a MetaTask submission, the order id for a service delivery.',
      'resolve_deadline (YYYY-MM-DD): by when the outcome must be observable — defaults to today + 3 days, never beyond today + 14 days.',
      'Record at most one prediction per action, and only when you actually mean the action — the ledger is evidence, not decoration.',
    ].join(' '),
    {
      action_type: z.enum(['buzz_post', 'metaweb_comment', 'metatask_submission', 'service_delivery']),
      prediction_text: z.string().min(1).describe('The concrete, checkable expectation in one or two sentences.'),
      expectation: z.record(z.string(), z.unknown()).describe('Closed schema per action_type (see description).'),
      subject_ref: z.string().optional().describe('pinId / "rootPinId:nodeId" / order id; omit when only known after the action.'),
      resolve_deadline: z.string().optional().describe('YYYY-MM-DD; default today+3d, max today+14d.'),
      source: z.enum(['cowork', 'surf', 'metatask', 'service']).optional().describe('Usually omitted — the host derives it from the session kind.'),
    },
    async (args: {
      action_type?: PredictionActionType;
      prediction_text?: string;
      expectation?: Record<string, unknown>;
      subject_ref?: string;
      resolve_deadline?: string;
      source?: PredictionSource;
    }) => {
      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'prediction_record could not resolve which MetaBot owns this session — predictions are per-bot; retry from a session attributed to a MetaBot.',
          true,
        );
      }
      const validated = validatePredictionInput({
        actionType: args.action_type,
        source: args.source,
        predictionText: args.prediction_text,
        subjectRef: args.subject_ref,
        expectation: args.expectation,
        resolveDeadline: args.resolve_deadline,
        defaultSource: deps.defaultSource ?? 'cowork',
        todayKey: formatBotWorkspaceDate(new Date()),
      });
      if (!validated.ok) {
        return textResult(`Refused: ${(validated as { ok: false; error: string }).error}`, true);
      }
      try {
        const prediction = predictions.recordPrediction({
          metabotId,
          sessionId,
          source: validated.source,
          actionType: validated.actionType,
          subjectRef: validated.subjectRef,
          predictionText: validated.predictionText,
          expectation: validated.expectation,
          resolveDeadline: validated.resolveDeadline,
        });
        return textResult([
          `Prediction recorded (id ${prediction.id}): ${validated.actionType}, resolve by ${validated.resolveDeadline}.`,
          `Expectation: ${JSON.stringify(validated.expectation)}.`,
          'The nightly dream will reconcile it against the observed outcome.',
        ].join('\n'));
      } catch (error) {
        return textResult(`Failed to record the prediction: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  return [predictionRecord];
}

/** Re-exported constants so hosts/tests share the single source of truth. */
export { PREDICTION_RESOLVE_DEFAULT_DAYS, PREDICTION_RESOLVE_MAX_DAYS };
