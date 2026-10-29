# 交付说明 · A6 设置页二级菜单重构（IA-PLAN v1 实施）

- **分支**：`fix/mobile-ue-rework`（A6 叠加在 A1–A5 交付 9c22eb11 之上，同一分支继续提交，未推未合并）
- **实施依据**：`/Users/tusm/idbots/project/bots/1/2026-10-29/mobile-ia-rework/IA-PLAN.md` v1（loop 撰、owner 2026-10-29 13:50 批准），唯一实施依据
- **范围**：仅 `src/mobile/**` + 测试 + 工单脚本挂载；桌面代码零改动；01/02 契约零改动
- **证据目录**：`/Users/tusm/idbots/project/bots/1/2026-10-29/mobile-ia-rework/a6-impl/`

## 1. 交付内容

### 1.1 一级页「我的」（IA-PLAN §2.2/§4.1）

三段固定布局：**用户卡 → 余额卡 → 入口注册表**。

- 用户卡：48px 圆头像（无头像首字母占位）+ 名字 + `globalmetaid` 前 10 位省略（`idq1mock0u…`）+ 链同步徽章（synced=灰点 / 异常=红点+「同步异常」）+ chevron；整卡可点 → `profile`。
- 余额卡：流量/LLM 双格（复用 `useMeters`），卡内 [充值]（直达收银台 overlay，stopPropagation 防双跳）/ [兑换码]（现 BottomSheet 通道，抽出为 `components/RedeemButton.tsx` 共用）；整卡可点 → `traffic`；低余额警告行（阈值=桌面口径 5,000,000 字节，本地重声明常量，移动 bundle 不 import 桌面模块）。
- 入口注册表：`screens/me/registry.ts` 数据驱动（`ME_ENTRIES` 6 行 × 3 组）——bots 组（无组标题）/通用组（技能/对话记忆/通用）/账号组（账号与安全/关于）。每行=20px 图标+标题+右侧值摘要+chevron，行高 52px。新增一个设置=注册表加一行+新页面组件，一级页布局零改动（P4）。

### 1.2 二级页 8+1（IA-PLAN §2.3/§4.3–§4.10）

导航栈 `useState<MeStackEntry[]>`（`MeRoute | 'botEdit'`），沿用「无路由库」选型；每次 push 同步 `history.pushState`，popstate/Android 系统返回/顶栏返回统一 pop；离开 Me tab 时 `history.go(-n)` 归还压入的条目。充值收银台维持全屏 overlay 通道不变。

### 1.3 逐页对照 IA-PLAN 自检表

| 页 | IA-PLAN 依据 | 落点 | 自检结果 | 证据 |
|---|---|---|---|---|
| 一级页 | §2.1/§2.2/§4.1 | `MeScreen.tsx` 重写：用户卡+余额卡+注册表 | PASS：三段布局、摘要（Bot 数/已启用技能/记忆开合/语言·主题组合/版本号）全部实数据渲染 | `a6-me-primary.png` |
| profile 个人资料 | §4.3/§3.1 | `me/ProfilePage.tsx`：头像仅展示（更换按钮置灰+「即将支持」）、名字显式保存（脏态才可点）、身份只读卡（MetaID/MVC 地址可复制，点击出「已复制」）、同步状态区（仅异常态出重试同步/重试补贴按钮） | PASS；头像编辑缺口=契约无 `userIdentity.updateAvatar`（IA-PLAN §5 缺口①），未动契约 | `a6-page-profile.png` |
| traffic 流量与充值 | §4.4/§3.5 | `me/TrafficPage.tsx`：余额大字+同通道双按钮、挂单条（`rechargeRecovery` 只读+「继续支付」跳收银台）、免费领取（成功后金额取自返回值）、用量三值+按日明细折叠表（getDailyUsage）、资费说明折叠表（桌面 trafficTariff* 文案平移）、账本倒序分页「加载更多」 | PASS | `a6-page-traffic.png` |
| bots 我的 Bot（二级） | §4.5 | `me/BotsPage.tsx`：行=头像+名字+角色+chevron（严格按规格）、右上角 [新建]（A5 两字段 BottomSheet）、空态文案 | PASS；Twin-first 排序保留 | `a6-page-bots.png` |
| botEdit（三级） | §2.1 注/§4.5 | `me/BotEditPage.tsx`：A5 五 Tab 全字段表单以全屏页承载；保存成功自动弹回列表；脏态保护接入 | PASS | `a6-page-bot-edit.png` |
| skills 技能 | §4.6/§3.6 | `me/SkillsPage.tsx`：已装列表开关即存、空态、页底灰字「技能市场即将上线」（Q3 挂后续） | PASS | `a6-page-skills.png` |
| memory 对话记忆 | §4.7/§3.4 | `me/MemoryPage.tsx`：说明文案+3 开关（`useMemorySettings` 平移，即改即存），无高级项 | PASS | `a6-page-memory.png` |
| general 通用 | §4.8/§3.2 | `me/GeneralPage.tsx`：语言/主题 Segmented 平移+三态保存反馈 | PASS | `a6-page-general.png` |
| account 账号与安全 | §4.9/§3.1 | `me/AccountPage.tsx`：登出/注销两行+确认弹层（文案复用），无助记词/导入/链备份入口 | PASS | `a6-page-account.png` |
| about 关于 | §4.10 | `me/AboutPage.tsx`：版本+合约版本、法务三链接（terms/privacy/custody，staging 占位域，沿用登录页占位先例）、版权行 | PASS | `a6-page-about.png` |

### 1.4 IA-PLAN §3 取舍表执行情况

- 搬 15 项全部落位（名字/MetaID/同步重试/登出/余额/充值/兑换码/账本/用量/资费/免费额度/已装技能/记忆 3 开关/语言/主题）。
- 「不搬本期」11 项（含 owner 点名的 IM 机器人、E-Mail）全部未实施；「不适用」12 项未建对应物。无第三态。

## 2. 偏差与如实声明（IA-PLAN 与现实的冲突，按规则标注、不自行发明）

1. **Bot 列表行能力退役（需 owner 知悉）**：IA-PLAN §4.5 行规格=头像+名字+角色+chevron，原一级列表的**启用/停用开关**与**链同步状态行+修复按钮（重试补贴/补同步）**不在规格内，随平铺 Section 一起退役。对应 e2e 段落已按新 IA 改写并在测试内注释标注。建议：若需保留，落点为 botEdit 页（后续工单），本期不擅自加。
2. **挂单条「取消」按钮**：§4.4 要求挂单条含「继续支付/取消」；取消订单语义属收银台 overlay 现有流程（工单红线「不动现链路」），挂单条只放「继续支付」，取消入口=收银台内现有流程。未新增任何支付通道调用。
3. **免费领取显隐**：契约无「已领取」字段（TrafficAccountInfo 无该位）；实现为会话内领取结果驱动（成功后换成功文案），金额取 claim 返回值，不预造数字。
4. **二级页与 TabBar**：二级页在 Me tab 面板内推入（TabBar 保持可见），未做覆盖 TabBar 的全屏层——与「无路由库」的壳选型一致，切 Tab 即退出二级态（历史条目同步归还）。
5. **用量按日明细表**：§4.4 线框未画但 §3.5 裁决去向为 traffic 页，按 §3.5 落地为折叠表（getDailyUsage）。
6. **法务第三页 URL**：托管与资产披露页 URL 仓库内无现成引用，按登录页占位先例用 `https://staging.idbots.world/custody`，上线前由 owner 换正式域（与 terms/privacy 同批）。

## 3. 质量门（全部实跑）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `tsc --noEmit` | PASS（0 error） |
| 全量 mobile 单测 | `pnpm run test:mobile` | **260/260 全绿**（新增 `tests/mobileMeIa.test.tsx` 7 例：注册表结构/六页壳/profile 脏态与同步区/traffic 区块/account/about；已挂 `test:mobile` 与 `.gitignore` 白名单） |
| mock e2e（双设备） | `pnpm run test:e2e:mobile` | **134 passed + 6 skipped（守卫）**，iphone14/pixel7 双项目全绿（新增 `e2e/mobile/me-ia.spec.ts` 8 例：注册表渲染/逐入口导航/卡片入口/三级 botEdit/浏览器返回/脏态确认双路径/保存回写/traffic 数据） |
| 真网关 e2e | `pnpm run test:e2e:mobile:gateway` | **17/17 全绿**（bots-gateway、account-gateway 已按 A6 导航更新） |

新增测试覆盖（工单 C 节点名点名的三件）：入口注册表渲染 ✓、二级页导航 ✓、返回行为（顶栏返回+浏览器 history 返回+脏态确认）✓。

## 4. 证据清单（a6-impl/）

```
a6-impl/
├── screenshots/            # A6 全套（390×844，本分支构建实截，14 张）
│   ├── a6-me-primary.png   # 一级页（用户卡+余额卡+注册表）
│   ├── a6-page-{profile,traffic,bots,skills,memory,general,account,about}.png
│   ├── a6-page-bot-edit.png        # 三级页
│   ├── create-form-name-role.png   # A5 新建表单（A6 导航下复验）
│   ├── a2/a3/a4-*.png              # A1-A5 会话线复验（A6 未触及，原样复截）
│   └── staging-main-me-baseline.png # 部署基线参考（见 §5）
├── a1a5-screenshots/       # A1-A5 终验证据集（12 张，上一批交付原样归档）
└── DELIVERY.md             # 本说明副本
```

## 5. A1–A5 截图终验欠账的如实交割

- 已做：A1–A5 证据集 12 张归档至 `a1a5-screenshots/`；A2/A3/A4 在 A6 分支构建上复截确认未回退；staging 部署版（main@1.0.8.1，owner 租户，**只读**）实拍 `staging-main-me-baseline.png`——**实锤部署版上 bot 头像仍为破图状态**（A1 缺陷现场，网关 4000 字符截断所致），坐实根因与「契约变更落地后移动端零改动自动恢复」的判断。
- 未做（本机不可达，需 Twin 安排）：owner 物理真机复验。A1 的完整修复依赖 `src/main/ipc/sanitize.ts` 契约变更（冻结领地，变更申请已在上一批交付单提出）；真机门须在合并部署后由 owner 手机闭环。
- staging 观察边界声明：仅登录+查看+截图，零写操作（未发消息/未建 Bot/未动额度）。

## 6. Mock 桥新增通道（mock parity，全部为真实 IPC 契约既有通道）

`userIdentity.updateName / retrySubsidy / retryChainSync`；`traffic.getLedger / getUsageSummary / getDailyUsage / claimFreeGrant`。Identity fixture 改为可变对象使改名回读成立。真实桥（installShim 按契约生成）无需改动。

## 7. 禁止事项核对

- 未改 01/02 契约 ✓（未触碰 `src/main/**`、`src/renderer/**`）
- 未推 main、未合并 main ✓（仅本地分支提交）
- 未做需求外顺手重构 ✓（BotEditorForm 仅增 `onDirtyChange` 可选 prop；MeScreen 重写属 A6 本体）
