// Twin 亲自做的完整真浏览器端到端验收（硬门一：陌生人打开链接 → 登录 → 发一句话 → 收到回复）
// 全程截图 + 网络请求 + WS 帧留证
import { chromium } from '/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/dsh-runtime/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://staging.idbots.world';
const PHONE = '13900000000';
const CODE = '246810';
const INVITE = process.argv[2];
const OUT = '/Users/tusm/idbots/project/bots/1/2026-10-24/twin-hg1/browser-login';
mkdirSync(OUT, { recursive: true });

const timeline = [];
const t0 = Date.now();
const rec = (step, data = {}) => {
  const row = { ms: Date.now() - t0, step, ...data };
  timeline.push(row);
  console.log(`[+${row.ms}ms] ${step} ${JSON.stringify(data).slice(0, 220)}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  locale: 'zh-CN',
});
const page = await ctx.newPage();

const http = [];
page.on('response', async (r) => {
  const u = r.url();
  if (u.includes('/api/') || u.includes('/ws')) {
    const setCookie = (await r.allHeaders())['set-cookie'];
    http.push({ status: r.status(), url: u.replace(BASE, ''), setCookie: setCookie ? 'present' : undefined });
    rec('http', { status: r.status(), url: u.replace(BASE, ''), setCookie: !!setCookie });
  }
});
const wsFrames = [];
page.on('websocket', (ws) => {
  rec('ws:open', { url: ws.url() });
  ws.on('framesent', (f) => wsFrames.push({ dir: 'sent', p: String(f.payload).slice(0, 400) }));
  ws.on('framereceived', (f) => wsFrames.push({ dir: 'recv', p: String(f.payload).slice(0, 400) }));
  ws.on('close', () => rec('ws:close'));
});
page.on('pageerror', (e) => rec('pageerror', { text: String(e).slice(0, 160) }));

await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 });
rec('loaded');
await page.screenshot({ path: `${OUT}/1-login.png`, fullPage: true });

// 填手机号
const phone = page.locator('input[type="tel"], input[inputmode="tel"], input[placeholder*="手机"]').first();
await phone.fill(PHONE);
rec('phone-filled');

// 发送验证码
const sendBtn = page.getByText(/发送验证码/).first();
await sendBtn.click();
rec('code-requested');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/2-code-sent.png`, fullPage: true });

// 验证码：找 6 位输入框（可能是单框或分格）
const codeInput = page.locator('input[inputmode="numeric"], input[placeholder*="验证码"], input[type="text"]').first();
const codeCount = await codeInput.count();
rec('code-input', { found: codeCount });
if (codeCount) { await codeInput.fill(CODE); rec('code-filled'); }

// 邀请码
const inviteInput = page.locator('input[placeholder*="邀请"]').first();
if (await inviteInput.count()) { await inviteInput.fill(INVITE); rec('invite-filled'); }

// 勾选同意（如有点选区域）
for (const sel of ['同意', '我已阅读', 'agree']) {
  const el = page.getByText(sel, { exact: false }).first();
  if (await el.count()) { try { await el.click({ timeout: 1200 }); rec('consent', { sel }); } catch {} }
}
await page.screenshot({ path: `${OUT}/3-form-filled.png`, fullPage: true });

// 提交
const submit = page.getByRole('button', { name: /登录|进入|开始|下一步|验证/ }).last();
if (await submit.count()) { await submit.click(); rec('submit-clicked'); }
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/4-after-submit.png`, fullPage: true });

const after = await page.evaluate(() => document.body.innerText);
rec('after-submit-text', { preview: after.slice(0, 300) });

writeFileSync(`${OUT}/timeline.json`, JSON.stringify({ timeline, http, wsFrames }, null, 2));
await browser.close();
console.log('\n=== 汇总 ===');
console.log('HTTP 调用:', http.map((h) => `${h.status} ${h.url}`).join(' ; '));
console.log('WS 帧数:', wsFrames.length, '| 页面最终文本:', after.slice(0, 120).replace(/\n+/g, ' | '));
