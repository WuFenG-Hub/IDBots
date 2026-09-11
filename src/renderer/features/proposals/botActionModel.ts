export type BotActionRisk = 'local' | 'external' | 'onchain';
export type BotActionStatus = 'awaiting_confirmation' | 'awaiting_tool_approval' | 'executing' | 'succeeded' | 'failed';

export interface BotActionRequest {
  id: string;
  version: number;
  actor: { name: string; role: string };
  action: { kind: string; title: string; description: string };
  target: { label: string; uri?: string };
  impact: { risk: BotActionRisk; writes: string[]; doesNotWrite: string[] };
  output: { label: string; expectedUriScheme: string };
}

export interface BotActionConfirmation {
  requestId: string;
  version: number;
  approved: boolean;
  instruction: string;
  confirmedAt: string;
}

export interface BotActionReceipt {
  requestId: string;
  version: number;
  status: 'succeeded' | 'failed';
  summary: string;
  outputUri?: string;
  completedAt: string;
}

export function validateConfirmation(request: BotActionRequest, value: BotActionConfirmation): boolean {
  return value.requestId === request.id
    && value.version === request.version
    && value.approved === true
    && typeof value.instruction === 'string'
    && value.instruction.length <= 2000
    && Number.isFinite(Date.parse(value.confirmedAt));
}

export function acceptConfirmation(
  request: BotActionRequest,
  previous: BotActionConfirmation | null,
  value: BotActionConfirmation,
): BotActionConfirmation {
  if (previous) return previous;
  if (!validateConfirmation(request, value)) throw new Error('操作确认无效或版本已经过期');
  return { ...value, instruction: value.instruction.trim() };
}

export function validateReceipt(request: BotActionRequest, receipt: BotActionReceipt): boolean {
  if (receipt.requestId !== request.id || receipt.version !== request.version) return false;
  if (!receipt.summary.trim() || !Number.isFinite(Date.parse(receipt.completedAt))) return false;
  if (receipt.status === 'succeeded') {
    return typeof receipt.outputUri === 'string'
      && receipt.outputUri.startsWith(`${request.output.expectedUriScheme}://`);
  }
  return receipt.outputUri === undefined;
}

export const exampleBotAction: BotActionRequest = {
  id: 'metaapp-homepage-preview',
  version: 1,
  actor: { name: '屌丝', role: 'Twin Bot · 当前 Cowork 会话' },
  action: {
    kind: 'metaapp.preview',
    title: '生成 MetaApp Bot 首页预览',
    description: '按照已选的画廊方案，生成一份可以在 BotBrowser 审阅的 MetaApp 预览。',
  },
  target: { label: '屌丝 · Bot 首页' },
  impact: {
    risk: 'local',
    writes: ['一个可清理的本地预览产物', '本次会话的操作回执'],
    doesNotWrite: ['不会发布上链', '不会修改身份或正式首页', '不会发送 A2A 消息'],
  },
  output: { label: '在 BotBrowser 中打开预览', expectedUriScheme: 'preview-metaapp' },
};
