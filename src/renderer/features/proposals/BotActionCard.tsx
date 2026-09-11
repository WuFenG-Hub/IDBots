import { useRef, useState } from 'react';
import type { BotActionConfirmation, BotActionReceipt, BotActionRequest, BotActionStatus } from './botActionModel';
import { acceptConfirmation } from './botActionModel';
import './botAction.css';

interface Props {
  request: BotActionRequest;
  initialConfirmation?: BotActionConfirmation | null;
  initialReceipt?: BotActionReceipt | null;
  /** Submit intent only. A null result means the DSH approval channel is pending. */
  onConfirm: (confirmation: BotActionConfirmation) => Promise<BotActionReceipt | null>;
  /** Called only after the host receives an allowed-once DSH approval. */
  onApprovalResolved?: () => Promise<BotActionReceipt>;
  onOpenOutput: (uri: string) => void;
}

export function BotActionCard({ request, initialConfirmation = null, initialReceipt = null, onConfirm, onApprovalResolved, onOpenOutput }: Props) {
  const [instruction, setInstruction] = useState(initialConfirmation?.instruction ?? '保留画廊式布局，文案语气再温暖一点。');
  const [confirmation, setConfirmation] = useState(initialConfirmation);
  const [receipt, setReceipt] = useState(initialReceipt);
  const [status, setStatus] = useState<BotActionStatus>(initialReceipt?.status ?? (initialConfirmation ? 'awaiting_tool_approval' : 'awaiting_confirmation'));
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const riskLabel = request.impact.risk === 'local' ? '仅生成本地预览' : request.impact.risk === 'onchain' ? '包含链上写入' : '包含外部操作';

  async function confirm() {
    if (submitting.current || confirmation) return;
    submitting.current = true;
    setError('');
    try {
      const accepted = acceptConfirmation(request, confirmation, {
        requestId: request.id, version: request.version, approved: true,
        instruction, confirmedAt: new Date().toISOString(),
      });
      setConfirmation(accepted);
      setStatus('executing');
      const result = await onConfirm(accepted);
      if (result) { setReceipt(result); setStatus(result.status); }
      else setStatus('awaiting_tool_approval');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
      setStatus('failed');
    } finally { submitting.current = false; }
  }

  return <section className="bot-action-card" aria-label={request.action.title}>
    <header className="bot-action-header">
      <div className="bot-action-icon" aria-hidden="true">↗</div>
      <div><span className="bot-action-kicker">BOT 操作 · V{request.version}</span><h2>{request.action.title}</h2><p>{request.action.description}</p></div>
      <span className={`bot-action-state state-${status}`}>{status === 'awaiting_confirmation' ? '等待确认' : status === 'awaiting_tool_approval' ? '等待工具授权' : status === 'executing' ? '执行中' : status === 'succeeded' ? '已完成' : '失败'}</span>
    </header>

    <div className="bot-action-route" aria-label="操作路径">
      <div><span>执行身份</span><strong>{request.actor.name}</strong><small>{request.actor.role}</small></div>
      <i aria-hidden="true">→</i>
      <div><span>操作</span><strong>{request.action.kind}</strong><small>由当前会话发起</small></div>
      <i aria-hidden="true">→</i>
      <div><span>目标</span><strong>{request.target.label}</strong><small>{request.target.uri ?? '本地工作区'}</small></div>
    </div>

    <div className="bot-action-impact">
      <div><span className="impact-label">将产生的影响</span><strong>{riskLabel}</strong>
        <ul>{request.impact.writes.map(item => <li key={item}>＋ {item}</li>)}</ul></div>
      <div className="impact-safe"><span>明确不会执行</span><ul>{request.impact.doesNotWrite.map(item => <li key={item}>✓ {item}</li>)}</ul></div>
    </div>

    <label className="bot-action-instruction">执行要求 <span>确认前可以修改</span>
      <textarea rows={2} maxLength={2000} disabled={!!confirmation} value={instruction} onChange={event => setInstruction(event.target.value)} />
    </label>

    {status === 'awaiting_tool_approval' && !receipt ? <div className="bot-action-approval" role="status">
      <strong>意图已记录，等待 DSH 工具授权</strong><span>这一步由系统权限通道决定，卡片本身不会放行操作。</span>
      {onApprovalResolved && <button type="button" onClick={() => { setStatus('executing'); void onApprovalResolved().then(result => { setReceipt(result); setStatus(result.status); }).catch(cause => { setError(cause instanceof Error ? cause.message : '授权后的操作失败'); setStatus('failed'); }); }}>模拟允许一次</button>}
    </div> : null}
    {receipt ? <div className={`bot-action-receipt receipt-${receipt.status}`} role="status">
      <div><span>{receipt.status === 'succeeded' ? '✓' : '!'}</span><div><strong>{receipt.summary}</strong><small>执行回执 · {new Date(receipt.completedAt).toLocaleTimeString()}</small></div></div>
      {receipt.outputUri && <button type="button" onClick={() => onOpenOutput(receipt.outputUri!)}>{request.output.label} ↗</button>}
    </div> : null}

    <footer className="bot-action-footer">
      <span role="status">{error || (status === 'awaiting_tool_approval' ? '请在底部权限审批条中处理 DSH 工具请求。' : status === 'executing' ? 'Bot 正在生成预览…' : confirmation ? '本版本的确认记录已经锁定。' : '继续前请核对执行身份、目标和影响。')}</span>
      <button type="button" disabled={!!confirmation || !instruction.trim()} onClick={() => void confirm()}>{status === 'executing' ? '执行中…' : confirmation ? '已确认 ✓' : '确认生成本地预览'}</button>
    </footer>
  </section>;
}
