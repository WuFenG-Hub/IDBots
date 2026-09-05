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
import { stripLoneSurrogates, truncateUtf16Units } from '../libs/llmSafeText';
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
  /** Step keys the full sync planned to publish (create-path partial reporting). */
  plannedSteps?: string[];
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
  /**
   * Skill-assignment write seam (wired to SkillManager.applyMetabotAssignedSkills).
   * Called whenever an update carries allow_chat_skills / chat_skill_op — the
   * on-chain published whitelist stays the metabots.allow_chat_skills column,
   * but the local authorization source of truth is the assignment table, so
   * every whitelist write must also replace that bot's assignment rows.
   * Absent = assignment write skipped (bare-embedding callers).
   */
  applyChatSkillAssignments?: (metabotId: number, skillIdsOrNames: readonly string[]) => string[];
  /**
   * Balance pre-check seam (wired to addressBalanceService). Returns the MVC
   * address balance in satoshis AFTER the gas subsidy settled, or null when
   * the balance API itself failed (pre-check then fails open). Absent = the
   * create-time balance gate is skipped entirely (tests, bare-embedding callers).
   */
  checkWalletBalance?: (mvcAddress: string) => Promise<number | null>;
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
  const text = stripLoneSurrogates(String(value ?? '').trim());
  if (!text) return '';
  return text.length <= maxLength ? text : `${truncateUtf16Units(text, maxLength - 1)}…`;
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
// Chain-sync pending state (partial-publish persistence, FR4)
// ---------------------------------------------------------------------------

/**
 * metabot_settings key holding the on-chain steps that were planned but never
 * confirmed (create partial / edit partial). An empty/absent step list means
 * "nothing pending" — the value is written as `{"remainingSteps":[],...}` on
 * completion so the row doubles as a "cleared" marker without needing a
 * settings-delete path.
 */
const CHAIN_SYNC_PENDING_KEY = 'chainSyncPending';

export interface ChainSyncPending {
  /** Step keys still unpublished (subset of the sync step vocabulary). */
  remainingSteps: string[];
  error?: string;
  updatedAt: number;
}

/** Read the persisted pending plan; null when absent or already empty. */
export function readChainSyncPending(store: MetabotStore, metabotId: number): ChainSyncPending | null {
  try {
    const raw = store.getMetabotSetting(metabotId, CHAIN_SYNC_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChainSyncPending>;
    const remainingSteps = Array.isArray(parsed.remainingSteps)
      ? parsed.remainingSteps.map((s) => String(s)).filter(Boolean)
      : [];
    if (remainingSteps.length === 0) return null;
    return {
      remainingSteps,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

/** Persist (or clear, when steps are empty) the pending sync plan. Best-effort. */
function writeChainSyncPending(
  store: MetabotStore,
  metabotId: number,
  pending: { remainingSteps: string[]; error?: string } | null,
): void {
  try {
    store.setMetabotSetting(
      metabotId,
      CHAIN_SYNC_PENDING_KEY,
      JSON.stringify({
        remainingSteps: pending?.remainingSteps ?? [],
        error: pending?.error,
        updatedAt: Date.now(),
      }),
    );
  } catch (error) {
    console.warn(
      `[metabotManage] failed to persist chainSyncPending for metabot ${metabotId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface MetabotChainSyncStateView {
  state: 'synced' | 'partial';
  /** Steps still unpublished (empty for synced, and for partials created before this tracking existed). */
  pendingSteps: string[];
}

/**
 * Derive the bot's chain-sync state for the UI. Never reports synced without a
 * pin on record: a pending plan wins, then metabot_info_pinid (a confirmed
 * profile pin) — anything else is partial, matching the legacy
 * isChainSynced badge fallback.
 */
export function deriveChainSyncState(
  metabot: Pick<Metabot, 'metabot_info_pinid' | 'globalmetaid'>,
  pending: ChainSyncPending | null,
): MetabotChainSyncStateView {
  if (pending && pending.remainingSteps.length > 0) {
    return { state: 'partial', pendingSteps: pending.remainingSteps };
  }
  if (metabot.metabot_info_pinid && metabot.metabot_info_pinid.trim()) {
    return { state: 'synced', pendingSteps: [] };
  }
  return { state: 'partial', pendingSteps: [] };
}

/**
 * Persist the pending plan from a FULL sync outcome (create path and the
 * manual idbots:syncMetaBot resync path): everything planned-but-unconfirmed
 * becomes the bot's pending steps; a fully confirmed sync clears the plan.
 */
export function recordFullSyncOutcome(
  store: MetabotStore,
  metabotId: number,
  outcome: { plannedSteps?: string[]; syncedSteps?: string[]; error?: string },
): void {
  const planned = outcome.plannedSteps ?? [];
  const synced = new Set(outcome.syncedSteps ?? []);
  const remainingSteps = planned.filter((step) => !synced.has(step));
  writeChainSyncPending(
    store,
    metabotId,
    remainingSteps.length > 0 ? { remainingSteps, error: outcome.error } : null,
  );
}

/** Convenience wrapper: read persisted pending + derive in one call. */
export function getMetabotChainSyncState(
  store: MetabotStore,
  metabot: Pick<Metabot, 'id' | 'metabot_info_pinid' | 'globalmetaid'>,
): MetabotChainSyncStateView {
  return deriveChainSyncState(metabot, readChainSyncPending(store, metabot.id));
}

/**
 * Fold a re-sync's confirmed steps into the persisted pending plan (a retry
 * only republishes what is left — on-chain pins are NOT idempotent). Called
 * from the sync IPC handlers after every edit-changes sync attempt.
 */
export function applyChainSyncProgress(store: MetabotStore, metabotId: number, syncedSteps: string[]): void {
  const pending = readChainSyncPending(store, metabotId);
  if (!pending) return;
  const synced = new Set(syncedSteps);
  const remainingSteps = pending.remainingSteps.filter((step) => !synced.has(step));
  if (remainingSteps.length === pending.remainingSteps.length) return;
  writeChainSyncPending(
    store,
    metabotId,
    remainingSteps.length > 0 ? { remainingSteps, error: pending.error } : null,
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Conservative floor for the freshly-subsidized wallet to even start creating:
 * a minimal create publishes name + chatpubkey + llm pins, each costing a few
 * hundred sats. Below this the name pin may land but the rest is doomed to a
 * partial publish, so we refuse up front with the shortfall instead.
 * Calibrate against observed pin fees when chain rates change.
 */
const MIN_CREATE_GAS_SATS = 1400;

/**
 * Create a MetaBot end-to-end: wallet → gas subsidy → balance gate → DB insert
 * → on-chain publish → P2P refresh. Behavior-preserving lift of the original
 * idbots:createMetaBotOnChain IPC handler. Mandatory step (name) failure rolls
 * back the DB records; a partial publish (canSkip) still succeeds locally and
 * its unpublished steps are persisted as the bot's chainSyncPending plan.
 */
export async function createMetaBotOnChainCore(
  input: CreateMetaBotOnChainInput,
  deps: MetabotManageDeps,
): Promise<CreateMetaBotOnChainResult> {
  const { store, createWallet, requestSubsidy, signOwnerBinding, syncToChain, onAfterMutation } = deps;
  let metabotId: number | null = null;
  try {
    assertCanCreateMetabot(store);
    // Pre-create name check: metabots.name is UNIQUE — surface a clear error
    // up front instead of a raw constraint violation after wallet generation.
    const wantedName = String(input.name ?? '').trim();
    const nameConflict = wantedName
      ? store.listMetabots().find((m) => m.name.trim() === wantedName)
      : undefined;
    if (nameConflict) {
      return {
        success: false,
        error: `NAME_ALREADY_EXISTS: a MetaBot named "${wantedName}" already exists (id=${nameConflict.id}). Pick another name.`,
      };
    }
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

    // 2b. Balance gate: the fresh wallet (plus whatever the subsidy just
    // delivered) must cover the minimal create publish. Fails CLOSED on a
    // confirmed low spendable balance (MVC subsidy payouts arrive and stay
    // 0-conf yet spendable, so the seam must count mempool funds too) — with
    // the shortfall reported and nothing written, the "identity registered,
    // info-pins partial" state never starts. Fails OPEN when the balance API
    // itself errors (never block creation on an explorer outage). Skipped
    // when the seam is not wired.
    if (deps.checkWalletBalance) {
      let balanceSats: number | null = null;
      try {
        balanceSats = await deps.checkWalletBalance(walletResult.mvc_address);
      } catch {
        balanceSats = null;
      }
      if (balanceSats != null && balanceSats < MIN_CREATE_GAS_SATS) {
        // The subsidy result was previously swallowed here, leaving the gate
        // failure undiagnosable (paid-but-unspent vs payout-refused).
        console.warn(
          `[metabotManage] balance gate rejected create of "${wantedName}" at ${walletResult.mvc_address}:`,
          JSON.stringify({ balanceSats, minRequired: MIN_CREATE_GAS_SATS, subsidyResult }),
        );
        const subsidyNote = subsidyResult.success
          ? 'the gas subsidy claimed success but the funds are not spendable yet'
          : `the gas subsidy failed${subsidyResult.error ? ` (${subsidyResult.error})` : ''}`;
        return {
          success: false,
          error: `INSUFFICIENT_BALANCE: creating "${wantedName}" needs roughly ${MIN_CREATE_GAS_SATS}+ sats of chain fee, but the fresh wallet holds ${balanceSats} sats (short by ${MIN_CREATE_GAS_SATS - balanceSats} sats) — ${subsidyNote}. Top up MVC/SPACE gas for the bot wallet (or retry the gas subsidy) and create again — nothing was created.`,
        };
      }
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

    // Assignment-model backfill: a creation input carrying allow_chat_skills
    // (on-chain projection) must also seed the assignment rows (the local
    // authorization source of truth). Fail-closed with the same rollback the
    // other hard steps use — a column/row fork at creation never self-heals.
    if (
      input.allow_chat_skills !== undefined
      && normalizedList(input.allow_chat_skills).length > 0
      && deps.applyChatSkillAssignments
    ) {
      try {
        deps.applyChatSkillAssignments(metabot.id, normalizedList(input.allow_chat_skills));
      } catch (error) {
        store.deleteMetabot(metabot.id);
        return {
          success: false,
          error: `Chat-skill assignment seeding failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

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

    // 5b. Chain succeeded (or partial with canSkip) — persist what (if
    // anything) is still unpublished so the My Bots partial badge and the
    // re-sync entry have a durable, chain-honest plan to work from.
    if (metabot.id) {
      recordFullSyncOutcome(store, metabot.id, {
        plannedSteps: syncResult.plannedSteps,
        syncedSteps: syncResult.syncedSteps,
        error: syncResult.error,
      });
    }
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

  // Skill-assignment absorption: an update carrying allow_chat_skills (the
  // metabot_update tool folds chat_skill_op into it before reaching here)
  // rewrites that bot's assignment rows — the local authorization source of
  // truth — before the regular column write + on-chain sync proceed. The
  // resolved id list (bundled skills dropped, names resolved) replaces the
  // raw input so the published column and the assignment rows never diverge.
  if (input.allow_chat_skills !== undefined && deps.applyChatSkillAssignments) {
    // Fail-closed: assignment rows are the authorization source of truth, so
    // a failed write must abort the whole update — continuing would publish
    // the column on-chain while the local rows keep the OLD (possibly
    // revoked) grants, a permanent fork the user cannot see.
    let resolvedSkillIds: string[];
    try {
      resolvedSkillIds = deps.applyChatSkillAssignments(id, normalizedList(input.allow_chat_skills));
    } catch (error) {
      return {
        success: false,
        error: `Chat-skill assignment write failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    input = { ...input, allow_chat_skills: resolvedSkillIds };
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
    // Publish attempt blew up mid-flight: persist what was still in the plan
    // so the partial badge + re-sync survive a restart.
    writeChainSyncPending(store, id, { remainingSteps: flagsToStepKeys(plan), error: errMsg });
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
  const remainingAfterKeys = flagsToStepKeys(remainingAfter);
  writeChainSyncPending(
    store,
    id,
    remainingAfterKeys.length > 0 ? { remainingSteps: remainingAfterKeys, error: syncResult.error } : null,
  );
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
 * Delete a metabot, then restore a Twin from the earliest remaining
 * non-welcome bot (if any) and refresh the P2P runtime config. Refuses to
 * delete the last remaining bot so the machine is never left botless.
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
    // Deleting the Twin transfers Twin status to the earliest remaining
    // non-welcome bot when one exists; the Welcome Bot is never promoted.
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
