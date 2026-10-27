/**
 * REQ-E-8 mock mode requires VITE_MOBILE_MOCK=1 outside production builds.
 * import.meta.env.PROD lets Vite fold production branches away; the process
 * fallback supports Node tests, and the guards keep browser dev runtime safe.
 */
const IS_PRODUCTION_BUILD =
  (import.meta as { env?: { PROD?: boolean } }).env?.PROD ??
  (typeof process !== 'undefined' && process.env.NODE_ENV === 'production');

export const MOCK_LOGIN_API =
  !IS_PRODUCTION_BUILD &&
  ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MOBILE_MOCK === '1' ||
    (typeof process !== 'undefined' && process.env.VITE_MOBILE_MOCK === '1'));
