# Delivery Note — feat/control-plane-proxy（T3）

## 基线

- 基线 commit: `605ed10b701d516ca8f117d773504ea9197cdb0a`（`main`）
- 分支 / 工作区: `feat/control-plane-proxy` @ `.worktrees/control-plane-proxy`
- 推送位置: 无 —— 全程本机，未推远端、未合 `main`
- T1+T2 已合入 `main`（merge `ef5f9f4a`）；本分支在其上叠加 T3
- 交付范围: **T3（REQ-B-13 ~ B-17、B-19、B-20 及 B-22 的 reverify 剩余项）**。REQ-B-18（CLI）T2 已交付；REQ-B-23 属 T4

提交清单（均只含 `cloud/`）:

| 提交 | 说明 |
|---|---|
| `eda29869` | feat: proxy /ws, files, upload, and /app routes with session-derived tenant routing（T3a） |
| `3538b15b` | feat: reverify and mnemonic export through the tenant sensitive route |
| `50628609` | feat: account deletion request endpoint |
| `eac40dfd` | feat: serve the mobile login bundle at / and /login |
| `47ee9454` | feat: prometheus metrics and complete request logging |
| （本文档随 dev-loop 提交） | test: proxy loop demo and T3 delivery note |

## 需求逐条

| REQ | 状态 | 证据 |
|---|---|---|
| REQ-B-13 | ✅ 完成 | `src/services/wsProxy.ts`：会话 Cookie→4001、Origin→4003、租户非 ready/degraded→4013（均按 C3 close-code 表先接受后关闭）；上游头 `X-IDBots-Gateway-Secret`/`X-IDBots-Client-Id`/`X-Forwarded-For`；帧双向原样转发；代理侧 1 MiB 入站限制（可解析 invoke→`PAYLOAD_TOO_LARGE` result 且连接保持；不可解析→4008）；hop-by-hop keepalive（代理 25 s ping、60 s 无 pong 断开；租户 ping 由 ws 客户端自动应答）；租户 close code 透传（SIGTERM 4012 验证）。证据：`test/proxy-ws.test.ts` 8 例 |
| REQ-B-14 | ✅ 完成 | `src/services/httpProxy.ts`：`/files/{token}` 流式转发（Range 直通 206、租户 404 直通）；`/upload?name=` 流式 + 代理侧 25 MB 计数截断（立即 413、上游 abort、从不缓冲）；`/app/*` 无 Cookie 或非 ready → 302 /login。上游错误 502 通用 envelope。证据：`test/proxy-http.test.ts` 8 例 |
| REQ-B-15 | ✅ 完成 | `src/services/tenantLookup.ts`：租户仅由会话派生；`/ws?tenant=`、`X-IDBots-Tenant` 头均被忽略。证据：proxy-ws / proxy-http 各 1 例负向测试 |
| REQ-B-16 | ✅ 完成 | `src/routes/sensitive.ts`：reverify/send（仅发本人手机号、purpose=reverify、60 s 重发限流）；reverify/verify（5 次尝试、消费码、签发 120 s 单次 reverifyId）；sensitive/reveal-mnemonic（行归属/用途/未过期/原子消费→403；租户非 ready→409 且**不消耗**单次额度；C2 token `base64url(payload).base64url(HMAC-SHA256(secret, payload))` 原样铸造；`Cache-Control: no-store`；审计行 actor `user:<id>`、detail 仅 target/metabotId；上游 401/错误透传状态）。证据：`test/reverify.test.ts` 9 例（含助记词不落日志断言、租户侧 nonce 重放 401） |
| REQ-B-17 | ✅ 完成 | `src/routes/account.ts`：`202 {requestId}`；已存在 open 请求时幂等返回同一 id（已文档化）；告警 webhook 只含掩码手机号 + 请求号。证据：`test/deletion.test.ts` 2 例 |
| REQ-B-19 | ✅ 完成 | `src/services/loginBundle.ts` + `CP_LOGIN_BUNDLE_DIR`（默认仓库根 `dist-mobile-login/`，缺省回退包内 `static-login/` 占位页并轮询 /me）；ready/degraded 会话 302 /app/；index.html `no-cache`、带 hash 资源 `immutable`。镜像构建上下文改为**仓库根**（Dockerfile 头注释 + `COPY dist-mobile-login/`），包内 `.dockerignore` 注明仅包上下文生效。证据：`test/login-bundle.test.ts` 4 例 |
| REQ-B-20 | ✅ 完成 | `src/metrics.ts` 手写 Prometheus registry（无新依赖）：`cp_tenants{status}`（db 每次抓取）、`cp_open_sockets`（ws 注册表回调）、`cp_http_requests_total{route,status}`（路由中间件）、`cp_sms_sends_total{purpose,result}`、`cp_provisioning_duration_seconds`（首次就绪直方图）、`cp_upgrade_duration_seconds{result}`；每请求一行 JSON access log（route/status/duration/掩码用户，永不记码/令牌/助记词），WS 开合带 requestId。证据：`test/metrics.test.ts` 3 例（含 /metrics 不在公网端口断言） |
| REQ-B-22 | ✅ 完成 | 工单六组单测 T1 已交付；本次补齐 reverify 过期与单次使用（`test/reverify.test.ts`） |
| REQ-B-23 | ⏸ 未开工 | T4（需中转环境）；conformance kit 经 `--via-control-plane` 跑 /ws 需会话 Cookie 适配层（kit 自身只带网关密钥头，控制面按 C3 close-code 表先接受后关闭 4001/4003/4013，HTTP 401 拒绝升级仅属租户侧行为） |

## 单元测试清单

`cd cloud/control-plane && pnpm test` → **tests 153 / pass 153 / fail 0**（32 个 suite）。新增 suite：

| 测试点 | 用例名 | PASS/FAIL |
|---|---|---|
| WS 代理 | welcome 带会话派生 clientId / invoke 回声 / 事件 / xff | PASS |
| WS 代理 | 超大帧 → PAYLOAD_TOO_LARGE 且连接可用 | PASS |
| WS 代理 | 同 Cookie 重连 clientId 一致 | PASS |
| WS 代理 | 无 Cookie→4001；错误 Origin→4003 | PASS |
| WS 代理 | 代理 ping（100 ms 注入）：自动 pong 存活 / 不 pong 被断开 | PASS |
| WS 代理 | 租户 SIGTERM→4012 透传；stopped→4013 | PASS |
| WS 代理 | REQ-B-15：?tenant= 与头注入不改路由 | PASS |
| HTTP 代理 | /files 全量 + Range 206 | PASS |
| HTTP 代理 | /upload 流式落盘 + path/size/mime | PASS |
| HTTP 代理 | 26 MB 流被代理 413 快速截断 | PASS |
| HTTP 代理 | /app/ 缓存头；无 Cookie→302；无 Origin→403；非 ready 语义 | PASS |
| reverify | 全 happy path（助记词 12 词、no-store、审计无词、只发本人手机） | PASS |
| reverify | 单次使用 / 过期 / 他人 id / 错误 purpose / 码错误矩阵 / 60 s 限流 | PASS |
| reverify | 非 ready→409 且单次额度不被消耗；租户 nonce 重放→401 | PASS |
| 注销请求 | 202 + 掩码告警 + 幂等同一 requestId | PASS |
| 登录包 | 无 Cookie 服务 bundle / ready 302 / 非 ready 服务 bundle / 占位页 | PASS |
| 指标 | 各 cp_ 序列存在且数值移动；/metrics 不在公网端口 | PASS |

## 回环演示

`node scripts/dev-loop.mjs` 19 步全绿（约 5 s）。T3 段输出（本机复现关键行）：

```text
[dev-loop] 14/19 T3: /ws echo through the control plane (real ws client)
[dev-loop]   /ws welcome: tenant=t_… clientId=c_…
[dev-loop]   invoke result ok=true echo="cowork:session:start"
[dev-loop] 15/19 T3: HTTP proxy routes (/app, /upload, /files)
[dev-loop]   GET /app/ -> 200 (… bytes)
[dev-loop]   POST /upload -> 200 path=/data/workspace/uploads/… size=16
[dev-loop]   GET /files/{token} -> 200 (6656 fixture bytes)
[dev-loop] 16/19 T3: reverify -> mnemonic export (words never printed)
[dev-loop]   mnemonic: <redacted len=12 words>
[dev-loop] 17/19 T3: deletion request -> 202 + operator alert
[dev-loop]   deletion-request -> 202 requestId=1; alert: deletion request #1 from +861****0000
[dev-loop] 18/19 T3: scrape /metrics on the internal port
[dev-loop]   cp_tenants{status="ready"} 1 / cp_open_sockets 0 / cp_http_requests_total{…} 1 …
[dev-loop] 19/19 T3: login bundle at /
[dev-loop]   GET /login (no cookie) -> 200 (serving: built-in placeholder, 1564 bytes)
[dev-loop]   GET / (cookie, ready tenant) -> 302 /app/
[dev-loop] OK — full phone loop complete (+4.3s)
```

注：步骤 12 重启控制面后进程内计数器清零（内存态指标的预期行为），直方图断言由 `test/metrics.test.ts` 覆盖。

## 未完成 / 存疑

1. **REQ-B-23（T4）**：conformance kit 经公网 /ws 运行需 Cookie 适配包装层；kit 的 auth 检查面向租户 socket（HTTP 401 拒升级），控制面 /ws 按 C3 close-code 表先接受后关闭。
2. **登录包镜像接线待 CI 复核**：构建上下文已改为仓库根（Dockerfile 头注释），CI 需先 `pnpm build:mobile` 生成 `dist-mobile-login/` 再构建镜像；包内 `.dockerignore` 只对包上下文构建生效，根上下文的 `.dockerignore` 归仓库根管（未触碰，按范围纪律）。
3. **假租户接受任意 file token**：真实 HMAC 校验属 WS-A；篡改 token→404 的行为由 conformance kit 在 T4 对真实镜像覆盖。
4. `/metrics` 为内存态（重启清零）；生产聚合由 WS-C 的 Prometheus 抓取侧负责。
5. 开发日志已按仓库规则逐提交上链（metabot simplebuzz，MVC 网络）。
