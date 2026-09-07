import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { ProposalCard } from './ProposalCard';
import { acceptDecision, exampleRequest, validateDecision, type Decision } from './model';

const storageKey = 'idbots:proposal-demo:homepage:v1';
function load(): Decision | null { try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); return saved && validateDecision(exampleRequest, saved) ? saved : null; } catch { return null; } }

function Demo() {
  const [decision, setDecision] = useState<Decision | null>(load);
  const [generation, setGeneration] = useState(0);
  const [dark, setDark] = useState(false);
  const [showPayload, setShowPayload] = useState(false);
  return <div className={`proposal-demo ${dark ? 'dark' : ''}`}>
    <aside className="demo-sidebar"><div className="demo-brand"><span>iD</span>IDBots</div><button className="demo-new" onClick={() => { localStorage.removeItem(storageKey); setDecision(null); setGeneration(generation + 1); }}>＋ New example</button><div className="demo-nav">◈ Cowork</div><div className="demo-nav muted">◎ Bots</div><div className="demo-nav muted">▧ MetaApps</div><div className="sidebar-caption">DSH SESSION</div><div className="demo-active">◌ 屌丝 · Homepage directions</div><div className="sidebar-bottom"><span>屌丝 · DSH</span><small>DeepSeek · deepseek-v4-flash-vision-exp</small></div></aside>
    <main className="demo-main"><header className="demo-topbar"><span><b>屌丝</b> <em>via DSH</em> <b>/</b> Homepage directions</span><div className="model-badge">DeepSeek · deepseek-v4-flash-vision-exp</div><button onClick={() => setDark(!dark)}>{dark ? '☀ Light' : '☾ Dark'}</button></header>
      <div className="demo-scroll"><div className="demo-conversation"><div className="demo-notice">INTERACTION PREVIEW <span>DSH / DeepSeek session · no network writes</span></div><div className="demo-user">屌丝，帮我选择一个个人工作室首页方向。</div><div className="demo-agent"><div className="agent-mark">屌</div><div><strong>屌丝 <span>via DSH · DeepSeek</span></strong><p>我整理了三个方向。你可以先选一个，再直接调整细节；提交后我会收到结构化的选择和修改意见。</p></div></div>
        <ProposalCard key={generation} request={exampleRequest} initialDecision={decision} onSubmit={async next => { const accepted = acceptDecision(exampleRequest, load(), next); localStorage.setItem(storageKey, JSON.stringify(accepted)); setDecision(accepted); }} />
        {decision && <div className="demo-receipt" role="status"><span>✓</span><div><strong>已交回屌丝</strong><p>{decision.optionId} · “{decision.headline}” · {decision.color}</p><p>{decision.notes || '没有附加说明。'}</p><small>预览模式：当前没有启动真实 Agent 回合。</small><button onClick={() => setShowPayload(!showPayload)}>{showPayload ? '隐藏' : '查看'}结构化交接记录</button>{showPayload && <pre>{JSON.stringify(decision, null, 2)}</pre>}</div></div>}
        <div className="demo-bottom-note">选择记录会在刷新后保留；点击“New example”重新体验。</div>
      </div></div>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Demo />);
