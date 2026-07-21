import { matchRule } from "./alert-rules.js";
import { firedSince, recordFired } from "./persist.js";
import { postAlert } from "./notify.js";

// The alert engine: turns a reconcile classification into notifications.
//
// Deliberately split so the decisions are testable without a webhook or a
// server: selectAlerts() decides WHAT should fire against an explicit db handle,
// formatAlert() decides how it reads, and evaluateAlerts() is the thin impure
// wrapper that sends. See docs/PLAN-alert-rules.md.

// A pathologically broad rule degrades to a summary line rather than emptying
// itself into the channel.
const MAX_PER_HOUR = () => Number(process.env.OSIRIS_ALERT_MAX_PER_HOUR) || 20;

// Dry run evaluates and reports but records nothing and sends nothing, so a rule
// can be tuned against live data without paging anyone. This is also the only
// way to find out that a rule is silently inert — a threshold above a layer's
// constant severity validates fine and then never matches anything.
const isDryRun = () => process.env.OSIRIS_ALERT_DRY_RUN === "1";

// Closed events do not notify: the triggers are appear and escalate. Kept in the
// classification because the Alerts panel and any future "went dark" rule want it.
const NOTIFIABLE = new Set(["appeared", "escalated"]);

// An escalation fires only when the rule's threshold is CROSSED upward. Without
// this, any severity bump on an already-qualifying entity would re-alert: an
// M4.1 becoming M4.2 is not an event, an M4 becoming M6 is.
function crossedThreshold(change, rule) {
  if (change.reason !== "escalated") return true;
  const previous = Number(change.previousSeverity);
  const current = Number(change.entity?.severity);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return false;
  return previous < rule.minSeverity && current >= rule.minSeverity;
}

// Decide what should fire. Takes an explicit handle so it is unit-testable on an
// in-memory db, the same way reconcile() is. Returns one group per rule that has
// something to say:
//   { rule, items: [change], suppressed: n, alreadyFired: n }
export function selectAlerts(handle, layer, changes, rules, { now = new Date().toISOString(), dryRun = isDryRun() } = {}) {
  const groups = [];
  const hourAgo = new Date(Date.parse(now) - 3_600_000).toISOString();

  for (const rule of rules || []) {
    if (!rule.enabled) continue;

    const candidates = (changes || []).filter((change) =>
      NOTIFIABLE.has(change.reason)
      && matchRule(rule, change.entity)
      && crossedThreshold(change, rule));
    if (!candidates.length) continue;

    // Budget left in this rule's hourly allowance.
    const budget = Math.max(0, MAX_PER_HOUR() - firedSince(handle, rule.id, hourAgo));

    const items = [];
    let alreadyFired = 0;
    let suppressed = 0;
    for (const change of candidates) {
      const entityId = String(change.entity.id);
      if (items.length >= budget) {
        suppressed += 1;
        continue;
      }
      if (dryRun) {
        // Nothing is written, so a preview can be run repeatedly and always
        // shows the same picture.
        items.push(change);
        continue;
      }
      // The INSERT is the dedupe: false means this rule already fired for this
      // entity and reason, so there is no check-then-write gap.
      const isNew = recordFired(handle, {
        ruleId: rule.id,
        layer,
        entityId,
        reason: change.reason,
        firedAt: now,
        severity: change.entity.severity,
        name: change.entity.name,
        payload: JSON.stringify(change.entity)
      });
      if (isNew) items.push(change);
      else alreadyFired += 1;
    }

    if (items.length || suppressed) groups.push({ rule, items, suppressed, alreadyFired });
  }

  return groups;
}

function describe(change) {
  const e = change.entity;
  const where = [e.country, Number.isFinite(e.lat) && Number.isFinite(e.lon)
    ? `${Number(e.lat).toFixed(2)}, ${Number(e.lon).toFixed(2)}`
    : null].filter(Boolean).join(" · ");
  // Some layers carry a fractional severity (seismic is a raw magnitude), so
  // trim it for display rather than printing "severity 2.7200000000000002".
  const grade = (value) => (Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : "?");
  const severity = change.reason === "escalated"
    ? `severity ${grade(change.previousSeverity)} → ${grade(e.severity)}`
    : `severity ${grade(e.severity)}`;
  return `• ${e.name || e.id} (${severity}${where ? ` · ${where}` : ""})`;
}

// One message per rule listing its matches — never one per entity. A seismic
// swarm or a GDELT burst arrives all at once, so per-entity messages are the
// single biggest source of alert noise.
export function formatAlert(group, layer, { dryRun = false } = {}) {
  const { rule, items, suppressed } = group;
  const prefix = dryRun ? "🧪 [dry run] " : "🔔 ";
  const count = items.length;
  const header = `${prefix}OSIRIS rule \`${rule.id}\` — ${count} match${count === 1 ? "" : "es"} on \`${layer}\``;
  const lines = items.slice(0, 10).map(describe);
  if (items.length > 10) lines.push(`• …and ${items.length - 10} more`);
  if (suppressed) {
    lines.push(`• ${suppressed} further match${suppressed === 1 ? "" : "es"} suppressed (rule hit its hourly cap of ${MAX_PER_HOUR()})`);
  }
  return [header, ...lines].join("\n");
}

// Impure wrapper: decide, then send. Never throws — an alerting failure must not
// affect the layer response it is fired from.
export async function evaluateAlerts(handle, layer, classification, rules, options = {}) {
  if (!handle || !rules?.length) return [];
  // A seed batch is stored but never alerted on; without this, enabling the
  // store would page the operator with the entire current feed.
  if (classification?.seeded) return [];

  const dryRun = options.dryRun ?? isDryRun();
  const groups = selectAlerts(handle, layer, classification?.changes, rules, { ...options, dryRun });

  // With no webhook configured the log IS the delivery channel, not a silent
  // drop. This matters because a real (non-dry) evaluation consumes the dedupe:
  // if the message went nowhere and was never printed, those events could never
  // alert again once a webhook was added.
  const hasWebhook = Boolean(process.env.SLACK_WEBHOOK_URL);
  for (const group of groups) {
    const text = formatAlert(group, layer, { dryRun });
    if (dryRun || !hasWebhook) console.log(`[alerts] ${text}`);
    else await postAlert(text);
  }
  return groups;
}
