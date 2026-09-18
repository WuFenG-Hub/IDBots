/**
 * 视觉走查素材生成器（**不是真机截图**）。
 *
 * 用真实组件（TrackedTasksBoard / TrackedTasksList / TrackedTaskDrawer）+ 真实编译样式
 * （dist/assets/index-*.css）静态渲染成 HTML，供 Chrome headless 截图。
 * 目的：在没有启动 Electron 的前提下，先拿到「组件真渲染」的像素证据；覆盖小明《用例集》
 * M1–M11 里与版式相关的项。**它不能替代真机走查**（不含真实 IPC、不含 redux 容器）。
 *
 * 运行：npx tsx .cowork-temp/board-preview/render.tsx
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve(process.cwd(), '.cowork-temp/board-preview');
const CSS_DIR = path.resolve(process.cwd(), 'dist/assets');

function stubBrowserGlobals() {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  (globalThis as any).navigator = (globalThis as any).navigator ?? { language: 'zh-CN' };
  (globalThis as any).window = (globalThis as any).window ?? {};
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
    reasonOverflow: 0,
    ...over,
  };
}

const CARDS = [
  card({
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
    activityAtMs: NOW - 2.4 * DAY,
    lastActivityAtMs: NOW - 2.4 * DAY,
    idleMs: 2.4 * DAY,
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
    reasonOverflow: 2,
  }),
  card({
    id: '9a1c2f30-0000-4000-8000-0000000000a1',
    title: 'MetaApp 技能介绍 · 第 12 期（选题冻结中）',
    state: 'waiting_decision',
    stateLabelKey: 'trackedTask.column.waitingDecision',
    ledgerStatus: 'completed',
    closureDue: true,
    closureDueLevel: 'terminal_missing_conclusion',
    closureWarn: true,
    closureSuggestion: 'Reached a terminal status without a conclusion; add a one-line closing note.',
    idleMs: 1.2 * DAY,
    lastActivityAtMs: NOW - 1.2 * DAY,
    sourceKind: 'session',
    needsOwnerAction: true,
    actionRank: 1,
    reasons: ['terminal status without a closing conclusion', 'idle for 1.2 day(s)'],
  }),
  card({
    id: '4b8d5e60-0000-4000-8000-0000000000b2',
    title: 'metaso 索引器：bot 信息聚合增量重构',
    state: 'blocked_external',
    stateLabelKey: 'trackedTask.column.blockedExternal',
    ledgerStatus: 'running',
    idleMs: 0.6 * DAY,
    lastActivityAtMs: NOW - 0.6 * DAY,
    reasons: ['2 blocked step(s) with unmet dependencies', 'linked sessions: idle'],
    closureDue: false,
    actionRank: 2,
  }),
  card({
    id: 'c0ffee10-0000-4000-8000-0000000000c3',
    title: 'OAC 服务市场：报价协议字段对齐',
    state: 'blocked_external',
    stateLabelKey: 'trackedTask.column.blockedExternal',
    ledgerStatus: 'running',
    sourceKind: 'scheduled_task',
    scheduledTaskId: 'sched-19',
    idleMs: 3.1 * DAY,
    lastActivityAtMs: NOW - 3.1 * DAY,
    closureDue: true,
    closureDueLevel: 'sessions_ended',
    closureSuggestion: 'No activity for 3.1 day(s); close it or redefine the acceptance criteria.',
    reasons: ['1 blocked step(s) with unmet dependencies', 'idle for 3.1 day(s)'],
    needsOwnerAction: true,
    actionRank: 0,
  }),
  card({
    id: '7d3a1b90-0000-4000-8000-0000000000d4',
    title: 'Agentpedia 词条：MVC 费用模型（第 3 稿）',
    state: 'in_progress',
    stateLabelKey: 'trackedTask.column.inProgress',
    ledgerStatus: 'running',
    idleMs: 0.1 * DAY,
    lastActivityAtMs: NOW - 0.1 * DAY,
    reasons: ['3 step(s) ready/queued/running', '1 attempt(s) queued/running', 'linked sessions: running'],
    actionRank: 3,
  }),
  card({
    id: 'f11e2d40-0000-4000-8000-0000000000e5',
    title: 'Bot Browser 缓存清理回归',
    state: 'in_progress',
    stateLabelKey: 'trackedTask.column.inProgress',
    ledgerStatus: 'planning',
    idleMs: 0.3 * DAY,
    lastActivityAtMs: NOW - 0.3 * DAY,
    reasons: ['1 step(s) ready/queued/running'],
    actionRank: 3,
  }),
  card({
    id: 'aa11bb22-0000-4000-8000-0000000000f6',
    title: '每日 Skill 素材归档（第 41 期）',
    state: 'closed',
    stateLabelKey: 'trackedTask.column.closed',
    ledgerStatus: 'completed',
    closureConclusion: '本期素材已按三件套归档，链上证据齐。',
    idleMs: 0.9 * DAY,
    lastActivityAtMs: NOW - 0.9 * DAY,
    reasons: ['linked sessions: idle'],
    actionRank: 4,
  }),
];

const COUNT_BY_STATE = (state: string) => CARDS.filter((c) => c.state === state).map((c) => c.id);

const BOARD = {
  ledger: 'orchestration_tasks' as const,
  generatedAtMs: NOW,
  scopeApplied: 'default' as const,
  scopeWindowMs: 7 * DAY,
  seq: 41,
  columns: [
    { state: 'waiting_decision', labelKey: 'trackedTask.column.waitingDecision', cardIds: COUNT_BY_STATE('waiting_decision') },
    { state: 'in_progress', labelKey: 'trackedTask.column.inProgress', cardIds: COUNT_BY_STATE('in_progress') },
    { state: 'blocked_external', labelKey: 'trackedTask.column.blockedExternal', cardIds: COUNT_BY_STATE('blocked_external') },
    { state: 'closed', labelKey: 'trackedTask.column.closed', cardIds: COUNT_BY_STATE('closed') },
  ],
  cards: CARDS,
  closureDueCardIdsPage: CARDS.filter((c) => c.closureDue).map((c) => c.id),
  closureDueCountPage: CARDS.filter((c) => c.closureDue).length,
  counts: {
    total: 262,
    visible: CARDS.length,
    folded: 255,
    closureDue: CARDS.filter((c) => c.closureDue).length,
    zombieLevel: 1,
    terminalMissingConclusionLevel: 1,
    sessionsEndedLevel: 1,
  },
  hasMore: false,
};

const DETAIL = {
  ...CARDS[0],
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
    { uri: 'metafile://9f8e7d6c5b4a39281706f5e4d3c2b1a0998877665544332211009f8e7d6c5b4ai0', status: 'accepted', confirmation: 'ok', kind: 'metafile' },
    // metaapp 交付物（owner 2026-09-18 反馈③）：kind 取主进程 trackedDeliverableKind 的返回值——
    // 修复前该函数先命中 pinid 令牌，把 metaapp://<pinid> 标成 'pin'；修复后按 scheme 返回 'metaapp'。
    { uri: 'metaapp://0c3855f5c73491fc3a3650d99672546e816a037283aa5a079c51a9a780a1a4eei0', status: 'delivered', confirmation: 'ok', kind: 'metaapp' },
  ],
  events: [
    { at: '2026-09-17T05:47:00.000Z', kind: 'card_created', detail: 'plan version 1' },
    { at: '2026-09-17T05:51:00.000Z', kind: 'step_updated', detail: '架构规格 -> completed' },
    { at: '2026-09-17T06:07:00.000Z', kind: 'attempt', detail: 'completed (worker 3)' },
    { at: '2026-09-17T06:12:00.000Z', kind: 'checkpoint', detail: 'open: 契约 v1.4 锁版' },
  ],
  closure: { conclusion: null, by: null, at: null, pinId: null },
};

const TITLE = 'IDBots · 跟踪任务（组件静态渲染 · 非真机截图）';

function page(body: string, extra = ''): string {
  return `<!doctype html>
<html class="dark" lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${TITLE}</title>
<link rel="stylesheet" href="${CSS_DIR}/index-CVEYvCTE.css" />
<style>
  body { margin:0; background:#262624; color:#e8e6e3; font-family: -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif; }
  .frame { width: 1440px; height: 900px; display:flex; flex-direction:column; overflow:hidden; }
  .pagehead { display:flex; align-items:center; height:48px; padding:0 16px; border-bottom:1px solid rgba(255,255,255,.08); }
  .pagehead h1 { font-size:15px; margin:0; font-weight:600; }
  .pagehead .tab { padding:10px 16px; font-size:13px; color:#8f8d8a; position:relative; }
  .pagehead .tab.on { color:#e8e6e3; }
  .pagehead .tab.on:after { content:''; position:absolute; left:0; right:0; bottom:0; height:2px; background:var(--brand, #d97757); }
  ${extra}
</style>
</head>
<body><div class="frame">${body}</div></body>
</html>`;
}

const HEAD = `
  <div class="pagehead">
    <h1>跟踪任务</h1>
    <div style="display:flex;margin-left:24px">
      <div class="tab on">长期任务</div>
      <div class="tab">定时任务</div>
    </div>
  </div>`;

async function main() {
  stubBrowserGlobals();
  const { i18nService } = await import('../../src/renderer/services/i18n');
  // 渲染证据用中文（与 owner 语言一致）；真机语言由 configService/i18nService.initialize() 决定。
  (i18nService as unknown as { currentLanguage: string }).currentLanguage = 'zh';

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const Board = (await import('../../src/renderer/components/trackedTasks/TrackedTasksBoard')).default;
  const List = (await import('../../src/renderer/components/trackedTasks/TrackedTasksList')).default;
  const Drawer = (await import('../../src/renderer/components/trackedTasks/TrackedTaskDrawer')).default;
  const Banner = (await import('../../src/renderer/components/trackedTasks/ClosureBanner')).default;

  const noop = () => {};
  const banner = renderToStaticMarkup(
    React.createElement(Banner as any, {
      cards: BOARD.cards,
      counts: BOARD.counts,
      onlyOwnerAction: false,
      onToggleOnlyOwnerAction: noop,
      onOpenCard: noop,
    } as any)
  );

  const board = renderToStaticMarkup(
    React.createElement(Board as any, { board: BOARD, onOpenCard: noop, onCloseCard: noop } as any)
  );

  const list = renderToStaticMarkup(
    React.createElement(List as any, {
      cards: BOARD.cards,
      onOpenCard: noop,
      onCloseCard: noop,
    } as any)
  );

  const names = new Map<number, string>([
    [1, 'AI_Sunny'],
    [2, 'loop'],
    [3, 'Builder阿码'],
    [6, '小明同学'],
    [35, '小昆'],
  ]);

  const drawer = renderToStaticMarkup(
    React.createElement(Drawer as any, {
      detail: DETAIL,
      metabotNames: names,
      onClose: noop,
      onRequestCloseCard: noop,
    } as any)
  );

  const toolbar = `
    <div class="flex shrink-0 items-center gap-2 border-b dark:border-claude-darkBorder border-claude-border px-4 py-2">
      <div class="flex rounded-lg border dark:border-claude-darkBorder border-claude-border p-0.5">
        <button class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium bg-claude-accent/10 dark:text-claude-darkText text-claude-text" type="button">看板</button>
        <button class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary" type="button">清单</button>
      </div>
      <span class="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">共 7 张卡</span>
      <button class="ml-auto inline-flex items-center gap-1 rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary" type="button">刷新</button>
    </div>`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'board.html'), page(HEAD + toolbar + banner + board));
  fs.writeFileSync(path.join(OUT_DIR, 'list.html'), page(HEAD + toolbar + banner + list));
  fs.writeFileSync(
    path.join(OUT_DIR, 'drawer.html'),
    page(HEAD + toolbar + banner + board + drawer, '.frame { position: relative; }')
  );
  console.log('rendered →', OUT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
