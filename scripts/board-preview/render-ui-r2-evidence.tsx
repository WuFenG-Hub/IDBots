/**
 * R2 修复前后对照素材生成器（**组件真渲染 + 真实编译样式，不是真机截图**）。
 *
 * 用途：把本轮三项 UI 修复的「修复前 / 修复后」两棵树渲染成同一套页面的 HTML，
 * 再交给 headless Chrome 按两个窗口尺寸出图，供验收方做像素级前后对照：
 *   - A 收口横幅文案：{count} 取 counts.closureDue（三级合计），旧文案把合计说成「超 2 天」；
 *   - B 抽屉头部：超长标题（owner_intent 原文）在旧版把正文压小、页脚顶出屏幕；
 *   - C 交付物行：metaapp:// 行在旧版被主进程标成 'pin'，新版按 scheme 给出紫色 MetaApp 徽章。
 *
 * 两套页：
 *   1) 静态页（renderToStaticMarkup，无 JS）：横幅与「标题墙」类证据，页脚/徽章可见性；
 *   2) 实挂载页 r2-live.html（见 live-r2-entry.tsx）：需要布局实测/交互的展开按钮与展开态。
 *      query：?expand=title|goal。壳里写死 body[data-metaapp-kind]，before 树='pin'（父提交返回值）。
 *
 * 用法（两个工作树各跑一次；before 树用同一份脚本文件，不提交）：
 *   AFTER : npx tsx scripts/board-preview/render-ui-r2-evidence.tsx
 *   BEFORE: R2_BEFORE=1 npx tsx scripts/board-preview/render-ui-r2-evidence.tsx
 * 产物：.cowork-temp/board-preview/r2-*.html（gitignore），截图见 README 的 Chrome 命令。
 *
 * 不证明什么：不含真实 IPC 与实库数据；fixture 的字段形状按主进程契约手写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  BANNER_COUNTS,
  METABOT_NAMES,
  TITLE_CHARS,
  buildBannerCards,
  buildDetail,
} from './r2-fixtures';

const OUT_DIR = path.resolve(process.cwd(), '.cowork-temp/board-preview');
const CSS_FILE = fs
  .readdirSync(path.resolve(process.cwd(), 'dist/assets'))
  .filter((f) => f.startsWith('index-') && f.endsWith('.css'))
  .sort()
  .pop()!;
const CSS_HREF = path.resolve(process.cwd(), 'dist/assets', CSS_FILE);
const BEFORE_MODE = process.env.R2_BEFORE === '1';

/**
 * before 模式：03069ece 上主进程 trackedDeliverableKind 先命中 pinid 令牌，metaapp:// 行返回 'pin'；
 * 修复后按 scheme 返回 'metaapp'。样张照抄该返回值，保证前后对照的输入差异只有组件与这一列。
 */
const METAAPP_ROW_KIND = BEFORE_MODE ? 'pin' : 'metaapp';
const TREE_LABEL = BEFORE_MODE ? '03069ece' : 'fix';

const TREE_SHA = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

function stubBrowserGlobals() {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  (globalThis as any).navigator = { language: 'zh-CN' };
  (globalThis as any).window = {
    electron: { platform: 'darwin' },
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

const BASE_CSS = `
  body { margin:0; background:#262624; color:#e8e6e3; font-family:-apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif; }
  .shot { display:flex; flex-direction:column; overflow:hidden; position:relative; }
  .caption { flex:0 0 auto; min-height:26px; display:flex; align-items:center; gap:10px; padding:3px 12px; font-size:11px;
             background:#1b1b19; color:#b4b1ad; border-bottom:1px solid rgba(255,255,255,.07); }
  .caption b { color:#ffd9a0; font-weight:600; }
  .stage { flex:1 1 auto; min-height:0; position:relative; }`;

/** 静态页：无 JS；抽屉根是 fixed inset-0，用 extra CSS 把它约束在 stage 内。 */
function page(width: number, height: number, note: string, body: string, extra = ''): string {
  return `<!doctype html>
<html class="dark" lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>R2 evidence ${width}x${height}</title>
<link rel="stylesheet" href="${CSS_HREF}" />
<style>
  ${BASE_CSS}
  .shot { width:${width}px; height:${height}px; }
  ${extra}
</style>
</head>
<body><div class="shot"><div class="caption">${note}</div>${body}</div></body>
</html>`;
}

/**
 * 实挂载页壳：`transform: translateZ(0)` 让 .stage 成为 fixed 后代的包含块——
 * 抽屉的 `fixed inset-0` 因此落在 stage 里（等价真机占满窗口），同时保住顶部 caption。
 * body[data-metaapp-kind] / [data-tree] 由生成器按树写死，供 live-r2-entry 读。
 */
function livePage(width: number, height: number, note: string): string {
  return `<!doctype html>
<html class="dark" lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>R2 live ${width}x${height}</title>
<link rel="stylesheet" href="${CSS_HREF}" />
<style>
  ${BASE_CSS}
  .shot { width:${width}px; height:${height}px; }
  .stage { transform:translateZ(0); }
</style>
</head>
<body data-metaapp-kind="${METAAPP_ROW_KIND}" data-tree="${TREE_LABEL}" data-tree-sha="${TREE_SHA}">
<div class="shot"><div class="caption">${note}</div><div class="stage"><div id="root"></div></div></div>
<script src="./live-r2.js"></script>
</body>
</html>`;
}

async function main() {
  stubBrowserGlobals();
  const { i18nService } = await import('../../src/renderer/services/i18n');
  (i18nService as unknown as { currentLanguage: string }).currentLanguage = 'zh';

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const Banner = (await import('../../src/renderer/components/trackedTasks/ClosureBanner')).default;
  const Drawer = (await import('../../src/renderer/components/trackedTasks/TrackedTaskDrawer')).default;

  const noop = () => undefined;
  const names = new Map<number, string>(METABOT_NAMES);
  const mode = BEFORE_MODE ? 'BEFORE parent 03069ece' : 'AFTER fix/tracked-board-ui-r2';
  const modeZh = BEFORE_MODE ? '修复前' : '修复后';

  const bannerCards = buildBannerCards(METAAPP_ROW_KIND);
  const detail = buildDetail(METAAPP_ROW_KIND);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sizes: Array<{ w: number; h: number }> = [
    { w: 1000, h: 700 },
    { w: 1440, h: 900 },
  ];
  const written: string[] = [];

  for (const { w, h } of sizes) {
    const bannerHtml = renderToStaticMarkup(
      React.createElement(Banner as any, {
        cards: bannerCards,
        counts: BANNER_COUNTS,
        onlyOwnerAction: false,
        onToggleOnlyOwnerAction: noop,
        onOpenCard: noop,
      } as any)
    );
    const bannerBody = `<div class="stage" style="background:#262624">
      ${bannerHtml}
      <div style="padding:14px 16px; font-size:12px; color:#8f8d8a">看板区域（占位）：本页只取证横幅文案与分级 chip 的对照。</div>
    </div>`;
    const bannerNote = `<b>R2-A</b> 收口横幅文案 · ${modeZh} · 树 ${TREE_SHA} · closureDue=3 (z1/t1/s1) · ${w}×${h} · ${mode}`;
    const bannerName = `r2-banner-${w}x${h}.html`;
    fs.writeFileSync(path.join(OUT_DIR, bannerName), page(w, h, bannerNote, bannerBody));
    written.push(bannerName);

    const drawerHtml = renderToStaticMarkup(
      React.createElement(Drawer as any, {
        detail,
        metabotNames: names,
        onClose: noop,
        onRequestCloseCard: noop,
      } as any)
    );
    const drawerBody = `<div class="stage">${drawerHtml}</div>`;
    const drawerNote = `<b>R2-B/C</b> 任务卡抽屉静态页 · ${modeZh} · 树 ${TREE_SHA} · 标题 ${TITLE_CHARS} 字 · 4 行交付物 metaapp kind=${METAAPP_ROW_KIND} · ${w}×${h}`;
    const drawerName = `r2-drawer-${w}x${h}.html`;
    fs.writeFileSync(
      path.join(OUT_DIR, drawerName),
      page(w, h, drawerNote, drawerBody, '.stage > div { position:absolute; inset:0; }'),
    );
    written.push(drawerName);

    const liveName = `r2-live-${w}x${h}.html`;
    const liveNote = `<b>R2-B/C-live</b> 抽屉实挂载 · ${modeZh} · 树 ${TREE_SHA} · 标题 ${TITLE_CHARS} 字 · metaapp kind=${METAAPP_ROW_KIND} · ${w}×${h} · ${mode}`;
    fs.writeFileSync(path.join(OUT_DIR, liveName), livePage(w, h, liveNote));
    written.push(liveName);
  }

  console.log('mode:', BEFORE_MODE ? 'BEFORE' : 'AFTER', '| tree:', TREE_SHA, '| metaapp row kind:', METAAPP_ROW_KIND);
  console.log('title chars:', TITLE_CHARS);
  console.log('css:', CSS_FILE);
  console.log('pages:', written.join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
