# Delivery Note — feat/control-plane

## 基线

- commit: `3cab9f0b79688f7afdfae18b43d14b94f4ac6788`（基线分支 `main`）
- 分支 / 工作区: `feat/control-plane` @ `.worktrees/control-plane`（按工单 §5 创建；`core.filemode` 步骤按现行 `AGENTS.md` 未执行，见「未完成 / 存疑」）
- 推送位置: 无 —— 全程本机，未推远端、未合 `main`
- 代码 HEAD: `e63a9869`；本说明为其后的 docs 提交
- 交付范围: **T1（REQ-B-1 ~ B-5、B-21、B-22 工单要求的六组单测）+ T2（REQ-B-6 ~ B-12、B-18）**。T3 前置（WS-A T3 桌面网关）与 T4 前置（中转环境）不满足，未开工，见「未完成 / 存疑」。

提交清单（均只含 `cloud/` 与根 `.eslintrc.cjs` 一处 ignorePatterns 增补）:

| 提交 | 说明 |
|---|---|
| `e2dcda68` | feat: control-plane package skeleton with config, migrations, crypto, rate limits, cookies, origin checks |
| `0e51a7e0` | feat: fake tenant and fake docker harness with local dev loop |
| `8bb92b13` | feat: control-plane auth endpoints, provisioning, tenant status machine, and startup reconcile |
| `03414075` | feat: tenant upgrade with automatic rollback and admin CLI |
| `e63a9869` | test: make control-plane timing tests deterministic under load |
| `dd858bed` | fix: recover provisioning and upgrading tenants after control-plane restart |
| `0e60dd02` | fix: alert on empty redeem pool only when required and catch provisioning failures |

## 需求逐条

| REQ | 状态 | 证据 |
|---|---|---|
| REQ-B-1 | ✅ 完成 | `cloud/control-plane/` 独立包：`package.json` / `pnpm-workspace.yaml`（自身为 workspace root，`nodeLinker: hoisted`，`allowBuilds`）/ `pnpm-lock.yaml`；根 `postinstall` 未改、不安装它；安装命令 `pnpm --dir cloud/control-plane install --frozen-lockfile` 验证通过 |
| REQ-B-2 | ✅ 完成 | `engines: node >=24 <25`；TypeScript ES modules，编译至 `cloud/control-plane/dist/`；运行依赖仅 `better-sqlite3` + `ws`，无 web 框架（README 已述理由） |
| REQ-B-3 | ✅ 完成 | 根 `.eslintrc.cjs` `ignorePatterns` 增加 `cloud/**`（唯一根改动）；包内 `eslint.config.mjs` 自检 `pnpm lint` 绿；`electron-builder.json` 未含 `cloud/`（未触碰）。注：根 lint 有 1 个基线预存错误，与本分支无关，见「未完成 / 存疑」 |
| REQ-B-4 | ✅ 完成（静态） | `cloud/control-plane/Dockerfile`：多阶段 `node:24-bookworm-slim`，uid 1000 非 root，`EXPOSE 8080 9100`；镜像 tag 规则注释留给 CI。本机无 Docker daemon，未实际构建镜像（存疑） |
| REQ-B-5 | ✅ 完成 | `src/db/`：WAL 模式、`schema_migrations` 版本化幂等迁移（事务内、可重入）；migration 1 建齐工单所列 10 表及唯一约束；迁移不删改用户行 |
| REQ-B-6 | 🟡 fake 模式完成，生产短信待接入（T4） | `src/routes/auth.ts`：C3 四端点逐字实现（sms/send、sms/verify、me、logout）；6 位码、5 分钟有效、哈希存储；错误码矩阵见 `test/auth-endpoints.test.ts` |
| REQ-B-7 | ✅ 完成 | `src/services/signup.ts`：用户行 + 邀请码消耗 + 租户行 + 兑换码认领同一事务；老用户登录无需邀请码、不消耗任何东西。证据：`test/signup-invite.test.ts`、`test/auth-flow.test.ts` |
| REQ-B-8 | ✅ 完成 | `src/origin.ts` + 路由器：所有非 GET 请求与（T3 的）WS upgrade 走同一校验；`403 ORIGIN_NOT_ALLOWED`。证据：`test/origin.test.ts`、auth-endpoints 的 Origin 用例 |
| REQ-B-9 | ✅ 完成 | `src/services/provisioning.ts`：卷 `idb-{tid}-data`、容器 `idb-{tid}`，C1 全量 env/资源/安全/日志/网络配置（无端口发布、`Init`）；网关密钥 32 字节随机、AES-256-GCM 加密落库（先于 Docker 调用）；`with_redeem=1` 时注入 `IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE`（池空则告警后不带码开通）。证据：auth-flow 测试经 docker inspect 断言容器 env |
| REQ-B-10 | ✅ 完成 | `src/services/statusMachine.ts` + `src/services/poller.ts`：状态机按工单图；3 s / 30 s 探测节奏；60 s / 300 s / 90 s 三档超时；失败告警 webhook。证据：`test/status-machine.test.ts`（12 组纯转移用例 + 3 个集成失败路径） |
| REQ-B-11 | ✅ 完成 | `src/services/reconcile.ts` + `recovery.ts`：启动时按容器名对账；未知容器只报告不删除；失踪容器置 `failed`；**并恢复被上次进程遗弃的 `provisioning`（容器在→`booting`，容器亡→幂等重开通、密钥不变）与 `upgrading`（按 `tenants.image` 回滚重建）行**；轮询另有 5 分钟陈旧 provisioning 兜底。证据：`test/reconcile.test.ts`、`test/recovery.test.ts`（6 例）+ 回环演示第 12/13 步 |
| REQ-B-12 | ✅ 完成 | `src/services/upgrade.ts`：逐一升级为默认（`--batch` 提高）；低于 `rollback-safe-to` 的降级拒绝；300 s 不就绪按新镜像 label 允许则自动回滚 `previous_image`，否则 `failed` + 告警；全程审计。证据：`test/upgrade.test.ts`（5 用例含自动回滚与拒绝） |
| REQ-B-18 | ✅ 完成 | `node dist/cli.js`：工单表格全命令（invite/redeem/user/tenant/deletion 五组）；所有写命令强制 `--as` 并写 `audit_log`；`redeem stats` 等输出永不打印码；删除完成必须先 export 且 `--confirm` 匹配。证据：`test/cli.test.ts`（10 用例） |
| REQ-B-21 | ✅ 完成 | `test/fake-tenant/`（C1 `/healthz` `/readyz` 脚本化相位 + C2 welcome/echo/event/pong/1 MiB 限制/4012 关闭；附小镜像 Dockerfile）+ `test/fake-docker/`（引擎 API 子集，子进程跑假租户）；集成测试覆盖开通、状态迁移、升级、回滚。代理类集成（/ws）属 T3 |
| REQ-B-22 | 🟡 部分 | 工单 T1 自检要求的**六组单测全部交付并绿色**（限流/邀请码消耗/兑换码分配/Cookie/Origin/密钥加密），另有状态机 12 组。`reverify` 单测随 T3 的 REQ-B-16 一并交付（功能尚未开工） |
| REQ-B-13 ~ B-17、B-19、B-20 | ⏸ 未开工 | T3 范围，工单前置为 WS-A T3 桌面网关（未交付） |
| REQ-B-23 | ⏸ 未开工 | T4 范围，需中转环境 |

## 单元测试清单

`cd cloud/control-plane && pnpm test` → **tests 119 / pass 119 / fail 0**（26 个 suite，约 12 s）。
六组必测（工单 §6）以 ✅ 标出；用例名与 `test/*.test.ts` 一一对应。

| 测试点 | 用例名 | PASS/FAIL |
|---|---|---|
| 限流 ✅ | blocked inside the 60 s window | PASS |
| 限流 ✅ | allowed exactly at the 60th second | PASS |
| 限流 ✅ | 9 sends today: the 10th is allowed, the 11th is refused | PASS |
| 限流 ✅ | 10 sends today: the 11th is refused at the daily boundary | PASS |
| 限流 ✅ | yesterday's sends do not count against today | PASS |
| 限流 ✅ | 30 sends from one IP: the 31st is refused | PASS |
| 限流 ✅ | 29 sends from one IP: the 30th is allowed | PASS |
| 限流 ✅ | consumed or expired codes cannot be attempted | PASS |
| 限流 ✅ | consumed codes do not count toward the lock | PASS |
| 限流 ✅ | the lock expires 24 h after the last failure | PASS |
| 邀请码消耗 ✅ | a valid first sign-up consumes exactly one invite use | PASS |
| 邀请码消耗 ✅ | missing invite for an unknown phone -> INVITE_REQUIRED | PASS |
| 邀请码消耗 ✅ | unknown invite -> INVITE_INVALID | PASS |
| 邀请码消耗 ✅ | disabled invite -> INVITE_INVALID | PASS |
| 邀请码消耗 ✅ | expired invite -> INVITE_INVALID | PASS |
| 邀请码消耗 ✅ | exhausted invite -> INVITE_EXHAUSTED | PASS |
| 邀请码消耗 ✅ | existing user signs in without an invite and consumes nothing | PASS |
| 邀请码消耗 ✅ | disabled existing user -> USER_DISABLED | PASS |
| 邀请码消耗 ✅ | concurrent sign-ups racing one remaining invite use: exactly one succeeds | PASS |
| 兑换码分配 ✅ | N users racing a pool of M<N codes: M assignments, no code twice, the rest flagged | PASS |
| 兑换码分配 ✅ | oldest imported code is claimed first | PASS |
| 兑换码分配 ✅ | empty pool: sign-up proceeds with the warn/alert flag | PASS |
| 兑换码分配 ✅ | invites without with_redeem never claim a code | PASS |
| 兑换码分配 ✅ | a repeat sign-up of the same user never takes a second code | PASS |
| Cookie ✅ | carries HttpOnly, Secure, SameSite=Strict, Path=/ and a 30-day expiry | PASS |
| Cookie ✅ | round-trips through parseCookieHeader | PASS |
| Cookie ✅ | missing cookie header parses to an empty map | PASS |
| Cookie ✅ | sliding expiry refreshes on every issue | PASS |
| Cookie ✅ | logout clear-cookie expires immediately | PASS |
| Origin 校验 ✅ | the exact deployment origin is allowed | PASS |
| Origin 校验 ✅ | a different scheme, host, or port is rejected | PASS |
| Origin 校验 ✅ | default ports normalize (browser Origin headers omit :443) | PASS |
| Origin 校验 ✅ | missing or malformed origins are rejected | PASS |
| 密钥加密 ✅ | encrypt/decrypt round-trips | PASS |
| 密钥加密 ✅ | ciphertext carries a random IV (same plaintext encrypts differently) | PASS |
| 密钥加密 ✅ | tampering fails the GCM auth tag | PASS |
| 密钥加密 ✅ | decryption with the wrong key fails | PASS |
| 密钥加密 ✅ | truncated ciphertext is rejected | PASS |
| 密钥加密 ✅ | sha256Hex is stable and matches the known vector for "abc" | PASS |
| 密钥加密 ✅ | timingSafeEqualStr compares constant-time style | PASS |
| 密钥加密 ✅ | masks the middle of a mainland number / keeps short numbers safe | PASS |
| 认证端点（AC-B-2 矩阵） | auth-endpoints.test.ts 12 用例（INVALID_PHONE / RATE_LIMITED / CODE_INVALID+计次 / TOO_MANY_ATTEMPTS×2 / CODE_EXPIRED / INVITE_* / USER_DISABLED / ORIGIN_NOT_ALLOWED / 401 / cookie 属性+掩码 / logout） | PASS |
| 端到端注册流 | invite sign-up -> provisioning -> ready, redeem code reaches the tenant | PASS |
| 状态机 | status-machine.test.ts 15 用例（健康/就绪超时、starting 相位、300s/90s 预算、degraded、phase failed、容器退出、终态不迁移、探针瞬时错误、告警路径） | PASS |
| 重启对账 | matches containers to tenants, reports unknowns, fails orphans | PASS |
| 重启对账 | docker unreachable: reconcile skips without touching statuses | PASS |
| 重启恢复 ✅(S2) | provisioning + 容器在 → 置 `booting`（`tenant.recovery.booting` 审计） | PASS |
| 重启恢复 ✅(S2) | provisioning + 容器亡 → 幂等重开通，**密钥不变**，轮询至 `ready` | PASS |
| 重启恢复 ✅(S2) | orphaned `upgrading` → 按 `tenants.image` 回滚重建 → `ready`（`tenant.recovery.rollback` 审计） | PASS |
| 重启恢复 ✅(S2) | `upgrading` 重建失败 → `failed` + 告警 + 审计 | PASS |
| 重启恢复 ✅(S2) | 轮询运行时兜底：陈旧 provisioning 行无需重启即被恢复 | PASS |
| 重启恢复 ✅(S2) | 并发 provision/recover 三次仅建一个容器（in-flight 去重） | PASS |
| 兑换码告警 ✅(S2) | 普通邀请开通：无告警、无 redeem env；with_redeem 池空：告警、照常开通 | PASS |
| 兑换码告警 ✅(S2) | 已分配码静默注入；损坏密文 → `failed` + 告警，进程不崩（S3-3） | PASS |
| 升级与回滚 | upgrade.test.ts 5 用例（happy path / 自动回滚 / safe-to 为空→failed+告警 / 降级拒绝容器未动 / batch=2 三租户） | PASS |
| 管理 CLI | cli.test.ts 10 用例（五组命令、--as 强制、审计行、去重导入、导出 tar、两种删除拒绝 + 成功路径） | PASS |
| Docker 客户端 | docker-client.test.ts 10 用例（ping 真假、卷冲突、镜像 label、全生命周期、前缀列举、崩溃退出码、两种 tenantBaseUrl 分支、无地址报错） | PASS |
| 假租户 | fake-tenant.test.ts 8 用例（healthz 闸、相位推进、密钥 401、WS welcome/echo/event/pong、错误密钥拒升级、1 MiB→4008、SIGTERM→4012） | PASS |
| 语义化版本 | semver.test.ts 3 用例 | PASS |

## 回环演示

前置：Node 24（`nvm use 24`）、`pnpm --dir cloud/control-plane install --frozen-lockfile`、`pnpm --dir cloud/control-plane build`。

```bash
cd cloud/control-plane
node scripts/dev-loop.mjs        # 完整回环（约 4~5 s）；--quick 为 5 步健康检查
```

实际运行输出（本机 2026-10-20 复现，关键行）：

```text
[dev-loop]  1/13 start fake docker engine                -> http://127.0.0.1:57108
[dev-loop]  2/13 start control plane against the fake docker
[dev-loop]   control plane at http://127.0.0.1:57109 (db …/cp-devloop-…/cp.sqlite)
[dev-loop]  3/13 seed image + create fake tenant container (what provisioning does in T2)
[dev-loop]   container /idb-t_devloop running=true tenantUrl=http://127.0.0.1:57118
[dev-loop]  4/5 wait for the fake tenant to become ready -> ready=true phase=ready version=0.12.0
[dev-loop]  5/13 GET /health -> 200 {"ok":true,"db":true,"docker":true}
[dev-loop]  6/13 start alert sink + seed versioned images (tenant:1.0.0, tenant:1.1.0)
[dev-loop]  7/13 CLI: import one redeem code, create a with-redeem invite
[dev-loop]   redeem import -> imported=1 skipped=0 ; invite created: RP… (masked)
[dev-loop]  8/13 phone: sms/send + verify with the invite -> 200, tenant status provisioning
[dev-loop]  9/13 phone: poll /api/v1/me until ready
[dev-loop]   /me: provisioning -> booting -> ready
[dev-loop]   redeem stats -> imported=1 assigned=1 remaining=0
[dev-loop] 10/13 phone: disconnect (drop the cookie)
[dev-loop] 11/13 phone: reconnect with the SAME phone and NO invite
[dev-loop]   same user u_h24kvrom7ve55huf5nxx, same tenant, invite still 1/1
[dev-loop] 12/13 create a ghost container, then restart the control plane
[dev-loop]   reconcile: "unknown container idb-t_ghost1 reported"; ghost still running
[dev-loop] 13/13 after restart: session and tenant intact, container NOT recreated
[dev-loop]   /me 200 (user +861****0000, tenant ready); container 7e0b3fdea28f… unchanged
[dev-loop] OK — full phone loop complete (+4.3s)
```

即 T2 完工判据「注册 → 拿到（假）租户 → 断开 → 重连回同一个租户」全绿，并额外覆盖 REQ-B-11 重启对账（容器 id 不变、未知容器仅报告）。

自检命令结果：

| 命令 | 结果 |
|---|---|
| `pnpm --dir cloud/control-plane test` | ✅ 119/119 |
| `pnpm --dir cloud/control-plane lint` / `build` | ✅ |
| 根 `pnpm test` | ✅ 全链绿（compile:electron + 全部套件） |
| 根 `pnpm run lint` | ⚠ 仅 1 个**基线预存**错误（见下），本分支文件零告警 |

## 审核修订（2026-10-22）

审查结论：无 S1，3 条 S2 已修，8 条 S3 登记延后。三条 S2 全部修复并各有测试证据（本节后 test 计数已升至 119）：

1. **S2-1 开通中途失败无恢复** → `src/services/recovery.ts` + 幂等化 `provisionTenant`（复用已存网关密钥、卷 409 容忍、容器名 409 采纳启动）+ 轮询 5 分钟陈旧兜底（in-flight 去重）。证据：`test/recovery.test.ts` 6 例（容器在→`booting`；容器亡→重开通且密钥不变至 `ready`；轮询兜底；并发去重）。
2. **S2-2 升级中途进程死亡永卡 `upgrading`** → 启动对账对 `upgrading` 行按 **`tenants.image`（升级前镜像；`previous_image` 仅在升级成功时交换）** 同卷同密钥回滚重建，交 `booting` 由轮询 90 s 重启预算收尾；重建失败 → `failed` + 告警。证据：`test/recovery.test.ts` 2 例（回滚至 `ready` + `tenant.recovery.rollback` 审计；重建失败 `failed` + 告警）。
3. **S2-3 池空告警被普通邀请淹没** → 告警条件改为 `invites.with_redeem=1`（经 `users.invite_code` 解析）**且**未取到码。证据：`test/provisioning-alerts.test.ts`（普通邀请零告警；with_redeem 池空必告警；已分配码静默）。

**S3-3（`void provisionTenant` 缺 catch，Node 24 未捕获 rejection 会崩进程）提前修复**：spec 构建/decrypt 失败在 `provisionTenant` 内部即置 `failed` + 告警；`auth.ts` 挂 `.catch` 兜底；recovery 触发的调用同样被覆盖。证据：`test/provisioning-alerts.test.ts` 损坏密文用例（进程存活、`failed`、告警达）。

**S3 延后登记**：① 生产短信接入 → T4；② 升级重建失败用户下线（有告警）→ 运行手册处置步骤已写入 README「Operations notes」；③ ~~`void provisionTenant` 无 catch~~ → 已提前修复；④ `sessions`/`sms_codes` 无过期清理 → 后续 janitor；⑤ `X-Forwarded-For` 信任前提（仅可信于 WS-C 反代之后）→ 部署文档/README「Operations notes」；⑥ 镜像缺 `rollback-safe-to` label 时降级放行 → 运维知悉（README「Operations notes」）；⑦ fake-SMS `*.staging` 首段判定 → 后续收紧；⑧ 注销保留 user 行 → T3 语义（见下）。

## 未完成 / 存疑

1. **T3（REQ-B-13 ~ B-17、B-19、B-20）未开工**：工单前置为 WS-A T3 桌面网关；登录页届时先用占位，等 WS-E 的 `dist-mobile-login/`。
2. **T4（REQ-B-23、AC-B-1 ~ B-6、场景 A-01/A-02/A-08）未开工**：需中转环境与真实租户镜像；真实短信仅届时验证一次，开发期全程 `CP_FAKE_SMS_NUMBERS`（本交付即如此）。
3. **根 `pnpm run lint` 预存错误**：`tests/coworkQuoteReplyMessage.test.tsx:846`（`no-regex-spaces`，PR#84 引入，基线 `3cab9f0b` 与 `main@67c19f5a` 均可复现）。与本工单无关，按范围纪律未修；本分支改动前后 lint 输出完全相同（证明零新增）。是否顺手修掉请派单方示下。
4. **Dockerfile 未实际构建**：本机 Docker daemon 不在运行（`docker info` 失败），控制面与假租户两个 Dockerfile 仅静态审查；建议 WS-C 的 CI 首次构建时复核。
5. **REQ-B-22 的 reverify 单测**：随 T3 的 REQ-B-16 落地（二次验证功能本身属 T3）。
6. **解释性决策（均已在代码/README 注释）**：fake SMS 的生产 origin 判定（仅 localhost/127.0.0.1/[::1] 或首段为 `staging` 放行，否则拒绝启动）；注册 locale 默认 `zh`（C3 未给字段）；readyz `starting` 相位并入 onboarding；`degraded` 明细只进日志、`last_error` 保持 NULL；升级/轮换重建容器时不再传一次性 `IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE`；`deletion complete` 保留 user 行（A-23「再登录需新邀请码」语义 T3 定稿）；`hosts` 行 id 由 `CP_DOCKER_URL` 哈希派生；限流日计数按 UTC 自然日；`provisioning` 由开通流程独占推进，轮询不探测其就绪性，但对 `updated_at` 超过 5 分钟的陈旧行执行恢复（2026-10-22 审核修订 S2-1，防进程重启后永卡 provisioning）。
7. **工单 §5 `core.filemode` 步骤未执行**：现行 `AGENTS.md` 明确 `.worktrees/` 已迁回内置盘（exFAT 方案废弃）且要求不再设置；实测 `.worktrees` 为普通目录，`git status` 无幻影改动。
8. 开发日志已按仓库规则逐提交上链（metabot simplebuzz，MVC 网络）。
