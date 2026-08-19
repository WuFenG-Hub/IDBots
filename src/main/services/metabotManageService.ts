/**
 * Shared MetaBot management orchestration.
 *
 * These pure, deps-injected functions hold the create / update / delete / list
 * logic that used to live inline inside main.ts IPC handlers. Both the IPC
 * handlers (the manual UI path) and the Twin-only builtin tools
 * (libs/metabotManageAgentTools.ts) call them, so a bot created or edited by
 * the Twin runs through the EXACT same code as one created/edited by hand —
 * including wallet generation, gas subsidy, on-chain pin publishing and
 * rollback. Keeping the deps injected keeps this unit-testable from compiled
 * output without touching the network or SQLite.
 */

import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import { getMetabotLimitError } from '../shared/metabotLimit';
import { normalizeMetabotLlmId } from './llmFallback';
import { toLlmEffortLevel } from '../libs/llmEffort';

// ---------------------------------------------------------------------------
// Input shapes (mirror the IPC handler payloads; local to avoid cross-module coupling)
// ---------------------------------------------------------------------------

export interface CreateMetaBotOnChainInput {
  name: string;
  avatar?: string | null;
  role?: string;
  soul?: string;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility input; use bio. */
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  llm_id?: string | null;
  /** Provider key the brain model was picked from (id-collision disambiguation). */
  llm_provider?: string | null;
  /** Reasoning effort for the primary brain (off/low/high/max); null = model default. */
  llm_effort?: string | null;
  /** Optional fallback brain (model id or legacy provider key; never required). */
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  fallback_llm_effort?: string | null;
  allow_chat_skills?: string[];
  metabot_type?: 'twin' | 'worker';
  homepage?: string | null;
}

export interface UpdateMetaBotInput {
  name?: string;
  avatar?: string | null;
  enabled?: boolean;
  metabot_type?: 'twin' | 'worker';
  role?: string;
  soul?: string;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility input; use bio. */
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  llm_id?: string | null;
  llm_provider?: string | null;
  llm_effort?: string | null;
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  fallback_llm_effort?: string | null;
  allow_chat_skills?: string[];
  a2a_max_incoming_turns?: number | null;
  a2a_bye_cooldown_ms?: number | null;
  a2a_auto_reply_enabled?: boolean | null;
  homepage?: string | null;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Fields produced by createMetaBotWallet() that the core needs. */
export interface MetabotWalletCreation {
  mnemonic: string;
  path: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  metaid: string;
  globalmetaid: string;
}

export interface OwnerBindingSignResult {
  payload?: string;
  error?: string;
}

/** Minimal subset of SyncMetaBotResult / SyncMetaBotEditChangesResult that we consume. */
export interface ChainSyncResult {
  success: boolean;
  canSkip?: boolean;
  error?: string;
  txids?: string[];
  syncedSteps?: string[];
}

/** On-chain edit sync input (mirrors SyncMetaBotEditChangesInput). */
export interface EditSyncInput {
  metabotId: number;
  syncName?: boolean;
  syncAvatar?: boolean;
  syncBio?: boolean;
  syncPersona?: boolean;
  syncLlm?: boolean;
  syncChatSkills?: boolean;
  syncHomepage?: boolean;
  /** Publish an /info/owner pin: signed binding payload, or '' to unbind. */
  syncOwner?: boolean;
  ownerBindingPayload?: string | null;
}

export interface MetabotManageDeps {
  store: MetabotStore;
  /** Generate a fresh in-memory MetaBot wallet (mnemonic + addresses + keys + metaid). */
  createWallet: () => Promise<MetabotWalletCreation>;
  /** Best-effort MVC gas subsidy for a brand-new bot wallet. */
  requestSubsidy: (p: { mvcAddress: string; mnemonic: string; path: string }) => Promise<{ success: boolean; error?: string }>;
  /** Sign an /info/owner binding against the local user identity. */
  signOwnerBinding: (bossGlobalMetaId: string, botGlobalMetaId: string | null | undefined) => Promise<OwnerBindingSignResult>;
  /** Full sync used at creation time (name/avatar/chatpubkey/bio/[owner]). */
  syncToChain: (
    store: MetabotStore,
    metabotId: number,
    options: { ownerBindingPayload?: string | null },
  ) => Promise<ChainSyncResult>;
  /** Edit-sync used on updates; publishes only the changed info pins. */
  syncEditChanges: (store: MetabotStore, input: EditSyncInput) => Promise<ChainSyncResult>;
  /** Refresh P2P runtime config after a create/delete (best-effort). */
  onAfterMutation?: () => Promise<void> | void;
  /** Optional post-delete hook receiving the deleted bot (e.g. cleanup side-effects). */
  onAfterDelete?: (deletedMetabot: Metabot) => Promise<void> | void;
  /** Active owner GlobalMetaID; used for the owner-binding identity check. */
  getOwnerGlobalMetaId?: () => string | null;
  /**
   * Read the configured LLM providers (app_config.providers) for the legacy
   * provider-key write guard. When absent/unreadable the guard is skipped
   * rather than blocking the write.
   */
  getLlmProviders?: () => Record<string, {
    enabled?: boolean;
    models?: Array<{ id?: string }>;
  } | undefined> | undefined;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface CreateMetaBotOnChainResult {
  success: boolean;
  metabot?: Metabot;
  subsidy?: { success: boolean; error?: string };
  chainPartial?: boolean;
  chainError?: string;
  error?: string;
}

export interface UpdateMetaBotLocalResult {
  success: boolean;
  metabot?: Metabot;
  error?: string;
}

export interface UpdateMetaBotResult {
  success: boolean;
  metabot?: Metabot;
  /** On-chain sync outcome (absent when there was nothing to publish). */
  sync?: {
    skipped: boolean;
    success: boolean;
    canSkip?: boolean;
    error?: string;
    txids?: string[];
    syncedSteps?: string[];
    /** Steps this update tried to publish (for the modal's checkmark display). */
    attemptedStepKeys?: SyncStepKey[];
    /**
     * Steps still unpublished after the core's auto-retry. The renderer's manual
     * Retry button forwards this to idbots:syncMetaBotEditChanges so re-sync only
     * republishes what is left (on-chain pins are NOT idempotent).
     */
    remainingSyncInput?: EditSyncInput;
  };
  error?: string;
}

export interface DeleteMetaBotResult {
  success: boolean;
  error?: string;
}

export interface ManagedMetabotSummary {
  id: number;
  name: string;
  type: 'twin' | 'worker' | 'welcome';
  enabled: boolean;
  llm_id: string | null;
  llm_effort: string | null;
  fallback_llm_id: string | null;
  fallback_llm_effort: string | null;
  role: string;
  soul: string;
  goal: string | null;
  bio: string | null;
  allow_chat_skills: string[];
  a2a_max_incoming_turns: number | null;
  a2a_bye_cooldown_ms: number | null;
  a2a_auto_reply_enabled: boolean | null;
  globalMetaID: string | null;
}

export interface LlmProviderOption {
  id: string;
  label: string;
  /** Models this provider offers (model-level brains pick from these). */
  models?: Array<{ id: string; name: string }>;
}

// ---------------------------------------------------------------------------
// Small shared helpers (also reused by main.ts)
// ---------------------------------------------------------------------------

/** Validate + normalize the required primary LLM brain value for creation. */
export function requireMetabotLlmIdForCreate(value: unknown): string {
  const llmId = typeof value === 'string' ? value.trim() : '';
  if (!llmId) {
    throw new Error('LLM Brain is required when creating a MetaBot');
  }
  return llmId;
}

/**
 * Write-time guard against re-introducing legacy-shaped brain values:
 * `llm_id` / `fallback_llm_id` hold a MODEL id; a value equal to a provider
 * KEY (e.g. 'opencode') is the pre-migration legacy shape and silently
 * misresolves. Returns an actionable error message, or null when the value is
 * acceptable — including when the provider catalog is unavailable (the guard
 * never blocks a write it cannot judge) or when the value is a genuine model
 * id that happens to equal a provider key.
 */
export function legacyLlmProviderKeyError(
  field: 'llm_id' | 'fallback_llm_id',
  value: unknown,
  providers: Record<string, { enabled?: boolean; models?: Array<{ id?: string }> } | undefined> | undefined,
): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || !providers) return null;
  for (const provider of Object.values(providers)) {
    if (provider?.models?.some((model) => model?.id === trimmed)) return null;
  }
  const needle = trimmed.toLowerCase();
  for (const [key, provider] of Object.entries(providers)) {
    if (key.toLowerCase() !== needle) continue;
    const providerField = field === 'llm_id' ? 'llm_provider' : 'fallback_llm_provider';
    const firstModel = provider?.models?.find((model) => typeof model?.id === 'string' && model.id)?.id;
    const example = firstModel ? ` (e.g. '${firstModel}')` : '';
    return `${field} '${trimmed}' is a provider id; pass a MODEL id${example} with ${providerField}='${key}'`;
  }
  return null;
}

/**
 * Normalize a brain reasoning-effort value for storage onto the app-wide
 * off/low/high/max ladder (see llmEffort.ts); null/unknown means "model default".
 */
export function normalizeMetabotLlmEffort(value: unknown): string | null {
  return toLlmEffortLevel(value);
}

/** Throw the limit-reached error when the machine already holds the max bot count. */
export function assertCanCreateMetabot(store: MetabotStore): void {
  const error = getMetabotLimitError(store.listMetabots().length);
  if (error) {
    throw new Error(error);
  }
}

const MAX_TEXT_LENGTH = 4_000;

function boundText(value: string | null | undefined, maxLength = MAX_TEXT_LENGTH): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function normalizedList(values: string[] | null | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean)));
}

/** Incremental add/remove against a chat-skill whitelist. Other items are preserved. */
export function applyChatSkillOp(
  current: string[] | null | undefined,
  op: { action: 'add' | 'remove'; skill: string },
): string[] {
  const skill = String(op.skill ?? '').trim();
  const list = normalizedList(current);
  if (!skill) return list;
  if (op.action === 'add') {
    return list.includes(skill) ? list : [...list, skill];
  }
  return list.filter((item) => item !== skill);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a MetaBot end-to-end: wallet → gas subsidy → DB insert → on-chain
 * publish → P2P refresh. Behavior-preserving lift of the original
 * idbots:createMetaBotOnChain IPC handler. Mandatory step (name) failure rolls
 * back the DB records; a partial publish (canSkip) still succeeds locally.
 */
export async function createMetaBotOnChainCore(
  input: CreateMetaBotOnChainInput,
  deps: MetabotManageDeps,
): Promise<CreateMetaBotOnChainResult> {
  const { store, createWallet, requestSubsidy, signOwnerBinding, syncToChain, onAfterMutation } = deps;
  let metabotId: number | null = null;
  try {
    assertCanCreateMetabot(store);
    const llmId = requireMetabotLlmIdForCreate(input.llm_id);
    const fallbackLlmId = normalizeMetabotLlmId(input.fallback_llm_id);
    // Reject legacy provider-key-shaped brain values (see legacyLlmProviderKeyError).
    const providers = deps.getLlmProviders?.();
    const primaryKeyError = legacyLlmProviderKeyError('llm_id', llmId, providers);
    if (primaryKeyError) throw new Error(primaryKeyError);
    const fallbackKeyError = legacyLlmProviderKeyError('fallback_llm_id', fallbackLlmId, providers);
    if (fallbackKeyError) throw new Error(fallbackKeyError);

    // 1. Generate wallet (in-memory)
    const walletResult = await createWallet();
    const metabotType = input.metabot_type === 'twin' ? 'twin' : 'worker';

    // 2. Request gas subsidy (best-effort; don't fail creation if subsidy fails)
    let subsidyResult: { success: boolean; error?: string } = { success: false };
    try {
      subsidyResult = await requestSubsidy({
        mvcAddress: walletResult.mvc_address,
        mnemonic: walletResult.mnemonic,
        path: walletResult.path,
      });
    } catch (e) {
      subsidyResult = { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    // 3. Insert wallet + metabot into DB (syncMetaBotToChain reads from DB)
    const wallet = store.insertMetabotWallet({
      mnemonic: walletResult.mnemonic,
      path: walletResult.path,
    });

    const metabot = store.createMetabot({
      wallet_id: wallet.id,
      mvc_address: walletResult.mvc_address,
      btc_address: walletResult.btc_address,
      doge_address: walletResult.doge_address,
      public_key: walletResult.public_key,
      chat_public_key: walletResult.chat_public_key,
      chat_public_key_pin_id: null,
      name: input.name,
      avatar: input.avatar ?? null,
      enabled: true,
      metaid: walletResult.metaid,
      globalmetaid: walletResult.globalmetaid,
      metabot_info_pinid: null,
      metabot_type: metabotType,
      created_by: '0000',
      // Minimal creation may omit persona fields; store empty strings and let
      // the sync plan skip the empty persona/bio pins.
      role: (input.role ?? '').trim(),
      soul: (input.soul ?? '').trim(),
      goal: input.goal ?? null,
      bio: input.bio !== undefined ? input.bio : (input.background ?? null),
      boss_id: null,
      boss_global_metaid: (input.boss_global_metaid ?? '').trim() || null,
      llm_id: llmId,
      llm_provider: normalizeMetabotLlmId(input.llm_provider),
      llm_effort: normalizeMetabotLlmEffort(input.llm_effort),
      fallback_llm_id: fallbackLlmId,
      fallback_llm_provider: normalizeMetabotLlmId(input.fallback_llm_provider),
      fallback_llm_effort: normalizeMetabotLlmEffort(input.fallback_llm_effort),
      tools: [],
      skills: [],
      allow_chat_skills: input.allow_chat_skills ?? [],
      homepage: input.homepage ?? null,
    });
    metabotId = metabot.id;

    // 4. Sign the owner binding when a boss GlobalMetaID was requested; it
    // must belong to the local user identity (signed consent).
    let ownerBindingPayload: string | undefined;
    const bossGlobalMetaId = (input.boss_global_metaid ?? '').trim();
    if (bossGlobalMetaId) {
      const signResult = await signOwnerBinding(bossGlobalMetaId, metabot.globalmetaid);
      if (signResult.error) {
        store.deleteMetabot(metabot.id);
        return { success: false, error: signResult.error };
      }
      ownerBindingPayload = signResult.payload;
    }

    // 5. Publish to chain (name + avatar + chatpubkey + bio [+ owner])
    const syncResult = await syncToChain(store, metabot.id, { ownerBindingPayload });

    if (!syncResult.success && !syncResult.canSkip) {
      // Mandatory step (name) failed — roll back DB records
      store.deleteMetabot(metabot.id);
      return { success: false, error: syncResult.error ?? 'Chain publish failed' };
    }

    // 5b. Chain succeeded (or partial with canSkip) — reload metabot with updated pinIds
    const updatedMetabot = store.getMetabotById(metabot.id) ?? metabot;
    await onAfterMutation?.();
    return {
      success: true,
      metabot: updatedMetabot,
      subsidy: subsidyResult,
      chainPartial: !syncResult.success && syncResult.canSkip,
      chainError: syncResult.canSkip ? syncResult.error : undefined,
    };
  } catch (error) {
    // Roll back DB records on unexpected error
    if (metabotId != null) {
      try {
        store.deleteMetabot(metabotId);
      } catch {
        /* ignore */
      }
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[metabotManage] createMetaBotOnChainCore failed:', errMsg);
    return { success: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Update (local write shared by UI + tool)
// ---------------------------------------------------------------------------

/**
 * Validate + persist a metabot update locally (the DB write half of an edit).
 * Enforces the owner-binding identity check when boss_global_metaid is touched.
 * Shared by the metabot:update IPC handler and the Twin update tool so both
 * paths normalize input identically.
 */
export function applyMetabotUpdateLocal(
  store: MetabotStore,
  id: number,
  input: UpdateMetaBotInput,
  deps: Pick<MetabotManageDeps, 'getOwnerGlobalMetaId' | 'getLlmProviders'>,
): UpdateMetaBotLocalResult {
  try {
    // Owner claims must belong to the local user identity; anything else is an
    // unsigned unilateral claim, which this feature removes.
    if (input.boss_global_metaid !== undefined) {
      const trimmedBoss = (input.boss_global_metaid ?? '').trim();
      if (trimmedBoss) {
        const owner = deps.getOwnerGlobalMetaId?.() ?? null;
        if (!owner || owner.toLowerCase() !== trimmedBoss.toLowerCase()) {
          return { success: false, error: 'OWNER_IDENTITY_MISMATCH' };
        }
      }
    }
    // Reject legacy provider-key-shaped brain values (see legacyLlmProviderKeyError).
    const providers = deps.getLlmProviders?.();
    const primaryKeyError = legacyLlmProviderKeyError('llm_id', input.llm_id, providers);
    if (primaryKeyError) {
      return { success: false, error: primaryKeyError };
    }
    const fallbackKeyError = legacyLlmProviderKeyError('fallback_llm_id', input.fallback_llm_id, providers);
    if (fallbackKeyError) {
      return { success: false, error: fallbackKeyError };
    }
    const metabot = store.updateMetabot(id, {
      ...input,
      boss_global_metaid:
        input.boss_global_metaid === undefined
          ? undefined
          : ((input.boss_global_metaid ?? '').trim() || null),
      llm_provider:
        input.llm_provider === undefined
          ? undefined
          : normalizeMetabotLlmId(input.llm_provider),
      llm_effort:
        input.llm_effort === undefined
          ? undefined
          : normalizeMetabotLlmEffort(input.llm_effort),
      fallback_llm_id:
        input.fallback_llm_id === undefined
          ? undefined
          : normalizeMetabotLlmId(input.fallback_llm_id),
      fallback_llm_provider:
        input.fallback_llm_provider === undefined
          ? undefined
          : normalizeMetabotLlmId(input.fallback_llm_provider),
      fallback_llm_effort:
        input.fallback_llm_effort === undefined
          ? undefined
          : normalizeMetabotLlmEffort(input.fallback_llm_effort),
    });
    return { success: true, metabot };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update metabot',
    };
  }
}

/**
 * Compute which on-chain sync groups an update should publish, mirroring the
 * renderer's MetabotsManager.saveEditFields diff. Returns the EditSyncInput
 * flags (all false ⇒ nothing to publish; the change is local-only such as a
 * Twin transfer or an A2A chat-limit knob).
 */
export function buildEditSyncFlags(
  before: Metabot,
  input: UpdateMetaBotInput,
): EditSyncInput {
  const nextName = input.name !== undefined ? input.name.trim() : before.name;
  const nextAvatar = input.avatar !== undefined ? (input.avatar ?? '').trim() : (before.avatar ?? '');
  const nextBio =
    input.bio !== undefined
      ? input.bio
      : input.background !== undefined
        ? input.background
        : before.bio;
  const nextRole = input.role !== undefined ? input.role.trim() : before.role;
  const nextSoul = input.soul !== undefined ? input.soul.trim() : before.soul;
  const nextGoal = input.goal !== undefined ? input.goal : before.goal;
  const nextLlm = input.llm_id !== undefined ? (input.llm_id ?? '').trim() : (before.llm_id ?? '');
  const nextFallbackLlm =
    input.fallback_llm_id !== undefined
      ? (input.fallback_llm_id ?? '').trim()
      : (before.fallback_llm_id ?? '');
  const nextAllowChatSkills = normalizedList(
    input.allow_chat_skills !== undefined ? input.allow_chat_skills : before.allow_chat_skills,
  );
  const nextHomepage = input.homepage !== undefined ? input.homepage : before.homepage;

  const syncName = nextName !== before.name;
  const syncAvatar = nextAvatar !== (before.avatar ?? '');
  const syncBio = (nextBio ?? '') !== (before.bio ?? '');
  const syncPersona = nextRole !== before.role || nextSoul !== before.soul || (nextGoal ?? '') !== (before.goal ?? '');
  const syncLlm = nextLlm !== (before.llm_id ?? '') || nextFallbackLlm !== (before.fallback_llm_id ?? '');
  const syncChatSkills = JSON.stringify(nextAllowChatSkills) !== JSON.stringify(normalizedList(before.allow_chat_skills));
  const syncHomepage = (nextHomepage ?? null) !== (before.homepage ?? null);

  // Owner binding is published only when boss_global_metaid actually changed.
  let syncOwner = false;
  if (input.boss_global_metaid !== undefined) {
    syncOwner = (input.boss_global_metaid ?? '').trim() !== ((before.boss_global_metaid ?? '').trim());
  }

  return {
    metabotId: before.id,
    syncName,
    syncAvatar,
    syncBio,
    syncPersona,
    syncLlm,
    syncChatSkills,
    syncHomepage,
    syncOwner,
  };
}

/** On-chain info steps an update can publish (mirrors the modal's SyncStepKey). */
export type SyncStepKey =
  | 'name'
  | 'avatar'
  | 'bio'
  | 'persona'
  | 'llm'
  | 'chatSkills'
  | 'homepage'
  | 'owner';

/** Boolean sync flags on EditSyncInput (everything except metabotId). */
type EditSyncFlagKey = Exclude<keyof EditSyncInput, 'metabotId' | 'ownerBindingPayload'>;

/** Ordered step↔flag pairs driving the plan ↔ display-key mapping below. */
const STEP_TO_FLAG: ReadonlyArray<readonly [SyncStepKey, EditSyncFlagKey]> = [
  ['name', 'syncName'],
  ['avatar', 'syncAvatar'],
  ['bio', 'syncBio'],
  ['persona', 'syncPersona'],
  ['llm', 'syncLlm'],
  ['chatSkills', 'syncChatSkills'],
  ['homepage', 'syncHomepage'],
  ['owner', 'syncOwner'],
];

const EDIT_SYNC_RETRY_DELAY_MS = 2500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True flags → ordered display step keys (for the modal's checkmarks). */
function flagsToStepKeys(plan: EditSyncInput): SyncStepKey[] {
  return STEP_TO_FLAG.filter(([, flag]) => plan[flag] === true).map(([step]) => step);
}

/** Whether a plan still has any step left to publish. */
function hasAnySyncFlag(plan: EditSyncInput): boolean {
  return flagsToStepKeys(plan).length > 0;
}

/**
 * Return a copy of `plan` with every step listed in `syncedSteps` zeroed out.
 * Used so a retry only republishes the steps that did NOT confirm — on-chain
 * pins are not idempotent, so re-publishing a synced step would create a
 * duplicate pin and waste gas.
 */
function subtractSyncedFlags(plan: EditSyncInput, syncedSteps: string[]): EditSyncInput {
  const synced = new Set(syncedSteps);
  const next: EditSyncInput = { metabotId: plan.metabotId };
  for (const [step, flag] of STEP_TO_FLAG) {
    next[flag] = plan[flag] === true && !synced.has(step);
  }
  return next;
}

/** A fully-formed plan with every sync flag false (nothing left to publish). */
function emptyEditSyncPlan(metabotId: number): EditSyncInput {
  const plan: EditSyncInput = { metabotId };
  for (const [, flag] of STEP_TO_FLAG) {
    plan[flag] = false;
  }
  return plan;
}

/**
 * Apply a metabot update locally and then publish the changed info pins to the
 * chain. Single source of truth for the on-chain sync plan (buildEditSyncFlags)
 * — called by BOTH the metabot:update IPC handler (manual UI path) and the Twin
 * metabot_update tool, so the two paths are identical. Best-effort: a partial
 * publish still counts as success locally. Includes one auto-retry over the
 * still-unpublished steps. Returns the attempted step keys (for display) and
 * the remaining plan (for the UI's manual Retry button).
 */
export async function updateMetaBotCore(
  id: number,
  input: UpdateMetaBotInput,
  deps: MetabotManageDeps,
): Promise<UpdateMetaBotResult> {
  const { store, syncEditChanges } = deps;
  const before = store.getMetabotById(id);
  if (!before) {
    return { success: false, error: `MetaBot ${id} not found` };
  }

  const local = applyMetabotUpdateLocal(store, id, input, deps);
  if (!local.success || !local.metabot) {
    return { success: false, error: local.error };
  }

  const flags = buildEditSyncFlags(before, input);
  const attemptedStepKeys = flagsToStepKeys(flags);
  const emptyRemaining: EditSyncInput = emptyEditSyncPlan(id);

  if (attemptedStepKeys.length === 0) {
    // Local-only change (metabot_type transfer, A2A knobs, enable toggle).
    return {
      success: true,
      metabot: local.metabot,
      sync: { skipped: true, success: true, attemptedStepKeys, remainingSyncInput: emptyRemaining },
    };
  }

  // Resolve a signed owner payload once; reused across the initial attempt and
  // the auto-retry (the signed string does not change between attempts).
  let ownerBindingPayload: string | null | undefined;
  if (flags.syncOwner) {
    const bossGlobalMetaId = (input.boss_global_metaid ?? '').trim();
    if (bossGlobalMetaId) {
      const signResult = await deps.signOwnerBinding(bossGlobalMetaId, before.globalmetaid);
      if (signResult.error) {
        return { success: false, error: signResult.error };
      }
      ownerBindingPayload = signResult.payload ?? null;
    } else {
      // Unbind: empty payload clears the on-chain /info/owner pin.
      ownerBindingPayload = '';
    }
  }

  let plan: EditSyncInput = { ...flags, ownerBindingPayload };
  let syncResult: ChainSyncResult;
  try {
    syncResult = await syncEditChanges(store, plan);

    // Auto-retry once over the steps that did not confirm (transient indexer
    // timing / UTXO races). Only remaining steps are re-published.
    if (!syncResult.success) {
      const remaining = subtractSyncedFlags(plan, syncResult.syncedSteps ?? []);
      if (hasAnySyncFlag(remaining)) {
        await sleep(EDIT_SYNC_RETRY_DELAY_MS);
        plan = { ...remaining, ownerBindingPayload: remaining.syncOwner ? ownerBindingPayload : undefined };
        const retryResult = await syncEditChanges(store, plan);
        // Fold the retry's outcome into the running result: combine txids and
        // synced steps so the caller sees the full picture.
        syncResult = {
          success: retryResult.success,
          canSkip: retryResult.canSkip,
          error: retryResult.error ?? syncResult.error,
          txids: [...(syncResult.txids ?? []), ...(retryResult.txids ?? [])],
          syncedSteps: [...(syncResult.syncedSteps ?? []), ...(retryResult.syncedSteps ?? [])],
        };
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      success: true,
      metabot: local.metabot,
      sync: {
        skipped: false,
        success: false,
        error: errMsg,
        attemptedStepKeys,
        remainingSyncInput: plan,
      },
    };
  }

  const updated = store.getMetabotById(id) ?? local.metabot;
  const overallSuccess = syncResult.success || Boolean(syncResult.canSkip);
  const remainingAfter = subtractSyncedFlags({ ...flags, ownerBindingPayload }, syncResult.syncedSteps ?? []);
  return {
    success: overallSuccess,
    metabot: updated,
    sync: {
      skipped: false,
      success: syncResult.success,
      canSkip: syncResult.canSkip,
      error: syncResult.error,
      txids: syncResult.txids,
      syncedSteps: syncResult.syncedSteps,
      attemptedStepKeys,
      remainingSyncInput: hasAnySyncFlag(remainingAfter)
        ? { ...remainingAfter, ownerBindingPayload: remainingAfter.syncOwner ? ownerBindingPayload : undefined }
        : emptyRemaining,
    },
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a metabot, then restore the machine-wide "exactly one Twin"
 * invariant and refresh the P2P runtime config. Refuses to delete the last
 * remaining bot so the machine is never left botless.
 */
export async function deleteMetaBotCore(
  id: number,
  deps: Pick<MetabotManageDeps, 'store' | 'onAfterMutation' | 'onAfterDelete'>,
): Promise<DeleteMetaBotResult> {
  const { store, onAfterMutation, onAfterDelete } = deps;
  const existing = store.getMetabotById(id);
  if (!existing) {
    return { success: false, error: `MetaBot ${id} not found` };
  }
  if (store.listMetabots().length <= 1) {
    return { success: false, error: 'Cannot delete the last remaining MetaBot.' };
  }
  const ok = store.deleteMetabot(id);
  if (ok) {
    // Deleting the Twin must transfer Twin status to the earliest remaining bot.
    store.ensureTwinExists();
    await onAfterMutation?.();
    await onAfterDelete?.(existing);
  }
  return { success: ok };
}

// ---------------------------------------------------------------------------
// List + provider listing (read-only helpers for the Twin tool)
// ---------------------------------------------------------------------------

/** Sanitized editable-field view of every bot, for the Twin management tool. */
export function listMetabotsForManagement(store: MetabotStore): ManagedMetabotSummary[] {
  return store.listMetabots().map((m) => ({
    id: m.id,
    name: m.name.trim(),
    type: m.metabot_type,
    enabled: m.enabled,
    llm_id: m.llm_id ?? null,
    llm_effort: m.llm_effort ?? null,
    fallback_llm_id: m.fallback_llm_id ?? null,
    fallback_llm_effort: m.fallback_llm_effort ?? null,
    role: boundText(m.role),
    soul: boundText(m.soul),
    goal: boundText(m.goal) || null,
    bio: boundText(m.bio ?? m.background) || null,
    allow_chat_skills: normalizedList(m.allow_chat_skills),
    a2a_max_incoming_turns: m.a2a_max_incoming_turns ?? null,
    a2a_bye_cooldown_ms: m.a2a_bye_cooldown_ms ?? null,
    a2a_auto_reply_enabled: m.a2a_auto_reply_enabled ?? null,
    globalMetaID: (m.globalmetaid ?? '').trim() || null,
  }));
}

const providerRequiresApiKey = (key: string) => key !== 'ollama';
const providerLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

/**
 * Configured LLM providers a new/edited bot may use: enabled and (for non-ollama)
 * carrying an API key, with each provider's models. Mirrors the renderer's
 * model-catalog filter (including custom-* providers) so the Twin offers the
 * exact same brains the manual picker does.
 */
export function listConfiguredLlmProviders(
  providers: Record<string, {
    enabled?: boolean;
    apiKey?: string;
    name?: string;
    models?: Array<{ id?: string; name?: string }> | undefined;
  } | undefined> | undefined,
): LlmProviderOption[] {
  if (!providers) return [];
  const configured: LlmProviderOption[] = [];
  for (const [key, p] of Object.entries(providers)) {
    if (!p?.enabled) continue;
    if (providerRequiresApiKey(key) && !(p.apiKey ?? '').trim()) continue;
    const models = (p.models ?? [])
      .filter((model) => typeof model?.id === 'string' && model.id.trim())
      .map((model) => ({ id: model.id as string, name: (model.name ?? '').trim() || (model.id as string) }));
    configured.push({
      id: key,
      label: (p.name ?? '').trim() || providerLabel(key),
      ...(models.length > 0 ? { models } : {}),
    });
  }
  return configured;
}
