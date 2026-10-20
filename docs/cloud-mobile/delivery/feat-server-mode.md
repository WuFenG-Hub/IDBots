# Delivery Note — feat/server-mode

## 基线

commit: 3cab9f0b79688f7afdfae18b43d14b94f4ac6788（分支自基线切出，随后合入本机分支 feat/ipc-registry、feat/ipc-contract、feat/gateway 作为依赖；未合 main，未推远端）
分支: feat/server-mode
推送位置: 无（本机分支，不推远端）
最终提交: 见 git log（骨架 + bootstrap + 本说明分提交）

## 需求逐条

| REQ | 状态 | 证据 |
|-----|------|------|
| REQ-A-1 | DONE | `src/main/server/`（`serverMode.ts`/`logger.ts`/`shutdown.ts`/`bootstrap.ts`/`bootstrapSteps.ts`）；`isServerMode()` = `IDBOTS_SERVER_MODE === '1'`；main.ts 中的分支全部以此为先决条件，未设置时桌面行为不变。 |
| REQ-A-2 | DONE | server 模式不创建任何 `BrowserWindow`（`main.ts` ~18396 的 `if (isServerMode())` 分支）、`window-all-closed` 不退、`activate` 直接返回；`startup:rendererInitialized` 经核实为 log-only（测试断言其无 await），无任何等待。审计文档 `docs/cloud-mobile/audits/renderer-side-effects.md`（6 项 main-side-must、26 项 ui-only，全部 file:line 引用）。原挂在首窗 `ready-to-show` 的调度器与 cowork-store 维护已吊起为 server 启动层（`main.ts:18403`）。 |
| REQ-A-3 | DONE | `src/main/server/shutdown.ts`：SIGTERM/SIGINT → 网关 4012 关连（并停收 invoke）→ 既有 `runAppCleanup()`（daemon、DSH runtime、IM 网关、技能服务、代理、调度器）→ SQLite flush+close → exit(0)；20 s watchdog 强制 exit(1)。每阶段 JSON 日志。测试覆盖顺序与 watchdog。 |
| REQ-A-4 | DONE | server 模式跳过：应用菜单、auto-launch 注册、sleep/power guard（`recomputeSleepGuard`/`startSleepGuardRefresh` 早退）、tray（本就在桌面 ready-to-show 路径内）。auto-update 主进程无初始化（30 分钟轮询本就在渲染进程，无渲染进程即不存​​在）；global shortcuts 主进程无实现（已核实）；desktopCapturer 仅经截图工具触达，该工具已从工具表移除（REQ-A-5）。 |
| REQ-A-5 | DONE | `SERVER_MODE_DISABLED_AGENT_TOOLS`（`serverMode.ts:165`）：8 个 bot_browser_* + browser_open、screenshot、open_metaapp/resolve_metaapp_url、project_query，在 `CoworkRunner.buildSessionInlineTools` 单点过滤（两条工具路径共用）；MCP local servers 在 composition providers 处返回空；Docker sandbox 运行时本已退役（有注释核实）；calendar 为 macOS 权限 IPC，allowlist-N 不会触达。 |
| REQ-A-6 | PARTIAL | 应用侧假设（无窗口运行）已落实；Xvfb 启动策略属 T5 镜像（entrypoint 清锁、`--no-sandbox` 等在 `deploy/tenant-image/`）。 |
| REQ-A-7 | DONE | `applyServerModeEnvDefaults()` 在 `configureUserDataPath()` 之前注入 `/data/userdata`、`/data/appdata` 默认（复用既有 `resolveRuntimeDataPaths`）；`resolveServerWorkspacePath()` = `/data/workspace` 并写进 cowork 配置默认值；R-cwd/R-path 由 T3 网关层强制。 |
| REQ-A-8 | DONE | `src/main/server/bootstrap.ts` 状态机 + `bootstrapSteps.ts` 七步执行器：identity（复用 createUserIdentity + 语言种子）、llmProvider（渲染进程 llmFreeQuotaBootstrap 的主进程等价实现，经共享纯模块保证 app_config 写入形状一致，串行化写锁）、twinMetabot（复用 createMetaBotOnChainCore；**pending 链上初始化每个重试 pass 重复 subsidy 请求 + chain sync 直到 synced**，气体赞助恢复后自行收敛，不需要二次注册）、workspace、trafficAccount（sponsorship 模式 + ensure + bindAll + free grant）、redeemCode（未配置 → skipped）、listener（audit 指出的与 twin 的竞态由步骤顺序解决）。逐步落库（`server_bootstrap_steps` 表），中断续跑；1–4 步失败 → failed + 30/60/120/240/300 s 退避（≤5 分钟）；5–7 步失败 → degraded。测试 20 项：每步后模拟崩溃重启、副作用计数不重复、degraded/failed 语义、退避序列。 |
| REQ-A-9 | DONE | bootstrap 经 `setGatewayReadinessProvider` 接管网关 readiness：`/readyz`（503 until ready/degraded）、WS welcome、`mobile:bootstrap:status` 三处一致；C1 onboarding 对象形状测试断言。 |
| REQ-A-10 | DONE | `src/main/server/logger.ts`：server 模式包装 console → 每行 `{ts,level,tenant,component,msg}` JSON；脱敏：网关密钥逐字、apiKey 字段值、12/24 词助记词形态、+861 手机号。桌面不受影响。 |
| REQ-A-11 | DONE | 核实无需改动：unattended 判定全在主进程（scheduler/longterm/IM/A2A/Gig Square 各自路径均有出处），权限请求经 `trackPendingPermission` 镜像供 `mobile:permission:listPending`；路径中无 BrowserWindow/dialog 依赖。 |
| REQ-A-31 | DONE | DSH 空闲会话 TTL 抽出为命名常量：桌面 30 min 不变，server 模式 10 min（`coworkDshTurn.ts:477` + `coworkRunner.ts:9414`）。内存回落实测属 AC-A-5（镜像 + Phase 0 harness）。 |
| REQ-A-32 | DONE | `src/main` 全量扫描无任何 remote-debugging/inspect 开关（测试断言）；server 模式额外关闭 `enable-logging`/`v=1` 保证 stdout 为纯 JSON 行。仓库里仅有的两处 remote-debugging 在开发脚本，与租户运行时无关。 |
| REQ-A-33 | DONE | `computeServerBootJitterMs`（FNV-1a，tenantId+job 确定性，0–120 s）；错峰对象：MetaWeb listener、fee-rate init、skill-manager sync+watch、MetaApp-manager sync+watch、skill-services、调度器启动；DSH prewarm/JEV/metaid RPC/SQLite 作业为延迟/正确性敏感路径，刻意不错峰（报告已说明）。 |

## 自检结果

- pnpm run lint: PASS
- pnpm run compile:electron: PASS
- pnpm run build:skills: PASS
- pnpm test: PASS（除预存在的本机环境失败 `coworkProxyBindHost`——VPN fake-ip 198.18.0.1，与本分支无关，T1 分支同样失败；其后续段已单独补跑全绿：cowork-proxy 其余 78 项、proposals、bot-browser、release-regressions-extra 80 项、memory 154、metaweb 222）
- conformance: PASS（沿用 T3 实测；本分支未改网关协议面）
- 新增测试：`tests/serverMode.test.mjs` 30 项、`tests/serverBootstrap.test.mjs` 20 项，均接入 `pnpm test` 首组

## 未完成/存疑

1. 无窗口真实启动（Xvfb 下）、`docker stop -t 30` 的 20 s 退出、内存 10 分钟回落等只能在容器镜像上终验（T5 + AC-A-3/4/5）。
2. 真实首启链上写入（身份 subsidy、relay bootstrap、twin pin、traffic grant）需要网络与气体赞助；结构性覆盖靠单测 + 复用既有已证路径，300 s ready 计时属 AC-A-3。
3. `bootstrapSteps.ts` 刻意未移植渲染进程「fresh install 且无 metabot」门——server 模式的步骤记录取代了它（文件内有注释）。

## 需求外的观察

- `main.ts` 中 `didInitAppOnce` 原先由首窗 `ready-to-show` 设置，调度器因此依赖窗口存在——这是 REQ-A-2 之外值得知道的既有耦合，已通过启动层吊起解决。
- 渲染进程「30 分钟检查更新」等定时器均属 ui-only，server 模式天然不运行（审计 26 项明细）。
