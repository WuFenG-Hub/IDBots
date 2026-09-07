import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import '../../index.css';
import Sidebar from '../../components/Sidebar';
import CoworkSessionDetail from '../../components/cowork/CoworkSessionDetail';
import { MessageExtensionContext } from '../../components/cowork/MessageExtensionContext';
import { store } from '../../store';
import { setCurrentSession } from '../../store/slices/coworkSlice';
import { setAvailableModels, setSelectedModel } from '../../store/slices/modelSlice';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import { DEEPSEEK_DEFAULT_MODEL_ID } from '../../config';
import { ProposalCard } from './ProposalCard';
import { acceptDecision, exampleRequest, validateDecision, type Decision } from './model';

const storageKey = 'idbots:native-proposal-preview:v1';
function load(): Decision | null {
  try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return saved && validateDecision(exampleRequest, saved) ? saved : null;
  } catch { return null; }
}
const now = Date.now();
store.dispatch(setCurrentSession({ id: 'proposal-preview', title: 'Homepage directions · UI preview',
  claudeSessionId: null, status: 'completed', pinned: false, cwd: '', systemPrompt: '',
  executionMode: 'local', activeSkillIds: [], createdAt: now, updatedAt: now,
  model: DEEPSEEK_DEFAULT_MODEL_ID, modelProvider: 'deepseek', messages: [
    { id: 'preview-user', type: 'user', content: 'Help me choose a homepage direction for my personal studio.', timestamp: now },
    { id: 'preview-proposal', type: 'assistant', content: 'Here are three directions. Select one and adjust the details below before continuing.', timestamp: now + 1 },
  ] }));
const model = { id: DEEPSEEK_DEFAULT_MODEL_ID, name: 'DeepSeek (preview)', provider: 'DeepSeek', providerKey: 'deepseek' };
store.dispatch(setAvailableModels([model]));
store.dispatch(setSelectedModel(model));
i18nService.setLanguage('zh', { persist: false });

function Demo() {
  const [collapsed, setCollapsed] = useState(false);
  const [decision, setDecision] = useState(load);
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState('Isolated UI preview · real IDBots components · no model, wallet or network actions');
  const unavailable = () => setNotice('This preview only demonstrates the proposal card. Other actions are not connected.');
  const reset = () => { localStorage.removeItem(storageKey); setDecision(null); setGeneration(n => n + 1); };
  return <Provider store={store}>
    <div className="h-screen flex flex-col bg-claude-bg text-claude-text">
      <div className="px-4 py-2 text-xs border-b border-claude-border bg-claude-surface flex justify-between gap-4" role="status">
        <span>{notice}</span><button onClick={reset}>Reset example</button>
      </div>
      <div className="flex flex-1 min-h-0">
        <Sidebar activeView="cowork" mode="home" internetPane="browser" isCollapsed={collapsed}
          onToggleCollapse={() => setCollapsed(!collapsed)} onShowSettings={unavailable}
          onShowSkills={unavailable} onShowCowork={unavailable} onShowScheduledTasks={unavailable}
          onShowGroupTasks={unavailable} onShowMetabots={unavailable} onNewChat={unavailable}
          onSelectHome={unavailable} onSelectBrowser={unavailable} onSelectInternetPane={unavailable} />
        <MessageExtensionContext.Provider value={message => message.id === 'preview-proposal' ?
          <div className="mt-4"><ProposalCard key={generation} request={exampleRequest} initialDecision={decision}
            onSubmit={async next => { const accepted = acceptDecision(exampleRequest, load(), next);
              localStorage.setItem(storageKey, JSON.stringify(accepted)); setDecision(accepted); }} />
            {decision && <details className="mt-3 text-xs"><summary>Saved locally · view decision (not sent to a Bot)</summary>
              <pre className="whitespace-pre-wrap mt-2">{JSON.stringify(decision, null, 2)}</pre></details>}
          </div> : null}>
          <div className="flex-1 min-w-0 flex flex-col"><CoworkSessionDetail onContinue={() => { unavailable(); return false; }}
            onStop={unavailable} isSidebarCollapsed={collapsed} onToggleSidebar={() => setCollapsed(!collapsed)}
            onNewChat={unavailable} onNavigateHome={unavailable} /></div>
        </MessageExtensionContext.Provider>
      </div>
    </div>
  </Provider>;
}
void configService.updateConfig({ providers: { ...configService.getConfig().providers!, deepseek: {
  enabled: true, apiKey: 'preview-not-a-real-key', baseUrl: 'https://preview.invalid', apiFormat: 'openai',
  models: [{ id: DEEPSEEK_DEFAULT_MODEL_ID, name: 'DeepSeek (preview)' }],
} } }).then(() => createRoot(document.getElementById('root')!).render(<Demo />));
