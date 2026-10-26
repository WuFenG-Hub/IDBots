// Twin 亲自做的真浏览器端到端验证（硬门一「陌生人打开链接能用」）
// 目标：Playwright 打开公网 staging → 走完登录 → 发一句话 → 收到回复
import { chromium } from '/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/dsh-runtime/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://staging.idbots.world';
const PHONE = '13900000000';
const CODE = '246810';
const INVITE = process.argv[2];
const OUT = '/Users/tusm/idbots/project/bots/1/2026-10-24/twin-hg1/browser';
mkdirSync(OUT, { recursive: true });

const log = [];
function rec(step, data) {
  const row = { at: new Date().toISOString(), step, ...data };
  log.push(row);
  console.log(`[${step}] ${JSON.stringify(data).slice(0, 300)}`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },   // iPhone 14 尺寸
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  locale: 'zh-CN',
});
const page = await ctx.newPage();

const wsFrames = [];
page.on('websocket', (ws) => {
  rec('ws:open', { url: ws.url() });
  ws.on('framesent', (f) => wsFrames.push({ dir: 'sent', payload: String(f.payload).slice(0, 300) }));
  ws.on('framereceived', (f) => wsFrames.push({ dir: 'recv', payload: String(f.payload).slice(0, 300) }));
  ws.on('close', () => rec('ws:close', {}));
});
page.on('console', (m) => { if (m.type() === 'error') rec('console:error', { text: m.text().slice(0, 200) }); });
page.on('pageerror', (e) => rec('pageerror', { text: String(e).slice(0, 200) }));

// 1. 打开首页
const t0 = Date.now();
const resp = await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
rec('goto', { status: resp?.status(), ms: Date.now() - t0, url: page.url() });
await page.screenshot({ path: `${OUT}/01-landing.png`, fullPage: true });

// 页面纯文本，用于判断是否渲染出登录界面
const bodyText = await page.evaluate(() => document.body.innerText);
rec('body-text', { preview: bodyText.slice(0, 400), len: bodyText.length });

// 2. 填手机号
const phoneInput = page.locator('input[type="tel"], input[inputmode="tel"], input[placeholder*="手机"], input[placeholder*="phone" i]').first();
const phoneCount = await phoneInput.count();
rec('phone-input', { found: phoneCount });
if (phoneCount === 0) {
  await page.screenshot({ path: `${OUT}/02-no-phone-input.png`, fullPage: true });
  writeFileSync(`${OUT}/session.json`, JSON.stringify({ log, wsFrames }, null, 2));
  console.log('STOP: 找不到手机号输入框，页面未渲染出登录表单');
  await browser.close();
  process.exit(2);
}
await phoneInput.fill(PHONE);
rec('phone-filled', { value: PHONE });

// 3. 同意条款（如有）
for (const label of ['同意', 'agree', '我已阅读']) {
  const cb = page.getByText(label, { exact: false }).first();
  if (await cb.count()) { try { await cb.click({ timeout: 1500 }); rec('consent-click', { label }); } catch {} }
}
await page.screenshot({ path: `${OUT}/03-filled.png`, fullPage: true });
writeFileSync(`${OUT}/session.json`, JSON.stringify({ log, wsFrames }, null, 2));
await browser.close();
console.log('阶段完成：登录页渲染与填表可用');
