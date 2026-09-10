/**
 * Agentpedia composite protocol schemas (draft-07), resolved through the latest
 * valid spec layers per chair erratum E-1
 * (pin://b3d8212a8da838dfa94b8db9aad982f4dcbe8a3390ae89688e4b84f42934190fi0).
 *
 * Layer provenance per schema:
 * - rev:         v0.1 §3.1 (pin://bd28bfc0e9d2488005c85caa3aa77618d05623dc15273cc38f6d73c33b868b10i0)
 *                + v0.1.1 X1 lang pattern tightened to ^[a-z]{2,8}$
 *                (pin://ab4224e2be9fe2e45cb927d286b14896a2c7009eb66b7aeee2f9dd391eb832eei0)
 * - challenge:   v0.1 §4 (unchanged through all deltas)
 * - ruling:      v0.1 §5 + v0.1.1 §2 (baselineRev property; params.displayMode) with the
 *                v0.1.2 §1 displayMode enum correction ("lww"|"reviewed"|null)
 * - review:      v0.1 §6 (unchanged)
 * - editor:      v0.1 §7 (unchanged)
 * - constitution:v0.1 §8 + v0.1.1 X8 (voteWindowHours) + v0.1.2 D2 (five ladder params)
 *                + D6 (arbiterSuspensionDays) + D7 (founders)
 * - param-proposal: v0.1 §9 (unchanged)
 *
 * v0.1.4 (pin://0be17b3e623d0ff3984eb7dec6f391f9f0913d33b4428bbc804cb040f85a9883i0)
 * is voided by v0.1.5 and contributes nothing.
 *
 * Everything here is schema-verbatim from the pins except where a delta says
 * otherwise; no field semantics live in this file (semantics live in the replay
 * engine, src/agentpedia-core/adoption-algo-v1.mjs).
 */

export const AGENTPEDIA_PATHS = {
  rev: '/protocols/agentpedia/rev',
  challenge: '/protocols/agentpedia/challenge',
  ruling: '/protocols/agentpedia/ruling',
  review: '/protocols/agentpedia/review',
  editor: '/protocols/agentpedia/editor',
  constitution: '/protocols/agentpedia/constitution',
  paramProposal: '/protocols/agentpedia/param-proposal',
} as const;

/** Outer 7-tuple protocol version for all agentpedia pins (spec v0.1 §1: fixed 1.0). */
export const AGENTPEDIA_PROTOCOL_VERSION = '1.0';

const PIN_ID_PATTERN = '^[0-9a-f]{64}i0$';
const HEX_64_PATTERN = '^[0-9a-f]{64}$';
const GLOBAL_META_ID_PATTERN = '^idq1[0-9a-z]{38}$';
const SLUG_CHARSET = '[a-z0-9_\\-\\u4E00-\\u9FFF\\u3400-\\u4DBF]';
const SLUG_PATTERN = `^${SLUG_CHARSET}+$`;
const SLUG_REDIRECT_TARGET_PATTERN = `^${SLUG_CHARSET}{1,96}$`; // v0.1 §3.1 redirectTo — quantifier on the char class, never `+{1,96}`
const LANG_PATTERN = '^[a-z]{2,8}$'; // v0.1.1 X1: lowercase-normalized, rejects zh-Hans style tags

export type AgentpediaSchema = Record<string, unknown>;

export const agentpediaRevSchema: AgentpediaSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'agentpedia-rev-v1',
  type: 'object',
  additionalProperties: false,
  required: ['v', 'slug', 'lang', 'title', 'type'],
  properties: {
    v: { const: 1 },
    slug: { type: 'string', minLength: 1, maxLength: 96, pattern: SLUG_PATTERN },
    lang: { type: 'string', pattern: LANG_PATTERN },
    title: { type: 'string', minLength: 1, maxLength: 256 },
    type: { enum: ['create', 'edit', 'revert', 'redirect'] },
    parentRev: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    basedOn: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    content: { type: ['string', 'null'], maxLength: 16384 },
    contentRef: { type: ['string', 'null'], pattern: '^metafile://[0-9a-f]{64}i0$' },
    contentHash: { type: ['string', 'null'], pattern: HEX_64_PATTERN },
    revertTo: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    redirectTo: { type: ['string', 'null'], pattern: SLUG_REDIRECT_TARGET_PATTERN },
    summary: { type: ['string', 'null'], maxLength: 256 },
    claim: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['changeType', 'refs'],
      properties: {
        changeType: { enum: ['create', 'expand', 'fact-fix', 'ref-format', 'revert', 'vandalism-fix'] },
        refs: { type: 'integer', minimum: 0, maximum: 999 },
      },
    },
  },
  allOf: [
    {
      if: { properties: { type: { const: 'create' } } },
      then: {
        properties: {
          parentRev: { const: null },
          basedOn: { const: null },
          revertTo: { const: null },
          redirectTo: { const: null },
        },
      },
      else: { required: ['parentRev'], properties: { parentRev: { type: 'string' } } },
    },
    {
      if: { properties: { type: { const: 'revert' } } },
      then: {
        required: ['revertTo', 'contentHash', 'content', 'contentRef', 'redirectTo'],
        properties: { content: { const: null }, contentRef: { const: null }, redirectTo: { const: null } },
      },
    },
    {
      if: { properties: { type: { const: 'redirect' } } },
      then: {
        required: ['redirectTo', 'content', 'contentRef', 'contentHash', 'revertTo'],
        properties: {
          content: { const: null },
          contentRef: { const: null },
          contentHash: { const: null },
          revertTo: { const: null },
        },
      },
    },
    {
      if: { properties: { type: { enum: ['create', 'edit'] } } },
      then: {
        properties: { revertTo: { const: null }, redirectTo: { const: null } },
        anyOf: [
          { required: ['content'], properties: { contentRef: { const: null }, contentHash: { type: 'string' } } },
          { required: ['contentRef'], properties: { content: { const: null }, contentHash: { type: 'string' } } },
        ],
      },
    },
  ],
};

export const agentpediaChallengeSchema: AgentpediaSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'agentpedia-challenge-v1',
  type: 'object',
  additionalProperties: false,
  required: ['v', 'targetRev', 'reason', 'detail'],
  properties: {
    v: { const: 1 },
    targetRev: { type: 'string', pattern: PIN_ID_PATTERN },
    reason: { enum: ['vandalism', 'copyright', 'neutrality', 'factual', 'editwar', 'other'] },
    detail: { type: 'string', minLength: 8, maxLength: 512 },
    proposed: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        outcome: { enum: ['revert-to', 'protect', 'transfer', 'none'] },
        revertTo: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
      },
    },
  },
};

export const agentpediaRulingSchema: AgentpediaSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'agentpedia-ruling-v1',
  type: 'object',
  additionalProperties: false,
  required: ['v', 'action'],
  properties: {
    v: { const: 1 },
    action: { enum: ['proposal', 'vote'] },
    // COMPOSITE CORRECTION (disclosed, erratum candidate for the architect/chair):
    // v0.1 §5 declares challengePin/seed as plain strings and outcome as a bare
    // enum, while the vote branch of the same allOf requires all three to be
    // null — the literal merge rejects EVERY valid vote pin. The editor schema
    // (v0.1 §7) and v0.1.1 §2 use the ['string','null'] + if/then convention for
    // exactly this shape, so the null variant here is the only self-consistent
    // reading of the frozen layers. params/proposalPin/approve are already
    // nullable in v0.1.
    challengePin: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    seed: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    outcome: {
      enum: [
        'dismiss',
        'revert-to',
        'protect',
        'unprotect',
        'unfreeze',
        'transfer-slug',
        'warn-editor',
        'slash-stake-half',
        'slash-stake-full',
        'ban-editor',
        'confirm-goodfaith',
        null,
      ],
    },
    params: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        revertTo: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
        fromEntry: { type: ['string', 'null'], pattern: '^[a-z]{2,8}:[^\\s]{1,105}$' },
        toEntry: { type: ['string', 'null'], pattern: '^[a-z]{2,8}:[^\\s]{1,105}$' },
        editor: { type: ['string', 'null'], pattern: GLOBAL_META_ID_PATTERN },
        protected: { type: ['boolean', 'null'] },
        displayMode: { type: ['string', 'null'], enum: ['lww', 'reviewed', null] }, // v0.1.2 §1 corrected enum
      },
    },
    rationale: { type: ['string', 'null'], maxLength: 1024 },
    proposalPin: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    approve: { type: ['boolean', 'null'] },
    comment: { type: ['string', 'null'], maxLength: 256 },
    baselineRev: { type: ['string', 'null'], pattern: PIN_ID_PATTERN }, // v0.1.1 §2
  },
  allOf: [
    {
      if: { properties: { action: { const: 'proposal' } } },
      then: {
        required: ['challengePin', 'seed', 'outcome'],
        properties: { proposalPin: { const: null }, approve: { const: null } },
      },
    },
    {
      if: { properties: { action: { const: 'vote' } } },
      then: {
        required: ['proposalPin', 'approve'],
        properties: {
          challengePin: { const: null },
          seed: { const: null },
          outcome: { const: null },
          params: { const: null },
        },
      },
    },
  ],
};

export const agentpediaReviewSchema: AgentpediaSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'agentpedia-review-v1',
  type: 'object',
  additionalProperties: false,
  required: ['v', 'targetRev', 'score', 'dimensions'],
  properties: {
    v: { const: 1 },
    targetRev: { type: 'string', pattern: PIN_ID_PATTERN },
    score: { type: 'integer', minimum: 1, maximum: 5 },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['accuracy', 'citation', 'neutrality'],
      properties: {
        accuracy: { type: 'integer', minimum: 1, maximum: 5 },
        citation: { type: 'integer', minimum: 1, maximum: 5 },
        neutrality: { type: 'integer', minimum: 1, maximum: 5 },
      },
    },
    comment: { type: ['string', 'null'], maxLength: 512 },
  },
};

export const agentpediaEditorSchema: AgentpediaSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'agentpedia-editor-v1',
  type: 'object',
  additionalProperties: false,
  required: ['v', 'action', 'editor'],
  properties: {
    v: { const: 1 },
    action: { enum: ['challenge', 'poc-response', 'register', 'endorse', 'suspend', 'revoke'] },
    editor: { type: 'string', pattern: GLOBAL_META_ID_PATTERN },
    nonce: { type: ['string', 'null'], pattern: '^[0-9a-f]{16}$' },
    challengePin: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    responsePin: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    registerPin: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    stake: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['txid', 'amountSat'],
      properties: {
        txid: { type: 'string', pattern: HEX_64_PATTERN },
        amountSat: { type: 'integer', minimum: 1 },
      },
    },
    rulingPin: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    reason: { type: ['string', 'null'], maxLength: 256 },
  },
  allOf: [
    { if: { properties: { action: { const: 'poc-response' } } }, then: { required: ['challengePin', 'responsePin'] } },
    { if: { properties: { action: { const: 'register' } } }, then: { required: ['challengePin', 'responsePin', 'stake'] } },
    { if: { properties: { action: { const: 'endorse' } } }, then: { required: ['registerPin'] } },
    { if: { properties: { action: { const: 'suspend' } } }, then: { required: ['rulingPin', 'reason'] } },
    { if: { properties: { action: { const: 'revoke' } } }, then: { required: ['rulingPin', 'reason'] } },
  ],
};

export const agentpediaConstitutionSchema: AgentpediaSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'agentpedia-constitution-v1',
  type: 'object',
  additionalProperties: false,
  required: ['v', 'revision', 'prevConstitution', 'params', 'algoVersions', 'founders'],
  properties: {
    v: { const: 1 },
    revision: { type: 'integer', minimum: 0 },
    prevConstitution: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    proposalPin: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    founders: {
      // E3-2: founders is required non-empty at genesis (revision=0) and must be
      // null for every revision > 0 (bidirectional conditions below).
      type: ['array', 'null'],
      minItems: 2,
      maxItems: 64,
      items: { type: 'string', pattern: GLOBAL_META_ID_PATTERN },
    },
    params: {
      type: 'object',
      additionalProperties: false,
      required: [
        'challengeWindowHours',
        'revertWarWindowHours',
        'revertWarThreshold',
        'arbiterPoolK',
        'arbiterDrawN',
        'rulingQuorum',
        'stakeAmountSat',
        'coldStartDays',
        'ratePerSlugDaily',
        'rateGlobalDaily',
        'thetaProtect',
        'thetaFeatured',
        'featuredMinReviews',
        'inlineContentMaxBytes',
        // v0.1.1 X8:
        'voteWindowHours',
        // v0.1.2 D2:
        't0DurationHours',
        't1MinValidRevs',
        't2MinDays',
        't2MinValidRevs',
        'bootstrapWindowDays',
        // E3-4 (SD-1): arbiterSuspensionDays is properties-only (v0.1.2 D6 says
        // "入宪法" without the explicit "required sync" wording D2/X8 used), min 0
        // per the theta* "0 disables the mechanism" precedent.
      ],
      properties: {
        challengeWindowHours: { type: 'integer', minimum: 1, maximum: 720 },
        revertWarWindowHours: { type: 'integer', minimum: 1, maximum: 168 },
        revertWarThreshold: { type: 'integer', minimum: 2, maximum: 10 },
        arbiterPoolK: { type: 'integer', minimum: 7, maximum: 101 },
        arbiterDrawN: { type: 'integer', minimum: 3, maximum: 21 },
        rulingQuorum: { type: 'integer', minimum: 2, maximum: 21 },
        stakeAmountSat: { type: 'integer', minimum: 1 },
        coldStartDays: { type: 'integer', minimum: 0, maximum: 90, description: 'deprecated by v0.1.2 D2, kept one version' },
        ratePerSlugDaily: { type: 'integer', minimum: 1 },
        rateGlobalDaily: { type: 'integer', minimum: 1 },
        thetaProtect: { type: 'integer', minimum: 0 },
        thetaFeatured: { type: 'integer', minimum: 0 },
        featuredMinReviews: { type: 'integer', minimum: 1 },
        inlineContentMaxBytes: {
          type: 'integer',
          const: 16384,
          description: 'schema constant: adjusting requires rev schema v2',
        },
        voteWindowHours: { type: 'integer', minimum: 1, maximum: 168 },
        t0DurationHours: { type: 'integer', minimum: 0, maximum: 720 },
        t1MinValidRevs: { type: 'integer', minimum: 1 },
        t2MinDays: { type: 'integer', minimum: 1 },
        t2MinValidRevs: { type: 'integer', minimum: 1 },
        bootstrapWindowDays: { type: 'integer', minimum: 0, maximum: 365 },
        arbiterSuspensionDays: { type: 'integer', minimum: 0 },
      },
    },
    algoVersions: {
      type: 'object',
      additionalProperties: false,
      required: ['adoption', 'reputation', 'arbiterDraw'],
      properties: {
        adoption: { type: 'string', pattern: '^adoption-algo-v[0-9]+$' },
        reputation: { type: 'string', pattern: '^reputation-algo-v[0-9]+$' },
        arbiterDraw: { type: 'string', pattern: '^arbiter-draw-v[0-9]+$' },
      },
    },
  },
  allOf: [
    // E3-2 bidirectional founders conditions.
    {
      if: { properties: { revision: { const: 0 } }, required: ['revision'] },
      then: {
        properties: {
          founders: {
            type: 'array',
            minItems: 2,
            maxItems: 64,
            items: { type: 'string', pattern: GLOBAL_META_ID_PATTERN },
          },
        },
      },
    },
    {
      if: { not: { properties: { revision: { const: 0 } }, required: ['revision'] } },
      then: { properties: { founders: { const: null } } },
    },
  ],
};

export const agentpediaParamProposalSchema: AgentpediaSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'agentpedia-param-proposal-v1',
  type: 'object',
  additionalProperties: false,
  required: ['v', 'kind', 'targetConstitution'],
  properties: {
    v: { const: 1 },
    kind: { enum: ['proposal', 'vote'] },
    targetConstitution: { type: 'string', pattern: PIN_ID_PATTERN },
    changes: { type: ['array', 'null'], maxItems: 64 },
    rationale: { type: ['string', 'null'], maxLength: 1024 },
    proposalPin: { type: ['string', 'null'], pattern: PIN_ID_PATTERN },
    approve: { type: ['boolean', 'null'] },
  },
  allOf: [
    {
      if: { properties: { kind: { const: 'proposal' } } },
      then: {
        required: ['changes', 'rationale'],
        properties: { proposalPin: { const: null }, approve: { const: null } },
      },
    },
    {
      if: { properties: { kind: { const: 'vote' } } },
      then: {
        required: ['proposalPin', 'approve'],
        properties: { changes: { const: null }, rationale: { const: null } },
      },
    },
  ],
};

export const agentpediaSchemas = {
  rev: agentpediaRevSchema,
  challenge: agentpediaChallengeSchema,
  ruling: agentpediaRulingSchema,
  review: agentpediaReviewSchema,
  editor: agentpediaEditorSchema,
  constitution: agentpediaConstitutionSchema,
  paramProposal: agentpediaParamProposalSchema,
} as const;

/**
 * Genesis parameter defaults. Values with a pin citation are spec-pinned initials;
 * the three flagged ones have no pinned initial on-chain and are tool defaults a
 * genesis issuer may override (they are constitution params, changeable via
 * param-proposal after genesis).
 */
export const agentpediaGenesisParamDefaults = {
  challengeWindowHours: 72, // spec v0.1 §9 challenge window
  revertWarWindowHours: 6, // v0.1 §10.3 / v0.1.2 §3
  revertWarThreshold: 3, // v0.1.2 §3 (threshold 3.0; schema integer)
  arbiterPoolK: 21, // v0.1.1 §2 top-K=21
  arbiterDrawN: 7, // v0.1 §13.4 top-N=7
  rulingQuorum: 5, // v0.1 §5.3 >= 5
  voteWindowHours: 48, // v0.1.1 X8 initial 48
  stakeAmountSat: 100000, // v0.1 §12 stake pricing
  coldStartDays: 14, // deprecated by v0.1.2 D2; kept one version
  ratePerSlugDaily: 10, // TOOL DEFAULT (no pinned initial on-chain)
  rateGlobalDaily: 20, // v0.1 §12 cold-start global daily 20
  thetaProtect: 10, // TOOL DEFAULT (no pinned initial on-chain)
  thetaFeatured: 20, // TOOL DEFAULT (no pinned initial on-chain)
  featuredMinReviews: 3, // v0.1 §6 (>= 3 valid reviews)
  inlineContentMaxBytes: 16384, // schema constant
  t0DurationHours: 72, // v0.1.2 D2 initial 72
  t1MinValidRevs: 10, // v0.1.2 D2 initial 10
  t2MinDays: 14, // v0.1.2 D2 initial 14
  t2MinValidRevs: 100, // v0.1.2 D2 initial 100
  bootstrapWindowDays: 30, // v0.1.2 D7 initial 30
  arbiterSuspensionDays: 30, // v0.1.2 D6 initial 30
} as const;

export const agentpediaAlgoVersions = {
  adoption: 'adoption-algo-v1',
  reputation: 'reputation-algo-v1',
  arbiterDraw: 'arbiter-draw-v1',
} as const;

/**
 * Provenance and disclosed corrections for the composite schemas (v1.1), aligned
 * with chair errata E-3 (pin://b480f635eae531044fbb25768794a2fdd72167ededd0a63fff894973dae9dec5i0)
 * and its addendum (pin://390922537362e4acd2af95f79c19505d4c664b6347de6d99817f855075e8a42ei0).
 */
export const agentpediaCompositeMeta = {
  version: 'v1.1',
  resolution:
    'six valid spec layers + chair errata E-1/E-2/E-3 (+ E-3 addendum), latest-layer resolution; v0.1.4 voided, never referenced',
  e3Notes:
    'E3-5 (refs = editor self-reported integer count; "resolvable" = on-chain URI pattern-filter, replay never queries an indexer; Web2 URLs neither count nor block writes) is tool/engine SEMANTICS, not schema — implemented as dumb-pipe pass-through.',
  corrections: [
    {
      id: 'E3-1',
      schema: 'ruling',
      change:
        'challengePin/seed -> ["string","null"], outcome enum gains null: the vote branch requires all three null while literal v0.1 §5 typed them string/enum-only, rejecting every valid vote pin',
      authority: 'E-3',
    },
    {
      id: 'E3-2',
      schema: 'constitution',
      change:
        'founders bidirectional conditions: revision=0 -> required array (2..64); revision>0 -> const null',
      authority: 'E-3',
    },
    {
      id: 'E3-3',
      schema: 'ruling.params.fromEntry/toEntry',
      change: 'lang segment tightened to lowercase ^[a-z]{2,8}: per X1 (F-β)',
      authority: 'E-3; ruling pin://054ae26164d34f15884b218667b84ea7127ddbc9b73642094eec75867ebaa557i0',
    },
    {
      id: 'E3-4',
      schema: 'constitution.params',
      change:
        'arbiterSuspensionDays properties-only (not in required) + minimum 0 — D6 "入宪法" lacks the explicit required-sync wording D2/X8 used; min 0 follows the theta* disable precedent',
      authority: 'E-3; ruling pin://cb4caacad6b1687fbd13fab804138f335ffa420c042fa735cd809b0ab593f06fi0',
    },
    {
      id: 'redirectTo-pattern',
      schema: 'rev',
      change:
        'redirectTo pattern rebuilt as char-class {1,96} (a prior build emitted "+{1,96}", a JS-invalid regex). E-3 effect statement classifies this as an implementation typo fixed by hotfix, not an erratum item',
      authority: 'E-3 effect statement',
    },
  ],
} as const;
