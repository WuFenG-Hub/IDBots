# Delivery Note — feat/ipc-contract

## 基线

commit: 3cab9f0b79688f7afdfae18b43d14b94f4ac6788
分支: feat/ipc-contract（自 `3cab9f0b` 切出，与 feat/ipc-registry 并行）
推送位置: 无（本机分支，不推远端）
最终提交: 由 owner 审阅后提交（本子代理不执行 git 提交；新增文件清单见文末「需求外的观察」）

## 需求逐条

| REQ | 状态 | 证据 |
|-----|------|------|
| REQ-A-17（数据半） | DONE（enforcement 半归 T3 feat/gateway） | `src/main/gateway/allowlist.ts`：纯数据 + 纯函数，无 electron/service import。`INVOKE_ALLOWLIST` 251 条精确项（全部逐条来自 `docs/cloud-mobile/02-ipc-allowlist-v1.md`：Cowork 68、MetaBots/Identity、Skills、Tasks、Billing、Gig Square/Background/App-Config-Utilities 各表 + "New Channels Added by WS-A" 7 条）+ `INVOKE_ALLOWLIST_PREFIXES` 15 组（`longtermTask:` P1、`groupTask:`/`gigSquare:` P2、N 组 12 个）；`EVENT_ALLOWLIST` 39 条精确项 + 3 组前缀（`agentGame:`/`botBrowser:` N、`api:stream:` N）；`SEND_CHANNELS` 8 条全 N；超时：`idbots:createMetaBotOnChain` 300_000（P1）、`chainBackup:backup` 900_000（P2）、`gigSquare:sendOrder` 300_000（P2，精确项覆盖前缀项）、`DEFAULT_INVOKE_TIMEOUT_MS` 120_000（C2 Limits）；`lookupInvokeChannel`/`lookupEventChannel`（精确优先、最长前缀次之、默认 `{tier:'N'}` deny）+ `lookupInvokeChannelWithSource`/`lookupEventChannelWithSource` 返回 `{entry, matched: 'exact'|'prefix'|'default'}` 供测试区分「来自 02 的分级」与「默认 N」。测试 `tests/ipcContract.test.mjs` 7 项全绿，含 `02` 要求的前两项（preload 每个 channel 有分级；逐条 spot check  tier/限制/超时）。 |
| REQ-A-23 | DONE | `scripts/generate-ipc-contract.mjs`：用 TypeScript compiler API 解析 `src/main/preload.ts`（sandboxed preload 无法运行时 import 共享模块，故解析而非导入），递归走 `contextBridge.exposeInMainWorld('electron', {…})`，分类 invoke（单表达式 `ipcRenderer.invoke`，含 `as Promise` 强转、单行块、三元参数）、on（`ipcRenderer.on` + 返回 `removeListener` 退订函数的形状）、send、value（`platform`/`arch`）、custom（其余）；输出 `src/mobile/generated/ipc-contract.json`（`contractVersion`/`allowlistVersion` 1.0.0、按 path 排序、无时间戳，405 个方法：invoke 349 / on 46 / send 8 / value 2）。`--check` 内存重生成并逐字节比对（陈旧即非零退出）；`--stdout` 只打印 JSON（摘要走 stderr）。override 机制：`scripts/ipc-contract-overrides.json`（4 项，全为 `api.onStream*` 的模板字符串 channel）；custom 无 override 即失败、override 指向已不存在路径（陈旧）即失败、对可分类方法声明 override 也失败——三种失败路径均实测验证。生成器在编译产物可用时对无分级 channel 打印警告（硬闸门在测试里）。AC-A-7：测试在 preload 新增无分级 channel 时失败（`lookup*WithSource().matched === 'default'` 断言），在当前 main 上通过。 |

## 变更清单

| 文件 | 说明 |
|---|---|
| `src/main/gateway/allowlist.ts` | 新增。REQ-A-17 数据半（见上）。 |
| `scripts/generate-ipc-contract.mjs` | 新增。REQ-A-23 契约生成器（见上）。 |
| `scripts/ipc-contract-overrides.json` | 新增。4 个 `api.onStream*` override（见「未完成/存疑」CR 记录）。 |
| `src/mobile/generated/ipc-contract.json` | 新增。生成产物（405 方法，已随 `--check` 校验新鲜）。 |
| `tests/ipcContract.test.mjs` | 新增。7 项测试（陈旧闸门、契约形状、分级覆盖、send 清单、02 spot checks、02 表存在性 + P1 抽查、默认 deny/精确优先）。`tests/*` 被 gitignore，需 `git add -f`。 |
| `package.json` | `test` 链第一段 `node --test` 组加入 `tests/ipcContract.test.mjs`（紧邻 `tests/llmSafeText.test.mjs`）。 |
| `tests/coworkQuoteReplyMessage.test.tsx` | 基线遗留 lint 修复（与 T1 完全相同的一行：`no-regex-spaces`，6 个连续空格改 `{6}`），见「未完成/存疑」。 |

## 自检结果

- `pnpm run compile:electron`: PASS（`tsc --project electron-tsconfig.json` + copy-electron-js，exit 0）
- `node scripts/generate-ipc-contract.mjs --check`: PASS（exit 0；另实测篡改产物文件 → exit 1、陈旧 override → exit 1、恢复后 → exit 0）
- `node --test tests/ipcContract.test.mjs`: PASS（7/7）
- `pnpm run lint`: PASS（`eslint . --ext ts,tsx --max-warnings 0`，exit 0；含上述基线遗留修复）
- `pnpm test`: PASS（完整链路 exit 0；llmSafeText + ipcContract 段、runtimeDependencyContract 段、long-term-task 段及后续各段全绿）
- 覆盖统计（生成契约 → allowlist 解析）：invoke channel 349 个（精确 244 / 前缀 105 / 默认 0；P1 135、P2 103、N 97、S 12、H 2）；event channel 46 个（精确 39 / 前缀 7 / 默认 0；P1 16、P2 11、N 19）；send 8 个全在 `SEND_CHANNELS`。
- conformance: N/A（T3 之后适用）

## 未完成/存疑

- **`02` v1.0.0 与当前 preload 存在 7+1 个 channel 的缺口（变更请求发现，已按 `02` 默认拒绝规则显式置 N）。** `02` 的清单采自 2026-10-14 的 preload；基线 `3cab9f0b` 的 preload 在其后新增了：`preference:listRounds`/`roundStatus`/`commit`/`telemetry`/`refresh`（+事件 `preference:update`，2026-10-14 当天入库，疑为盘点遗漏）、`jevRelay:resolveCredentials`（2026-10-14）、`store:getStrict` 与 `cowork:session:prewarmTurnSlot`（2026-10-16，明确晚于冻结点）。这些 channel 在 `02` 中没有任何行，按工单规则我不得为它们发明 P1/P2 分级，也不得更改冻结的 `02`；`02` 开头「Everything not listed as allowed is denied」即是对未列出 channel 的 N 级裁决，故 `allowlist.ts` 将它们以显式 N 条目收录（`POST_FREEZE_INVOKE` 段 + `preference:update` 事件项），行为与默认 deny 完全一致，仅使覆盖检查可精确区分「已盘点但拒绝」与「从未分级」。**需要 owner 走 `00` 的变更请求流程给它们在 `02` 中定级**（大概率：prewarmTurnSlot 参照 cowork P1 家族、getStrict 参照 store:get 的 P1-R、preference:* 与 jevRelay 需产品决策）。在此之前 T3 网关对它们返回 `CHANNEL_NOT_ALLOWED`。
- `api:stream:{requestId}:data|done|error|abort` 四个模板 channel 是 N 级 `api:stream` invoke 的渲染端内部事件，同样不在 `02` Events 表；以 `EVENT_ALLOWLIST` 的 `api:stream:` 前缀（N）覆盖，4 个 override 记录准确来源。同上，建议随上一条 CR 一并写回 `02`。
- `pnpm run lint` 在基线 `3cab9f0` 上有一处与本次无关的失败（`tests/coworkQuoteReplyMessage.test.tsx:846` `no-regex-spaces`，来自 PR #84）。为满足工单「提交前必须全绿」，本分支按 T1 的同一处最小修复（正则内 6 个连续空格改 `{6}`，与 feat/ipc-registry 分支内容逐字一致，行为不变）单独提交。**这是本分支唯一的需求外改动。**
- 桌面端冒烟（AC-A-1）无法在本环境验证；本分支不改运行时行为（allowlist 数据模块无调用方，生成器为独立工具），编译/lint/单测全绿。

## 需求外的观察

- `src/mobile/` 目录为新建，**未被 gitignore**（`git check-ignore` 无匹配），生成产物可直接 `git add` 跟踪；`tests/ipcContract.test.mjs` 与 `docs/cloud-mobile/delivery/feat-ipc-contract.md` 落在被忽略的 `tests/*`、`docs/*` 下，需 `git add -f`（与 T1 相同）。
- 生成器解析用的 `typescript` 是根 `devDependencies` 直接依赖（`^5.7.3`），无新增依赖；`scripts/`、根 `package.json` 均未被忽略。
- 契约里 349 个 invoke 方法对应 349 个唯一 channel（无重复 channel）；`p2p.*`/`metaWebListener.*` 等别名路径暴露的 channel（如 `metaid:getUserInfo`、`idbots:getListenerConfig`）与主路径共用同一 channel，allowlist 按 channel 分级天然去重。
- `coworkQuoteReplyMessage.test.tsx` 的 lint 修复与 feat/ipc-registry 分支逐字相同：两个并行分支合入 main 时该 hunk 内容一致，不会产生冲突；若 T1 先合入，本分支 rebase 后该提交变为空提交，可直接丢弃。
- worktree 内的 `AGENTS.md` 仍是外置 exFAT SSD 时代的旧版本（T1 已观察到同一问题，建议另行同步，不在本支线范围）。
