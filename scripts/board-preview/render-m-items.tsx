/**
 * M 组视觉素材生成器（**组件真渲染 + 真实编译样式**，不是真机截图）。
 *
 * 与上一版的区别：这一版**灌真实 redux store 后渲染真实容器**（`ScheduledTasksView` /
 * `TrackedTasksSection` / `TrackedTaskDrawer` / `CloseTaskModal`），因此 M 组里
 * 「版式与层级」类条目拿到的不是复刻件，而是组件自身的输出。
 *
 * 不能覆盖的（据实）：任何需要**交互**或**真机 IPC/实库**的条目（切换 Tab、点击跳转、
 * 跑过迁移的库、M13 的定时任务挂卡勾选——该界面尚未实现）。
 *
 * 运行：npx tsx .cowork-temp/board-preview/render.tsx
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve(process.cwd(), '.cowork-temp/board-preview');
const CSS_FILE = fs
  .readdirSync(path.resolve(process.cwd(), 'dist/assets'))
  .filter((f) => f.startsWith('index-') && f.endsWith('.css'))
  .sort()
  .pop()!;
const CSS_HREF = path.resolve(process.cwd(), 'dist/assets', CSS_FILE);

function stubBrowserGlobals() {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  (globalThis as any).navigator = { language: 'zh-CN' };
  (globalThis as any).window = {
    electron: { platform: 'darwin' },
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

const NOW = Date.parse('2026-09-17T14:00:00.000Z');
const DAY = 86_400_000;

function card(over: Record<string, unknown>): any {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    title: '未命名卡',
    goal: '未命名卡',
    state: 'in_progress',
    stateLabelKey: 'trackedTask.column.inProgress',
    ledgerStatus: 'running',
    closureWarn: false,
    closureDue: false,
    closureDueLevel: null,
    closureSuggestion: '',
    closureConclusion: null,
    activityAtMs: NOW - 2 * DAY,
    lastActivityAtMs: NOW - 2 * DAY,
    idleMs: 2 * DAY,
    createdAt: '2026-09-10T02:00:00.000Z',
    updatedAt: '2026-09-15T02:00:00.000Z',
    sourceSessionId: null,
    sourceKind: 'session',
    groupTaskId: null,
    scheduledTaskId: null,
    needsOwnerAction: false,
    actionRank: 3,
    reasons: [],
    reasonCodes: [],
    closureSuggestionArgs: null,
    reasonOverflow: 0,
    closureSuggestionCode: null,
    ...over,
  };
}

const CARD_GROUP = card({
  id: 'e37fc784-0000-4000-8000-000000000083',
  title: 'IDBots 长期任务看板 v1（本机跨 session 共享任务台账）',
  goal: '在 IDBots 本机原生界面落地「长期任务看板 v1」，复用 orchestration_tasks 作为唯一权威台账',
  state: 'waiting_decision',
  stateLabelKey: 'trackedTask.column.waitingDecision',
  ledgerStatus: 'review',
  closureDue: true,
  closureDueLevel: 'zombie',
  closureWarn: true,
  closureSuggestion: 'Deliverables are verifiable (3); close the card with a one-line conclusion.',
  idleMs: 2.4 * DAY,
  lastActivityAtMs: NOW - 2.4 * DAY,
  sourceKind: 'group_task',
  groupTaskId: 83,
  needsOwnerAction: true,
  actionRank: 0,
  reasons: [
    'ledger status=review, awaiting a decision',
    '2 open group-task checkpoint(s)',
    '3 verifiable deliverable(s)',
    'idle for 2.4 day(s)',
    'linked sessions: idle, idle, idle',
  ],
  reasonCodes: [
    { code: 'ledger_review', args: {} },
    { code: 'open_checkpoints', args: { count: 2 } },
    { code: 'deliverables_verifiable', args: { count: 3 } },
    { code: 'idle_days', args: { days: 2.4 } },
    { code: 'linked_sessions', args: { count: 3 } },
  ],
  reasonOverflow: 2,
  closureSuggestionCode: 'deliverables_verifiable',
  closureSuggestionArgs: { count: 3 },
});

const CARD_TERMINAL = card({
  id: '9a1c2f30-0000-4000-8000-0000000000a1',
  title: 'MetaApp 技能介绍 · 第 12 期（选题冻结中）',
  state: 'waiting_decision',
  stateLabelKey: 'trackedTask.column.waitingDecision',
  ledgerStatus: 'completed',
  closureDue: true,
  closureDueLevel: 'terminal_no_conclusion',
  closureWarn: true,
  closureSuggestion: 'Reached a terminal status without a conclusion; add a one-line closing note.',
  idleMs: 1.2 * DAY,
  lastActivityAtMs: NOW - 1.2 * DAY,
  needsOwnerAction: true,
  actionRank: 1,
  reasons: ['terminal status without a closing conclusion', 'idle for 1.2 day(s)'],
  reasonCodes: [
    { code: 'terminal_without_conclusion', args: {} },
    { code: 'idle_days', args: { days: 1.2 } },
  ],
  closureSuggestionCode: 'terminal_no_conclusion',
  closureSuggestionArgs: {},
});

const CARD_BLOCKED_A = card({
  id: '4b8d5e60-0000-4000-8000-0000000000b2',
  title: 'metaso 索引器：bot 信息聚合增量重构',
  state: 'blocked_external',
  stateLabelKey: 'trackedTask.column.blockedExternal',
  idleMs: 0.6 * DAY,
  lastActivityAtMs: NOW - 0.6 * DAY,
  reasons: ['2 blocked step(s) with unmet dependencies', 'linked sessions: idle'],
  reasonCodes: [
    { code: 'blocked_unmet_dependencies', args: { count: 2 } },
    { code: 'linked_sessions', args: { count: 1 } },
  ],
  actionRank: 2,
});

const CARD_BLOCKED_B = card({
  id: 'c0ffee10-0000-4000-8000-0000000000c3',
  title: 'OAC 服务市场：报价协议字段对齐',
  state: 'blocked_external',
  stateLabelKey: 'trackedTask.column.blockedExternal',
  sourceKind: 'scheduled_task',
  scheduledTaskId: 'sched-19',
  idleMs: 3.1 * DAY,
  lastActivityAtMs: NOW - 3.1 * DAY,
  closureDue: true,
  closureDueLevel: 'sessions_ended',
  closureSuggestion: 'No activity for 3.1 day(s); close it or redefine the acceptance criteria.',
  reasons: ['1 blocked step(s) with unmet dependencies', 'idle for 3.1 day(s)'],
  reasonCodes: [
    { code: 'blocked_unmet_dependencies', args: { count: 1 } },
    { code: 'idle_days', args: { days: 3.1 } },
  ],
  closureSuggestionCode: 'unresolved_dependencies',
  closureSuggestionArgs: { days: 3.1 },
  needsOwnerAction: true,
  actionRank: 0,
});

const CARD_RUNNING_A = card({
  id: '7d3a1b90-0000-4000-8000-0000000000d4',
  title: 'Agentpedia 词条：MVC 费用模型（第 3 稿）',
  idleMs: 0.1 * DAY,
  lastActivityAtMs: NOW - 0.1 * DAY,
  reasons: ['3 step(s) ready/queued/running', '1 attempt(s) queued/running', 'linked sessions: running'],
  reasonCodes: [
    { code: 'steps_active', args: { count: 3 } },
    { code: 'attempts_open', args: { count: 1 } },
    { code: 'linked_sessions', args: { count: 1 } },
  ],
});

const CARD_RUNNING_B = card({
  id: 'f11e2d40-0000-4000-8000-0000000000e5',
  title: 'Bot Browser 缓存清理回归',
  ledgerStatus: 'planning',
  idleMs: 0.3 * DAY,
  lastActivityAtMs: NOW - 0.3 * DAY,
  reasons: ['1 step(s) ready/queued/running'],
  reasonCodes: [{ code: 'steps_active', args: { count: 1 } }],
});

const CARD_CLOSED = card({
  id: 'aa11bb22-0000-4000-8000-0000000000f6',
  title: '每日 Skill 素材归档（第 41 期）',
  state: 'closed',
  stateLabelKey: 'trackedTask.column.closed',
  ledgerStatus: 'completed',
  closureConclusion: '本期素材已按三件套归档，链上证据齐。',
  idleMs: 0.9 * DAY,
  lastActivityAtMs: NOW - 0.9 * DAY,
  reasons: ['linked sessions: idle'],
  reasonCodes: [{ code: 'linked_sessions', args: { count: 1 } }],
  actionRank: 4,
});

const ALL_CARDS = [CARD_GROUP, CARD_TERMINAL, CARD_BLOCKED_A, CARD_BLOCKED_B, CARD_RUNNING_A, CARD_RUNNING_B, CARD_CLOSED];
const idsOf = (state: string) => ALL_CARDS.filter((c) => c.state === state).map((c) => c.id);

function boardOf(cards: any[], over: Record<string, unknown> = {}): any {
  return {
    ledger: 'orchestration_tasks',
    generatedAtMs: NOW,
    scopeApplied: 'default',
    scopeWindowMs: 7 * DAY,
    seq: 41,
    columns: [
      { state: 'waiting_decision', labelKey: 'trackedTask.column.waitingDecision', cardIds: idsOf('waiting_decision') },
      { state: 'in_progress', labelKey: 'trackedTask.column.inProgress', cardIds: idsOf('in_progress') },
      { state: 'blocked_external', labelKey: 'trackedTask.column.blockedExternal', cardIds: idsOf('blocked_external') },
      { state: 'closed', labelKey: 'trackedTask.column.closed', cardIds: idsOf('closed') },
    ],
    cards,
    closureDueCardIdsPage: cards.filter((c) => c.closureDue).slice(0, cards.length).map((c) => c.id),
    closureDueCountPage: cards.filter((c) => c.closureDue).length,
    counts: {
      total: 262,
      visible: cards.length,
      folded: 255,
      closureDue: cards.filter((c) => c.closureDue).length,
      zombieLevel: 1,
      terminalNoConclusionLevel: 1,
      sessionsEndedLevel: 1,
    },
    hasMore: false,
    ...over,
  };
}

/** M4 空列态：把「已收口」的卡拿走，让该列渲染空态。 */
const BOARD_EMPTY_CLOSED = boardOf(ALL_CARDS.filter((c) => c.state !== 'closed'));

const DETAIL_BASE = {
  ...CARD_GROUP,
  enrichedGoal:
    '把现有「定时任务」入口升级成「跟踪任务」：唯一权威台账 orchestration_tasks，看板/清单/卡详情三层，Twin 心跳驱动僵尸清扫。',
  acceptanceCriteria: [
    '账本仍只有 orchestration_tasks 一本，群任务与定时任务挂同一张卡',
    '状态机含「等外部·阻塞」与「待你拍板」两态，可自动推导',
    '僵尸：>1 天预警、>2 天判僵尸，超阈值进待收口并给一句话建议',
    '跟踪任务页两 Tab，长期任务默认在前',
    '看板四列 + 清单按「需要我出手」排序 + 任务卡抽屉九字段',
  ],
  owner: { twinMetabotId: 1, ownerGlobalMetaId: 'idq1t3lzq0q4rec8edujklp4w8hfmgceqxth82a7m9' },
  planVersion: 3,
  completedAt: null,
  nextCheckpointAt: '2026-09-17T06:30:00.000Z',
  checkpoints: [{ topic: '契约 v1.4 锁版', status: 'open', createdAt: '2026-09-17T06:30:00.000Z' }],
  dependencies: [
    { stepId: 's1', title: '架构契约 v1.4 冻结', status: 'completed', dependsOn: [], unmet: [] },
    { stepId: 's2', title: '主进程 trackedTask:* 四通道', status: 'running', dependsOn: ['s1'], unmet: [] },
    { stepId: 's3', title: '前端三层界面接线', status: 'blocked', dependsOn: ['s2'], unmet: ['s2'] },
  ],
  steps: [
    { id: 's1', ordinal: 1, title: '架构契约', status: 'completed', assigneeMetabotId: 2 },
    { id: 's2', ordinal: 2, title: '后端四通道', status: 'running', assigneeMetabotId: 3 },
    { id: 's3', ordinal: 3, title: '前端接线', status: 'blocked', assigneeMetabotId: 35 },
  ],
  participants: [2, 3, 35, 6],
  sessions: [
    { sessionId: '823308c4-ebff-4c2b-8b38-ec21dbe6b0a5', role: 'source' },
    { sessionId: 'b1a2c3d4-1111-4222-8333-444455556666', role: 'group_chat' },
    { sessionId: 'c9d8e7f6-2222-4333-8444-555566667777', role: 'worker_attempt' },
    { sessionId: '7f6e5d4c-3333-4444-8555-666677778888', role: 'scheduled_run' },
  ],
  deliverables: [
    { uri: 'pin://16cb33915d4443f7f90858808ba4efca94fd2241b49335167953f054ce0e9d1di0', status: 'delivered', confirmation: 'ok', kind: 'pin' },
    { uri: 'pin://b6487c2152d49dc2f8e468788d9162e9574d5f9be53c998a037aa384277ec3c9i0', status: 'delivered', confirmation: 'ok', kind: 'pin' },
    { uri: 'metafile://9f8e7d6c5b4a39281706f5e4d3c2b1a0998877665544332211009f8e7d6c5b4ai0', status: 'accepted', confirmation: 'ok', kind: 'file' },
  ],
  events: [
    { at: '2026-09-17T05:47:00.000Z', kind: 'card_created', detail: 'plan version 1' },
    { at: '2026-09-17T05:51:00.000Z', kind: 'step_updated', detail: '架构规格 -> completed' },
    { at: '2026-09-17T06:07:00.000Z', kind: 'attempt', detail: 'completed (worker 3)' },
    { at: '2026-09-17T06:12:00.000Z', kind: 'checkpoint', detail: 'open: 契约 v1.4 锁版' },
  ],
  closure: { conclusion: null, by: null, at: null, pinId: null },
};

const DETAIL_5 = { ...DETAIL_BASE, reasons: DETAIL_BASE.reasons.slice(0, 5), reasonOverflow: 0 };
const DETAIL_7 = {
  ...DETAIL_BASE,
  reasons: [...DETAIL_BASE.reasons, '6 verifiable deliverable(s)', '7 step(s) ready/queued/running'],
  reasonCodes: [
    ...DETAIL_BASE.reasonCodes,
    { code: 'deliverables_verifiable', args: { count: 6 } },
    { code: 'steps_active', args: { count: 7 } },
  ],
  reasonOverflow: 2,
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(title: string, note: string, body: string, extra = ''): string {
  return `<!doctype html>
<html class="dark" lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${CSS_HREF}" />
<style>
  body { margin:0; background:#262624; color:#e8e6e3; font-family:-apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif; }
  .shot { width:1440px; height:900px; display:flex; flex-direction:column; overflow:hidden; position:relative; }
  .caption { height:26px; display:flex; align-items:center; gap:10px; padding:0 12px; font-size:11px;
             background:#1b1b19; color:#b4b1ad; border-bottom:1px solid rgba(255,255,255,.07); }
  .caption b { color:#ffd9a0; font-weight:600; }
  .split { display:flex; gap:16px; padding:16px; }
  .split > .pane { flex:1; min-width:0; border:1px solid rgba(255,255,255,.1); border-radius:10px; overflow:hidden; }
  .panehead { padding:6px 10px; font-size:11px; color:#b4b1ad; background:#1b1b19; }
  ${extra}
</style>
</head>
<body><div class="shot"><div class="caption">${note}</div>${body}</div></body>
</html>`;
}

async function main() {
  stubBrowserGlobals();
  const { i18nService } = await import('../../src/renderer/services/i18n');
  (i18nService as unknown as { currentLanguage: string }).currentLanguage = 'zh';

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Provider } = await import('react-redux');
  const { store } = await import('../../src/renderer/store');
  const slice = await import('../../src/renderer/store/slices/trackedTaskSlice');

  const ScheduledTasksView = (await import('../../src/renderer/components/scheduledTasks/ScheduledTasksView')).default;
  const Section = (await import('../../src/renderer/components/trackedTasks/TrackedTasksSection')).default;
  const Drawer = (await import('../../src/renderer/components/trackedTasks/TrackedTaskDrawer')).default;
  const CloseModal = (await import('../../src/renderer/components/trackedTasks/CloseTaskModal')).default;
  const ChipView = (await import('../../src/renderer/components/trackedTasks/TrackedTaskOriginChipView')).default;
  const List = (await import('../../src/renderer/components/trackedTasks/TrackedTasksList')).default;

  const noop = () => undefined;
  const names = new Map<number, string>([
    [1, 'AI_Sunny'],
    [2, 'loop'],
    [3, 'Builder阿码'],
    [6, '小明同学'],
    [35, '小昆'],
  ]);
  const withStore = (el: React.ReactElement) =>
    renderToStaticMarkup(React.createElement(Provider as any, { store } as any, el));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files: Array<{ name: string; html: string }> = [];

  // ---------- M1 / M3 / M4 / M10 / M11 / M12 / M16：真实 ScheduledTasksView + 种子 board ----------
  store.dispatch(slice.setBoard(boardOf(ALL_CARDS) as any));
  store.dispatch(slice.setViewMode('board'));
  files.push({
    name: 'm1-board',
    html: page(
      'M1/M3/M10/M11/M12',
      '<b>M1</b> L1 双 Tab（长期任务默认在前） · <b>M3</b> 看板四列列名与顺序 · <b>M10</b> 待收口跨列横幅+一键筛 · <b>M11</b> 三级分别计数 · <b>M12</b> 默认范围明示可清除 · <b>M16</b> 入口文案「跟踪任务」',
      withStore(React.createElement(ScheduledTasksView as any, {}))
    ),
  });

  // ---------- M4：空列态 ----------
  store.dispatch(slice.setBoard(boardOf(BOARD_EMPTY_CLOSED.cards) as any));
  store.dispatch(slice.setViewMode('board'));
  files.push({
    name: 'm4-empty-column',
    html: page(
      'M4',
      '<b>M4</b> 空列态渲染（「已收口」列无卡时该列显示空态文案，不是空白）',
      withStore(React.createElement(Section as any, {}))
    ),
  });

  // ---------- M5：清单排序（同一批卡，两种顺序） ----------
  const orderA = [CARD_GROUP, CARD_TERMINAL, CARD_BLOCKED_A, CARD_BLOCKED_B, CARD_RUNNING_A, CARD_RUNNING_B, CARD_CLOSED];
  const orderB = [CARD_CLOSED, CARD_RUNNING_B, CARD_RUNNING_A, CARD_BLOCKED_B, CARD_BLOCKED_A, CARD_TERMINAL, CARD_GROUP];
  const listPane = (label: string, cards: any[]) =>
    `<div class="pane"><div class="panehead">${label}</div><div style="height:800px;overflow:hidden">${renderToStaticMarkup(
      React.createElement(List as any, { cards, onOpenCard: noop, onCloseCard: noop } as any)
    )}</div></div>`;
  files.push({
    name: 'm5-list-order',
    html: page(
      'M5',
      '<b>M5</b> 清单排序可复算：同 7 张卡，左=台账顺序 / 右=把顺序完全颠倒后输入，输出恒按 actionRank 排（两栏结果必须一致）',
      `<div class="split" style="flex:1">${listPane('输入 = 台账顺序', orderA)}${listPane('输入 = 颠倒顺序', orderB)}</div>`,
      '.split { height: 874px; }'
    ),
  });

  // ---------- M6 / M7 / M8：抽屉九字段 · 摘要 5 行 vs 截断 ----------
  const drawerPane = (label: string, detail: any) =>
    `<div class="pane"><div class="panehead">${label}</div><div style="position:relative;height:800px;overflow:hidden">${renderToStaticMarkup(
      React.createElement(Drawer as any, { detail, metabotNames: names, onClose: noop, onRequestCloseCard: noop } as any)
    )}</div></div>`;
  files.push({
    name: 'm6-m7-drawer',
    html: page(
      'M6/M7',
      '<b>M6</b> 抽屉九字段齐全 · <b>M7</b> 左=摘要恰 5 行（无溢出） / 右=7 行输入被硬截到 5 行并显示「另有 2 条」',
      `<div class="split" style="flex:1">${drawerPane('摘要 5 行 · 无溢出', DETAIL_5)}${drawerPane('摘要 7 行 · 截断为 5 行 + 另有 N 条', DETAIL_7)}</div>`,
      '.split { height: 874px; } .split .pane > div:last-child > div { position:absolute; inset:0; } .split .pane > div:last-child > div > div { width:100% !important; max-width:100% !important; }'
    ),
  });

  // ---------- M8：抽屉内 ≥2 条关联会话 ----------
  files.push({
    name: 'm8-sessions',
    html: page(
      'M8',
      '<b>M8</b> 卡 → 全部关联会话（本例 4 条，5 路 UNION 的 4 个 role 各一条）；点击走既有 scheduledTask:viewSession 通道',
      withStore(
        React.createElement('div', { style: { padding: 16, height: 858, overflow: 'hidden', position: 'relative' } },
          React.createElement(Drawer as any, { detail: DETAIL_5, metabotNames: names, onClose: noop, onRequestCloseCard: noop } as any)
        ) as any
      ),
      'body > .shot > div:last-child > div > div > div:last-child { display:none; }'
    ),
  });

  // ---------- M14：结论为空被拦截 / 无验收·拒绝二选一 ----------
  files.push({
    name: 'm14-close-modal',
    html: page(
      'M14',
      '<b>M14</b> 收口唯一入口：结论为空时确认按钮 disabled（左）；后端校验拒绝时显示错误且库不动（右）。全页无「验收/拒绝」二选一按钮',
      `<div class="split" style="flex:1">
        <div class="pane"><div class="panehead">结论为空 → disabled</div><div style="position:relative;height:800px">${renderToStaticMarkup(
          React.createElement(CloseModal as any, { card: CARD_GROUP, submitting: false, error: null, onSubmit: noop, onCancel: noop } as any)
        )}</div></div>
        <div class="pane"><div class="panehead">后端 VALIDATION → 拦截并回显</div><div style="position:relative;height:800px">${renderToStaticMarkup(
          React.createElement(CloseModal as any, {
            card: CARD_GROUP,
            submitting: false,
            error: 'A one-line closing conclusion is required.',
            onSubmit: noop,
            onCancel: noop,
          } as any)
        )}</div></div>
      </div>`,
      '.split { height: 874px; } .split .pane > div:last-child > div > div { position:absolute; inset:0; }'
    ),
  });

  // ---------- M15：两种收口回执 ----------
  store.dispatch(slice.setBoard(boardOf(ALL_CARDS) as any));
  store.dispatch(slice.setViewMode('list'));
  store.dispatch(slice.setReceipt({ cardId: CARD_GROUP.id, statusMoved: true, statusNote: 'ledger status review -> completed' } as any));
  const receiptMoved = withStore(React.createElement(Section as any, {}));
  store.dispatch(slice.setReceipt({ cardId: CARD_GROUP.id, statusMoved: false, statusNote: 'ledger status is already terminal; the conclusion alone closes the card.' } as any));
  const receiptKept = withStore(React.createElement(Section as any, {}));
  files.push({
    name: 'm15-receipt',
    html: page(
      'M15',
      '<b>M15</b> 收口回执两种文案：上=状态已推进（statusMoved=true） / 下=结论已记录、状态保留（statusMoved=false）',
      `<div style="height:437px;overflow:hidden">${receiptMoved}</div><div style="height:437px;overflow:hidden;border-top:1px solid rgba(255,255,255,.12)">${receiptKept}</div>`,
      '.shot { height: 900px; }'
    ),
  });

  // ---------- M9：会话侧「所属长期任务」chip（有归属 / 0 关联不渲染） ----------
  files.push({
    name: 'm9-session-chip',
    html: page(
      'M9',
      '<b>M9</b> 会话侧 chip（纯展示件渲染）：有归属 → 显示角色与卡号，多卡显示 +N；0 关联 → 组件渲染空（下方右侧空白即「不臆造归属」）',
      `<div class="split" style="flex:1;align-items:flex-start">
        <div class="pane"><div class="panehead">会话有 2 张关联卡</div><div style="padding:14px;display:flex;gap:8px">${renderToStaticMarkup(
          React.createElement(ChipView as any, {
            cards: [
              { cardId: 'e37fc784-0000-4000-8000-000000000083', role: 'group_chat' },
              { cardId: '4b8d5e60-0000-4000-8000-0000000000b2', role: 'source' },
            ],
            onOpenCard: noop,
          } as any)
        )}</div></div>
        <div class="pane"><div class="panehead">会话 0 张关联卡 → 渲染空</div><div style="padding:14px;display:flex;gap:8px;min-height:40px">${renderToStaticMarkup(
          React.createElement(ChipView as any, { cards: [], onOpenCard: noop } as any)
        )}</div></div>
      </div>`
    ),
  });

  for (const f of files) {
    fs.writeFileSync(path.join(OUT_DIR, `${f.name}.html`), f.html);
  }
  console.log('M-pages:', files.map((f) => f.name).join(', '));
  console.log('css:', CSS_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
