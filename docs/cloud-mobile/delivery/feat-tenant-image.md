# Delivery Note — feat/tenant-image

## 基线

commit: 3cab9f0b79688f7afdfae18b43d14b94f4ac6788（分支自基线切出，合入本机分支 feat/ipc-registry、feat/ipc-contract、feat/gateway、feat/server-mode；未合 main，未推远端）
分支: feat/tenant-image
推送位置: 无（本机分支，不推远端）
最终提交: 见 git log

## 需求逐条

| REQ | 状态 | 证据 |
|-----|------|------|
| REQ-A-6 | DONE | `deploy/tenant-image/entrypoint.sh`：启动前删除 `/tmp/.X99-lock` 与 `/tmp/.X11-unix/X99`；D-Bus + Xvfb `:99`；`exec electron --no-sandbox /app`（`--no-sandbox` 在命令行上）；无调试端口；要求 `IDBOTS_SERVER_MODE=1`/`IDBOTS_TENANT_ID`/`IDBOTS_GATEWAY_SECRET`，缺失即拒绝启动。 |
| REQ-A-26 | DONE | `deploy/tenant-image/Dockerfile` 四阶段：deps（manifest 优先缓存 + 完整 `pnpm install --frozen-lockfile`，postinstall 含内核补丁）→ build（构建期门禁 `apply-dsh-kernel-patches.cjs --check` + `check:dsh-deps`，失败即构建失败；`build` + `compile:electron` + `build:skills` + 守卫式 `build:mobile`）→ prod-deps（生产依赖单独安装，mvc-scrypt 补丁显式重放）→ runtime（debian:bookworm-slim，无编译器）。apt：xvfb/dbus/chromium/libreoffice-writer+calc+impress/pandoc/poppler-utils/tesseract-ocr(+chi-sim)/ffmpeg/fonts-noto-cjk + Electron 运行库 + python3-venv + curl。Python venv `/opt/skills-venv` 入 PATH，`python-pptx` 等导入在构建期断言。uid 1000 非 root，`VOLUME /data`，HEALTHCHECK 打 `/healthz`，C1 四标签（version/commit/contract/rollback-safe-to 经 build args，空 version/commit 直接构建失败）。 |
| REQ-A-27 | DONE | 标签与 tag 约定 `{appVersion}-{commit7}`（README 给出命令）；`org.idbots.rollback-safe-to` 由 build arg 注入（本仓库当前无数据库降级边界，留空）。/readyz 与 welcome 帧的版本来自 `app.getVersion()` 与打包版本一致。 |
| REQ-A-28 | DONE | 本支线无删除/重置用户数据的改动；server bootstrap 的 `server_bootstrap_steps` 表为 `CREATE TABLE IF NOT EXISTS` 幂等迁移（T4 测试断言既有 `app_config` 数据保留）。 |

## 自检结果

- pnpm run lint: PASS
- pnpm run compile:electron: PASS
- pnpm run build:skills: PASS（镜像内同样执行）
- pnpm test: PASS（同 T3/T4 的本机环境例外 `coworkProxyBindHost`，VPN fake-ip 所致，与本分支无关）
- `tests/tenantImage.test.mjs`（14 项静态断言）: PASS
- 镜像构建: PASS（linux/amd64，buildx + QEMU；构建期内核补丁检查与 dsh-deps 门禁通过）
- `deploy/tenant-image/verify-image.sh`: PASS（18/18：标签、uid 1000、python-pptx、chromium/LibreOffice/pandoc/chi_sim/ffmpeg、entrypoint 两种拒绝、构建门禁日志）
- 容器实测见下（AC 证据）

## 容器实测（AC 证据，全部在本机 docker + linux/amd64 镜像、C1 生产限制 `--cap-drop ALL`/`no-new-privileges`/2304m/shm 1g 下运行）

- **AC-A-3 首启**：fresh volume 首启 ready **73 s**（限 300 s），readyz 含真实链上 `globalMetaId` 与 `twinMetabotId=1`，contractVersion 1.0.0。
- **AC-A-3 重启**：同一 volume `docker start` 后 **7 s** ready（限 90 s）。
- **AC-A-3 bootstrap 中断续跑**：fresh volume 分别在 ~8 s 与 ~25 s（第二次启动内）`docker kill`，第三次启动后 bootstrap 续跑完成；期间恰遇真实气体赞助故障（`no_user_utxo`），`twinMetabot` 按 30/60/120/240/300 s 退避重试 subsidy+链上同步，赞助恢复后**自行收敛至 synced，无需二次注册**（REQ-A-8 特别案例的活体验证）。终态：`metabot:list` 全容器**恰好一个** twin（id=1），`server_bootstrap_steps` 全 done/skipped。
- **AC-A-4**：`docker stop -t 30` → **0.61 s** 退出（限 20 s），exit code 0；`PRAGMA integrity_check` = `ok`。
- **AC-A-5 浏览器路径（关键新增证据）**：在租户容器内驱动 web-search 浏览器路径——`/api/browser/launch` 启动 `/usr/lib/chromium/chromium`（Debian 包，独立 user-data-dir），CDP 9222 `/json/version` 返回 **Chrome/155 HeadlessChrome（非 Electron）**；经 `/api/page/navigate` + `/api/search` 完成一次真实联网搜索（bing 引擎返回真实结果列表）。峰值内存 `docker stats` **1.636 GiB / 2.25 GiB（72.7%）**，无 OOM。server 模式下 Electron 无任何窗口与调试端口（「app page 保持在 dist/index.html」在 server 模式下强化为「无 app 页面」）。其余技能（docx/xlsx/pptx/pdf/weather 与 script 路径 web-search）沿用 Phase 0/S05b 既有通过结论；10 分钟内存回落（REQ-A-31）的实测属验收阶段配合 Phase 0 harness 完成。
- **AC-A-2 容器半边**：`node cloud/conformance/run.mjs` 对租户容器 **10 passed / 0 failed / 2 skipped**（两项 SKIP 理由同 feat/gateway 交付说明）。

### 实测中发现并修复的缺陷

- **web-search 浏览器路径在生产限制下无法启动**（Chromium `No usable sandbox`）——正是工单 A-5 特别说明要求实测的原因。修复：`SKILLs/web-search/server/playwright/browser.ts` 支持 `WEB_SEARCH_CHROME_NO_SANDBOX=1`（追加 `--no-sandbox`），镜像以 `ENV` 注入（entrypoint 同时 export 作冗余）。桌面路径不受影响。修复后浏览器路径实测通过（见上）。

## 复审修复（2026-10-22，WS-A-修改意见）

- 已合入 S2-1（服务端模式额度耗尽文案改为充值引导，桌面不变）与 S2-2（`__test:sleep` 超时钩子）两条修复；`__test:sleep` 在容器内需以 `IDBOTS_GATEWAY_TEST_HOOKS=1` 显式开启，生产默认关闭。
- 附带健壮性修复：移除 Dockerfile 的 `# syntax=docker/dockerfile:1` 指令——该指令会在构建时拉取 Docker Hub 前端元数据，在受限网络下曾导致构建失败；buildx 内建前端即可完成本 Dockerfile 全部特性。
- 复审后容器侧复测：fresh volume 首启 **70 s ready**；conformance **11 passed / 0 failed / 1 skipped**，`invoke-timeout — TIMEOUT after 1508 ms`（钩子经 `IDBOTS_GATEWAY_TEST_HOOKS=1` 开启）。
- 验证方式说明：复审修复的完整镜像重建因 Docker Hub/镜像源当时不可达未能完成；容器复测使用「上一版完整构建镜像 + 本地产物（dist/dist-electron）」的增量补丁镜像（`idbots/tenant:1.0.2-reviewfix`），应用代码与分支 HEAD 一致。`# syntax` 移除本身未再经完整构建验证（属注释级改动，buildx 内建前端语义等价），中转环境首次全量构建时请留意。

## 未完成/存疑

1. 镜像 ~3.37 GB（Phase 0 参考值 ~2.1 GB 的镜像形态不同）；如需收敛，生产依赖裁剪与 apt 层瘦身是下一步（不阻塞验收）。
2. `/readyz` 的 `commit` 字段为 `dev`：应用的构建期 commit 戳读取 `.git`，而 docker context 排除了它；镜像标签 `org.idbots.commit` 携带真实哈希，建议 WS-C 的 CI 在构建时通过 `IDBOTS_COMMIT` 注入（README 已注明）。
3. ~~web-search 浏览器路径未证~~ → 已实测通过（见上）；同时修复了 Chromium sandbox 缺陷。

## 需求外的观察

- 技能目录本身不带 Python requirements 文件；`deploy/tenant-image/skills-requirements.txt` 是按技能实际 import 归并的清单，技能新增 Python 依赖时需同步维护。
- pptx / imap-smtp-email 两个 npm 依赖型技能在镜像内预装依赖（hoisted 实体目录），避免首用时后台 npm install 挤占 C1 的 300 s 首启预算。
- 构建期发现根 postinstall 引用 `scripts/`，因此 deps 阶段必须 COPY scripts；以及本网络环境访问 GitHub releases 不可达，加了可选 `ELECTRON_MIRROR` build arg（默认空=官方源，CI 无需感知）。
