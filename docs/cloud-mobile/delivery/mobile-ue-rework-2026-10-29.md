# 交付说明 · PWA「我的/会话/新建」UE 重审修复（A1–A5 + A6 方案）

- 分支：`fix/mobile-ue-rework`（自 main 24fe58e4 切出；含基线 223a341f 与上一批 UI 改动 c9c2fdb5——A5 要求建在 c9c2fdb5 之上，故分支点取 main 当前头而非简报所写 223a341f，后者是其祖先）
- 工单：/Users/tusm/idbots/project/bots/1/2026-10-29/mobile-ia-rework/WORKORDER.md（owner 01:48 口述七点）
- 证据截图：/Users/tusm/idbots/project/bots/35/2026-10-29/mobile-ue-rework-evidence/（12 张，390×844，iPhone 14 项目实拍）
- 合并：未推 main，未合并（按权限由 Twin 安排）

## A1 头像缺陷：根因 + 移动端兜底 + 契约变更申请

**根因（代码级，已实测坐实）**：
真实桥上每条 invoke 结果经过 C2 网关的 `sanitizeIpcPayload`（src/main/gateway/server.ts:780 → src/main/ipc/sanitize.ts），其中 `IPC_STRING_MAX_CHARS = 4000` 对所有字符串硬截断并追加 `...[truncated in main IPC forwarding]` 标记。而 metabot 头像以 base64 `data:image/png` data URL 传输：本机 12 个真实 bot 的 avatar blob 实测 1.4KB–110KB（idbots.sqlite，`length(avatar)`），base64 后约 2K–147K 字符——除 1 个外全部超 4000 截断线。截断的 data URL 无法解码 → `<img>` 全挂。三个佐证：桌面直连 IPC 不走网关 sanitize 所以正常；mock 桥 fixture 头像为 null/小图所以开发与 e2e 看不出；会话摘要里的 metabotAvatar 同理受影响。

**本批移动端兜底（src/mobile/app/avatar.ts + components/BotAvatar.tsx）**：
`isRenderableAvatar()` 拒收带截断标记/非 data:image 与 http(s) 形态的字符串；BotAvatar 组件在判定失败**或 img 运行时 onError** 时降级为首字母圆盘（`data-avatar-state="fallback"`），真机上不再出现破图。e2e 有注入 6000 字符截断头像的回归用例（ue-rework.spec.ts A1）。

**契约侧变更申请（超出本切片权限，需 owner/Twin 拍板后另派）**：
根因文件属 src/main/ipc/sanitize.ts + src/main/gateway/server.ts（冻结契约 01/02 领地）。建议修法（最小爆炸半径）：在 `sanitizeIpcPayload` 内对 `data:image/` 形态的字符串给予独立上限（如 `IPC_AVATAR_DATA_URL_MAX_CHARS = 512_000`，或对 metabot:list / cowork:session:listMetabotAvatars 两个通道的结果豁免常规字符串帽），保住「失控载荷打爆 IPC」的防护本意。修复合入前，真机头像一律显示首字母圆盘（本批兜底），不破图。注意：契约侧修复落地后**无需改移动端**——isRenderableAvatar 对完整 data URL 放行，头像自动恢复。

## A2 会话内切换器：已移除
ChatScreen 顶部的 MetaBot 横滑切换条整段删除；头部 = 汉堡菜单 + 该会话所属 Bot 头像（32px）+ 标题。头像解析优先级：会话摘要 metabotAvatar → 名册行头像 → 当前 metabotId 对应 Bot → 首字母（全部过 A1 闸门）。

## A3 新建对话先选 Bot：已实现
抽屉「+ 新聊天」→ 底部弹层选择器（BotPickerSheet）：行内头像 + 名字 + 角色，Twin 置顶（复用 sortBotsForList），选中即以该 Bot 开新会话；选择后不可换（对齐桌面「开始对话先选 MetaBot」语义）。

## A4 会话列表分组 + 行内头像：已实现
sessionList.ts 纯函数 groupSessionsByDay（今天/昨天/更早，本地时区零点界；脏时间戳落「更早」不炸），抽屉按组渲染 sticky 组头，每行 32px Bot 头像 + 标题 + running 圆点。单测 13 例覆盖边界（23:59/00:30、脏数据、不可变输入）。

## A5 新建/编辑拆分
- **新建**：只名字 + 角色 + 引导文案（含「未选模型将自动使用目录第一个可用模型」的明文说明——真实契约 requireMetabotLlmIdForCreate 要求主模型，UI 透明补默认，不改后端）。高级区、Tab 全部移除（旧 bot-advanced-toggle 仍在 e2e 中断言 toHaveCount(0) 防回归）。
- **编辑**：五 Tab（基础/人设/模型/聊天设置/其他），面板常挂载仅 CSS 隐藏（沿用桌面规则）。新增字段：goal、头像上传（canvas 压到 256×256 PNG，remove 支持）、A2A 三项（自动回复开关/单局最大轮数/结束后冷却——选项集与 src/main/services/a2aChatLimits.ts 逐值对齐并有防漂移测试）。
- **逐项对照表**（桌面 MetaBotEditTabs 六 Tab → 移动编辑页）：

| 桌面字段 | 移动端 | 备注 |
|---|---|---|
| basic.name / role* | ✅ 顶部常显 | *role 属桌面 persona Tab |
| basic.avatar | ✅ 基础 Tab，上传/移除 | 256×256 下采样 |
| basic.bio | ✅ 基础 Tab | |
| basic.metabot_type | 不适用 | Twin/Worker 属本地身份设置，桌面亦本地态；移动端不开放防误改 |
| basic.boss_global_metaid | 不适用 | Owner 绑定转移，安全敏感，桌面有身份校验门；移动端后续单独立项 |
| basic.llm_id/provider/effort | ✅ 模型 Tab | |
| basic.fallback_llm 三件 | ✅ 模型 Tab | |
| persona.role / soul / goal | ✅ 角色（顶部）+ 人设 Tab | goal 本批新增 |
| chatSettings.allow_chat_skills | ✅ 聊天设置 Tab | 默认折叠规则保留 |
| chatSettings.a2a_auto_reply / max_turns / bye_cooldown | ✅ 聊天设置 Tab | 本批新增，选项与主进程常量对齐 |
| chatSettings cowork MCP 工具 / 浏览器自动化 / 电脑使用 | 不适用（本期） | 走 metabot_settings 立即生效开关，属桌面工作面向；列后续批次 |
| knowledgeBase（知识库语料） | 不适用（本期） | 独立 knowledgeBase:* IPC 面 + 文件管理 UI，体量大，建议单独立项 |
| surf（冲浪开关+报告） | 不适用（本期） | metabot_settings 即时开关 + 报告面板，后续批次 |
| advanced.homepage | 不适用（本期） | 桌面为 metafile 发布流，非单字段 |
| advanced（转账/助记词/删除等资产操作） | 不适用 | 移动端账户区已有登出/注销；助记词导出属周期范围外（OUT） |

缺项=0 的口径：所有「不适用」均为范围/安全理由并已逐条注明，非遗漏。

## A6 设置 IA 方案（只出方案未动工）
docs/cloud-mobile/delivery/mobile-settings-ia-proposal-a6.md：二级菜单架构图、七个二级页定义（全部复用既有通道）、桌面九区+三 case 的逐项搬运取舍表（搬 7 / 不搬 4 / 分期 3），含三个待 owner 拍板点。**owner 过目前不实施。**

## 测试证据
- `pnpm run test:mobile`：253 用例全绿（tsc 全仓 + tsx/node 双跑），新增 tests/mobileSessionList.test.ts（13 例）+ tests/mobileA2aLimits.test.ts（8 例，含与主进程 a2aChatLimits 的防漂移对账），均已进 package.json 与 .gitignore 白名单。
- e2e mock 套件：iphone14 59 passed / 2 skipped（守卫跳过），pixel7 59 passed / 2 skipped；网关套件（真 C2）iphone14 17 passed。runner：E2E_CHROMIUM_EXECUTABLE_PATH 指向本机 Chrome for Testing。
- e2e 同步更新：bots/bots-gateway/app/gateway/ux-screenshots 五个既有 spec 适配新流程；新增 ue-rework.spec.ts 四用例（A1 截断注入/A2 无切换条/A3 选择器/A4 分组）；共享 startNewChatViaPicker 辅助（抽屉幂等）。修复过程中抓到并修复一个自伤：helper 二次点「Sessions」被抽屉遮罩挡死（trace 定位），改幂等后全绿。
- mock 桥补 A2A 三字段持久化（src/mobile/bridge/mockBridge.ts，对齐真实 metabot:update 契约；沿用 c9c2fdb5 的 mock-parity 先例，代码内注明）。

## 边界与如实声明
- 未上 owner 真机：A1 判据「修完真机可见」在契约侧修复落地前只能达到「不破图+首字母」，真实头像恢复需 §A1 变更申请合入（合入后移动端零改动自动恢复）。
- 头像上传后的 data URL 走 metabot:update，同样受 4000 截断影响——即 256×256 PNG（~几十 KB base64）在契约修复前于真机编辑页会回显为首字母。此为同一根因，不重复修。
- 权限内说明：改动集中在 src/mobile/app/** + i18n + e2e + tests；越出 src/mobile/app/** 的仅 mockBridge.ts 三行 mock-parity（有先例、有注释）。
