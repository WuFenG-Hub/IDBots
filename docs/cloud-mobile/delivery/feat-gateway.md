# Delivery Note — feat/gateway

## 基线

commit: 3cab9f0b79688f7afdfae18b43d14b94f4ac6788（分支自基线切出，随后合入本机分支 feat/ipc-registry 与 feat/ipc-contract 作为依赖；未合 main，未推远端）
分支: feat/gateway
推送位置: 无（本机分支，不推远端）
最终提交: 见 git log（实现 + 一致性套件 + 本说明分提交）

## 需求逐条

| REQ | 状态 | 证据 |
|-----|------|------|
| REQ-A-15 | DONE | `src/main/gateway/server.ts`：Node `http` + `ws`（新增为正式 dependency），无 web 框架；仅 server 模式监听 `0.0.0.0:{IDBOTS_GATEWAY_PORT}`；密钥恒定时间比较（`server.ts` `MP()`，`crypto.timingSafeEqual`），错误密钥一律 401 且无 body 细节。测试 `tests/gatewayServer.test.mjs`（34 项）。 |
| REQ-A-16 | DONE | `src/main/gateway/protocol.ts`：帧类型/错误码/限额（入 1 MiB、出 8 MiB、在飞 32、50/s burst 100、默认 120 s）、keepalive（25 s ping / 60 s 无 pong 终止）、关闭码（4009/4012 等）全部按 C2。`tests/gatewayCore.test.mjs`（28 项）+ `tests/gatewayServer.test.mjs` 逐项覆盖每个错误码。 |
| REQ-A-17 | DONE | T2 的 `allowlist.ts` 在 `server.ts` invoke 管线运行时强制：tier 门（P2 需 `IDBOTS_GATEWAY_TIER=P2`）、N/S/H → CHANNEL_NOT_ALLOWED、R 规则 → ARG_RESTRICTED。`02` 末尾 5 条测试全部落地（registry 存在性见 T1 测试 + `tests/ipcContract.test.mjs`；R 规则正负例与 store 脱敏见 gatewayCore/gatewayServer 测试；P1/P2 tier 门见 gatewayServer 测试）。 |
| REQ-A-18 | DONE | `gateway:file:sign`（`src/main/gateway/fileSignChannel.ts` + `fileSign.ts`）：realpath 限制在 data root（含符号链接逃逸，dev 模式多根见「存疑」）、HMAC token 绑定 tenant、10 分钟过期、Range 支持、Content-Type 按扩展名。一致性套件 file-roundtrip 通过（含篡改 token 404、Range 206）。 |
| REQ-A-19 | DONE | 上传路由：25 MB 上限（413）、可执行类型 415、`{yyyy-mm-dd}/{uuid}-{sanitized}` 落盘于 uploads root。单元测试 + 一致性套件 upload-limits 通过。 |
| REQ-A-20 | DONE | `/gateway/v1/sensitive/reveal-mnemonic`：校验 `X-IDBots-Reverify`（HMAC、tenant、purpose、≤120 s 过期、一次性 nonce），`Cache-Control: no-store`，审计行不含助记词。复用 main.ts 抽出的 `revealUserMnemonicCore` / `revealMetabotMnemonicCore`（两个 H 通道原逻辑逐字保留）。单元测试覆盖 nonce 重用 403、错误 purpose 403。 |
| REQ-A-21 | DONE | `/app/*` 静态服务 `dist-mobile/`（不存在时 404），index.html `no-cache`、指纹资源 `immutable`。gatewayServer 测试覆盖。 |
| REQ-A-22 | DONE | `IDBOTS_GATEWAY_DEV=1` 桌面开发模式：`127.0.0.1:8790`，密钥取 `IDBOTS_GATEWAY_SECRET` 或打印一次性随机密钥；`app.isPackaged` 时 DEV 变量不生效；事件同时进窗口与网关（T1 的 `addBroadcastListener` seam）。本机实测：Electron 开发实例 + 一致性套件通过（见下）。 |
| REQ-A-24 | DONE | 7 个新通道全部经 `registerIpcHandler` 注册并有 preload 方法（`preload.ts:798-819`）：`gateway:file:sign`、`mobile:permission:listPending`（新追踪器 `src/main/ipc/pendingPermissions.ts`，挂在既有 permission 广播/解决点上，桌面行为不变）、`mobile:bootstrap:status`、`bundle:getPlans/createOrder/getOrder/getMeters`（`src/main/services/bundleService.ts`，复用 trafficAccountService 的身份签名；`IDBOTS_BUNDLE_STUB=1` 或 `stub://local` 走本地 C4 stub：两个套餐、订单首查即 credited）。契约已重新生成：405 → 412 方法，`--check` 通过。 |
| REQ-A-25 | DONE | `coworkRunner.ts`、`CoworkSessionDetail.tsx`、`privateChatSkillTurnPolicy.ts`、`dreamRetryPolicy.ts` 四处检测均扩展到 `free_quota_exhausted` + `quota_exhausted`；cowork 流错误带 `metadata.errorCode = 'LLM_QUOTA_EXHAUSTED'`（main.ts:7347-7356 透传）；移动端文案改为引导充值（运行时经 `src/renderer/services/isMobileRuntime.ts` 判定，桌面文案不变）。`tests/quotaExhaustedStreamError.test.mjs` 4 项 + dream/privateChat 既有测试各 +2。 |
| REQ-A-29 | DONE | `tests/gatewayCore.test.mjs`（28）+ `tests/gatewayServer.test.mjs`（34）+ `tests/bundleService.test.mjs`（9）+ `tests/mobileChannels.test.mjs`（7）+ `tests/quotaExhaustedStreamError.test.mjs`（4）：registry 完整性、allowlist tier/限制、帧编解码与错误码、文件 token 签名/过期/租户绑定/路径限制（含符号链接逃逸）、reverify token 与 nonce 重用、上传限额。bootstrap 崩溃恢复测试属 T4 范围。 |
| REQ-A-30 | DONE | `cloud/conformance/run.mjs`（+ README）：auth / welcome / invoke-allowed / invoke-denied / arg-restricted / payload-limit / file-roundtrip / upload-limits / event-during-chat / reconnect-resync / **invoke-timeout（真实执行，复审 S2-2 修复）** 十一项可执行检查 + 一项文档化 SKIP（invoke-not-found）。对桌面开发模式实测：**11 passed, 0 failed, 1 skipped**。 |

## 自检结果

- pnpm run lint: PASS（exit 0）
- pnpm run compile:electron: PASS
- pnpm run build:skills: PASS
- pnpm test: PASS（除一处环境性失败：`tests/coworkProxyBindHost.test.mjs`「proxy listens on loopback only」——本机 VPN 的 fake-ip 接口（198.18.0.1）把到该地址的连接 NAT 回本机栈，与代码无关；在未触碰该文件的 feat/ipc-registry 分支上同样失败。其后被中断的 test:cowork-proxy 其余 100 项、test:release-regressions-extra、test:memory（154）、test:metaweb（222）均已单独补跑通过）
- conformance: PASS（桌面开发模式，**11 passed / 0 failed / 1 skipped**；`invoke-timeout` 经 `IDBOTS_GATEWAY_TEST_HOOKS=1` 的 `__test:sleep` 钩子真实执行，TIMEOUT 实测 1504 ms。复审 S2-2 修复后的结果；命令 `node cloud/conformance/run.mjs --url ws://127.0.0.1:8790/gateway/v1/ws --secret <dev-secret>`）

## 未完成/存疑

1. ~~invoke-timeout 检查在一致性套件中为 SKIP~~ → **复审 S2-2 已修复**：`IDBOTS_GATEWAY_TEST_HOOKS=1` 时网关注册虚拟 `__test:sleep` 通道（不在冻结 allowlist 内，生产关闭），超时阈值 1.5 s；套件真实断言 TIMEOUT 并输出耗时。目标未开钩子时输出 `SKIP(not-covered)`，明确「未覆盖、不得据此认为通过」。
2. **invoke-not-found 为 SKIP**：正确实现不存在「allowlisted 但未注册」的通道；CHANNEL_NOT_FOUND 路径同样由单元测试覆盖。
3. **dev 模式多数据根（实现细节偏差）**：契约假设单一 `/data` 根；桌面开发模式下 userData 与 cowork 工作区不相交，`GatewayPaths` 增加可选 `dataRoots`（server 模式仍单根 `/data`，行为不变），否则 upload → file:sign 回路在桌面开发模式下必然 ARG_RESTRICTED。一致性套件 file-roundtrip 曾因此 FAIL，修复后通过。
4. **C2 文件 URL 形态**：C2 说 `url` 为「相对控制平面 origin 的 `/files/{token}`」，而租户路由是 `/gateway/v1/files/{token}`；当前实现返回租户路由形态，一致性套件两种形态都接受。需要契约方澄清（应由 WS-B 代理改写还是改 C2 文字），已按变更申请处理流程记录，未改契约。
5. **C4 quota 端点鉴权**：`bundle:getMeters` 对 `GET /v2/assist/llm/quota` 采用 `llm-relay-quota:{identityAddress}:{ts}` 身份签名（与 C4 ledger 的签名约定同族）；C4 对该端点的鉴权表述需 WS-D 确认。
6. **`bundle:createOrder` 的 `gateway` 字段**：`02` 固定参数为 `[{ planId }]`，实现接受可选 `gateway`、默认 `alipay`（stub 供开发）。
7. ws 库对超过自身 `maxPayload` 的帧会硬断连，无拦截钩子；实现把 ws 上限设为 4 MiB、在消息层精确执行 1 MiB 的 `PAYLOAD_TOO_LARGE` 且保持连接（符合 C2），>4 MiB 仍会硬断——ws 的限制，已记录。

## 需求外的观察

- **构建踩坑（重要）**：Electron 应用入口是 `vite-plugin-electron` 产出的打包文件 `dist-electron/main.js`；`pnpm run compile:electron`（tsc）只更新 `dist-electron/main/*.js`。只跑 compile 不重跑 `pnpm run build` 时，运行中的桌面实例用的仍是旧打包——本次调试一度误以为修复未生效。建议在涉及 main 进程调试时把 `pnpm run build` 纳入自检。
- 桌面开发实例首次运行时在 `SKILLs/web-search/` 下生成了 `package-lock.json`（技能运行时的 npm 副作用），已从工作区删除；仓库规则是只允许 pnpm，若该技能在容器镜像构建中也触发 npm，T5 需要处理。
- 新增依赖：`ws@8.21.3`（dependencies）与 `@types/ws@8`（devDependencies），REQ-A-15 指定。
- `.gitignore` 为新增测试文件加了 `!tests/<file>` 例外（`tests/*` 整体被 ignore 但已跟踪）。
- `tests/coworkPermissionForwarding.test.mjs` 未被任何 package.json 脚本引用；T1 的广播重构使其 regex 失配，已在本分支更新（行为断言不变）。
