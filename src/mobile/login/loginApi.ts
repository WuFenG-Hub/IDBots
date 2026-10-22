/**
 * Login API seam (C3 control-plane auth endpoints).
 *
 * The page talks ONLY to these two functions. T1 implements them as mocks;
 * T3/T4 swaps the internals for `fetch('/api/v1/auth/sms/send')` and
 * `fetch('/api/v1/auth/sms/verify')` without touching the page. Request and
 * response shapes already mirror C3 (01-interface-contracts.md).
 *
 * Logging never includes the phone number or the SMS code (SEC-12).
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

const MOCK_LATENCY_MS = 300;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** C3 `POST /api/v1/auth/sms/send` with `{ phone, purpose: 'login' }`. */
export async function sendCode(phone: string): Promise<SendCodeResult> {
  console.info('[loginApi] sendCode called (mock)');
  await wait(MOCK_LATENCY_MS);
  if (!/^\+86\d{11}$/.test(phone)) {
    const error = new Error('INVALID_PHONE') as Error & { code?: string };
    error.code = 'INVALID_PHONE';
    throw error;
  }
  return { resendAfterSec: 60 };
}

/** C3 `POST /api/v1/auth/sms/verify` with `{ phone, code, inviteCode? }`. */
export async function verifyCode(
  phone: string,
  code: string,
  inviteCode?: string,
): Promise<VerifyCodeResult> {
  console.info('[loginApi] verifyCode called (mock)', { hasInviteCode: Boolean(inviteCode) });
  await wait(MOCK_LATENCY_MS);
  if (!code) {
    const error = new Error('CODE_INVALID') as Error & { code?: string };
    error.code = 'CODE_INVALID';
    throw error;
  }
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
