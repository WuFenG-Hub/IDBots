# LLM 免费额度（IDBots 侧）— 开发 Handoff

> 写给下一个接力开发 session。后端侧（assist-base-service）另有一份更全的 handoff：
> `assist-base-service/docs/llm-free-quota-handoff.md`（在其 `llm-free-quota` 分支上），
> 接口契约见 assist-base-service 根目录《LLM 免费额度对接文档.md》。

## 1. 本侧目标

新用户安装 IDBots 后**不再先看到 LLM 配置面板**，而是：

1. 首启静默创建身份（默认名 "User"）→ 自动向 assist-base-service bootstrap 换取 relay key；
2. 自动配置内置 provider `metaid-free`（OpenAI 兼容，baseUrl 指向后端 `llm.public_base_url`）；
3. 自动落地一个内置"欢迎 Bot"会话，直接可聊（worker 类型，`llm_id = metaid-free`）；
4. 每个身份默认 100 万 token 免费额度（后端可配）；
5. 额度用尽 → 429 `free_quota_exhausted` → 聊天页出现引导横幅，指引用户去配置自己的 API Key。欢迎 Bot 可保留可删除。

老用户不自动配置，在 Settings 的"免费额度"卡片里可手动启用。

## 2. 分支与提交位置

- 本仓库（IDBots，`/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots`）：分支 `feat/llm-free-quota`，worktree `.worktrees/llm-free-quota`，提交 `c4f0a3d5`..`d9f1e5eb`（6 个，基于 `57a05174`）。
- 后端（assist-base-service）：分支 `llm-free-quota`，worktree `.worktrees/llm-free-quota`，提交 `daaf22b`..`13e6e54`（7 个）。
- 均未合并。合并需用户明确指令（`git merge --no-ff`）；合并后删除本分支与 worktree。

提交序列：

1. `c4f0a3d5` feat: llmRelayService（主进程 bootstrap/quota client）+ IPC + preload + 类型
2. `099e0cd8` feat: 内置 provider `metaid-free` 注册（config / 标签 / Settings）
3. `0dff98de` feat: 首启编排 + 欢迎 Bot
4. `45f40c49` feat: Settings 免费额度卡片（含手动启用）+ i18n
5. `76320d2a` feat: 额度耗尽检测（proxy）+ 聊天页引导横幅
6. `d9f1e5eb` feat: 首启 `deferChainSync` + relay service 测试

## 3. 代码地图

主进程：

- `src/main/services/llmRelayService.ts` — bootstrap/quota 请求、relay key 存取、IPC handler。
- `src/main/services/userIdentityService.ts` — 静默建身份支持 `deferChainSync: true`（不阻塞首屏；链上 pin 由 `resumeUserIdentitySetup` 后台幂等续传）。
- `src/main/libs/coworkOpenAICompatProxy.ts` — 识别 429 `free_quota_exhausted` 并透传给渲染层。
- `src/main/main.ts`、`src/main/preload.ts`、`src/renderer/types/electron.d.ts` — IPC 注册与类型。

渲染层：

- `src/renderer/services/llmFreeQuotaBootstrap.ts` — 首启编排：判身份 → bootstrap → 写 provider 配置 → 建欢迎 Bot。
- `src/renderer/services/llmFreeQuotaGate.js` — onboarding 分流 gate。
- `src/renderer/config.ts` — 内置 provider `metaid-free` 注册；兼容以 `/v1` 结尾的 baseUrl（`buildOpenAIChatCompletionsURL`、llmConnection 两处都已核实）。
- `src/renderer/components/FreeQuotaCard.tsx` + `Settings.tsx` — 额度卡片（用量展示、手动启用）。
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`、`CoworkView.tsx` — 耗尽引导横幅。
- `src/renderer/components/onboarding/Onboarding.tsx`、`onboardingDefaults.js`、`App.tsx` — 首启绕过 onboarding 面板。
- `src/renderer/services/i18n.ts` — 中英文案。

测试：`tests/llmRelayService.test.mjs`、`tests/llmFreeQuotaGate.test.mjs`、`tests/userIdentityService.test.mjs`。

## 4. 已定案的设计决策（不要重开）

- 签名串：`llm-relay-bootstrap:<addr>:<ts>`；relay key（`mrk_` 前缀）只在 bootstrap 响应里出现一次，落盘保存。
- 欢迎 Bot 走 `addMetaBot` 本地路径，kv `llmRelay.welcomeBotId` 防重复创建。
- 首启建身份用 `deferChainSync: true` 避免首屏阻塞数十秒，pin 后台续传是幂等的，断网/失败会在下次启动补传。
- 老用户（已有身份）不自动启用免费额度，避免改动其既有模型配置；只能手动在 Settings 卡片启用。

## 5. 验证状态（如实汇报）

- `compile:electron`、renderer `tsc`、`npm run build`、scoped eslint 全绿。
- 新增/相关测试 36/36 通过（含真实助记词验签）。
- **未做真机联调**：没有连真实后端跑过完整首启流程；bootstrap→落地配置→发消息扣额度这条链路只在单测层面验证过。
- 存量问题（main 上就有，与本分支无关）：全量 `tests/*.test.mjs` 在本环境大面积红（dist-electron 路径漂移）；全量 lint 有 2 个 unused-disable 报错（`opcatInscribe.ts`、`MetaBotEditTabs.tsx`）；源旁 `.ts` 测试扩展名解析失败。

## 6. 下一步（接力顺序）

1. 后端先按其后端 handoff 第 7 节部署 testnet（yaml `llm:` 段 + `sql/update.sql` + 真实 DeepSeek key）。
2. 本 worktree 里 `npm run electron:dev` 走真实首启：
   - 应看到：静默建身份（不卡 onboarding）→ bootstrap 成功 → 欢迎 Bot 会话出现 → 可直接聊天。
   - 后端地址从哪来：`metaid-free` provider 的 baseUrl（`src/renderer/config.ts` 与 bootstrap 请求里的后端地址），testnet 联调时确认指向测试环境。
3. 验证：额度随对话扣减（FreeQuotaCard 数字变化 / 后端 usage 表）；把后端额度改小触发 429，看聊天页引导横幅；Settings 卡片手动启用/禁用。
4. 真机通过后向用户申请合并两端分支。

## 7. 环境与工具坑

- worktree 首次使用：`ln -s ../../node_modules node_modules`。
- 跑测试用 Node 24：`~/.nvm/versions/node/v24.13.1/bin/node --test tests/xxx.test.mjs`（系统 Node 26 会挂）。
- `tests/` 被 gitignore，提交测试文件要 `git add -f`。
- `logs/` 是本地运行产物，未跟踪，不要提交。

## 8. 排查入口

- bootstrap 失败 → DevTools 看 `llmRelayService` IPC 返回；签名逻辑在 `userIdentityService`（测试里有真实助记词验签用例可对照）。
- 没有欢迎 Bot → 查 kv `llmRelay.welcomeBotId` 是否已写；编排入口 `llmFreeQuotaBootstrap.ts`。
- 额度数字不动 → 后端是否真的在结算（查后端 `llm_relay_usage` 表）；quota 查询走 `GET /v2/assist/llm/quota`。
- 429 但无横幅 → `coworkOpenAICompatProxy.ts` 的 `free_quota_exhausted` 透传是否被上游错误格式绕过。
