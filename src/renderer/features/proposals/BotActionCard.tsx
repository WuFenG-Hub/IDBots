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
  const [instruction, setInstruction] = useState(initialConfirmation?.instruction ?? 'Keep the gallery layout, but make the tone a little warmer.');
  const [confirmation, setConfirmation] = useState(initialConfirmation);
  const [receipt, setReceipt] = useState(initialReceipt);
  const [status, setStatus] = useState<BotActionStatus>(initialReceipt?.status ?? (initialConfirmation ? 'awaiting_tool_approval' : 'awaiting_confirmation'));
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const riskLabel = request.impact.risk === 'local' ? 'Local preview only' : request.impact.risk === 'onchain' ? 'Includes on-chain writes' : 'Includes external actions';

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
      setError(cause instanceof Error ? cause.message : 'Action failed');
      setStatus('failed');
    } finally { submitting.current = false; }
  }

  return <section className="bot-action-card" aria-label={request.action.title}>
    <header className="bot-action-header">
      <div className="bot-action-icon" aria-hidden="true">↗</div>
      <div><span className="bot-action-kicker">BOT ACTION · V{request.version}</span><h2>{request.action.title}</h2><p>{request.action.description}</p></div>
      <span className={`bot-action-state state-${status}`}>{status === 'awaiting_confirmation' ? 'Awaiting confirmation' : status === 'awaiting_tool_approval' ? 'Awaiting tool approval' : status === 'executing' ? 'Executing' : status === 'succeeded' ? 'Completed' : 'Failed'}</span>
    </header>

    <div className="bot-action-route" aria-label="Action route">
      <div><span>Actor</span><strong>{request.actor.name}</strong><small>{request.actor.role}</small></div>
      <i aria-hidden="true">→</i>
      <div><span>Action</span><strong>{request.action.kind}</strong><small>Initiated by this session</small></div>
      <i aria-hidden="true">→</i>
      <div><span>Target</span><strong>{request.target.label}</strong><small>{request.target.uri ?? 'Local workspace'}</small></div>
    </div>

    <div className="bot-action-impact">
      <div><span className="impact-label">Impact</span><strong>{riskLabel}</strong>
        <ul>{request.impact.writes.map(item => <li key={item}>＋ {item}</li>)}</ul></div>
      <div className="impact-safe"><span>Explicitly will not</span><ul>{request.impact.doesNotWrite.map(item => <li key={item}>✓ {item}</li>)}</ul></div>
    </div>

    <label className="bot-action-instruction">Instructions <span>Editable before confirming</span>
      <textarea rows={2} maxLength={2000} disabled={!!confirmation} value={instruction} onChange={event => setInstruction(event.target.value)} />
    </label>

    {status === 'awaiting_tool_approval' && !receipt ? <div className="bot-action-approval" role="status">
      <strong>Intent recorded. Waiting for DSH tool approval</strong><span>This step is decided by the system permission channel; the card itself does not authorize the action.</span>
      {onApprovalResolved && <button type="button" onClick={() => { setStatus('executing'); void onApprovalResolved().then(result => { setReceipt(result); setStatus(result.status); }).catch(cause => { setError(cause instanceof Error ? cause.message : 'The post-approval action failed'); setStatus('failed'); }); }}>Simulate allow once</button>}
    </div> : null}
    {receipt ? <div className={`bot-action-receipt receipt-${receipt.status}`} role="status">
      <div><span>{receipt.status === 'succeeded' ? '✓' : '!'}</span><div><strong>{receipt.summary}</strong><small>Execution receipt · {new Date(receipt.completedAt).toLocaleTimeString()}</small></div></div>
      {receipt.outputUri && <button type="button" onClick={() => onOpenOutput(receipt.outputUri!)}>{request.output.label} ↗</button>}
    </div> : null}

    <footer className="bot-action-footer">
      <span role="status">{error || (status === 'awaiting_tool_approval' ? 'Handle the DSH tool request in the permission bar below.' : status === 'executing' ? 'Bot is generating the preview…' : confirmation ? 'The confirmation for this version is locked.' : 'Review the actor, target, and impact before continuing.')}</span>
      <button type="button" disabled={!!confirmation || !instruction.trim()} onClick={() => void confirm()}>{status === 'executing' ? 'Executing…' : confirmation ? 'Confirmed ✓' : 'Confirm and generate local preview'}</button>
    </footer>
  </section>;
}
