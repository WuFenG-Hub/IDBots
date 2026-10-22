/**
 * Standalone mobile i18n service (REQ-E-18).
 *
 * Deliberately NOT src/renderer/services/i18n.ts: the desktop service bundles
 * a 6000+ line dictionary and imports configService -> localStore ->
 * window.electron.store. The mobile login bundle runs before any bridge
 * exists and has an 80 KB gzip budget (REQ-E-19), so the mobile module keeps
 * its own small `mobile.`-prefixed dictionary in sync with the desktop
 * service's public shape: t(key, params?), subscribe(listener), setLanguage,
 * getLanguage, and the same inferLanguageFromLocale rule (only
 * simplified-Chinese locales map to zh, everything else to en).
 */

export type MobileLanguage = 'zh' | 'en';

type MobileDictionary = Record<string, string>;

const zhTranslations: MobileDictionary = {
  'mobile.common.loading': '加载中…',
  'mobile.common.error': '出了点问题',
  'mobile.bridge.unavailableTitle': '客户端未连接',
  'mobile.bridge.unavailableBody': '当前没有可用的后端连接。请稍后重试，或联系支持人员。',
  'mobile.connection.connecting': '连接中',
  'mobile.connection.online': '已连接',
  'mobile.connection.reconnecting': '正在重连…',
  'mobile.connection.offline': '离线',
  'mobile.connection.upgrading': '正在升级',
  'mobile.demo.title': 'Mock 桥演示',
  'mobile.demo.chatTitle': '聊天演示',
  'mobile.demo.chatHint': '发一条消息；试试包含 permission 或 quota 的内容',
  'mobile.demo.composerPlaceholder': '给 Mock 助手发消息',
  'mobile.demo.send': '发送',
  'mobile.demo.you': '你',
  'mobile.demo.assistant': '助手',
  'mobile.demo.permissionTitle': '工具权限请求',
  'mobile.demo.permissionTool': '工具：{name}',
  'mobile.demo.permissionApprove': '允许',
  'mobile.demo.permissionDeny': '拒绝',
  'mobile.demo.quotaTitle': 'LLM 额度已用完',
  'mobile.demo.quotaBody': '已购额度已用尽，充值后可继续使用。',
  'mobile.demo.rechargeLink': '去充值',
  'mobile.demo.dismiss': '关闭',
  'mobile.demo.tasksTitle': '定时任务',
  'mobile.demo.nextRun': '下次运行：{time}',
  'mobile.demo.lastStatus': '上次：{status}',
  'mobile.demo.enabled': '已启用',
  'mobile.demo.disabled': '已停用',
  'mobile.demo.neverRun': '从未运行',
  'mobile.demo.runHistory': '运行历史',
  'mobile.demo.noRuns': '还没有运行记录',
  'mobile.demo.runStatus.success': '成功',
  'mobile.demo.runStatus.error': '失败',
  'mobile.demo.runStatus.running': '运行中',
  'mobile.demo.runStatus.skipped': '已跳过',
  'mobile.demo.trigger.scheduled': '定时',
  'mobile.demo.trigger.manual': '手动',
  'mobile.demo.plansTitle': '套餐',
  'mobile.demo.buy': '购买',
  'mobile.demo.orderCreated': '订单已创建，等待支付',
  'mobile.demo.orderWaiting': '等待支付…',
  'mobile.demo.orderCredited': '支付成功，套餐已到账',
  'mobile.demo.payUrl': '支付宝二维码链接',
  'mobile.demo.metersTitle': '余额',
  'mobile.demo.metersTraffic': '流量：{amount}',
  'mobile.demo.metersLlm': 'LLM 额度：{amount}',
  'mobile.demo.metersRefresh': '刷新',
  'mobile.demo.reconnectButton': '模拟重连',
  'mobile.login.title': '登录 IDBots',
  'mobile.login.subtitle': '使用手机号和验证码登录。',
  'mobile.login.phonePlaceholder': '手机号',
  'mobile.login.sendCode': '发送验证码',
  'mobile.login.codeSent': '验证码已发送，{sec} 秒后可重发',
  'mobile.login.codePlaceholder': '验证码',
  'mobile.login.verify': '登录',
  'mobile.login.verified': '登录成功，正在准备你的 Bot（{status}）',
  'mobile.login.invalidPhone': '手机号格式不正确',
  'mobile.login.invalidCode': '验证码不正确，请重试',
  'mobile.login.demoNote': '演示环境：登录接口为 mock。',
};

const enTranslations: MobileDictionary = {
  'mobile.common.loading': 'Loading…',
  'mobile.common.error': 'Something went wrong',
  'mobile.bridge.unavailableTitle': 'Client not connected',
  'mobile.bridge.unavailableBody': 'No backend connection is available right now. Please try again later or contact support.',
  'mobile.connection.connecting': 'Connecting',
  'mobile.connection.online': 'Online',
  'mobile.connection.reconnecting': 'Reconnecting…',
  'mobile.connection.offline': 'Offline',
  'mobile.connection.upgrading': 'Upgrading',
  'mobile.demo.title': 'Mock bridge demo',
  'mobile.demo.chatTitle': 'Chat demo',
  'mobile.demo.chatHint': 'Send a message; try one containing permission or quota',
  'mobile.demo.composerPlaceholder': 'Message the mock assistant',
  'mobile.demo.send': 'Send',
  'mobile.demo.you': 'You',
  'mobile.demo.assistant': 'Assistant',
  'mobile.demo.permissionTitle': 'Tool permission requested',
  'mobile.demo.permissionTool': 'Tool: {name}',
  'mobile.demo.permissionApprove': 'Approve',
  'mobile.demo.permissionDeny': 'Deny',
  'mobile.demo.quotaTitle': 'LLM quota exhausted',
  'mobile.demo.quotaBody': 'Your purchased quota is used up. Recharge to continue.',
  'mobile.demo.rechargeLink': 'Recharge',
  'mobile.demo.dismiss': 'Dismiss',
  'mobile.demo.tasksTitle': 'Scheduled tasks',
  'mobile.demo.nextRun': 'Next run: {time}',
  'mobile.demo.lastStatus': 'Last: {status}',
  'mobile.demo.enabled': 'Enabled',
  'mobile.demo.disabled': 'Disabled',
  'mobile.demo.neverRun': 'Never run',
  'mobile.demo.runHistory': 'Run history',
  'mobile.demo.noRuns': 'No runs yet',
  'mobile.demo.runStatus.success': 'Success',
  'mobile.demo.runStatus.error': 'Error',
  'mobile.demo.runStatus.running': 'Running',
  'mobile.demo.runStatus.skipped': 'Skipped',
  'mobile.demo.trigger.scheduled': 'Scheduled',
  'mobile.demo.trigger.manual': 'Manual',
  'mobile.demo.plansTitle': 'Plans',
  'mobile.demo.buy': 'Buy',
  'mobile.demo.orderCreated': 'Order created, waiting for payment',
  'mobile.demo.orderWaiting': 'Waiting for payment…',
  'mobile.demo.orderCredited': 'Payment received, bundle credited',
  'mobile.demo.payUrl': 'Alipay QR URL',
  'mobile.demo.metersTitle': 'Balance',
  'mobile.demo.metersTraffic': 'Traffic: {amount}',
  'mobile.demo.metersLlm': 'LLM quota: {amount}',
  'mobile.demo.metersRefresh': 'Refresh',
  'mobile.demo.reconnectButton': 'Simulate reconnect',
  'mobile.login.title': 'Sign in to IDBots',
  'mobile.login.subtitle': 'Sign in with your phone number and SMS code.',
  'mobile.login.phonePlaceholder': 'Phone number',
  'mobile.login.sendCode': 'Send code',
  'mobile.login.codeSent': 'Code sent; you can resend it in {sec}s',
  'mobile.login.codePlaceholder': 'SMS code',
  'mobile.login.verify': 'Sign in',
  'mobile.login.verified': 'Signed in; preparing your Bot ({status})',
  'mobile.login.invalidPhone': 'Invalid phone number',
  'mobile.login.invalidCode': 'Invalid code, please try again',
  'mobile.login.demoNote': 'Demo build: the login API is mocked.',
};

const dictionaries: Record<MobileLanguage, MobileDictionary> = {
  zh: zhTranslations,
  en: enTranslations,
};

/** Same locale rule as the desktop inferLanguageFromLocale (services/i18n.ts). */
export function inferLanguageFromLocale(systemLocale: string): MobileLanguage {
  const normalized = String(systemLocale || '').trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) {
    return 'en';
  }
  const tags = normalized.split('-').filter(Boolean);
  if (tags[0] !== 'zh') {
    return 'en';
  }
  if (tags.includes('hant') || tags[1] === 'tw' || tags[1] === 'hk' || tags[1] === 'mo') {
    return 'en';
  }
  return 'zh';
}

class MobileI18nService {
  private currentLanguage: MobileLanguage = 'en';
  private listeners = new Set<() => void>();

  /** Picks the device language; safe before any bridge exists (no electron calls). */
  initFromDeviceLocale(locale?: string): MobileLanguage {
    const source =
      locale ??
      (typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language
        : 'en');
    this.currentLanguage = inferLanguageFromLocale(source);
    return this.currentLanguage;
  }

  t(key: string, params?: Record<string, string | number>): string {
    let translation = dictionaries[this.currentLanguage][key];
    if (!translation) {
      console.warn(`[mobile-i18n] missing key: ${key} (${this.currentLanguage})`);
      translation = dictionaries.en[key];
      if (!translation) return key;
    }
    if (params) {
      translation = translation.replace(/\{(\w+)\}/g, (match, name: string) =>
        params[name] !== undefined ? String(params[name]) : match,
      );
    }
    return translation;
  }

  setLanguage(language: MobileLanguage): void {
    if (this.currentLanguage === language) return;
    this.currentLanguage = language;
    for (const listener of [...this.listeners]) listener();
  }

  getLanguage(): MobileLanguage {
    return this.currentLanguage;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const mobileI18n = new MobileI18nService();

/** Short alias mirroring the desktop `i18nService.t` call sites. */
export const t = (key: string, params?: Record<string, string | number>): string =>
  mobileI18n.t(key, params);
