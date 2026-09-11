import React, { useRef, useState } from 'react';
import { acceptDecision, type Decision, type Proposal, type ProposalRequest } from './model';
import './proposals.css';

export function ProposalPreview({ option, headline = option.headline, color = option.color }: { option: Proposal; headline?: string; color?: string }) {
  return <div className={`proposal-preview ${option.layout}`} style={{ '--preview-accent': color } as React.CSSProperties} aria-label={`${option.name} layout preview`}>
    <div className="preview-nav"><strong>studio /</strong><span>Work About ↗</span></div>
    <div className="preview-body"><small>INDEPENDENT IDEAS & EXPERIMENTS</small><h3>{headline}</h3><div className="preview-art"><i/><i/><i/></div><div className="preview-lines"><i/><i/></div></div>
    <div className="preview-bottom"><span>Selected work</span><span>2026 ↗</span></div>
  </div>;
}

// Submission is delegated to the host; a production adapter must persist and deduplicate it.
export function ProposalCard({ request, initialDecision = null, onSubmit }: { request: ProposalRequest; initialDecision?: Decision | null; onSubmit: (decision: Decision) => Promise<void> }) {
  const [selected, setSelected] = useState(initialDecision?.optionId ?? '');
  const [edits, setEdits] = useState<Record<string, { headline: string; color: string }>>(() => initialDecision ? {
    [initialDecision.optionId]: { headline: initialDecision.headline, color: initialDecision.color },
  } : {});
  const [notes, setNotes] = useState(initialDecision?.notes ?? '');
  const [decision, setDecision] = useState(initialDecision);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const option = request.options.find(item => item.id === selected);
  const edit = option ? edits[option.id] ?? { headline: initialDecision?.headline ?? option.headline, color: initialDecision?.color ?? option.color } : null;
  async function submit() {
    if (!option || !edit || submitting.current || decision) return;
    submitting.current = true; setPending(true); setError('');
    try {
      const next = acceptDecision(request, decision, { requestId: request.id, version: request.version, optionId: option.id, ...edit, notes, submittedAt: new Date().toISOString() });
      await onSubmit(next); setDecision(next);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not submit. Please try again.'); }
    finally { submitting.current = false; setPending(false); }
  }
  return <section className="proposal-card" aria-label="Compare homepage proposals">
    <header className="proposal-heading"><div><span className="eyebrow">PROPOSAL COLLECTION · V{request.version}</span><h2>Choose a direction. Make it yours.</h2><p>Compare three approaches, then fine-tune the one you like.</p></div><span className={`status-pill ${decision ? 'done' : ''}`}>{decision ? '✓ Submitted' : 'Your input needed'}</span></header>
    <div className="proposal-options" role="group" aria-label="Design options">{request.options.map((item, index) => <button type="button" key={item.id} disabled={!!decision || pending} aria-pressed={selected === item.id} className={`proposal-option ${selected === item.id ? 'selected' : ''}`} onClick={() => setSelected(item.id)}>
      <ProposalPreview option={item} headline={edits[item.id]?.headline} color={edits[item.id]?.color}/>
      <div className="option-copy"><div className="option-title"><span>{String.fromCharCode(65 + index)} / {item.name}</span><span className="selection-dot">{selected === item.id ? '✓' : ''}</span></div><p>{item.description}</p><div className="option-benefit">{item.benefit}</div><div className="option-tradeoff">Consider: {item.tradeoff}</div></div>
    </button>)}</div>
    {option && edit ? <div className="proposal-editor"><div className="editor-intro"><span className="eyebrow">{decision ? 'YOUR DECISION' : 'MAKE IT YOURS'}</span><h3>{option.name}</h3><p>{decision ? 'Saved with this proposal version.' : 'Your changes appear in the preview above.'}</p></div><fieldset disabled={!!decision || pending}><label>Homepage headline<input maxLength={100} value={edit.headline} onChange={event => setEdits({ ...edits, [option.id]: { ...edit, headline: event.target.value } })}/></label><label className="color-label">Accent color<div><input type="color" value={edit.color} onChange={event => setEdits({ ...edits, [option.id]: { ...edit, color: event.target.value } })}/><code>{edit.color.toUpperCase()}</code></div></label><label className="notes-label">Anything else? <span>Optional</span><textarea maxLength={2000} rows={2} placeholder="Keep the layout, but make the tone a little warmer…" value={notes} onChange={event => setNotes(event.target.value)}/></label></fieldset></div> : <div className="proposal-empty">Select a direction above to edit its headline, color and instructions.</div>}
    <footer className="proposal-footer"><span role="status">{error || (decision ? '✓ Decision saved. This card is now read-only.' : 'You can edit your choice before submitting.')}</span><button className="proposal-submit" disabled={!option || !edit?.headline.trim() || pending || !!decision} onClick={() => void submit()}>{decision ? 'Submitted ✓' : pending ? 'Saving…' : 'Continue with this →'}</button></footer>
  </section>;
}
