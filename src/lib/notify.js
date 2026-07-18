// Best-effort Slack alerting for upstream source failures. Optional and keyless
// by default: with no SLACK_WEBHOOK_URL set, every call is a silent no-op, so the
// app behaves exactly as before. Alerting must never break a request path, so all
// network work here swallows its own errors.
//
// The single choke point is withHealth() in health.js, which calls alertSource()
// on every failure and clearSourceAlert() on recovery.

const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 15 * 60_000);

// Last alert time per source id. A persistently failing feed (polled on its
// cadence) would otherwise alert on every cycle; the cooldown collapses that to
// one alert per window while it stays down.
const lastAlertAt = new Map();

function isRateLimit(error) {
  return error?.status === 429 || error?.status === 403 || /^(429|403)\b/.test(String(error?.message || ""));
}

async function postToSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
  } catch {
    // Alerting is best-effort — a Slack outage must not surface to the caller.
  }
}

// Alert on an upstream failure. Fires immediately the first time a source fails,
// then at most once per COOLDOWN_MS while it stays down. Rate-limits (429/403)
// are tagged distinctly so IP-level throttling is obvious at a glance.
export function alertSource(id, source, error) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  const now = Date.now();
  if (now - (lastAlertAt.get(id) || 0) < COOLDOWN_MS) return;
  lastAlertAt.set(id, now);

  const rateLimited = isRateLimit(error);
  const icon = rateLimited ? "🚫" : "⚠️"; // 🚫 / ⚠️
  const kind = rateLimited ? "rate-limited" : "error";
  const detail = String(error?.message || error || "unknown");
  postToSlack(`${icon} OSIRIS: \`${id}\` ${kind} — ${source}: ${detail}`);
}

// Called when a previously failing source succeeds again. Sends one recovery
// note and resets the cooldown so the next failure alerts immediately.
export function clearSourceAlert(id, source) {
  if (!lastAlertAt.has(id)) return;
  lastAlertAt.delete(id);
  if (!process.env.SLACK_WEBHOOK_URL) return;
  postToSlack(`✅ OSIRIS: \`${id}\` recovered — ${source}`); // ✅
}
