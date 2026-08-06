import { v4 as uuidv4 } from 'uuid';
import type {
  MetaIDMemoryGrant,
  MetaIDMemoryGrantStore,
} from '../metaidMemoryGrantStore';
import type { MetaIDImpressionStore } from '../metaidImpressionStore';
import {
  normalizeGlobalMetaID,
  type GlobalMetaID,
} from '../shared/globalMetaId';

export interface MetaIDMemoryAccessServiceDeps {
  grantStore: MetaIDMemoryGrantStore;
  impressionStore: MetaIDImpressionStore;
  /** Shared reads are disabled by default; explicit opt-in only. */
  enabled?: boolean;
  now?: () => number;
}

export interface MetaIDSharedSummaryReadResult {
  allowed: boolean;
  reasonCode: string;
  requestId: string;
  requestedAt: number;
  resourceOwnerGlobalMetaID: GlobalMetaID;
  readerGlobalMetaID: GlobalMetaID;
  subjectGlobalMetaID: GlobalMetaID;
  resourceType: 'snapshot';
  requestedCapability: 'read_summary';
  grantId: string | null;
  /** The owner's snapshot summary when allowed; never evidence or raw text. */
  summary: string | null;
  snapshotUpdatedAt: number | null;
  /** Shared context is always labeled; it never counts as direct interaction. */
  provenance: 'shared';
}

/**
 * Enforces explicit grants before any shared memory read. There is no implicit
 * Twin/Worker/Boss inheritance, no capability beyond read_summary in the first
 * delivery, and every decision is appended to the audit trail. This service is
 * deliberately read-only for evidence and snapshots: read_summary cannot read
 * evidence and cannot mutate snapshots.
 */
export class MetaIDMemoryAccessService {
  private readonly enabled: boolean;
  private readonly now: () => number;

  constructor(private readonly deps: MetaIDMemoryAccessServiceDeps) {
    this.enabled = deps.enabled === true;
    this.now = deps.now ?? Date.now;
  }

  private audit(input: {
    requestId: string;
    requestedAt: number;
    resourceOwnerGlobalMetaID: GlobalMetaID;
    readerGlobalMetaID: GlobalMetaID;
    subjectGlobalMetaID: GlobalMetaID;
    resourceType: string;
    requestedCapability: string;
    grantId?: string | null;
    outcome: 'allowed' | 'denied';
    reasonCode: string;
    scopeReference?: string | null;
  }): void {
    this.deps.grantStore.appendAudit({
      requestId: input.requestId,
      requestedAt: input.requestedAt,
      resourceOwnerGlobalMetaID: input.resourceOwnerGlobalMetaID,
      readerGlobalMetaID: input.readerGlobalMetaID,
      subjectGlobalMetaID: input.subjectGlobalMetaID,
      resourceType: input.resourceType,
      requestedCapability: input.requestedCapability,
      grantId: input.grantId ?? null,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      scopeReference: input.scopeReference ?? null,
    });
  }

  private denied(input: {
    reasonCode: string;
    requestId: string;
    requestedAt: number;
    resourceOwnerGlobalMetaID: GlobalMetaID;
    readerGlobalMetaID: GlobalMetaID;
    subjectGlobalMetaID: GlobalMetaID;
    grantId?: string | null;
  }): MetaIDSharedSummaryReadResult {
    return {
      allowed: false,
      reasonCode: input.reasonCode,
      requestId: input.requestId,
      requestedAt: input.requestedAt,
      resourceOwnerGlobalMetaID: input.resourceOwnerGlobalMetaID,
      readerGlobalMetaID: input.readerGlobalMetaID,
      subjectGlobalMetaID: input.subjectGlobalMetaID,
      resourceType: 'snapshot',
      requestedCapability: 'read_summary',
      grantId: input.grantId ?? null,
      summary: null,
      snapshotUpdatedAt: null,
      provenance: 'shared',
    };
  }

  async readSharedSummary(input: {
    requestId?: string;
    resourceOwnerGlobalMetaID: unknown;
    readerGlobalMetaID: unknown;
    subjectGlobalMetaID: unknown;
    scopeReference?: string | null;
  }): Promise<MetaIDSharedSummaryReadResult> {
    const requestId = (input.requestId ?? '').trim() || uuidv4();
    const requestedAt = this.now();
    const resourceOwnerGlobalMetaID = normalizeGlobalMetaID(input.resourceOwnerGlobalMetaID);
    const readerGlobalMetaID = normalizeGlobalMetaID(input.readerGlobalMetaID);
    const subjectGlobalMetaID = normalizeGlobalMetaID(input.subjectGlobalMetaID);
    if (
      !resourceOwnerGlobalMetaID
      || !readerGlobalMetaID
      || !subjectGlobalMetaID
      || resourceOwnerGlobalMetaID === readerGlobalMetaID
    ) {
      return {
        allowed: false,
        reasonCode: 'invalid_request',
        requestId,
        requestedAt,
        resourceOwnerGlobalMetaID: resourceOwnerGlobalMetaID ?? ('' as GlobalMetaID),
        readerGlobalMetaID: readerGlobalMetaID ?? ('' as GlobalMetaID),
        subjectGlobalMetaID: subjectGlobalMetaID ?? ('' as GlobalMetaID),
        resourceType: 'snapshot',
        requestedCapability: 'read_summary',
        grantId: null,
        summary: null,
        snapshotUpdatedAt: null,
        provenance: 'shared',
      };
    }

    const recordAndReturnDenied = (reasonCode: string, grantId?: string | null): MetaIDSharedSummaryReadResult => {
      try {
        this.audit({
          requestId,
          requestedAt,
          resourceOwnerGlobalMetaID,
          readerGlobalMetaID,
          subjectGlobalMetaID,
          resourceType: 'snapshot',
          requestedCapability: 'read_summary',
          grantId,
          outcome: 'denied',
          reasonCode,
          scopeReference: input.scopeReference,
        });
      } catch {
        // Audit failure never widens access.
      }
      return this.denied({
        reasonCode,
        requestId,
        requestedAt,
        resourceOwnerGlobalMetaID,
        readerGlobalMetaID,
        subjectGlobalMetaID,
        grantId,
      });
    };

    // Disabled-by-default gate: explicit opt-in is required before any shared read.
    if (!this.enabled) {
      return recordAndReturnDenied('feature_disabled');
    }

    const candidates = this.deps.grantStore.listGrantsForAccess({
      resourceOwnerGlobalMetaID,
      granteeGlobalMetaID: readerGlobalMetaID,
      subjectGlobalMetaID,
      resourceType: 'snapshot',
    });
    let firstDenyReason: string | null = null;
    let firstCandidate: MetaIDMemoryGrant | null = null;
    let chosenGrant: MetaIDMemoryGrant | null = null;
    for (const grant of candidates) {
      firstCandidate ??= grant;
      if (!grant.capabilities.includes('read_summary')) {
        firstDenyReason ??= 'missing_capability';
        continue;
      }
      if (grant.revokedAt != null) {
        firstDenyReason ??= 'revoked';
        continue;
      }
      if (requestedAt < grant.validFrom) {
        firstDenyReason ??= 'not_yet_valid';
        continue;
      }
      if (requestedAt >= grant.expiresAt) {
        firstDenyReason ??= 'expired';
        continue;
      }
      const conversationScope = grant.scope?.conversationId;
      if (typeof conversationScope === 'string' && conversationScope.trim()) {
        const scopeReference = (input.scopeReference ?? '').trim();
        if (scopeReference !== conversationScope.trim()) {
          firstDenyReason ??= 'scope_mismatch';
          continue;
        }
      }
      chosenGrant = grant;
      break;
    }

    if (!chosenGrant) {
      return recordAndReturnDenied(firstDenyReason ?? 'no_grant', firstCandidate?.id ?? null);
    }

    // read_summary reads only the owner's snapshot read model. No evidence is
    // loaded and no write/rebuild method is reachable on this path.
    const snapshot = this.deps.impressionStore.getSnapshot(
      resourceOwnerGlobalMetaID,
      subjectGlobalMetaID,
    );
    if (!snapshot) {
      return recordAndReturnDenied('no_snapshot', chosenGrant.id);
    }

    try {
      this.audit({
        requestId,
        requestedAt,
        resourceOwnerGlobalMetaID,
        readerGlobalMetaID,
        subjectGlobalMetaID,
        resourceType: 'snapshot',
        requestedCapability: 'read_summary',
        grantId: chosenGrant.id,
        outcome: 'allowed',
        reasonCode: 'allowed',
        scopeReference: input.scopeReference,
      });
    } catch {
      return recordAndReturnDenied('audit_failure', chosenGrant.id);
    }

    return {
      allowed: true,
      reasonCode: 'allowed',
      requestId,
      requestedAt,
      resourceOwnerGlobalMetaID,
      readerGlobalMetaID,
      subjectGlobalMetaID,
      resourceType: 'snapshot',
      requestedCapability: 'read_summary',
      grantId: chosenGrant.id,
      summary: snapshot.summaryText,
      snapshotUpdatedAt: snapshot.updatedAt,
      provenance: 'shared',
    };
  }

  /**
   * First-delivery boundary: capabilities other than read_summary are defined
   * in the grant model but not yet enabled for shared access. Every call still
   * produces an audited denial so the contract is explicit.
   */
  async checkCapability(input: {
    requestId?: string;
    resourceOwnerGlobalMetaID: unknown;
    readerGlobalMetaID: unknown;
    subjectGlobalMetaID?: unknown;
    capability: string;
    resourceType?: string;
    scopeReference?: string | null;
  }): Promise<{
    allowed: boolean;
    reasonCode: string;
    requestId: string;
    requestedAt: number;
    capability: string;
    grantId: string | null;
  }> {
    const requestId = (input.requestId ?? '').trim() || uuidv4();
    const requestedAt = this.now();
    const capability = (input.capability ?? '').trim();
    const resourceOwnerGlobalMetaID = normalizeGlobalMetaID(input.resourceOwnerGlobalMetaID);
    const readerGlobalMetaID = normalizeGlobalMetaID(input.readerGlobalMetaID);
    const subjectGlobalMetaID = normalizeGlobalMetaID(input.subjectGlobalMetaID);
    if (
      !resourceOwnerGlobalMetaID
      || !readerGlobalMetaID
      || !capability
      || (input.subjectGlobalMetaID !== undefined && !subjectGlobalMetaID)
    ) {
      return {
        allowed: false,
        reasonCode: 'invalid_request',
        requestId,
        requestedAt,
        capability,
        grantId: null,
      };
    }
    if (capability !== 'read_summary') {
      try {
        this.audit({
          requestId,
          requestedAt,
          resourceOwnerGlobalMetaID,
          readerGlobalMetaID,
          subjectGlobalMetaID: subjectGlobalMetaID ?? readerGlobalMetaID,
          resourceType: input.resourceType ?? 'snapshot',
          requestedCapability: capability,
          outcome: 'denied',
          reasonCode: 'capability_not_enabled',
          scopeReference: input.scopeReference,
        });
      } catch {
        // Audit failure never widens access.
      }
      return {
        allowed: false,
        reasonCode: 'capability_not_enabled',
        requestId,
        requestedAt,
        capability,
        grantId: null,
      };
    }
    const read = await this.readSharedSummary({
      requestId,
      resourceOwnerGlobalMetaID,
      readerGlobalMetaID,
      subjectGlobalMetaID: subjectGlobalMetaID ?? readerGlobalMetaID,
      scopeReference: input.scopeReference,
    });
    return {
      allowed: read.allowed,
      reasonCode: read.reasonCode,
      requestId: read.requestId,
      requestedAt: read.requestedAt,
      capability,
      grantId: read.grantId,
    };
  }
}
