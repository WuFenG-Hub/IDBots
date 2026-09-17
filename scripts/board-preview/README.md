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
