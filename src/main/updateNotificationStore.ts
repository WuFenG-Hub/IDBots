/**
 * Update notification IPC handlers
 *
 * Provides IPC methods for managing app update notifications:
 * - Getting/setting first install version
 * - Checking if a notification has been viewed
 * - Recording notification views
 *
 * Note: Uses SqliteStore's key-value store (app_local_data table) instead of
 * dedicated tables, as this is the pattern used throughout the codebase.
 */

import type { SqliteStore } from './sqliteStore';

const METADATA_KEY_FIRST_INSTALL = 'first_install_version';
const METADATA_KEY_VIEWED_PREFIX = 'notification_viewed_';

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
