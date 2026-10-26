/**
 * Login API seam (C3 control-plane auth endpoints).
 *
 * The page talks ONLY to these functions. Under `VITE_MOBILE_MOCK=1`
 * (`pnpm dev:mobile`) the functions below serve the REQ-E-8 demo mocks; any
 * other build hits the real C3 endpoints per 01-interface-contracts.md:
 * `POST /api/v1/auth/sms/send`, `POST /api/v1/auth/sms/verify`,
 * `GET /api/v1/me`, `POST /api/v1/auth/logout` and
 * `POST /api/v1/account/deletion-request`. Request and response shapes mirror
 * C3 exactly, so swapping never touches the page.
 *
 * The page is served from the same origin as the control plane (staging:
 * `https://staging.idbots.world`), so the fetches use origin-relative URLs
 * and `credentials: 'same-origin'` — the browser fills in the `Origin` header
 * itself and the `idb_session` cookie rides along (the control plane rejects
 * state-changing requests whose Origin does not match the deployment origin
 * with `403 ORIGIN_NOT_ALLOWED`; a hand-set Origin header is a forbidden
 * header name, so there is nothing to configure here).
 *
 * Logging never includes the phone number, the SMS code, or the invite code
 * (SEC-12).
 */

export interface LoginUser {
  id: string;
  phoneMasked: string;
  createdAt: number;
  locale: 'zh' | 'en';
}

export interface LoginTenant {
  status:
    | 'provisioning'
    | 'booting'
    | 'onboarding'
    | 'ready'
    | 'degraded'
    | 'upgrading'
    | 'stopped'
    | 'failed'
    | 'suspended';
  phase: string | null;
  appVersion: string | null;
  contractVersion: string | null;
  error: string | null;
}

export interface SendCodeResult {
  resendAfterSec: number;
}

export interface VerifyCodeResult {
  user: LoginUser;
  tenant: LoginTenant;
}

/** C3 `sms/verify` extras: invite-only sign-up and the on-chain display name. */
export interface VerifyCodeOptions {
  inviteCode?: string;
  displayName?: string;
}

export interface GetMeResult {
  user: LoginUser;
  tenant: LoginTenant;
}

export interface LogoutResult {
  success: boolean;
}

export interface AccountDeletionResult {
  success: boolean;
}

/** C3 error body: `{"error":{"code":"…","message":"…"}}`. */
interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * Mock-mode switch (REQ-E-8). `true` only with `VITE_MOBILE_MOCK=1` outside
 * production builds. `import.meta.env.PROD` lets Vite fold production mock
 * branches away; the process fallback keeps the node test runner working.
 * `typeof process` guards also make real Vite dev-server operation safe when
 * no Node global exists in the browser.
 */
const IS_PRODUCTION_BUILD =
  (import.meta as { env?: { PROD?: boolean } }).env?.PROD ??
  (typeof process !== 'undefined' && process.env.NODE_ENV === 'production');
const MOCK_LOGIN_API =
  !IS_PRODUCTION_BUILD &&
  ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_MOBILE_MOCK === '1' ||
    (typeof process !== 'undefined' && process.env.VITE_MOBILE_MOCK === '1'));

function errorWithCode(code: string): Error & { code: string } {
  const error = new Error(`loginApi: ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

/** Maps a C3 error response to a page-dispatchable error code. */
async function responseError(response: Response): Promise<Error & { code: string }> {
  let code = '';
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (typeof body?.error?.code === 'string' && body.error.code) {
      code = body.error.code;
    }
  } catch {
    // Non-JSON error body: fall through to the status-derived code.
  }
  if (!code && response.status === 401) {
    code = 'UNAUTHORIZED';
  }
  if (!code) {
    code = `HTTP_${response.status}`;
  }
  return errorWithCode(code);
}

async function requestJson<T>(
  path: string,
  init?: { method?: string; jsonBody?: unknown },
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    method: init?.method ?? 'GET',
    ...(init?.jsonBody !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.jsonBody) }
      : {}),
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Real C3 implementation.
// ---------------------------------------------------------------------------

/** C3 `POST /api/v1/auth/sms/send` with `{ phone, purpose: 'login' }`. */
export async function sendCode(phone: string, purpose = 'login'): Promise<SendCodeResult> {
  if (MOCK_LOGIN_API) {
    return mockSendCode(phone, purpose);
  }
  console.info('[loginApi] sendCode', { purpose });
  if (!/^\+86\d{11}$/.test(phone)) {
    throw errorWithCode('INVALID_PHONE');
  }
  return requestJson<SendCodeResult>('/api/v1/auth/sms/send', {
    method: 'POST',
    jsonBody: { phone, purpose },
  });
}

/**
 * C3 `POST /api/v1/auth/sms/verify` with
 * `{ phone, code, inviteCode?, displayName? }`. Success sets the
 * `idb_session` cookie; error codes pass through verbatim (`CODE_INVALID`,
 * `CODE_EXPIRED`, `INVITE_REQUIRED`, `INVITE_INVALID`, `INVITE_EXHAUSTED`,
 * `USER_DISABLED`, `TOO_MANY_ATTEMPTS`).
 */
export async function verifyCode(
  phone: string,
  code: string,
  options?: VerifyCodeOptions,
): Promise<VerifyCodeResult> {
  if (MOCK_LOGIN_API) {
    return mockVerifyCode(phone, code, options);
  }
  const inviteCode = options?.inviteCode;
  const displayName = options?.displayName;
  console.info('[loginApi] verifyCode', {
    hasInviteCode: Boolean(inviteCode),
    hasDisplayName: Boolean(displayName),
  });
  if (!code) {
    throw errorWithCode('CODE_INVALID');
  }
  return requestJson<VerifyCodeResult>('/api/v1/auth/sms/verify', {
    method: 'POST',
    jsonBody: {
      phone,
      code,
      ...(inviteCode !== undefined ? { inviteCode } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    },
  });
}

/** C3 `GET /api/v1/me` (session cookie). */
export async function getMe(): Promise<GetMeResult> {
  if (MOCK_LOGIN_API) {
    return mockGetMe();
  }
  console.info('[loginApi] getMe');
  return requestJson<GetMeResult>('/api/v1/me');
}

/** C3 `POST /api/v1/auth/logout` (204, cookie cleared). */
export async function logout(): Promise<LogoutResult> {
  if (MOCK_LOGIN_API) {
    return mockLogout();
  }
  console.info('[loginApi] logout');
  const response = await fetch('/api/v1/auth/logout', {
    credentials: 'same-origin',
    method: 'POST',
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  return { success: true };
}

/**
 * C3 `POST /api/v1/account/deletion-request` (`{ reason? }` →
 * `202 { requestId }`; the control plane keeps the account in a
 * pending-deletion grace period server-side).
 */
export async function requestAccountDeletion(reason?: string): Promise<AccountDeletionResult> {
  if (MOCK_LOGIN_API) {
    return mockRequestAccountDeletion(reason);
  }
  const trimmed = reason?.trim();
  console.info('[loginApi] requestAccountDeletion', { hasReason: Boolean(trimmed) });
  await requestJson<{ requestId: string }>('/api/v1/account/deletion-request', {
    method: 'POST',
    jsonBody: trimmed ? { reason: trimmed } : {},
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// REQ-E-8 demo mocks, active only under VITE_MOBILE_MOCK=1.
// ---------------------------------------------------------------------------

const MOCK_LATENCY_MS = 300;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Mock page-session state. `verifiedPhones` stands in for the account table
 * (a phone verified at least once is a returning user and needs no invite);
 * `mockSessionPhone` / `mockMePollCount` stand in for the session cookie and
 * the tenant provisioning progression that the control plane would drive.
 */
const verifiedPhones = new Set<string>();
let mockSessionPhone: string | null = null;
let mockMePollCount = 0;

async function mockSendCode(phone: string, purpose: string): Promise<SendCodeResult> {
  console.info('[loginApi] sendCode called (mock)', { purpose });
  await wait(MOCK_LATENCY_MS);
  if (!/^\+86\d{11}$/.test(phone)) {
    throw errorWithCode('INVALID_PHONE');
  }
  return { resendAfterSec: 60 };
}

/**
 * Mock rules (deterministic, so the demo can exercise every branch):
 * - empty code -> `CODE_INVALID`; code `000000` -> `CODE_EXPIRED`;
 * - a phone never verified in this page session is a new account: without
 *   `inviteCode` it fails `INVITE_REQUIRED`; invite `FULL`/`BAD` fail
 *   `INVITE_EXHAUSTED`/`INVITE_INVALID`; any other invite is accepted;
 * - a returning phone needs no invite.
 */
async function mockVerifyCode(
  phone: string,
  code: string,
  options?: VerifyCodeOptions,
): Promise<VerifyCodeResult> {
  const inviteCode = options?.inviteCode;
  const displayName = options?.displayName;
  console.info('[loginApi] verifyCode called (mock)', {
    hasInviteCode: Boolean(inviteCode),
    hasDisplayName: Boolean(displayName),
  });
  await wait(MOCK_LATENCY_MS);
  if (!code) {
    throw errorWithCode('CODE_INVALID');
  }
  if (code === '000000') {
    throw errorWithCode('CODE_EXPIRED');
  }
  const isReturningPhone = verifiedPhones.has(phone);
  if (!isReturningPhone && !inviteCode) {
    throw errorWithCode('INVITE_REQUIRED');
  }
  if (inviteCode === 'FULL') {
    throw errorWithCode('INVITE_EXHAUSTED');
  }
  if (inviteCode === 'BAD') {
    throw errorWithCode('INVITE_INVALID');
  }
  verifiedPhones.add(phone);
  mockSessionPhone = phone;
  mockMePollCount = 0;
  return {
    user: {
      id: 'mock-user',
      phoneMasked: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
      createdAt: Date.now(),
      locale: 'zh',
    },
    tenant: {
      status: 'provisioning',
      phase: null,
      appVersion: null,
      contractVersion: null,
      error: null,
    },
  };
}

// Roughly two `getMe` calls per stage so the preparing screen can demo the
// provisioning -> booting -> onboarding -> ready progression; past the list
// the tenant stays `ready`.
const TENANT_PROGRESSION: LoginTenant['status'][] = [
  'provisioning',
  'provisioning',
  'booting',
  'booting',
  'onboarding',
  'onboarding',
];

// Tenant /readyz-style phase strings while booting or onboarding (C3 Tenant).
const TENANT_PHASE: Partial<Record<LoginTenant['status'], string>> = {
  booting: 'starting-services',
  onboarding: 'initializing-workspace',
};

async function mockGetMe(): Promise<GetMeResult> {
  console.info('[loginApi] getMe called (mock)');
  await wait(MOCK_LATENCY_MS);
  if (!mockSessionPhone) {
    throw errorWithCode('UNAUTHORIZED');
  }
  mockMePollCount += 1;
  const status = TENANT_PROGRESSION[mockMePollCount - 1] ?? 'ready';
  return {
    user: {
      id: 'mock-user',
      phoneMasked: `${mockSessionPhone.slice(0, 3)}****${mockSessionPhone.slice(-4)}`,
      createdAt: Date.now(),
      locale: 'zh',
    },
    tenant: {
      status,
      phase: TENANT_PHASE[status] ?? null,
      appVersion: null,
      contractVersion: null,
      error: null,
    },
  };
}

/** Clears the mock session and resets the tenant progression. */
async function mockLogout(): Promise<LogoutResult> {
  console.info('[loginApi] logout called (mock)');
  await wait(MOCK_LATENCY_MS);
  mockSessionPhone = null;
  mockMePollCount = 0;
  return { success: true };
}

/**
 * In the mock the request is accepted whenever a session exists and the
 * session is cleared immediately.
 */
async function mockRequestAccountDeletion(reason?: string): Promise<AccountDeletionResult> {
  console.info('[loginApi] requestAccountDeletion called (mock)', {
    hasReason: Boolean(reason && reason.trim()),
  });
  await wait(MOCK_LATENCY_MS);
  if (!mockSessionPhone) {
    throw errorWithCode('UNAUTHORIZED');
  }
  mockSessionPhone = null;
  mockMePollCount = 0;
  return { success: true };
}
