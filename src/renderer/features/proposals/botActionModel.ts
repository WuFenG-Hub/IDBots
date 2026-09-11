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
  if (!validateConfirmation(request, value)) throw new Error('Invalid or outdated action confirmation');
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
  actor: { name: 'Demo Bot', role: 'Twin Bot · current Cowork session' },
  action: {
    kind: 'metaapp.preview',
    title: 'Generate a MetaApp bot homepage preview',
    description: 'Generate a MetaApp preview from the selected gallery direction for review in BotBrowser.',
  },
  target: { label: 'Demo Bot · Bot homepage' },
  impact: {
    risk: 'local',
    writes: ['A disposable local preview artifact', 'An action receipt for this session'],
    doesNotWrite: ['Will not publish on-chain', 'Will not modify identity or the live homepage', 'Will not send A2A messages'],
  },
  output: { label: 'Open preview in BotBrowser', expectedUriScheme: 'preview-metaapp' },
};
