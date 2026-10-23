/**
 * In-app browser and platform detection helpers for the login page.
 *
 * The userAgent predicates are pure functions so they stay unit-testable;
 * the DOM-touching helpers (standalone display mode, clipboard) are guarded
 * for non-browser contexts.
 */

/**
 * WeChat (`MicroMessenger`) and QQ (` QQ/`) in-app browsers cannot complete
 * sign-in (no reliable cookies / redirect handling inside webviews), so the
 * login page replaces itself with an "open in the system browser" guide.
 */
export function isInAppBrowser(userAgent: string): boolean {
  return /MicroMessenger/i.test(userAgent) || /(?:^|\s)QQ\//i.test(userAgent);
}

export function isIosDevice(userAgent: string): boolean {
  return /iPhone|iPad|iPod/.test(userAgent);
}

/**
 * iOS Safari proper — excludes other iOS browsers (Chrome `CriOS`, Firefox
 * `FxiOS`, Edge `EdgiOS`, Opera `OPiOS`, QQBrowser, …) and in-app webviews,
 * whose UA also contains `Safari/`.
 */
export function isIosSafari(userAgent: string): boolean {
  if (!isIosDevice(userAgent)) {
    return false;
  }
  if (isInAppBrowser(userAgent)) {
    return false;
  }
  if (/CriOS|FxiOS|EdgiOS|OPiOS|QQBrowser|YaBrowser|SamsungBrowser/i.test(userAgent)) {
    return false;
  }
  return /Safari\//.test(userAgent);
}

/** True when the page already runs as an installed PWA (Add to Home Screen). */
export function isStandaloneDisplay(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  // iOS Safari sets navigator.standalone for home-screen web apps.
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) {
    return true;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(display-mode: standalone)').matches;
  }
  return false;
}

/**
 * Clipboard write with a fallback for non-secure contexts where
 * `navigator.clipboard` is missing (temporary textarea + execCommand).
 * Resolves to whether the text reached the clipboard.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path below.
    }
  }
  if (typeof document === 'undefined') {
    return false;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}
