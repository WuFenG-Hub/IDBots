import type { ControlPlaneConfig } from './config.js';

/**
 * Operator alerts (provisioning/upgrade failures, empty redeem pool,
 * unknown containers). Posts a Feishu/DingTalk text message to
 * CP_ALERT_WEBHOOK; a no-op when no webhook is configured. Never throws —
 * alert delivery must not break the operation that triggered it.
 */
export async function sendAlert(config: ControlPlaneConfig, text: string): Promise<void> {
  const webhook = config.alertWebhook;
  if (!webhook) {
    return;
  }
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(JSON.stringify({ msg: 'alert webhook answered non-2xx', status: res.status }));
    }
  } catch (err) {
    console.warn(
      JSON.stringify({ msg: 'alert delivery failed', error: err instanceof Error ? err.message : String(err) }),
    );
  }
}
