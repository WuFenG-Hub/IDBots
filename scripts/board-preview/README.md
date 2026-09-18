# scripts/board-preview —— 长期任务看板「视觉素材」生成器

用**真实组件 + 真实编译样式**渲染静态 HTML，再用 Chrome headless 截图，产出 M 组视觉素材。
它让「没启动 Electron 也能先看像素」成为可长期复跑的动作，而不是一次性手工活。

## 它证明什么、不证明什么

**证明**：版式、层级、密度、配色、文案可达性——用的是 `vite build` 的那一份 tailwind 产物，
组件是产品里的同一批组件（`ScheduledTasksView` / `TrackedTasksSection` / `TrackedTaskDrawer` /
`CloseTaskModal` / `TrackedTaskOriginChipView` / `TrackedTasksList`）。

**不证明**：
- **不是真机截图**：不含真实 IPC 调用、不含实库数据（数据是脚本里的确定性 fixture）；
- **不含任何交互**：切 Tab、点击跳转、收口提交都没有真的发生，交互类条目（M2、M8/M9 的跳转落点）拍不出来；
- 不能替代验收方的复跑证据。

## 用法

```bash
cd <worktree>
npx vite build                                       # 生成 dist/assets/index-*.css
npx tsx scripts/board-preview/render-m-items.tsx     # 产出 .cowork-temp/board-preview/*.html
npx tsx scripts/board-preview/render-overview.tsx    # 总览：看板 / 清单 / 抽屉三张

# 截图（任选可用的 chrome 二进制）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --window-size=1440,900 --virtual-time-budget=3000 \
  --screenshot=m1-board.png "file://$PWD/.cowork-temp/board-preview/m1-board.html"
```

产出的 HTML 落在 `.cowork-temp/board-preview/`（gitignore 目录），仓库里只留生成器。

## 页面 → 覆盖条目

| 页面 | 覆盖 |
|---|---|
| `m1-board` | M1 双 Tab 默认选中 · M3 看板四列 · M10 跨列待收口横幅 · M11 分级计数 · M12 范围明示 · M16 入口文案 |
| `m4-empty-column` | M4 空列态 |
| `m5-list-order` | M5 清单排序确定性（同批卡两种输入，输出逐行相同） |
| `m6-m7-drawer` | M6 抽屉九字段 · M7 摘要 5 行 vs 截断 |
| `m8-sessions` | M8 关联会话行（跳转落点需真机） |
| `m9-session-chip` | M9 会话侧归属 chip（有归属 / 0 关联渲染空；跳回需真机） |
| `m14-close-modal` | M14 空结论 disabled + 后端 VALIDATION 拦截 |
| `m15-receipt` | M15 两种收口回执 |

## 维护约定

- fixture 里的卡片字段**必须与主进程 `TrackedCardSummary` 同形**；主进程改字段名时这里同步改，
  否则渲染出的到底是「组件对」还是「fixture 对」就说不清。
- 结构化事实（`reasonCodes` / `closureSuggestionCode` / `closureSuggestionParams`）要按**当前契约**
  填，别用旧字段名——脚本会照原样渲染，旧字段名会静默渲染成空。
- 任何时候都不要把本目录的产物当成验收证据；验收证据由验收方在绑定 commit 的树上跑出来。

## R2 修复前后对照（横幅文案 / 抽屉标题与页脚 / 交付物徽章）

除 M 组素材外，这里还有一套「同一份输入、两棵树渲染」的前后对照工具：

| 文件 | 作用 |
|---|---|
| `r2-fixtures.ts` | 共享 fixture（1616 字长标题 / 4 行交付物含 metaapp 行）；静态页与实挂载页同源，禁止各写一份 |
| `render-ui-r2-evidence.tsx` | 生成静态页与实挂载页壳：`r2-banner-WxH.html` / `r2-drawer-WxH.html` / `r2-live-WxH.html` |
| `live-r2-entry.tsx` | 实挂载入口（展开按钮与展开态需要 JS 才会出现）；用 esbuild 打成 `live-r2.js` |
| `shoot-r2-pages.mjs` | 精确视口截图（CDP `Emulation.setDeviceMetricsOverride`），同时落 `probe.json` 量测读数 |

```bash
# after 树（修复提交）
npx tsx scripts/board-preview/render-ui-r2-evidence.tsx
npx esbuild scripts/board-preview/live-r2-entry.tsx --bundle \
  --outfile=.cowork-temp/board-preview/live-r2.js --format=iife --platform=browser \
  --jsx=automatic --define:process.env.NODE_ENV='"production"'
node scripts/board-preview/shoot-r2-pages.mjs --after <fix树> --before <before树> --out <输出目录>

# before 树（03069ece 的独立 worktree，只读用途、不提交）
#   把 r2-fixtures.ts / live-r2-entry.tsx / render-ui-r2-evidence.tsx 复制过去，
#   R2_BEFORE=1 npx tsx scripts/board-preview/render-ui-r2-evidence.tsx
#   esbuild 同上；shoot 仍从 after 树跑（它按 file:// 读两边的 HTML）
```

**视口口径**：`--window-size=W,H --screenshot` 在本机 headless Chrome 下「窗口 ≠ 视口」
（1000×700 的窗口，页面 `innerHeight` 只有 613），`40vh` 这类 vh 单位会按 613 计算。
所以对照截图请走 `shoot-r2-pages.mjs`（视口被钉死成 W×H），不要用裸 `--screenshot`。

**metaapp 行的 kind**：`r2-live.html` 把 `body[data-metaapp-kind]` 写死成所在树的真实语义——
before='pin'（复现 03069ece 上 `trackedDeliverableKind` 先命中 pinid 令牌的返回值），
after='metaapp'；这是两棵树之间**唯一**的 fixture 差异，其余输入完全相同。
