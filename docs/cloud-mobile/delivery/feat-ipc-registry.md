# Delivery Note — feat/ipc-registry

## 基线

commit: 3cab9f0b79688f7afdfae18b43d14b94f4ac6788
分支: feat/ipc-registry
推送位置: 无（本机分支，不推远端）
最终提交: d6faf8aa（实现）+ 92617c51（本说明）

## 需求逐条

| REQ | 状态 | 证据 |
|-----|------|------|
| REQ-A-12 | DONE | `src/main/ipc/registry.ts` (`registerIpcHandler` calls `ipcMain.handle` and records the handler); all 346 `registerIpcHandler(...)` registrations across `src/main/main.ts` (316), `services/trafficAccountService.ts` (18), `services/metabotWalletIpc.ts` (4), `services/feeRateStore.ts` (4), `services/llmRelayService.ts` (3), `services/jevRelayService.ts` (1). Guard test `tests/ipcRegistry.test.mjs` ("no ipcMain.handle outside src/main/ipc/registry.ts") fails on any bare `ipcMain.handle(`. |
| REQ-A-13 | DONE | Synthetic event `{ sender: null, senderFrame: null, gateway: { clientId } }` defined in `src/main/ipc/registry.ts` (`SyntheticGatewayInvokeEvent`, `invokeRegisteredHandler`). Audit at `docs/cloud-mobile/audits/invoke-event-shape.md`: 24 raw sites reviewed, 20 handler sites audited, **0 need follow-up** — no P1/P2 allowlisted channel reads `event.sender`/`senderFrame`/`fromWebContents`. Naming note: REQ-A-13 text names the file `event-sender-review.md`; the workorder assigns `invoke-event-shape.md` — delivered under the workorder name, noted in the doc. |
| REQ-A-14 | DONE | `src/main/ipc/broadcast.ts` (`broadcastToRenderers` sends to every live window + registered gateway listeners via `addBroadcastListener`). 47 broadcast sites converted (site-by-site map below). Specific-window sends documented as desktop-only and left in place. Guard test "no getAllWindows broadcast loop outside src/main/ipc/broadcast.ts". |

## Site map (workorder §3 T1 完工判据)

### `ipcMain.handle` → `registerIpcHandler`

| 文件 | 站点数 | 说明 |
|---|---|---|
| `src/main/main.ts` | 316 | 全部机械替换；import 见 `main.ts:7` |
| `src/main/services/trafficAccountService.ts` | 18 | DI 由 `ipcMain: IpcMainLike` 改为 `registerIpcHandler: RegisterIpcHandlerFn` |
| `src/main/services/metabotWalletIpc.ts` | 4 | 同上 |
| `src/main/services/feeRateStore.ts` | 4 | 直接 import registry（原 import electron 的 ipcMain） |
| `src/main/services/llmRelayService.ts` | 3 | DI 改动同 trafficAccountService |
| `src/main/services/jevRelayService.ts` | 1 | 同上 |
| 调用点 | — | `main.ts` 中 4 处 `register*IpcHandlers({ ipcMain })` 改为传 `registerIpcHandler`；`tests/metabotWalletIpc.test.mjs` 的 fake 同步更新 |

### 广播站点 → `broadcastToRenderers`

`src/main/main.ts`（40 处）: `main.ts:781` cowork:stream:message（emitCoworkStreamMessage）、`:814` cowork:stream:messageUpdate（sendCoworkStreamMessageUpdate）、`:830` cowork:session:profileRefreshed、`:914` providerDiscovery:changed、`:919` groupTask 动态 channel（broadcastGroupTaskEvent）、`:3039` idbots:listener-log、`:4184` privateChatDaemon 动态 channel、`:4963` dream 动态 channel、`:5101` memoryHygiene 动态 channel、`:5255` sqlite:relaunch-required、`:5407` cowork:delegation:stateChange、`:5421` cowork:stream:message（delegation 注入）、`:7340` cowork:stream:message、`:7369` cowork:stream:permission、`:7377` cowork:stream:permissionResolved、`:7387` cowork:stream:complete、`:7395` cowork:stream:error、`:7405` cowork:stream:sessionTitle、`:7547` metaapps:changed、`:7702` im:status:change、`:7706` im:message:received、`:7966` preference:update、`:8021` metatask:update（broadcastMetaTaskUpdate）、`:8036` metatask:update（Refresher onUpdated）、`:8063` longtermTask:update、`:8233` agentGame:consentRequired、`:8236` agentGame:sessionUpdated、`:8491` knowledgeBase 动态 channel、`:8728` SURF_STATUS_CHANNEL、`:9681` powerGuard:changed、`:9724` cowork:sandbox:downloadProgress、`:9896` store:changed、`:10668`/`:10680` skills:changed、`:11874` cowork:stream:complete（clearError）、`:11891` endPrivateChatA2A 动态 channel、`:12073`/`:12120`/`:12173` cowork:stream:message（delivery 通知 ×3）、`:15003` chainBackup:progress。

其他文件: `libs/scheduler.ts:650` scheduledTask:statusUpdate、`:657` scheduledTask:runUpdate；`libs/coworkOpenAICompatProxy.ts:3586`/`:3613` scheduledTask:statusUpdate；`skillManager.ts:2196` skills:changed；`metaAppManager.ts:793` metaapps:changed；`services/botBrowserOpenUriService.ts:21` botBrowser:openUri（保留 focus 副作用与无窗口时报错）。

### 刻意保留的单窗口发送（desktop-only，REQ-A-14 允许）

| 站点 | 原因 |
|---|---|
| `main.ts` emitWindowState → `window:state-changed` | 发送到状态变化的特定窗口 |
| `main.ts` appUpdate:download 内 `event.sender.send('appUpdate:downloadProgress')` | 回复请求方 renderer |
| `trayManager.ts` `app:newTask` / `app:openSettings` | 单窗口 + show/focus 副作用 |
| `services/botBrowserTabBridge.ts`、`services/botBrowserCaptureBridge.ts` | 按 `.find()` 寻址特定窗口的桥接 |

## 自检结果

- pnpm run lint: PASS（`eslint . --ext ts,tsx --max-warnings 0`，exit 0；修复了一处基线遗留失败，见「未完成/存疑」）
- pnpm run compile:electron: PASS（`tsc --project electron-tsconfig.json` + copy-electron-js，exit 0）
- pnpm run build:skills: PASS（`build-skills.js` + `build-web-search-skill.js`，exit 0）
- pnpm test: PASS（完整链路 exit 0；末段 222 pass / 0 fail；新增 `tests/ipcRegistry.test.mjs` 3 项断言在链内）
- conformance: N/A（T3 之后适用）

## 未完成/存疑

- `pnpm run lint` 在基线 `3cab9f0` 上就有一处与本次改动无关的失败（`tests/coworkQuoteReplyMessage.test.tsx:846` `no-regex-spaces`，来自 PR #84）。为满足工单 §6「提交前必须全绿」，在本分支用单独提交做了最小修复（正则内 6 个连续空格改 `{6}`），行为不变。**这是本分支唯一的需求外改动。**
- 桌面端冒烟（AC-A-1 的 macOS/Windows 打包跑）无法在本环境验证；本分支为纯重构，编译/lint/单测全绿，广播与注册语义逐站点保持不变。

## 需求外的观察

- `docs/*` 与 `tests/*` 在 `.gitignore` 中被忽略，但大量文件已被强制跟踪；本分支新增的 `docs/cloud-mobile/audits/invoke-event-shape.md` 与 `tests/ipcRegistry.test.mjs` 需要 `git add -f`。
- worktree 内自带的 `AGENTS.md` 仍是外置 exFAT SSD 时代的旧版本（要求 `core.filemode false`），与主检出当前的内部盘约定冲突；主检出的新版为准，建议另行同步（不在本支线范围）。
- `botBrowserOpenUriService` 旧的逐窗 `delivered` 计数改为转换前的 live-window 计数；helper 内部 try/catch，单窗发送异常不再上抛（更稳，无实际行为差异）。
