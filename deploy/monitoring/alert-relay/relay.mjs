#!/usr/bin/env node
// WS-C C4 / REQ-C-16 — Alertmanager -> Feishu/DingTalk robot relay.
// Dependency-free (Node >= 24). Receives an Alertmanager v4 webhook on
// POST /alert, formats one compact text message, and delivers it to the
// robot webhook from ALERT_WEBHOOK_URL (auto-detects feishu vs dingtalk,
// optional 加签 via ALERT_SECRET).
//
// Env:
//   ALERT_PORT          listen port (default 9080)
//   ALERT_WEBHOOK_URL   robot webhook (required)
//   ALERT_TARGET        feishu | dingtalk | auto (default auto, from the URL)
//   ALERT_SECRET        robot signing secret (optional)
//   ALERT_KEYWORD       message prefix, also usable as the robot keyword
//                       (default "[IDBots]")

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.ALERT_PORT || 9080);
const WEBHOOK = process.env.ALERT_WEBHOOK_URL || '';
const TARGET = process.env.ALERT_TARGET || 'auto';
const SECRET = process.env.ALERT_SECRET || '';
const KEYWORD = process.env.ALERT_KEYWORD || '[IDBots]';

function log(level, msg, extra) {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(), level, component: 'alert-relay', msg, ...extra,
  }) + '\n');
}

function target() {
  if (TARGET !== 'auto') return TARGET;
  if (WEBHOOK.includes('oapi.dingtalk.com')) return 'dingtalk';
  return 'feishu';
}

// Feishu 加签: HmacSHA256(key = `${ts}\n${secret}`, data = "") base64; ts in seconds.
function feishuSign() {
  if (!SECRET) return {};
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHmac('sha256', `${ts}\n${SECRET}`).digest('base64');
  return { timestamp: ts, sign };
}

// DingTalk 加签: sign = urlenc(base64(HmacSHA256(`${ts}\n${secret}`, `${ts}\n${secret}`))); ts in ms.
function dingtalkUrl() {
  if (!SECRET) return WEBHOOK;
  const ts = String(Date.now());
  const stringToSign = `${ts}\n${SECRET}`;
  const sign = encodeURIComponent(
    crypto.createHmac('sha256', SECRET).update(stringToSign).digest('base64'),
  );
  const sep = WEBHOOK.includes('?') ? '&' : '?';
  return `${WEBHOOK}${sep}timestamp=${ts}&sign=${sign}`;
}

function formatAlerts(body) {
  const lines = [];
  for (const a of body.alerts || []) {
    const status = (a.status || '').toUpperCase();
    const name = a.labels?.alertname || 'unknown';
    const sev = a.labels?.severity || '-';
    const instance = a.labels?.instance || a.labels?.name || '';
    const summary = a.annotations?.summary || a.annotations?.description || '';
    const at = a.startsAt ? new Date(a.startsAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
    lines.push(`${status} [${sev}] ${name}${instance ? ` (${instance})` : ''}\n${summary}${at ? `\n${at} +08:00` : ''}`);
  }
  return `${KEYWORD} ${body.status === 'resolved' ? 'RESOLVED' : 'ALERT'}\n${lines.join('\n---\n')}`;
}

async function deliver(text) {
  const kind = target();
  const payload = kind === 'dingtalk'
    ? { msgtype: 'text', text: { content: text } }
    : { msg_type: 'text', content: { text }, ...feishuSign() };
  const url = kind === 'dingtalk' ? dingtalkUrl() : WEBHOOK;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`webhook ${res.status}: ${body.slice(0, 200)}`);
      log('info', 'delivered', { target: kind, attempt, response: body.slice(0, 120) });
      return;
    } catch (err) {
      lastErr = err;
      log('warn', 'delivery failed', { target: kind, attempt, error: String(err) });
    }
  }
  throw lastErr;
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, target: target(), webhookConfigured: Boolean(WEBHOOK) }));
  }
  if (req.method === 'POST' && req.url === '/alert') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); } catch {
        res.writeHead(400); return res.end('bad json');
      }
      if (!WEBHOOK) {
        log('error', 'ALERT_WEBHOOK_URL is not configured — dropping alert');
        res.writeHead(500); return res.end('webhook not configured');
      }
      const text = formatAlerts(body);
      log('info', 'relaying alert group', { status: body.status, count: (body.alerts || []).length });
      try {
        await deliver(text);
        res.writeHead(200); res.end('ok');
      } catch {
        res.writeHead(502); res.end('delivery failed');
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', `alert-relay listening on :${PORT}`, { target: target(), webhookConfigured: Boolean(WEBHOOK), signed: Boolean(SECRET) });
});
