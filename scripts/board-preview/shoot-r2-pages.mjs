#!/usr/bin/env node
/**
 * R2 证据页精确视口截图器（headless Chrome + CDP）。
 *
 * 为什么不用 `--window-size=W,H --screenshot`：本机实测该口径下「窗口」≠「视口」，
 * 窗口 1000×700 时页面 innerHeight 只有 613（少掉 87px 的 headless 窗口边框），
 * `40vh` 这类 vh 单位会按 613 而不是 700 计算。本脚本用
 * `Emulation.setDeviceMetricsOverride` 把视口钉死成 W×H，再 `Page.captureScreenshot`，
 * 产出的 PNG 就是 W×H，且每张同时落一份 `probe.json` 里对应条目的量测读数
 * （标题行数/限高区 clientHeight vs scrollHeight/展开按钮数/页脚与关闭按钮是否在视口内）。
 *
 * 用法（在 fix 树里跑；before 树只提供 file:// 页面，不需要本脚本）：
 *   node scripts/board-preview/shoot-r2-pages.mjs \
 *     --after  <fix worktree 绝对路径> \
 *     --before <before worktree 绝对路径> \
 *     --out    <截图输出目录>
 * 依赖：本机 Chrome；Node ≥ 22（内置 WebSocket/fetch）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = process.env.R2_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const AFTER_DIR = arg('after');
const BEFORE_DIR = arg('before');
const OUT_DIR = arg('out');
if (!AFTER_DIR || !OUT_DIR) {
  console.error('用法: node scripts/board-preview/shoot-r2-pages.mjs --after <fix树> --before <before树> --out <输出目录>');
  process.exit(2);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const PAGES = path.join('.cowork-temp', 'board-preview');
const SIZES = [
  { w: 1000, h: 700 },
  { w: 1440, h: 900 },
];

/** 待截清单：静态页 + 实挂载页（folded / expanded-title / expanded-goal），各 before/after。 */
function buildPlan() {
  const plan = [];
  for (const { w, h } of SIZES) {
    const size = `${w}x${h}`;
    const after = (file) => `file://${path.join(AFTER_DIR, PAGES, file)}`;
    const before = (file) => `file://${path.join(BEFORE_DIR, PAGES, file)}`;
    plan.push(
      { name: `r2-banner-before-${size}.png`, url: before(`r2-banner-${size}.html`), w, h, probe: false },
      { name: `r2-banner-after-${size}.png`, url: after(`r2-banner-${size}.html`), w, h, probe: false },
      { name: `r2-drawer-before-${size}.png`, url: before(`r2-drawer-${size}.html`), w, h, probe: true },
      { name: `r2-drawer-after-${size}.png`, url: after(`r2-drawer-${size}.html`), w, h, probe: true },
      { name: `r2-live-before-folded-${size}.png`, url: before(`r2-live-${size}.html`), w, h, probe: true },
      { name: `r2-live-after-folded-${size}.png`, url: after(`r2-live-${size}.html`), w, h, probe: true },
      { name: `r2-live-after-expanded-title-${size}.png`, url: `${after(`r2-live-${size}.html`)}?expand=title`, w, h, probe: true },
      { name: `r2-live-after-expanded-goal-${size}.png`, url: `${after(`r2-live-${size}.html`)}?expand=goal`, w, h, probe: true },
      // 交付物徽章：短标题 + 滚到交付物一节（徽章缺陷与标题长度无关；长标题会把 before 的正文区压成 0 高）
      { name: `r2-live-before-deliverables-${size}.png`, url: `${before(`r2-live-${size}.html`)}?title=short&scroll=deliverables`, w, h, probe: true },
      { name: `r2-live-after-deliverables-${size}.png`, url: `${after(`r2-live-${size}.html`)}?title=short&scroll=deliverables`, w, h, probe: true },
    );
  }
  return plan;
}

/**
 * 页面内探针：把「验收要求看得见的东西」量成 JSON——标题实际行数与 line-clamp、
 * 限高区的 max-height/overflow/client vs scroll、展开与收起按钮数、页脚与关闭按钮是否在视口内。
 */
const PROBE_EXPRESSION = `(() => {
  const root = document.querySelector('.non-draggable');
  const title = document.querySelector('h2');
  const labels = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
  const capped = Array.from(document.querySelectorAll('h2, p'))
    .map((n) => n.parentElement)
    .filter((b, i, l) => b && l.indexOf(b) === i)
    .filter((b) => getComputedStyle(b).maxHeight !== 'none')
    .map((b) => ({
      maxHeight: getComputedStyle(b).maxHeight,
      overflowY: getComputedStyle(b).overflowY,
      clientHeight: b.clientHeight,
      scrollHeight: b.scrollHeight,
      scrollable: b.scrollHeight > b.clientHeight,
    }));
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
  };
  const closeButton = root ? root.querySelector('button[aria-label]') : null;
  const closeRect = rect(closeButton);
  // 抽屉根的结构固定为 [遮罩, 面板]；面板结构为 [header, body, footer]——
  // 页脚 = 根的最后一个子元素的最后一个子元素（量错了就会把「面板可见」当成「页脚可见」）。
  const panel = root ? root.lastElementChild : null;
  const footerRect = rect(panel ? panel.lastElementChild : null);
  const titleStyle = title ? getComputedStyle(title) : null;
  const lineHeight = titleStyle ? parseFloat(titleStyle.lineHeight) : null;
  return {
    viewport: [window.innerWidth, window.innerHeight],
    drawer: rect(root),
    title: title ? {
      textLength: title.textContent.length,
      clientHeight: title.clientHeight,
      lineHeight,
      lines: lineHeight ? Math.round(title.clientHeight / lineHeight) : null,
      webkitLineClamp: titleStyle.webkitLineClamp,
      display: titleStyle.display,
    } : null,
    expandButtons: labels.filter((t) => t === '展开全文').length,
    collapseButtons: labels.filter((t) => t === '收起').length,
    capped,
    /** 交付物行：徽章文案 + 实际渲染色（徽章按 kind 分色是本轮验收点之一）。 */
    deliverables: (() => {
      const section = Array.from(document.querySelectorAll('section')).find((n) =>
        (n.querySelector('h3')?.textContent ?? '').includes('交付物'));
      if (!section) return null;
      return Array.from(section.querySelectorAll('li')).map((li) => {
        const badge = li.querySelector('span');
        const badgeStyle = badge ? getComputedStyle(badge) : null;
        const link = li.querySelector('a');
        return {
          badgeText: badge ? badge.textContent.trim() : null,
          badgeColor: badgeStyle ? badgeStyle.color : null,
          badgeBorderColor: badgeStyle ? badgeStyle.borderColor : null,
          linkText: link ? (link.textContent.trim().slice(0, 12)) : null,
          linkColor: link ? getComputedStyle(link).color : null,
        };
      });
    })(),
    closeButtonBottomVisible: closeRect ? closeRect.bottom <= window.innerHeight : null,
    footerBottomVisible: footerRect ? footerRect.bottom <= window.innerHeight : null,
    // 「收口」按钮本体也量一次：仅页脚容器可见、按钮被裁掉不算通过。
    closeCardButtonBottomVisible: (() => {
      const button = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '收口');
      if (!button) return null;
      return button.getBoundingClientRect().bottom <= window.innerHeight;
    })(),
    footerRect,
    closeRect,
  };
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchChrome(port) {
  const profile = fs.mkdtempSync(path.join('/tmp', 'r2-cdp-'));
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return { child, wsUrl: page.webSocketDebuggerUrl };
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(200);
  }
  child.kill();
  throw new Error('Chrome CDP endpoint 未就绪');
}

async function main() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const { child, wsUrl } = await launchChrome(port);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  const probeResults = {};
  const plan = buildPlan();

  for (const page of plan) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: page.w,
      height: page.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.navigate', { url: page.url });
    await sleep(900); // 等 React 挂载 + live 页的 60ms 点击 / 400ms 量测
    if (page.probe) {
      const probe = await send('Runtime.evaluate', { expression: PROBE_EXPRESSION, returnByValue: true });
      probeResults[page.name] = probe.result?.result?.value ?? { error: probe.result?.exceptionDetails?.text };
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT_DIR, page.name), Buffer.from(shot.result.data, 'base64'));
    console.log('shot', page.name, `${page.w}x${page.h}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, '..', 'probe.json'), `${JSON.stringify(probeResults, null, 2)}\n`);
  console.log('probe.json →', path.resolve(OUT_DIR, '..', 'probe.json'));
  ws.close();
  child.kill();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
