/**
 * R2 证据页的**客户端实挂载入口**（有 React 运行时；与静态 renderToStaticMarkup 页互补）。
 *
 * 为什么需要它：展开/收起按钮的显示条件来自 `useLayoutEffect` 的 ref 实测
 * （scrollHeight > clientHeight），静态服务端渲染不跑布局 effect，按钮永远不会出现。
 * 本入口把真实抽屉挂进浏览器（fixture 与静态页共用 r2-fixtures.ts），让实测真的发生；
 * 页面 query `expand=title|goal` 时自动点开对应按钮，用于拍「展开态限高 40vh +
 * 区域内部可滚 + 收起按钮仍可见」的像素证据。
 *
 * 打包（不改 vite 配置）：
 *   npx esbuild scripts/board-preview/live-r2-entry.tsx --bundle \
 *     --outfile=.cowork-temp/board-preview/live-r2.js --format=iife --platform=browser \
 *     --jsx=automatic --define:process.env.NODE_ENV='"production"' --log-level=warning
 * 页面壳由 render-ui-r2-evidence.tsx 生成（r2-live.html）。
 *
 * 不证明什么：不含真实 IPC / 实库数据；metaapp 行的 kind 来自 body[data-metaapp-kind]
 * （由生成器按树写死：before='pin' 复现父提交主进程返回值，after='metaapp'）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { i18nService } from '../../src/renderer/services/i18n';
import TrackedTaskDrawer from '../../src/renderer/components/trackedTasks/TrackedTaskDrawer';
import { buildDetail, METABOT_NAMES, SHORT_TITLE, TITLE_CHARS } from './r2-fixtures';

(i18nService as unknown as { currentLanguage: string }).currentLanguage = 'zh';

const params = new URLSearchParams(window.location.search);
const metaappKind = document.body.dataset.metaappKind === 'pin' ? 'pin' : 'metaapp';
const expand = params.get('expand');
/** title=short：交付物徽章取证用短标题（徽章缺陷与标题长度无关），两棵树同输入。 */
const titleMode = params.get('title');
const scrollTo = params.get('scroll');

const detail = buildDetail(metaappKind);
if (titleMode === 'short') detail.title = SHORT_TITLE;

const names = new Map<number, string>(METABOT_NAMES);
const noop = () => undefined;

createRoot(document.getElementById('root')!).render(
  <TrackedTaskDrawer
    detail={detail}
    metabotNames={names}
    onClose={noop}
    onRequestCloseCard={noop}
  />
);

/** 展开态取证：先点开对应按钮，等 React 提交 + 布局稳定后再量「限高 + 内部可滚」并写进 caption。 */
window.setTimeout(() => {
  const buttons = Array.from(document.querySelectorAll('button')).filter((button) =>
    (button.textContent ?? '').includes('展开全文'),
  );
  const target = expand === 'goal' ? buttons[1] : expand === 'title' ? buttons[0] : undefined;
  target?.click();
  (window as unknown as { __r2ExpandButtons?: number }).__r2ExpandButtons = buttons.length;
  (window as unknown as { __r2Clicked?: number }).__r2Clicked = target ? 1 : 0;
}, 60);

window.setTimeout(() => {
  const state = window as unknown as { __r2ExpandButtons?: number; __r2Clicked?: number };
  // scroll=deliverables：正文区本身就是滚动容器，scrollIntoView 会滚它，把交付物一节顶进视野。
  if (scrollTo === 'deliverables') {
    const section = Array.from(document.querySelectorAll('section')).find((node) =>
      (node.querySelector('h3')?.textContent ?? '').includes('交付物'),
    );
    section?.scrollIntoView({ block: 'start' });
  }
  /** 展开后把「限高 + 内部可滚」量出来写进 caption：比只看像素更硬的可核对读数。 */
  const textNodes = Array.from(document.querySelectorAll('h2, p'));
  const boxes = textNodes
    .map((node) => node.parentElement)
    .filter((box, index, list): box is HTMLElement => Boolean(box) && list.indexOf(box) === index)
    .filter((box) => getComputedStyle(box).maxHeight !== 'none')
    .map((box) => {
      const style = getComputedStyle(box);
      return `${box.tagName.toLowerCase()}[max-h=${style.maxHeight} overflow-y=${style.overflowY} client=${box.clientHeight} scroll=${box.scrollHeight}]`;
    });

  const caption = document.querySelector('.caption');
  if (caption) {
    const mode = document.body.dataset.tree === 'fix' ? 'AFTER fix/tracked-board-ui-r2' : 'BEFORE parent 03069ece';
    const modeZh = document.body.dataset.tree === 'fix' ? '修复后' : '修复前';
    caption.innerHTML = `<b>R2-B/C-live</b> 抽屉实挂载 · ${modeZh} · 树 ${document.body.dataset.treeSha ?? '?'} · 标题 ${titleMode === 'short' ? '短标题' : `${TITLE_CHARS} 字`} · metaapp kind=${metaappKind} · expand=${expand ?? 'none'} · scroll=${scrollTo ?? 'none'} · 展开按钮 ${state.__r2ExpandButtons ?? '?'} 个 · 已点 ${state.__r2Clicked ?? 0} · ${window.innerWidth}×${window.innerHeight} · ${mode} · 限高区 ${boxes.length ? boxes.join(' ') : `无（h2/p=${textNodes.length}）`}`;
  }

  document.title = `r2-live kind=${metaappKind} expand=${expand ?? 'none'} expandButtons=${state.__r2ExpandButtons ?? '?'} clicked=${state.__r2Clicked ?? 0} textNodes=${textNodes.length} capped=${boxes.join(' ')}`;
}, 400);
