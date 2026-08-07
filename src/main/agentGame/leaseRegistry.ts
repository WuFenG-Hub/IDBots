/**
 * Lease / fencing registry (docs/14 §6, docs/09 §4).
 *
 * Lease key is `(groupId, seat)`. While a Runner holds an active lease, no
 * second Runner may take the same seat — this is a safety error, not an
 * acceptable race. Leases expire (TTL) and are renewed by heartbeat; a stale
 * lease can be reclaimed. `stop`/terminal release the lease; `pause` keeps it.
 *
 * The in-memory map is the fast path for acquire/release; the lease id +
 * expiry are mirrored onto agent_game_sessions for restart recovery. On host
 * restart the runtime re-acquires (fresh id) rather than trusting a stale id.
 */

import { randomUUID } from 'crypto';

/** Default lease lifetime. Renewed by heartbeat at TTL/3. */
export const LEASE_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Heartbeat interval = TTL / 3. */
export const LEASE_HEARTBEAT_INTERVAL_MS = Math.floor(LEASE_TTL_MS / 3);

export interface Lease {
  key: string;
  sessionId: string;
  leaseId: string;
  /** Wall-clock expiry (ms). */
  expiresAt: number;
}

export interface LeaseAcquireResult {
  acquired: boolean;
  lease?: Lease;
  /** Present when acquisition failed because another live lease holds the seat. */
  conflictSessionId?: string;
}

function leaseKey(groupId: string, seat: string): string {
  return `${groupId}|${seat}`;
}

export class LeaseRegistry {
  private leases = new Map<string, Lease>();
  private now: () => number = () => Date.now();

  /** Inject a clock (tests). */
  setClock(now: () => number): void {
    this.now = now;
  }

  /** Try to take or renew the lease for `(groupId, seat)` on behalf of sessionId. */
  acquire(groupId: string, seat: string, sessionId: string, ttlMs: number = LEASE_TTL_MS): LeaseAcquireResult {
    const key = leaseKey(groupId, seat);
    const now = this.now();
    const cur = this.leases.get(key);
    if (cur) {
      // Same session renews / re-acquires freely.
      if (cur.sessionId === sessionId) {
        const renewed: Lease = { ...cur, leaseId: randomUUID(), expiresAt: now + ttlMs };
        this.leases.set(key, renewed);
        return { acquired: true, lease: renewed };
      }
      // Another session holds it; conflict only while it is still live.
      if (cur.expiresAt > now) {
        return { acquired: false, conflictSessionId: cur.sessionId };
      }
      // Expired — fall through and reclaim.
    }
    const lease: Lease = {
      key,
      sessionId,
      leaseId: randomUUID(),
      expiresAt: now + ttlMs,
    };
    this.leases.set(key, lease);
    return { acquired: true, lease };
  }

  /** Refresh the lease TTL (heartbeat). No-op if not held by sessionId. */
  renew(groupId: string, seat: string, sessionId: string, ttlMs: number = LEASE_TTL_MS): boolean {
    const key = leaseKey(groupId, seat);
    const cur = this.leases.get(key);
    if (!cur || cur.sessionId !== sessionId) return false;
    cur.expiresAt = this.now() + ttlMs;
    return true;
  }

  /** Release the lease only if currently held by sessionId. */
  release(groupId: string, seat: string, sessionId: string): boolean {
    const key = leaseKey(groupId, seat);
    const cur = this.leases.get(key);
    if (!cur || cur.sessionId !== sessionId) return false;
    this.leases.delete(key);
    return true;
  }

  /** Release every lease held by a session (used on stop/terminal). */
  releaseSession(sessionId: string): number {
    let n = 0;
    for (const [key, lease] of this.leases) {
      if (lease.sessionId === sessionId) {
        this.leases.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Is this session the current holder of the (groupId, seat) lease? */
  isHolder(groupId: string, seat: string, sessionId: string): boolean {
    const key = leaseKey(groupId, seat);
    const cur = this.leases.get(key);
    return !!cur && cur.sessionId === sessionId && cur.expiresAt > this.now();
  }

  /** Drop expired leases (housekeeping). Returns number dropped. */
  sweep(): number {
    const now = this.now();
    let n = 0;
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(key);
        n++;
      }
    }
    return n;
  }

  /** Current lease for a key, if any (live or expired). */
  peek(groupId: string, seat: string): Lease | undefined {
    return this.leases.get(leaseKey(groupId, seat));
  }
}
