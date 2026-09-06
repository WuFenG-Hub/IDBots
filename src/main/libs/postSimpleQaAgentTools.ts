import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { ChainWriteCreatePin } from './postBuzzAgentTools';
import type { MetaFileUploadControl } from './metaFileUploadAgentTools';
import { markdownSelfLink } from './metawebUri';
import {
  listSimpleQaAnswers,
  recordSimpleQaAnswer,
  type SimpleQaAnswerLedgerEntry,
} from './simpleQaAnswerLedger';

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

/**
 * Inline MCP tools for the on-chain Q&A protocols (docs/metaid_protocols/
 * 08-qanda.md): post_simplequestion (/protocols/simplequestion 1.0.0) and
 * post_simpleanswer (/protocols/simpleanswer 1.0.0). Same registration
 * posture as post_buzz / post_simplenote: every cowork surface, host-provided
 * createPin/upload deps (see coworkRunner).
 *
 * Payload design follows declarative minimalism: only what a reader cannot
 * derive is required, no self-declared timestamps (block time and indexer
 * witness time are authoritative), and empty optional fields are omitted
 * entirely instead of written as empty strings/arrays.
 */
export function buildPostSimpleQaAgentTools(deps: {
  tool: SdkToolFactory;
  createPin: ChainWriteCreatePin;
  /**
   * Upload function; the host passes the GATED wrapper from chainUploadGate
   * (wrapUploadWithGate) so files outside the session workspace require
   * owner approval before they are published.
   */
  uploadFile: MetaFileUploadControl['upload'];
  sessionId: string;
  resolveMetabotId: (sessionId: string) => number | undefined;
  /** Host/test overrides for the local answer ledger (defaults: kv-backed module ledger). */
  listPriorAnswers?: (metabotId: number, questionPinId: string) => SimpleQaAnswerLedgerEntry[];
  recordAnswer?: (metabotId: number, questionPinId: string, entry: SimpleQaAnswerLedgerEntry) => void;
}): unknown[] {
  const {
    tool,
    createPin,
    uploadFile,
    sessionId,
    resolveMetabotId,
    listPriorAnswers = listSimpleQaAnswers,
    recordAnswer = recordSimpleQaAnswer,
  } = deps;

  function asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  function textResult(text: string, isError = false) {
    return {
      content: [{ type: 'text' as const, text }],
      ...(isError ? { isError: true } : {}),
    };
  }

  function isMetafileUri(value: string): boolean {
    return value.trim().toLowerCase().startsWith('metafile://');
  }

  /** Resolve one attachment reference: local absolute paths are uploaded on-chain; metafile:// URIs pass through. */
  async function resolveFileReference(
    input: { metabotId: number; network: 'mvc' | 'doge' | 'btc' },
    raw: string,
    toolName: string,
    field: string,
  ): Promise<{ uri?: string; error?: string }> {
    const item = asString(raw);
    if (!item) return {};
    if (isMetafileUri(item)) return { uri: item };
    if (!path.isAbsolute(item)) {
      return {
        error: `${toolName} requires ABSOLUTE local file paths for ${field}. Received a relative path: "${item}". Resolve it to an absolute path first, or pass an existing metafile:// URI.`,
      };
    }
    if (!fs.existsSync(item)) {
      return { error: `${toolName} ${field} file not found: ${item}` };
    }
    try {
      // File upload does not support DOGE; keep DOGE only for the pin write.
      const uploadNetwork = input.network === 'doge' ? 'mvc' : input.network;
      const result = await uploadFile({ metabotId: input.metabotId, filePath: item, network: uploadNetwork });
      const metafileUri = asString(result?.metafileUri);
      if (!metafileUri) {
        return { error: `${toolName} failed to get a metafile URI for uploaded ${field}: ${item}` };
      }
      return { uri: metafileUri };
    } catch (error) {
      return {
        error: `${toolName} failed to upload ${field} "${item}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const postSimpleQuestion = tool(
    'post_simplequestion',
    [
      'Publish a question on-chain via the simplequestion protocol, as the MetaBot that owns this session.',
      'Use when you hit a knowledge gap you cannot resolve yourself — a stuck task, repeated failures, unclear how to proceed — and an answer from the MetaWeb community would help. Write a clear, specific title; `content` for context and `tags` for discoverability are optional (a title alone is a complete question).',
      'Attachments (local absolute paths) are uploaded on-chain automatically; error screenshots often make questions answerable.',
      'Returns the question pinId — others reference exactly this pinId when answering (`answer_to` in post_simpleanswer). Keep it to check answers later.',
      'Do NOT use for notes/articles (post_simplenote), short buzz posts (post_buzz), or plain file uploads (upload_file).',
      'Writes permanently on-chain and costs transaction fees; attachments on a DOGE write still upload on MVC (file upload does not support DOGE). Local files outside the session workspace require the owner\'s explicit confirmation before upload. Returns pinId, txids, cost in sats, and a ready-to-quote pin:// view link.',
    ].join(' '),
    {
      title: z.string().min(1).describe('Question title, plain text. Required — the only required field.'),
      content: z.string().optional().describe('Optional question description/supplement (markdown).'),
      tags: z.array(z.string()).optional().describe('Topic tags for discovery.'),
      content_type: z
        .string()
        .optional()
        .describe('MIME type of the content field. Default: text/markdown. Ignored when content is empty.'),
      attachments: z
        .array(z.string())
        .optional()
        .describe('Files/images (error screenshots etc.): local absolute file paths and/or metafile:// URIs.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Write network. Default: mvc. DOGE is allowed for the pin write only; files always upload on MVC.'),
    },
    async (args: {
      title: string;
      content?: string;
      tags?: string[];
      content_type?: string;
      attachments?: string[];
      network?: 'mvc' | 'doge' | 'btc';
    }) => {
      const title = asString(args.title);
      if (!title) {
        return textResult(
          'post_simplequestion requires `title` (non-empty). The description `content` is optional — a title alone is a complete question.',
          true,
        );
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'post_simplequestion could not determine which MetaBot owns this session, so there is no wallet/identity to publish with. Ask the user which MetaBot should publish the question.',
          true,
        );
      }

      const network = args.network ?? 'mvc';
      const uploadScope = { metabotId, network };

      try {
        const attachments: string[] = [];
        for (const raw of args.attachments ?? []) {
          if (!asString(raw)) continue;
          const resolved = await resolveFileReference(uploadScope, raw, 'post_simplequestion', 'attachment');
          if (resolved.error) return textResult(resolved.error, true);
          if (resolved.uri) attachments.push(resolved.uri);
        }

        // Declarative minimalism: empty optional fields are omitted entirely.
        const payloadObject: Record<string, unknown> = { title };
        const content = asString(args.content);
        if (content) {
          payloadObject.content = content;
          payloadObject.contentType = asString(args.content_type) || 'text/markdown';
        }
        const tags = (args.tags ?? []).map((tag) => asString(tag)).filter(Boolean);
        if (tags.length) payloadObject.tags = tags;
        if (attachments.length) payloadObject.attachments = attachments;

        const result = await createPin(
          metabotId,
          {
            operation: 'create',
            path: '/protocols/simplequestion',
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify(payloadObject),
          },
          { network, origin: 'tool:post_simplequestion' },
        );
        return textResult(
          formatSimpleQuestionResult({
            pinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            title,
            attachments,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Question publish failed: ${msg}`, true);
      }
    }
  );

  const postSimpleAnswer = tool(
    'post_simpleanswer',
    [
      'Answer a question published on-chain via the simplequestion protocol, as the MetaBot that owns this session.',
      '`answer_to` must be the pinId of a simplequestion pin (the question). Answer only when you have a clear, useful answer — quality is ranked by community likes (PayLike), not by protocol.',
      'If you have already answered this question from this host, the tool first returns your previous answers WITHOUT publishing; whether a repeat answer adds value is your decision. Call again with allow_repeat=true if the new answer substantially improves the old one; small additions are usually better as a PayComment on the existing answer.',
      'Do NOT use for buzz (post_buzz), notes/articles (post_simplenote), or plain file uploads (upload_file).',
      'Writes permanently on-chain and costs transaction fees; attachments on a DOGE write still upload on MVC (file upload does not support DOGE). Local files outside the session workspace require the owner\'s explicit confirmation before upload. Returns pinId, txids, cost in sats, and a ready-to-quote pin:// view link.',
    ].join(' '),
    {
      answer_to: z.string().min(1).describe('pinId of the simplequestion pin being answered. Required.'),
      content: z.string().min(1).describe('Answer body. Markdown by default (see content_type).'),
      tags: z.array(z.string()).optional().describe('Topic tags.'),
      content_type: z
        .string()
        .optional()
        .describe('MIME type of the content field. Default: text/markdown.'),
      attachments: z
        .array(z.string())
        .optional()
        .describe('Files/images: local absolute file paths and/or metafile:// URIs.'),
      allow_repeat: z
        .boolean()
        .optional()
        .describe('Set true to publish even when this host already recorded a previous answer from you to this question.'),
      network: z
        .enum(['mvc', 'doge', 'btc'])
        .optional()
        .describe('Write network. Default: mvc. DOGE is allowed for the pin write only; files always upload on MVC.'),
    },
    async (args: {
      answer_to: string;
      content: string;
      tags?: string[];
      content_type?: string;
      attachments?: string[];
      allow_repeat?: boolean;
      network?: 'mvc' | 'doge' | 'btc';
    }) => {
      const answerTo = asString(args.answer_to);
      const content = asString(args.content);
      if (!answerTo || !content) {
        return textResult(
          'post_simpleanswer requires both `answer_to` (pinId of the question pin) and `content` (non-empty).',
          true,
        );
      }

      const metabotId = resolveMetabotId(sessionId);
      if (metabotId == null) {
        return textResult(
          'post_simpleanswer could not determine which MetaBot owns this session, so there is no wallet/identity to publish with. Ask the user which MetaBot should publish the answer.',
          true,
        );
      }

      const network = args.network ?? 'mvc';
      const uploadScope = { metabotId, network };

      try {
        // Fact-first repeat notice (host bookkeeping only, never a protocol
        // constraint): surface prior local answers BEFORE spending sats; the
        // bot decides whether to proceed with allow_repeat=true.
        const priorAnswers = listPriorAnswers(metabotId, answerTo);
        if (priorAnswers.length && args.allow_repeat !== true) {
          return textResult(formatAlreadyAnsweredNotice(answerTo, priorAnswers));
        }

        const attachments: string[] = [];
        for (const raw of args.attachments ?? []) {
          if (!asString(raw)) continue;
          const resolved = await resolveFileReference(uploadScope, raw, 'post_simpleanswer', 'attachment');
          if (resolved.error) return textResult(resolved.error, true);
          if (resolved.uri) attachments.push(resolved.uri);
        }

        const payloadObject: Record<string, unknown> = { answerTo, content };
        const contentType = asString(args.content_type);
        if (contentType) payloadObject.contentType = contentType;
        const tags = (args.tags ?? []).map((tag) => asString(tag)).filter(Boolean);
        if (tags.length) payloadObject.tags = tags;
        if (attachments.length) payloadObject.attachments = attachments;

        const result = await createPin(
          metabotId,
          {
            operation: 'create',
            path: '/protocols/simpleanswer',
            encryption: '0',
            version: '1.0.0',
            contentType: 'application/json',
            payload: JSON.stringify(payloadObject),
          },
          { network, origin: 'tool:post_simpleanswer' },
        );

        recordAnswer(metabotId, answerTo, {
          answerPinId: result.pinId,
          content,
          postedAt: Date.now(),
          network,
        });

        return textResult(
          formatSimpleAnswerResult({
            pinId: result.pinId,
            txids: Array.isArray(result.txids) ? result.txids : [],
            totalCost: result.totalCost,
            questionPinId: answerTo,
            attachments,
            priorAnswerCount: priorAnswers.length,
          }),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(`Answer publish failed: ${msg}`, true);
      }
    }
  );

  return [postSimpleQuestion, postSimpleAnswer];
}

/**
 * Human-readable success sheet for post_simplequestion. The view link follows
 * the MetaWeb URI convention (pin:// — never a Web2 viewer URL). Exposed for
 * tests.
 */
export function formatSimpleQuestionResult(input: {
  pinId: string;
  txids: string[];
  totalCost: number;
  title: string;
  attachments: string[];
}): string {
  const lines: string[] = ['Question published on-chain.'];
  if (input.pinId) {
    lines.push(`- question pinId: ${input.pinId}`);
    lines.push('- others answer this question by referencing this pinId as `answer_to` in post_simpleanswer');
  }
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- title: ${input.title}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  for (const uri of input.attachments) lines.push(`- attachment: ${uri}`);
  if (input.pinId) {
    lines.push(`- view link: ${markdownSelfLink(`pin://${input.pinId}`)}`);
  }
  return lines.join('\n');
}

/**
 * Human-readable success sheet for post_simpleanswer. Exposed for tests.
 */
export function formatSimpleAnswerResult(input: {
  pinId: string;
  txids: string[];
  totalCost: number;
  questionPinId: string;
  attachments: string[];
  priorAnswerCount: number;
}): string {
  const lines: string[] = ['Answer published on-chain.'];
  if (input.pinId) lines.push(`- answer pinId: ${input.pinId}`);
  if (input.txids.length) lines.push(`- txids: ${input.txids.join(', ')}`);
  lines.push(`- question pinId: ${input.questionPinId}`);
  lines.push(`- cost: ${input.totalCost} sats`);
  for (const uri of input.attachments) lines.push(`- attachment: ${uri}`);
  if (input.priorAnswerCount > 0) {
    lines.push(`- note: this is answer #${input.priorAnswerCount + 1} you published to this question from this host`);
  }
  if (input.pinId) {
    lines.push(`- view link: ${markdownSelfLink(`pin://${input.pinId}`)}`);
  }
  return lines.join('\n');
}

/**
 * Informational (non-error) notice shown when prior local answers exist.
 * States facts and options; the publish/not-publish decision stays with the
 * bot. Exposed for tests.
 */
export function formatAlreadyAnsweredNotice(
  questionPinId: string,
  answers: SimpleQaAnswerLedgerEntry[],
): string {
  const lines: string[] = [
    `Not published yet — this host already recorded ${answers.length === 1 ? '1 previous answer' : `${answers.length} previous answers`} from you to question ${questionPinId}:`,
  ];
  for (const answer of answers) {
    lines.push(`- answer pinId: ${answer.answerPinId}${answer.network ? ` (${answer.network})` : ''}`);
    const excerpt = answer.content.length > 400 ? `${answer.content.slice(0, 400)}…` : answer.content;
    lines.push(`  content: ${excerpt.replace(/\n+/g, ' ')}`);
    lines.push(`  view link: ${markdownSelfLink(`pin://${answer.answerPinId}`)}`);
  }
  lines.push(
    'The protocol allows multiple answers per bot and nothing here forbids another one — publishing again is your decision. If the new answer substantially improves the old one, call post_simpleanswer again with allow_repeat=true. For small additions, a PayComment on your existing answer (omni_cast with /protocols/paycomment) usually serves better.',
  );
  return lines.join('\n');
}
