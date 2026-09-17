import { z } from 'zod';
import type { ChainWriteCreatePin } from './postBuzzAgentTools';
import { chainWriteFailureDetail, feeAssistReceiptLines } from './chainFeeAssistReceipt';
import {
  SIMPLELOG_CONTENT_MAX_BYTES,
  SIMPLELOG_KINDS,
  SIMPLELOG_PATH,
  SIMPLELOG_ROLES,
  SIMPLELOG_SUMMARY_MAX,
  buildSimpleLogPayload,
  type SimpleLogBuildFailure,
  type SimpleLogBuildOk,
} from './simpleLogProtocol';

/**
 * Explicit failure guard: this project compiles the main process with
 * strictNullChecks OFF, where a truthiness test on the discriminant does not
 * narrow a union — the guard keeps the error list reachable without a cast.
 */
function isBuildFailure(
  result: SimpleLogBuildOk | SimpleLogBuildFailure
): result is SimpleLogBuildFailure {
  return result.ok === false;
}

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

/**
 * Result sheet for one published record — pinId first, because every consumer
 * (ledger, timeline app, the next record's refs) keys off it.
 */
export function formatSimpleLogResult(input: {
  pinId: string;
  txids: string[];
  totalCost: number;
  kind: string;
  summary: string;
  anchor: string;
  warnings: string[];
  feeAssist?: unknown;
}): string {
  const lines: string[] = ['SimpleLog record cast on-chain.'];
  const txid = input.txids[0];
  if (txid) lines.push(`- txid: ${txid}`);
  if (input.pinId) lines.push(`- pinId: ${input.pinId}`);
  lines.push(`- kind: ${input.kind}`);
  lines.push(`- task anchor: ${input.anchor}`);
  lines.push(`- summary: ${input.summary}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  lines.push(...feeAssistReceiptLines(input.feeAssist));
  for (const warning of input.warnings) lines.push(`- note: ${warning}`);
  if (input.pinId) {
    lines.push(`- view link: [pin://${input.pinId}](pin://${input.pinId})`);
    lines.push(
      `- read back: omni_read pins_by_path with path "${SIMPLELOG_PATH}" (filter this pinId) — the ledger reads the same record's deliverables array directly.`,
    );
  }
  return lines.join('\n');
}

/**
 * Inline MCP tool `post_simplelog` — write ONE process record of the
 * SimpleLog protocol (/protocols/simplelog, v1).
 *
 * Same registration posture as post_buzz / post_simplenote: every cowork
 * surface with a host-provided createPin dep (see coworkRunner). The field
 * contract comes from the protocol pin, enforced by libs/simpleLogProtocol so
 * the writer, the ledger extractor and the pilot CLI share one validation:
 * v/kind/summary required, taskid (bare pinid) or taskkey at least one,
 * deliverables/refs complete chain URIs only, content ≤ the 4 KiB budget.
 * An invalid record is REJECTED before it reaches the wallet — never a
 * half-formed record on the chain.
 */
export function buildPostSimpleLogAgentTools(deps: {
  tool: SdkToolFactory;
  createPin: ChainWriteCreatePin;
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
}): unknown[] {
  const { tool, createPin, sessionId, resolveMetabotId } = deps;

  const postSimpleLog = tool(
    'post_simplelog',
    [
      'Write ONE SimpleLog record on-chain (/protocols/simplelog) — the PROCESS record layer of multi-agent collaboration: who, on which task, did what, in which state, with which evidence.',
      'Boundary: 过程进 log，知识进 note. Use post_simplelog for task flow records (handoff/status/review/close), and post_simplenote for anything meant to be read by the whole internet (tutorials, announcements, distilled post-mortems).',
      `Required: summary (one line, ≤${SIMPLELOG_SUMMARY_MAX} chars) and kind (${SIMPLELOG_KINDS.join('|')}); plus taskid (the task anchor pinid, BARE — no pin:// scheme) or taskkey (e.g. local:184) for anchorless tasks.`,
      `Optional: step, status (${'executing|review|done|blocked|cancelled'}), role (${SIMPLELOG_ROLES.join('|')}), toid (handoff target globalMetaId), deliverables (array of COMPLETE chain URIs — pin:// metafile:// metaapp:// — no truncation, no Web2), refs (evidence/parent/corrected-entry URIs), content (markdown detail, ≤${SIMPLELOG_CONTENT_MAX_BYTES} bytes — larger material goes to a metafile and into refs), extra (free object for v1-undefined semantics).`,
      'Records are append-only and public: never edit a sent record — correct it with a NEW entry whose summary starts with 更正: and whose refs point at the corrected entry.',
      'Writes permanently on-chain and costs transaction fees. Returns pinId, txid, cost in sats, and a ready-to-quote pin:// view link.',
    ].join(' '),
    {
      kind: z
        .enum(SIMPLELOG_KINDS as unknown as [string, ...string[]])
        .describe('Record kind: handoff | status | review | close | note.'),
      summary: z
        .string()
        .min(1)
        .describe(`One line stating what happened, ≤${SIMPLELOG_SUMMARY_MAX} characters ("更正：" prefix marks a correction).`),
      taskid: z
        .string()
        .optional()
        .describe('Task anchor pinid (64 lowercase hex + i0), BARE — do not wrap it in pin://.'),
      taskkey: z
        .string()
        .optional()
        .describe('Free task key when there is no on-chain anchor (e.g. local:184). taskid or taskkey is required.'),
      step: z.string().optional().describe('Stage / which baton (e.g. "第一棒").'),
      status: z.string().optional().describe('Task state at record time; suggested: executing|review|done|blocked|cancelled.'),
      role: z
        .enum(SIMPLELOG_ROLES as unknown as [string, ...string[]])
        .optional()
        .describe('Writer role: chair | worker | reviewer | observer.'),
      toid: z.string().optional().describe('Handoff target globalMetaId (idq1…) for kind=handoff.'),
      deliverables: z
        .array(z.string())
        .optional()
        .describe('Deliverable chain URIs, each complete and independent (pin:// / metafile:// / metaapp://).'),
      refs: z
        .array(z.string())
        .optional()
        .describe('Related chain URIs: evidence, parent records, the entry a correction supersedes.'),
      content: z
        .string()
        .optional()
        .describe(`Markdown detail (≤${SIMPLELOG_CONTENT_MAX_BYTES} bytes); larger material publishes as a metafile and rides refs.`),
      extra: z.record(z.string(), z.unknown()).optional().describe('Free extension object; v1-undefined semantics live here.'),
      network: z.enum(['mvc', 'doge', 'btc']).optional().describe('Write network. Default: mvc.'),
    },
    async (args: {
      kind: string;
      summary: string;
      taskid?: string;
      taskkey?: string;
      step?: string;
      status?: string;
      role?: string;
      toid?: string;
      deliverables?: string[];
      refs?: string[];
      content?: string;
      extra?: Record<string, unknown>;
      network?: 'mvc' | 'doge' | 'btc';
    }) => {
      const built = buildSimpleLogPayload(args);
      if (isBuildFailure(built)) {
        return textResult(
          `post_simplelog rejected the record (nothing was published):\n${built.errors.map((error) => `- ${error}`).join('\n')}`,
          true,
        );
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'post_simplelog could not determine which MetaBot owns this session, so there is no wallet/identity to record with. Ask the user which MetaBot should write the record.',
          true,
        );
      }

      const network = args.network ?? 'mvc';
      try {
        const result = await createPin(
          metabotId,
          {
            operation: 'create',
            path: SIMPLELOG_PATH,
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify(built.payload),
          },
          { network, origin: 'tool:post_simplelog' },
        );
        return textResult(
          formatSimpleLogResult({
            pinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            kind: String(built.payload.kind),
            summary: String(built.payload.summary),
            anchor: String(built.payload.taskid ?? built.payload.taskkey ?? ''),
            warnings: built.warnings,
            feeAssist: result.feeAssist,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`SimpleLog record failed: ${msg}${chainWriteFailureDetail(error)}`, true);
      }
    }
  );

  return [postSimpleLog];
}
