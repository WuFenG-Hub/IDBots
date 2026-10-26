/**
 * Update notification store helpers
 *
 * Backing the update-notification IPC surface:
 * - First-install version, seeded once and used to tell fresh installs apart
 *   from upgrades
 * - Per-version viewed markers
 *
 * Note: values live in SqliteStore's key-value store (the `kv` table) —
 * the same pattern used throughout the codebase.
 */

import type { SqliteStore } from './sqliteStore';

const METADATA_KEY_FIRST_INSTALL = 'first_install_version';
const METADATA_KEY_VIEWED_PREFIX = 'notification_viewed_';

/**
 * Seed value for users whose install predates the feature. The notification
 * feature shipped in 1.0.8, so no earlier release ever recorded
 * first_install_version; an upgrading user needs a version that is below the
 * current release (so they are not misread as a fresh install) yet at or
 * above every announcement's minShowVersion floor.
 */
const LEGACY_UPGRADE_FIRST_INSTALL_VERSION = '1.0.0';

export function getFirstInstallVersion(store: SqliteStore): string | null {
  try {
    return store.get<string>(METADATA_KEY_FIRST_INSTALL) ?? null;
  } catch (error) {
    console.error('[UpdateNotification] Failed to get first_install_version:', error);
    return null;
  }
}

export function setFirstInstallVersion(store: SqliteStore, version: string): void {
  try {
    store.set(METADATA_KEY_FIRST_INSTALL, version);
  } catch (error) {
    console.error('[UpdateNotification] Failed to set first_install_version:', error);
  }
}

/**
 * Resolve (and seed exactly once) the first-install version. An absent key
 * means either a genuinely fresh install or a user upgrading from <= 1.0.7,
 * which never recorded one — the key alone cannot tell them apart, and
 * seeding every pre-1.0.8 user at the current version would permanently hide
 * upgrade notices from exactly the audience they are written for. Prior data
 * is the only signal that predates the feature: any existing metabot or
 * cowork session row proves an upgrade.
 */
export function resolveFirstInstallVersion(store: SqliteStore, currentVersion: string): string {
  const existing = getFirstInstallVersion(store);
  if (existing) return existing;
  const seeded = hasPriorUsageEvidence(store)
    ? LEGACY_UPGRADE_FIRST_INSTALL_VERSION
    : currentVersion;
  setFirstInstallVersion(store, seeded);
  return seeded;
}

function hasPriorUsageEvidence(store: SqliteStore): boolean {
  try {
    const db = store.getDatabase();
    if (db.exec('SELECT 1 FROM metabots LIMIT 1')[0]?.values.length) return true;
    return Boolean(db.exec('SELECT 1 FROM cowork_sessions LIMIT 1')[0]?.values.length);
  } catch (error) {
    console.warn('[UpdateNotification] Upgrade-evidence probe failed; treating as fresh install:', error);
    return false;
  }
}

export function hasViewedNotification(store: SqliteStore, version: string): boolean {
  try {
    return store.get<boolean>(`${METADATA_KEY_VIEWED_PREFIX}${version}`) ?? false;
  } catch (error) {
    console.error('[UpdateNotification] Failed to check notification view status:', error);
    return false;
  }
}

export function markNotificationAsViewed(store: SqliteStore, version: string): void {
  try {
    store.set(`${METADATA_KEY_VIEWED_PREFIX}${version}`, true);
  } catch (error) {
    console.error('[UpdateNotification] Failed to mark notification as viewed:', error);
  }
}
