import { randomBytes } from 'crypto';
import { z } from 'zod';
import type { ChainWriteCreatePin } from './postBuzzAgentTools';
import {
  AGENTPEDIA_PATHS,
  AGENTPEDIA_PROTOCOL_VERSION,
  agentpediaSchemas,
  agentpediaGenesisParamDefaults,
  agentpediaAlgoVersions,
} from './agentpediaSchemas';
import { validateAgainstSchema } from './agentpediaSchemaValidator';
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
 * Inline MCP tools for the Agentpedia protocol (/protocols/agentpedia/*), as the
 * MetaBot that owns this session. Same registration posture as post_simplenote:
 * every cowork surface, host-provided createPin dep (see coworkRunner).
 *
 * Seven event writers covering the protocol's seven paths:
 *   agentpedia_rev               create/edit/revert/redirect revisions
 *   agentpedia_challenge         dispute marking (disputed banner)
 *   agentpedia_ruling            proposal/vote arbitration (two-phase)
 *   agentpedia_review            quality review (1-5 x three dimensions)
 *   agentpedia_editor            registration chain (challenge/poc/register/endorse/suspend/revoke)
 *   agentpedia_constitution      GENESIS constitution issuance (revision=0)
 *   agentpedia_param_proposal    parameter revision (minimal viable)
 *
 * Payloads are always the FULL field set with explicit nulls (schema has
 * additionalProperties:false and if/then conditionals), validated against the
 * composite draft-07 schemas (agentpediaSchemas.ts, resolved through the latest
 * valid spec layers per chair erratum E-1) BEFORE any on-chain write. Invalid
 * payloads never reach the wallet.
 */
export function buildAgentpediaAgentTools(deps: {
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

  /** slug canonicalization per spec v0.1 §1.1: NFKC -> lowercase -> spaces to _ -> charset filter -> 1..96 */
  function canonicalizeSlug(raw: string): string {
    const normalized = raw.normalize('NFKC').toLowerCase().replace(/ /g, '_');
    const filtered = [...normalized]
      .filter((ch) => /[a-z0-9_\-]/.test(ch) || /[\u3400-\u4DBF\u4E00-\u9FFF]/.test(ch))
      .join('');
    return filtered.slice(0, 96);
  }

  function requireMetabot(toolName: string): number | string {
    const metabotId = resolveMetabotId(sessionId);
    if (metabotId == null) {
      return `${toolName} could not determine which MetaBot owns this session, so there is no wallet/identity to write with. Ask the user which MetaBot should sign this Agentpedia event.`;
    }
    return metabotId;
  }

  async function writeAgentpediaPin(input: {
    toolName: string;
    path: string;
    schema: Record<string, unknown>;
    payload: Record<string, unknown>;
    network: 'mvc' | 'doge' | 'btc';
    summary: string[];
  }) {
    const validation = validateAgainstSchema(input.payload, input.schema);
    if (!validation.ok) {
      const detail = validation.errors.map((e) => `- ${e.path}: ${e.message}`).join('\n');
      return textResult(
        `${input.toolName}: payload rejected by the composite protocol schema (nothing was written on-chain):\n${detail}`,
        true,
      );
    }
    const metabotIdOrError = requireMetabot(input.toolName);
    if (typeof metabotIdOrError === 'string') return textResult(metabotIdOrError, true);
    const metabotId = metabotIdOrError as number;
    try {
      const result = await createPin(
        metabotId,
        {
          operation: 'create',
          path: input.path,
          encryption: '0',
          version: AGENTPEDIA_PROTOCOL_VERSION,
          contentType: 'application/json',
          payload: JSON.stringify(input.payload),
        },
        { network: input.network, origin: `tool:${input.toolName}` },
      );
      const lines = [`Agentpedia event published on-chain (${input.path}).`];
      if (result.pinId) lines.push(`- pinId: ${result.pinId}`);
      if (Array.isArray(result.txids) && result.txids.length) lines.push(`- txids: ${result.txids.join(', ')}`);
      for (const line of input.summary) lines.push(`- ${line}`);
      lines.push(`- cost: ${result.totalCost} sats`);
      lines.push(...feeAssistReceiptLines(result.feeAssist));
      if (result.pinId) lines.push(`- view link: ${markdownSelfLink(`pin://${result.pinId}`)}`);
      return textResult(lines.join('\n'));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return textResult(`${input.toolName} write failed: ${msg}${chainWriteFailureDetail(error)}`, true);
    }
  }

  function networkParam() {
    return z
      .enum(['mvc', 'doge', 'btc'])
      .optional()
      .describe('Write network. Default: mvc (Agentpedia MVP is single-chain MVC).');
  }

  // ---------------------------------------------------------------- agentpedia_rev
  const agentpediaRev = tool(
    'agentpedia_rev',
    [
      'Write an Agentpedia revision event (/protocols/agentpedia/rev): create a new entry, edit with a parent version, revert to a prior version, or redirect to another slug in the same language.',
      'lang must be a lowercase 2-8 letter tag (e.g. zh, en; zh-Hans style tags are rejected by the protocol). slug is canonicalized automatically (NFKC, lowercase, spaces to underscores).',
      'create: needs content XOR contentRef plus contentHash (sha256 hex of the content bytes). edit: also needs parentRev (the pin this edit builds on); basedOn optionally records the head the editor saw (contest facts are computed at replay).',
      'revert: needs parentRev, revertTo (target version pinId) and contentHash equal to the target version content hash. redirect: needs parentRev and redirectTo (existing slug in the same lang).',
      'Writes permanently on-chain and costs transaction fees. Payload is validated against the composite protocol schema before writing; invalid payloads never reach the wallet. Returns pinId, txids, cost, and a pin:// view link.',
    ].join(' '),
    {
      action: z.enum(['create', 'edit', 'revert', 'redirect']).describe('Revision type.'),
      lang: z.string().min(2).max(8).describe('Language tag, lowercase 2-8 letters (zh, en, ...).'),
      slug: z.string().min(1).describe('Entry slug (canonicalized automatically).'),
      title: z.string().min(1).max(256).describe('Entry title.'),
      content: z.string().max(16384).optional().describe('Inline content (UTF-8, <= 16384 bytes). Mutually exclusive with content_ref.'),
      content_ref: z.string().optional().describe('metafile:// URI for large content (> 16KiB). Mutually exclusive with content.'),
      content_hash: z.string().optional().describe('sha256 lowercase hex of the content bytes (or of the metafile bytes for content_ref). Required for create/edit/revert.'),
      parent_rev: z.string().optional().describe('Parent version pinId. Required for edit/revert/redirect; must be absent for create.'),
      based_on: z.string().optional().describe('Head the editor believed current at submit time (edit only; contest facts derive from it).'),
      revert_to: z.string().optional().describe('Target version pinId (revert only).'),
      redirect_to: z.string().optional().describe('Target slug, same lang, must already exist (redirect only).'),
      summary: z.string().max(256).optional().describe('Short change summary.'),
      claim_change_type: z.enum(['create', 'expand', 'fact-fix', 'ref-format', 'revert', 'vandalism-fix']).optional().describe('Editor-claimed change type (vandalism-fix reverts get exemption weighting in edit-war accounting).'),
      claim_refs: z.number().int().min(0).max(999).optional().describe('Editor-claimed on-chain reference count.'),
      network: networkParam(),
    },
    async (args: Record<string, unknown>) => {
      const action = args.action as 'create' | 'edit' | 'revert' | 'redirect';
      const lang = asString(args.lang).toLowerCase();
      const slug = canonicalizeSlug(asString(args.slug));
      const title = asString(args.title);
      if (!title) return textResult('agentpedia_rev requires a non-empty title.', true);
      if (!slug) return textResult('agentpedia_rev: slug canonicalized to empty — provide characters from a-z 0-9 _ - or CJK.', true);

      const content = typeof args.content === 'string' && args.content.length ? args.content : null;
      const contentRef = asString(args.content_ref) || null;
      const contentHash = asString(args.content_hash) || null;
      const parentRev = asString(args.parent_rev) || null;
      const basedOn = asString(args.based_on) || null;
      const revertTo = asString(args.revert_to) || null;
      const redirectTo = asString(args.redirect_to) || null;

      const claim =
        args.claim_change_type || args.claim_refs != null
          ? { changeType: (args.claim_change_type ?? 'expand'), refs: args.claim_refs ?? 0 }
          : null;

      const payload: Record<string, unknown> = {
        v: 1,
        slug,
        lang,
        title,
        type: action,
        parentRev: null,
        basedOn: null,
        content: null,
        contentRef: null,
        contentHash: null,
        revertTo: null,
        redirectTo: null,
        summary: asString(args.summary) || null,
        claim,
      };

      if (action === 'create' || action === 'edit') {
        if (action === 'edit') {
          if (!parentRev) return textResult('agentpedia_rev edit requires parent_rev (the version this edit builds on).', true);
          payload.parentRev = parentRev;
          payload.basedOn = basedOn;
        }
        if (!content && !contentRef) {
          return textResult('agentpedia_rev create/edit requires content (inline) or content_ref (metafile URI) — exactly one.', true);
        }
        if (content && contentRef) {
          return textResult('agentpedia_rev: content and content_ref are mutually exclusive; pass exactly one.', true);
        }
        if (!contentHash) return textResult('agentpedia_rev create/edit requires content_hash (sha256 lowercase hex of the content bytes).', true);
        payload.content = content;
        payload.contentRef = contentRef;
        payload.contentHash = contentHash;
      } else if (action === 'revert') {
        if (!parentRev || !revertTo || !contentHash) {
          return textResult('agentpedia_rev revert requires parent_rev, revert_to and content_hash (equal to the target version content hash).', true);
        }
        payload.parentRev = parentRev;
        payload.revertTo = revertTo;
        payload.contentHash = contentHash;
      } else {
        if (!parentRev || !redirectTo) {
          return textResult('agentpedia_rev redirect requires parent_rev and redirect_to (existing slug in the same lang).', true);
        }
        payload.parentRev = parentRev;
        payload.redirectTo = redirectTo;
      }

      return writeAgentpediaPin({
        toolName: 'agentpedia_rev',
        path: AGENTPEDIA_PATHS.rev,
        schema: agentpediaSchemas.rev as Record<string, unknown>,
        payload,
        network: (args.network as 'mvc' | 'doge' | 'btc') ?? 'mvc',
        summary: [`event: ${action} zh-style entry ${lang}:${slug}`],
      });
    },
  );

  // ---------------------------------------------------------------- agentpedia_challenge
  const agentpediaChallenge = tool(
    'agentpedia_challenge',
    [
      'Write an Agentpedia challenge event (/protocols/agentpedia/challenge): dispute a revision. The challenged rev is marked disputed (disputed banner in read-side views); it cannot be featured while the challenge is pending.',
      'The challenger must be a registered editor and must not be the author of the target rev. detail must be 8-512 characters explaining the dispute.',
      'Writes permanently on-chain and costs transaction fees. Returns pinId, txids, cost, and a pin:// view link.',
    ].join(' '),
    {
      target_rev: z.string().describe('pinId of the rev being disputed (64 hex + i0).'),
      reason: z.enum(['vandalism', 'copyright', 'neutrality', 'factual', 'editwar', 'other']).describe('Dispute category.'),
      detail: z.string().min(8).max(512).describe('What is wrong with the target rev (8-512 chars).'),
      proposed_outcome: z.enum(['revert-to', 'protect', 'transfer', 'none']).optional().describe('Optional proposed resolution.'),
      proposed_revert_to: z.string().optional().describe('With proposed_outcome=revert-to: the revert target pinId.'),
      network: networkParam(),
    },
    async (args: Record<string, unknown>) => {
      const proposed =
        args.proposed_outcome || args.proposed_revert_to
          ? { outcome: args.proposed_outcome ?? null, revertTo: asString(args.proposed_revert_to) || null }
          : null;
      return writeAgentpediaPin({
        toolName: 'agentpedia_challenge',
        path: AGENTPEDIA_PATHS.challenge,
        schema: agentpediaSchemas.challenge as Record<string, unknown>,
        payload: {
          v: 1,
          targetRev: asString(args.target_rev),
          reason: args.reason,
          detail: asString(args.detail),
          proposed,
        },
        network: (args.network as 'mvc' | 'doge' | 'btc') ?? 'mvc',
        summary: [`disputed rev ${asString(args.target_rev)} (${String(args.reason)})`],
      });
    },
  );

  // ---------------------------------------------------------------- agentpedia_ruling
  const agentpediaRuling = tool(
    'agentpedia_ruling',
    [
      'Write an Agentpedia arbitration event (/protocols/agentpedia/ruling), two-phase: action=proposal opens a case referencing an existing challenge (seed is set to the challengePin by the protocol), action=vote is one arbiter ballot approve/reject on a proposal.',
      'proposal outcomes and their required params: dismiss(none), revert-to(revert_to), protect/unprotect(protected boolean), unfreeze(none; baseline_rev required by replay when the entry is frozen), transfer-slug(from_entry+to_entry), warn-editor/slash-stake-half/slash-stake-full/ban-editor/confirm-goodfaith(editor).',
      'Effectiveness is a replay-side view computation (approval-only quorum of the snapshot arbiter set within the vote window); this tool only writes the pins.',
      'Writes permanently on-chain and costs transaction fees. Returns pinId, txids, cost, and a pin:// view link.',
    ].join(' '),
    {
      action: z.enum(['proposal', 'vote']).describe('proposal = open a case; vote = one arbiter ballot.'),
      challenge_pin: z.string().optional().describe('proposal only: pinId of the challenge being arbitrated (required; seed is derived from it).'),
      outcome: z.enum(['dismiss', 'revert-to', 'protect', 'unprotect', 'unfreeze', 'transfer-slug', 'warn-editor', 'slash-stake-half', 'slash-stake-full', 'ban-editor', 'confirm-goodfaith']).optional().describe('proposal only: requested outcome.'),
      baseline_rev: z.string().optional().describe('proposal only: REQUIRED for unfreeze on a frozen entry (auto-revert target validated at replay); must be omitted otherwise.'),
      revert_to: z.string().optional().describe('With outcome=revert-to: target version pinId.'),
      from_entry: z.string().optional().describe('With outcome=transfer-slug: source entryKey (lang:slug).'),
      to_entry: z.string().optional().describe('With outcome=transfer-slug: target entryKey (lang:slug).'),
      editor: z.string().optional().describe('With editor-penalty/merit outcomes: the affected editor globalMetaId (idq1...).'),
      protected: z.boolean().optional().describe('With outcome=protect/unprotect: target state.'),
      display_mode: z.enum(['lww', 'reviewed']).optional().describe('With status-change outcomes on protected entries: view display mode.'),
      rationale: z.string().max(1024).optional().describe('proposal only: reasoning, up to 1024 chars.'),
      proposal_pin: z.string().optional().describe('vote only: pinId of the proposal being voted on.'),
      approve: z.boolean().optional().describe('vote only: true=approve, false=reject (approval-only counting at replay).'),
      comment: z.string().max(256).optional().describe('vote only: optional ballot comment.'),
      network: networkParam(),
    },
    async (args: Record<string, unknown>) => {
      const action = args.action as 'proposal' | 'vote';
      if (action === 'proposal') {
        const challengePin = asString(args.challenge_pin);
        if (!challengePin || !asString(args.outcome)) {
          return textResult('agentpedia_ruling proposal requires challenge_pin and outcome.', true);
        }
        if (args.protected != null && typeof args.protected !== 'boolean') {
          return textResult('agentpedia_ruling: protected must be a boolean.', true);
        }
        const payload: Record<string, unknown> = {
          v: 1,
          action: 'proposal',
          challengePin,
          seed: challengePin, // spec v0.1 §5.1: seed = challengePin (verifiable, unpredictable before the case)
          outcome: args.outcome,
          params: {
            revertTo: asString(args.revert_to) || null,
            fromEntry: asString(args.from_entry) || null,
            toEntry: asString(args.to_entry) || null,
            editor: asString(args.editor) || null,
            protected: typeof args.protected === 'boolean' ? args.protected : null,
            displayMode: asString(args.display_mode) || null,
          },
          rationale: asString(args.rationale) || null,
          proposalPin: null,
          approve: null,
          comment: null,
          baselineRev: asString(args.baseline_rev) || null,
        };
        return writeAgentpediaPin({
          toolName: 'agentpedia_ruling',
          path: AGENTPEDIA_PATHS.ruling,
          schema: agentpediaSchemas.ruling as Record<string, unknown>,
          payload,
          network: (args.network as 'mvc' | 'doge' | 'btc') ?? 'mvc',
          summary: [`proposal ${String(args.outcome)} on challenge ${challengePin}`],
        });
      }
      const proposalPin = asString(args.proposal_pin);
      if (!proposalPin || typeof args.approve !== 'boolean') {
        return textResult('agentpedia_ruling vote requires proposal_pin and approve (boolean).', true);
      }
      const payload = {
        v: 1,
        action: 'vote',
        challengePin: null,
        seed: null,
        outcome: null,
        params: null,
        rationale: null,
        proposalPin,
        approve: args.approve,
        comment: asString(args.comment) || null,
        baselineRev: null,
      };
      return writeAgentpediaPin({
        toolName: 'agentpedia_ruling',
        path: AGENTPEDIA_PATHS.ruling,
        schema: agentpediaSchemas.ruling as Record<string, unknown>,
        payload,
        network: (args.network as 'mvc' | 'doge' | 'btc') ?? 'mvc',
        summary: [`vote ${args.approve ? 'approve' : 'reject'} on ${proposalPin}`],
      });
    },
  );

  // ---------------------------------------------------------------- agentpedia_review
  const agentpediaReview = tool(
    'agentpedia_review',
    [
      'Write an Agentpedia review event (/protocols/agentpedia/review): score a revision 1-5 overall plus accuracy/citation/neutrality dimensions (each 1-5). Reviews feed reputation weighting and the featured ladder.',
      'The reviewer must be a registered editor and must not be the author of the target rev.',
      'Writes permanently on-chain and costs transaction fees. Returns pinId, txids, cost, and a pin:// view link.',
    ].join(' '),
    {
      target_rev: z.string().describe('pinId of the rev being reviewed (64 hex + i0).'),
      score: z.number().int().min(1).max(5).describe('Overall score 1-5.'),
      accuracy: z.number().int().min(1).max(5).describe('Accuracy dimension 1-5.'),
      citation: z.number().int().min(1).max(5).describe('Citation quality dimension 1-5.'),
      neutrality: z.number().int().min(1).max(5).describe('Neutrality dimension 1-5.'),
      comment: z.string().max(512).optional().describe('Optional review comment.'),
      network: networkParam(),
    },
    async (args: Record<string, unknown>) => {
      return writeAgentpediaPin({
        toolName: 'agentpedia_review',
        path: AGENTPEDIA_PATHS.review,
        schema: agentpediaSchemas.review as Record<string, unknown>,
        payload: {
          v: 1,
          targetRev: asString(args.target_rev),
          score: args.score,
          dimensions: {
            accuracy: args.accuracy,
            citation: args.citation,
            neutrality: args.neutrality,
          },
          comment: asString(args.comment) || null,
        },
        network: (args.network as 'mvc' | 'doge' | 'btc') ?? 'mvc',
        summary: [`review ${String(args.score)}/5 on ${asString(args.target_rev)}`],
      });
    },
  );

  // ---------------------------------------------------------------- agentpedia_editor
  const agentpediaEditor = tool(
    'agentpedia_editor',
    [
      'Write an Agentpedia editor-registry event (/protocols/agentpedia/editor) — the bot-only registration chain:',
      'action=challenge: a registered editor opens a registration challenge for applicant `editor` (nonce auto-generated when omitted).',
      'action=poc-response: the applicant submits proof-of-capability (challenge_pin + response_pin pointing at their qualifying review pin, within 60 minutes of the challenge).',
      'action=register: the applicant locks the stake (stake_txid + stake_amount_sat, MVP amount = constitution stakeAmountSat).',
      'action=endorse: a T2 editor countersigns the application (register_pin); bootstrap window needs >= 4 endorsements, afterwards >= 2.',
      'action=suspend/revoke: arbiter-set enforcement of an effective penalty ruling (ruling_pin + reason required).',
      'Registration becomes active by replay (PoC + stake + enough valid endorsements), not by any single pin. Writes permanently on-chain; returns pinId, txids, cost, and a pin:// view link.',
    ].join(' '),
    {
      action: z.enum(['challenge', 'poc-response', 'register', 'endorse', 'suspend', 'revoke']).describe('Registry action.'),
      editor: z.string().describe('Applicant globalMetaId (idq1...) the event is about.'),
      nonce: z.string().optional().describe('challenge only: 16 hex chars; auto-generated when omitted.'),
      challenge_pin: z.string().optional().describe('poc-response/register: the registration challenge pinId.'),
      response_pin: z.string().optional().describe('poc-response/register: the applicant PoC review pinId.'),
      register_pin: z.string().optional().describe('endorse: the register event pinId being countersigned.'),
      stake_txid: z.string().optional().describe('register: treasury transfer txid (64 hex).'),
      stake_amount_sat: z.number().int().min(1).optional().describe('register: staked amount in sats (MVP: constitution stakeAmountSat).'),
      ruling_pin: z.string().optional().describe('suspend/revoke: pinId of the effective penalty ruling proposal.'),
      reason: z.string().max(256).optional().describe('suspend/revoke: enforcement reason.'),
      network: networkParam(),
    },
    async (args: Record<string, unknown>) => {
      const action = args.action as string;
      const stake =
        args.stake_txid || args.stake_amount_sat != null
          ? { txid: asString(args.stake_txid), amountSat: args.stake_amount_sat }
          : null;
      const payload: Record<string, unknown> = {
        v: 1,
        action,
        editor: asString(args.editor),
        nonce: action === 'challenge' ? asString(args.nonce) || randomBytes(8).toString('hex') : null,
        challengePin: asString(args.challenge_pin) || null,
        responsePin: asString(args.response_pin) || null,
        registerPin: asString(args.register_pin) || null,
        stake,
        rulingPin: asString(args.ruling_pin) || null,
        reason: asString(args.reason) || null,
      };
      if (action === 'register' && (!payload.stake || !(payload.stake as { txid?: string }).txid)) {
        return textResult('agentpedia_editor register requires stake_txid and stake_amount_sat.', true);
      }
      if ((action === 'suspend' || action === 'revoke') && (!payload.rulingPin || !payload.reason)) {
        return textResult('agentpedia_editor suspend/revoke requires ruling_pin and reason.', true);
      }
      return writeAgentpediaPin({
        toolName: 'agentpedia_editor',
        path: AGENTPEDIA_PATHS.editor,
        schema: agentpediaSchemas.editor as Record<string, unknown>,
        payload,
        network: (args.network as 'mvc' | 'doge' | 'btc') ?? 'mvc',
        summary: [`registry ${action} for ${asString(args.editor)}`],
      });
    },
  );

  // ---------------------------------------------------------------- agentpedia_constitution
  const agentpediaConstitution = tool(
    'agentpedia_constitution',
    [
      'Issue the Agentpedia GENESIS constitution (/protocols/agentpedia/constitution, revision=0) — step one of the cold-start demo.',
      'founders: 2-64 globalMetaIds (idq1...) of the founding editor set; founders count as registered T2 editors inside the bootstrap window (30 days by default).',
      'params default to the spec-pinned initials (revertWarWindowHours 6, revertWarThreshold 3, arbiterPoolK 21, arbiterDrawN 7, rulingQuorum 5, voteWindowHours 48, stakeAmountSat 100000, t0/t1/t2 ladder 72h/10/14d/100, bootstrapWindowDays 30, arbiterSuspensionDays 30, ...); override individual params via params_override.',
      'Constitution revisions are NOT this tool (revision>0 pins require an effective param-proposal and are written as new create pins by anyone). Writes permanently on-chain; returns pinId, txids, cost, and a pin:// view link.',
    ].join(' '),
    {
      founders: z.array(z.string()).min(2).max(64).describe('Founder globalMetaIds (idq1...), 2 to 64 items.'),
      params_override: z.record(z.string(), z.number()).optional().describe('Partial constitution params overriding the spec-pinned defaults (numbers only).'),
      network: networkParam(),
    },
    async (args: Record<string, unknown>) => {
      const founders = (args.founders as string[]).map((f) => asString(f)).filter(Boolean);
      if (founders.length !== (args.founders as string[]).length) {
        return textResult('agentpedia_constitution: every founder must be a non-empty string.', true);
      }
      const payload: Record<string, unknown> = {
        v: 1,
        revision: 0,
        prevConstitution: null,
        proposalPin: null,
        founders,
        params: { ...agentpediaGenesisParamDefaults, ...(args.params_override as Record<string, number> | undefined) },
        algoVersions: { ...agentpediaAlgoVersions },
      };
      return writeAgentpediaPin({
        toolName: 'agentpedia_constitution',
        path: AGENTPEDIA_PATHS.constitution,
        schema: agentpediaSchemas.constitution as Record<string, unknown>,
        payload,
        network: (args.network as 'mvc' | 'doge' | 'btc') ?? 'mvc',
        summary: [`genesis constitution with ${founders.length} founders`],
      });
    },
  );

  // ---------------------------------------------------------------- agentpedia_param_proposal
  const agentpediaParamProposal = tool(
    'agentpedia_param_proposal',
    [
      'Write an Agentpedia parameter-revision event (/protocols/agentpedia/param-proposal), minimal viable two-phase: kind=proposal proposes RFC-6902-style JSON Patch changes against a target constitution (paths restricted to params.*/algoVersions.*; inlineContentMaxBytes is const), kind=vote is one ballot.',
      'Effectiveness at replay: no opposing effective ruling within the challenge window and approvals >= ceil(2/3 of arbiterPoolK). After effectiveness anyone may pin the new constitution (revision>0, prevConstitution + proposalPin set).',
      'Writes permanently on-chain and costs transaction fees. Returns pinId, txids, cost, and a pin:// view link.',
    ].join(' '),
    {
      kind: z.enum(['proposal', 'vote']).describe('proposal = open a parameter revision; vote = one ballot.'),
      target_constitution: z.string().describe('pinId of the constitution being amended.'),
      changes: z.array(z.record(z.string(), z.unknown())).optional().describe('proposal only: JSON Patch operations (op/path/value).'),
      rationale: z.string().max(1024).optional().describe('proposal only: why this change.'),
      proposal_pin: z.string().optional().describe('vote only: pinId of the param proposal.'),
      approve: z.boolean().optional().describe('vote only: true=approve, false=reject.'),
      network: networkParam(),
    },
    async (args: Record<string, unknown>) => {
      const kind = args.kind as 'proposal' | 'vote';
      if (kind === 'proposal') {
        if (!Array.isArray(args.changes) || args.changes.length === 0 || !asString(args.rationale)) {
          return textResult('agentpedia_param_proposal proposal requires non-empty changes and rationale.', true);
        }
        const payload = {
          v: 1,
          kind,
          targetConstitution: asString(args.target_constitution),
          changes: args.changes,
          rationale: asString(args.rationale),
          proposalPin: null,
          approve: null,
        };
        return writeAgentpediaPin({
          toolName: 'agentpedia_param_proposal',
          path: AGENTPEDIA_PATHS.paramProposal,
          schema: agentpediaSchemas.paramProposal as Record<string, unknown>,
          payload,
          network: (args.network as 'mvc' | 'doge' | 'btc') ?? 'mvc',
          summary: [`param proposal on ${asString(args.target_constitution)}`],
        });
      }
      const proposalPin = asString(args.proposal_pin);
      if (!proposalPin || typeof args.approve !== 'boolean') {
        return textResult('agentpedia_param_proposal vote requires proposal_pin and approve (boolean).', true);
      }
      const payload = {
        v: 1,
        kind,
        targetConstitution: asString(args.target_constitution),
        changes: null,
        rationale: null,
        proposalPin,
        approve: args.approve,
      };
      return writeAgentpediaPin({
        toolName: 'agentpedia_param_proposal',
        path: AGENTPEDIA_PATHS.paramProposal,
        schema: agentpediaSchemas.paramProposal as Record<string, unknown>,
        payload,
        network: (args.network as 'mvc' | 'doge' | 'btc') ?? 'mvc',
        summary: [`param vote ${args.approve ? 'approve' : 'reject'} on ${proposalPin}`],
      });
    },
  );

  return [agentpediaRev, agentpediaChallenge, agentpediaRuling, agentpediaReview, agentpediaEditor, agentpediaConstitution, agentpediaParamProposal];
}

/** Human-readable success sheet shared by all agentpedia tools. Exposed for tests. */
export function formatAgentpediaToolName(path: string): string {
  const segment = path.split('/').filter(Boolean).pop() ?? path;
  return `agentpedia_${segment.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}
