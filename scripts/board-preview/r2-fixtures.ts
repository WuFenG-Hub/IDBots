/**
 * R2 前后对照证据页的共享 fixture（静态页与客户端实挂载页共用同一份输入）。
 *
 * 纪律：这里的卡片字段**与主进程 TrackedCardDetail / TrackedCardSummary 同形**；
 * 主进程改字段名时这里同步改，否则「组件对还是 fixture 对」就说不清。
 * 结构化事实（reasonCodes / closureSuggestionCode+params）按当前契约填，不写旧字段名。
 *
 * metaapp 行的 kind 由调用侧传入（静态页读 R2_BEFORE，实挂载页读 URL query）：
 * 父提交 03069ece 上主进程 trackedDeliverableKind 对 metaapp:// 返回 'pin'（先命中 pinid 令牌），
 * 修复后按 scheme 返回 'metaapp'——样张照抄对应返回值，保证前后对照只差组件与这一列。
 */

export const PIN_A = '16cb33915d4443f7f90858808ba4efca94fd2241b49335167953f054ce0e9d1di0';
export const PIN_B = 'b6487c2152d49dc2f8e468788d9162e9574d5f9be53c998a037aa384277ec3c9i0';
export const METAFILE_PIN = '9f8e7d6c5b4a39281706f5e4d3c2b1a0998877665544332211009f8e7d6c5b4ai0';
export const METAAPP_PIN = '0c3855f5c73491fc3a3650d99672546e816a037283aa5a079c51a9a780a1a4eei0';

/** owner_intent 原文样张：一条 1500+ 字的真实长标题（抽屉头部撑爆的输入）。 */
export const LONG_TITLE = [
  '把「定时任务」这个入口升级成「长期任务看板」，这轮先把真机上看到的三处缺陷收干净，其余能力维持现状不动。',
  '第一处，看板顶部的收口横幅说错话。现在它的标题是「{count} 张卡已超 2 天无动静，建议收口」，我打开台账对了一遍：那个数字是三级的合计——僵尸级、终态缺结论级、会话已结束级全都算进去了，而「超 2 天」只对僵尸级成立。一张今天创建、今天走到终态、只是还没写收口结论的卡，会被这条横幅说成「已超 2 天无动静」。这是文案失真：横幅右端的三个分级 chip 就摆在旁边，数字对不上。改法已定：只改文案层措辞，不要动 ClosureBanner 取 counts.closureDue 的取数逻辑，也不要动 trackedTaskBoard.ts 的判定与计数——后端出结构化事实、前端只出文案，这条分工不许破。',
  '第二处，任务卡抽屉的头部。抽屉标题直接渲染 detail.title，也就是 owner_intent 原文，这个入口里最长的一条是 1600 多字。现在的表现是：标题整段铺开、把正文区压成 0 高、页脚连同「收口」按钮一起被顶出屏幕，整块又没有任何滚动容器，想关都关不掉。我要的是：标题默认折叠成 3 行，溢出时给展开/收起；展开后文本自己限高滚动，不要把抽屉撑爆；展开/收起按钮必须始终可见，页脚和右上角的关闭按钮也一样。「目标」节维持 6 行折叠的既有契约保留，别顺手改掉；标题和「目标」应该共用同一个组件，不要再写第二份。',
  '第三处，交付物那一行。我的卡里有一条 metaapp:// 的交付物，抽屉里却给它标了一个「pin」。核了主进程的 trackedDeliverableKind：它先判断有没有 pinid 令牌，可 metaapp:// 的载荷里本来就带 64 位 hex + i0，于是先命中令牌、返回 pin，metaapp 分支成了永远走不到的死代码。修的时候把判断顺序改成 metaapp:// → metafile:// → pinid 令牌 → http(s):// → other，并补单元测试；界面上每行交付物给一个彩色类型徽章，metaapp 紫、metafile 绿、pin 蓝、url 琥珀，徽章文案走 i18n，中英都要；链接文字按 scheme 分色，别再一律用同一个强调色。',
  '另外几件事顺手说明，免得评审时再问：一、横幅的取数与判定都不许动，改的只有措辞，中英两本字典要同时改，别只改中文；二、标题折叠行数定为 3 行，「目标」维持 6 行，两处共用一个组件，溢出判定必须继续用 ref 实测，不许改成字数启发式，展开态文本容器限高 40vh 并且内部可滚，展开/收起按钮渲染在滚动容器之外、任何时候都能点到；三、抽屉正文区的 min-h-0 flex-1 overflow-y-auto、根节点的 non-draggable、页脚的 shrink-0 一个都不能动，关闭按钮和收口按钮必须始终可见；四、交付物行的原始状态 chip 保留，别让信息丢。',
  '验收口径我再说一遍：这不是「看起来变好看了」的验收，是「同一份输入、两棵树渲染、逐处对照」的验收——横幅文案一处、抽屉标题与页脚一处、交付物徽章一处，三处都要有 1000×700 与 1440×900 两个尺寸的前后截图，并且每张截图都要能指认它来自哪棵树、哪个提交。修完这三处，其余行为一处都不许回归。',
  '再补几句口径，免得后面对不上账：我只看同一份输入、两棵树、逐处对照的证据。截图不写明来自哪棵树、哪个提交，或者前后两张的窗口尺寸不一致的，我不认；测试贴的是转述而不是原始输出的，我也不认。核不了的地方宁可在报告里留白，也不要写「结构上应该如此」——上一轮我就在这种地方吃过亏，被人在现场用一个读数把结论推翻，那次教训记到现在。所以这轮要求：每一项都给出可复跑的入口，谁都能重跑一遍，跑完对不对得上，一眼可见，不靠信我。',
].join('\n');

/** 「目标」节样张：超过 6 行，验证「目标 6 行折叠」在长标题下依然成立。 */
export const LONG_GOAL = [
  '在 IDBots 本机原生界面落地「长期任务看板 v1」：唯一权威台账仍是 orchestration_tasks 一本，群任务与定时任务挂同一张卡，看板 / 清单 / 卡详情三层共用同一份台账投影。',
  'Twin 心跳驱动僵尸清扫：>1 天预警、>2 天判僵尸；终态缺结论与会话已结束作为补充分级，三级分别计数、不合成一个数。',
  '卡面永远只展示后端给出的结构化事实（reasons / reasonCodes / counts），前端不重算任何一级判定，也不维护第二套状态口径。',
  '收口是单入口：写一句结论即可，不做验收 / 拒绝二选一；已收口的卡可手工归档，归档走 kv 单行可逆 override，不删数据、不动历史。',
].join('\n');

/** 交付物徽章取证用的短标题：徽章缺陷与标题长度无关，短标题让正文区能正常滚到交付物一节。 */
export const SHORT_TITLE = 'IDBots 长期任务看板 v1（本机跨 session 共享任务台账）';

export const TITLE_CHARS = LONG_TITLE.replace(/\n/g, '').length;

export const METABOT_NAMES: Array<[number, string]> = [
  [1, 'AI_Sunny'],
  [2, 'loop'],
  [3, 'Builder阿码'],
  [6, '小明同学'],
  [35, '小昆'],
];

export function buildDeliverables(metaappKind: string): Array<Record<string, unknown>> {
  return [
    { uri: `pin://${PIN_A}`, status: 'delivered', confirmation: 'ok', kind: 'pin' },
    { uri: `pin://${PIN_B}`, status: 'delivered', confirmation: 'ok', kind: 'pin' },
    { uri: `metafile://${METAFILE_PIN}`, status: 'accepted', confirmation: 'ok', kind: 'metafile' },
    { uri: `metaapp://${METAAPP_PIN}`, status: 'delivered', confirmation: 'ok', kind: metaappKind },
  ];
}

const NOW = Date.parse('2026-09-18T10:00:00.000Z');
const DAY = 86_400_000;

export function buildDetail(metaappKind: string): any {
  return {
    id: 'e37fc784-0000-4000-8000-000000000083',
    title: LONG_TITLE,
    goal: LONG_GOAL,
    enrichedGoal: '把「定时任务」入口升级成「长期任务看板」：台账 orchestration_tasks 一本、看板/清单/卡详情三层、Twin 心跳驱动僵尸清扫。',
    state: 'waiting_decision',
    stateLabelKey: 'trackedTask.column.waitingDecision',
    ledgerStatus: 'review',
    closureWarn: true,
    closureDue: true,
    closureDueLevel: 'zombie',
    /** 收口建议走结构化 code（renderer 出文案）；裸串只作诊断用，不给 UI。 */
    closureSuggestionCode: 'stale_inactivity',
    closureSuggestionParams: { days: 2.4 },
    closureSuggestion: '',
    activityAtMs: NOW - 2.4 * DAY,
    lastActivityAtMs: NOW - 2.4 * DAY,
    idleMs: 2.4 * DAY,
    createdAt: '2026-09-10T02:00:00.000Z',
    updatedAt: '2026-09-15T02:00:00.000Z',
    sourceSessionId: null,
    sourceKind: 'group_task',
    groupTaskId: 83,
    scheduledTaskId: null,
    needsOwnerAction: true,
    actionRank: 0,
    reasons: [
      'ledger status=review, awaiting a decision',
      '2 open group-task checkpoint(s)',
      '4 verifiable deliverable(s)',
      'idle for 2.4 day(s)',
      'linked sessions: idle, idle, idle',
    ],
    reasonCodes: [
      { code: 'ledger_review', params: {} },
      { code: 'open_checkpoints', params: { count: 2 } },
      { code: 'deliverables_verifiable', params: { count: 4 } },
      { code: 'idle_days', params: { days: 2.4 } },
      { code: 'linked_sessions', params: { count: 3 } },
    ],
    reasonOverflow: 0,
    acceptanceCriteria: [
      '账本仍只有 orchestration_tasks 一本，群任务与定时任务挂同一张卡',
      '状态机含「等外部·阻塞」与「待你拍板」两态，可自动推导',
      '僵尸：>1 天预警、>2 天判僵尸，超阈值进待收口并给一句话建议',
      '看板四列 + 清单按「需要我出手」排序 + 任务卡抽屉九字段',
    ],
    owner: { twinMetabotId: 1, ownerGlobalMetaId: 'idq1t3lzq0q4rec8edujklp4w8hfmgceqxth82a7m9' },
    planVersion: 3,
    completedAt: null,
    admitted: false,
    nextCheckpointAt: '2026-09-18T06:30:00.000Z',
    checkpoints: [{ topic: '契约 v1.4 锁版', status: 'open', createdAt: '2026-09-18T06:30:00.000Z' }],
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
      { sessionId: '7f6e5d4c-3333-4444-8555-666677778888', role: 'scheduled_run' },
    ],
    deliverables: buildDeliverables(metaappKind),
    events: [
      { at: '2026-09-18T05:47:00.000Z', kind: 'card_created', detail: 'plan version 1' },
      { at: '2026-09-18T05:51:00.000Z', kind: 'step_updated', detail: '架构规格 -> completed' },
      { at: '2026-09-18T06:07:00.000Z', kind: 'attempt', detail: 'completed (worker 3)' },
      { at: '2026-09-18T06:12:00.000Z', kind: 'checkpoint', detail: 'open: 契约 v1.4 锁版' },
    ],
    closure: { conclusion: null, by: null, at: null, pinId: null },
  };
}

/** 横幅取证用的 counts：closureDue 是三级合计（3），但只有僵尸级 1 张真的「超 2 天」。 */
export const BANNER_COUNTS = {
  total: 262,
  visible: 7,
  folded: 255,
  closureDue: 3,
  zombieLevel: 1,
  terminalNoConclusionLevel: 1,
  sessionsEndedLevel: 1,
};

export function buildBannerCards(metaappKind: string): any[] {
  const base = buildDetail(metaappKind);
  return [
    {
      ...base,
      id: 'e37fc784-0000-4000-8000-000000000083',
      state: 'waiting_decision',
      closureDue: true,
      closureDueLevel: 'zombie',
      closureSuggestionCode: 'stale_inactivity',
      closureSuggestionParams: { days: 2.4 },
    },
    {
      ...base,
      id: '9a1c2f30-0000-4000-8000-0000000000a1',
      title: 'MetaApp 技能介绍 · 第 12 期（选题冻结中）',
      state: 'waiting_decision',
      idleMs: 1.2 * DAY,
      closureDue: true,
      closureDueLevel: 'terminal_no_conclusion',
      closureSuggestionCode: 'terminal_no_conclusion',
      closureSuggestionParams: {},
    },
    {
      ...base,
      id: 'c0ffee10-0000-4000-8000-0000000000c3',
      title: 'OAC 服务市场：报价协议字段对齐',
      state: 'blocked_external',
      idleMs: 3.1 * DAY,
      closureDue: true,
      closureDueLevel: 'sessions_ended',
      closureSuggestionCode: 'session_ended',
      closureSuggestionParams: { days: 3.1 },
    },
  ];
}
