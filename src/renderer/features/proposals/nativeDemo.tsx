import { useRef, useState } from 'react';
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
import { BotActionCard } from './BotActionCard';
import { acceptConfirmation, exampleBotAction, validateConfirmation, validateReceipt, type BotActionConfirmation, type BotActionReceipt } from './botActionModel';

const confirmationKey = 'idbots:bot-action-preview:confirmation:v1';
const receiptKey = 'idbots:bot-action-preview:receipt:v1';
function loadConfirmation(): BotActionConfirmation | null {
  try { const saved = JSON.parse(localStorage.getItem(confirmationKey) || 'null');
    return saved && validateConfirmation(exampleBotAction, saved) ? saved : null;
  } catch { return null; }
}
function loadReceipt(): BotActionReceipt | null {
  try { const saved = JSON.parse(localStorage.getItem(receiptKey) || 'null');
    return saved && validateReceipt(exampleBotAction, saved) ? saved : null;
  } catch { return null; }
}
const now = Date.now();
store.dispatch(setCurrentSession({ id: 'proposal-preview', title: 'MetaApp 首页 · 操作预览',
  claudeSessionId: null, status: 'completed', pinned: false, cwd: '', systemPrompt: '',
  executionMode: 'local', activeSkillIds: [], createdAt: now, updatedAt: now,
  model: DEEPSEEK_DEFAULT_MODEL_ID, modelProvider: 'deepseek', messages: [
    { id: 'preview-user', type: 'user', content: '用刚才选好的画廊方案，生成一个我可以审阅的 Bot 首页。', timestamp: now },
    { id: 'preview-action', type: 'assistant', content: '设计方向已经确定。开始生成前，请确认由哪个 Bot 执行、会写入什么，以及完成后在哪里查看。', timestamp: now + 1 },
  ] }));
const model = { id: DEEPSEEK_DEFAULT_MODEL_ID, name: 'DeepSeek（演示）', provider: 'DeepSeek', providerKey: 'deepseek' };
store.dispatch(setAvailableModels([model]));
store.dispatch(setSelectedModel(model));
i18nService.setLanguage('zh', { persist: false });

function Demo() {
  const [collapsed, setCollapsed] = useState(false);
  const [confirmation, setConfirmation] = useState(loadConfirmation);
  const [receipt, setReceipt] = useState(loadReceipt);
  const [generation, setGeneration] = useState(0);
  const actionEpoch = useRef(0);
  const [notice, setNotice] = useState('隔离交互演示 · 使用真实 IDBots 组件 · 不调用模型、钱包或网络');
  const unavailable = () => setNotice('当前只演示 Bot 操作闭环，其他按钮尚未接入。');
  const reset = () => {
    actionEpoch.current += 1;
    localStorage.removeItem(confirmationKey); localStorage.removeItem(receiptKey);
    setConfirmation(null); setReceipt(null); setGeneration(n => n + 1);
  };
  return <Provider store={store}>
    <div className="h-screen flex flex-col bg-claude-bg text-claude-text">
      <div className="px-4 py-2 text-xs border-b border-claude-border bg-claude-surface flex justify-between gap-4" role="status">
        <span>{notice}</span><button onClick={reset}>重置演示</button>
      </div>
      <div className="flex flex-1 min-h-0">
        <Sidebar activeView="cowork" mode="home" internetPane="browser" isCollapsed={collapsed}
          onToggleCollapse={() => setCollapsed(!collapsed)} onShowSettings={unavailable}
          onShowSkills={unavailable} onShowCowork={unavailable} onShowScheduledTasks={unavailable}
          onShowGroupTasks={unavailable} onShowMetabots={unavailable} onNewChat={unavailable}
          onSelectHome={unavailable} onSelectBrowser={unavailable} onSelectInternetPane={unavailable} />
        <MessageExtensionContext.Provider value={message => message.id === 'preview-action' ?
          <div className="mt-4"><BotActionCard key={generation} request={exampleBotAction}
            initialConfirmation={confirmation} initialReceipt={receipt}
            onConfirm={async next => {
              const accepted = acceptConfirmation(exampleBotAction, loadConfirmation(), next);
              localStorage.setItem(confirmationKey, JSON.stringify(accepted)); setConfirmation(accepted);
              return null;
            }}
            onApprovalResolved={async () => {
              const epoch = actionEpoch.current;
              await new Promise(resolve => window.setTimeout(resolve, 650));
              if (actionEpoch.current !== epoch) throw new Error('操作已被重置');
              const result: BotActionReceipt = { requestId: exampleBotAction.id, version: exampleBotAction.version,
                status: 'succeeded', summary: 'MetaApp 预览已生成，可以开始审阅',
                outputUri: 'preview-metaapp://fixture/homepage-gallery', completedAt: new Date().toISOString() };
              localStorage.setItem(receiptKey, JSON.stringify(result)); setReceipt(result); return result;
            }}
            onOpenOutput={uri => setNotice(`BotBrowser 交接预览：${uri} · 演示环境未执行真实跳转`)} />
            {receipt && <details className="mt-3 text-xs"><summary>查看结构化执行回执（本地模拟数据）</summary>
              <pre className="whitespace-pre-wrap mt-2">{JSON.stringify(receipt, null, 2)}</pre></details>}
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
  models: [{ id: DEEPSEEK_DEFAULT_MODEL_ID, name: 'DeepSeek（演示）' }],
} } }).then(() => createRoot(document.getElementById('root')!).render(<Demo />));
