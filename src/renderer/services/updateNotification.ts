/**
 * Update notification service
 *
 * Manages app update notifications shown to users after upgrading.
 * - Loads notification definitions from update-notifications.json
 * - Checks if the user should see a notification based on their install/upgrade history
 * - Records when notifications are viewed
 */

export interface UpdateNotification {
  version: string;
  minShowVersion: string;
  title: {
    zh: string;
    en: string;
  };
  content: {
    zh: string;
    en: string;
  };
  type: 'info' | 'warning' | 'feature';
}

export interface UpdateNotificationsData {
  notifications: UpdateNotification[];
}

/**
 * Load and parse update-notifications.json
 */
export async function loadUpdateNotifications(): Promise<UpdateNotificationsData | null> {
  try {
    const response = await fetch('/update-notifications.json');
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.warn('[UpdateNotification] Failed to load update-notifications.json:', error);
    return null;
  }
}

/**
 * Get the notification for the current app version, if any
 */
export function getNotificationForVersion(
  data: UpdateNotificationsData,
  currentVersion: string
): UpdateNotification | null {
  return data.notifications.find((n) => n.version === currentVersion) || null;
}

/**
 * Check if the user should see the update notification
 *
 * Returns true if:
 * 1. The user is not a fresh install (firstInstallVersion < currentVersion)
 * 2. The notification hasn't been viewed yet
 * 3. The user's previous version is >= notification.minShowVersion
 */
export function shouldShowNotification(
  firstInstallVersion: string | null,
  currentVersion: string,
  notification: UpdateNotification,
  hasViewed: boolean
): boolean {
  // Fresh installs don't see upgrade notifications
  if (!firstInstallVersion || firstInstallVersion === currentVersion) {
    return false;
  }

  // Already viewed this notification
  if (hasViewed) {
    return false;
  }

  // Check if user's version is recent enough
  const minVersion = notification.minShowVersion;
  if (compareVersions(firstInstallVersion, minVersion) < 0) {
    return false;
  }

  return true;
}

/**
 * Simple semver comparison (supports x.y.z format)
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map((x) => parseInt(x, 10) || 0);
  const bParts = b.split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }
  return 0;
}
