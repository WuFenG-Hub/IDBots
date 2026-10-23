/**
 * Login API seam (C3 control-plane auth endpoints).
 *
 * The page talks ONLY to these functions. T1/T2 implement them as mocks;
 * T3/T4 swaps the internals for `fetch('/api/v1/auth/sms/send')`,
 * `fetch('/api/v1/auth/sms/verify')`, `fetch('/api/v1/me')` and
 * `fetch('/api/v1/auth/logout')` without touching the page. Request and
 * response shapes already mirror C3 (01-interface-contracts.md).
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

const MOCK_LATENCY_MS = 300;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function mockError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * Mock page-session state. `verifiedPhones` stands in for the account table
 * (a phone verified at least once is a returning user and needs no invite);
 * `mockSessionPhone` / `mockMePollCount` stand in for the session cookie and
 * the tenant provisioning progression that the control plane would drive.
 */
const verifiedPhones = new Set<string>();
let mockSessionPhone: string | null = null;
let mockMePollCount = 0;

/**
 * C3 `POST /api/v1/auth/sms/send`.
 *
 * The production request body MUST include `purpose` (staging returns 400
 * without it): `{ phone, purpose: 'login' }`.
 */
export async function sendCode(phone: string, purpose = 'login'): Promise<SendCodeResult> {
  console.info('[loginApi] sendCode called (mock)', { purpose });
  await wait(MOCK_LATENCY_MS);
  if (!/^\+86\d{11}$/.test(phone)) {
    throw mockError('INVALID_PHONE');
  }
  return { resendAfterSec: 60 };
}

/**
 * C3 `POST /api/v1/auth/sms/verify` with
 * `{ phone, code, inviteCode?, displayName? }`.
 *
 * Mock rules (deterministic, so the demo can exercise every branch):
 * - empty code -> `CODE_INVALID`; code `000000` -> `CODE_EXPIRED`;
 * - a phone never verified in this page session is a new account: without
 *   `inviteCode` it fails `INVITE_REQUIRED`; invite `FULL`/`BAD` fail
 *   `INVITE_EXHAUSTED`/`INVITE_INVALID`; any other invite is accepted;
 * - a returning phone needs no invite.
 */
export async function verifyCode(
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
    throw mockError('CODE_INVALID');
  }
  if (code === '000000') {
    throw mockError('CODE_EXPIRED');
  }
  const isReturningPhone = verifiedPhones.has(phone);
  if (!isReturningPhone && !inviteCode) {
    throw mockError('INVITE_REQUIRED');
  }
  if (inviteCode === 'FULL') {
    throw mockError('INVITE_EXHAUSTED');
  }
  if (inviteCode === 'BAD') {
    throw mockError('INVITE_INVALID');
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

/** C3 `GET /api/v1/me` (session cookie in production). */
export async function getMe(): Promise<GetMeResult> {
  console.info('[loginApi] getMe called (mock)');
  await wait(MOCK_LATENCY_MS);
  if (!mockSessionPhone) {
    throw mockError('UNAUTHORIZED');
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

/**
 * C3 `POST /api/v1/auth/logout` (204 in production). Clears the mock session
 * and resets the tenant progression so the next sign-in starts over.
 */
export async function logout(): Promise<LogoutResult> {
  console.info('[loginApi] logout called (mock)');
  await wait(MOCK_LATENCY_MS);
  mockSessionPhone = null;
  mockMePollCount = 0;
  return { success: true };
}

/**
 * C3 `POST /api/v1/account/deletion-requests` (shape per the Me screen's
 * delete-account flow: an optional human reason). In the mock the request is
 * accepted whenever a session exists and the session is cleared immediately
 * (the real control plane keeps the account in a pending-deletion grace
 * period server-side).
 */
export async function requestAccountDeletion(reason?: string): Promise<AccountDeletionResult> {
  console.info('[loginApi] requestAccountDeletion called (mock)', {
    hasReason: Boolean(reason && reason.trim()),
  });
  await wait(MOCK_LATENCY_MS);
  if (!mockSessionPhone) {
    throw mockError('UNAUTHORIZED');
  }
  mockSessionPhone = null;
  mockMePollCount = 0;
  return { success: true };
}
