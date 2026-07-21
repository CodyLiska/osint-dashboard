import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applySchema, firedSince, hasFired } from "../src/lib/persist.js";
import { evaluateAlerts, formatAlert, selectAlerts } from "../src/lib/alerts.js";
import { parseRules } from "../src/lib/alert-rules.js";

const NOW = "2026-07-20T12:00:00.000Z";
const db = () => applySchema(new DatabaseSync(":memory:"));
const rulesOf = (...raw) => {
  const { rules, errors } = parseRules(raw);
  assert.deepEqual(errors, [], "test rules must be valid");
  return rules;
};

const quake = (over = {}) => ({
  id: "q1", layer: "seismic", name: "M5.2 near Hualien", severity: 4, lat: 23.9, lon: 121.5, ...over
});
const appeared = (entity) => ({ reason: "appeared", entity });
const escalated = (entity, previousSeverity) => ({ reason: "escalated", entity, previousSeverity });
const select = (handle, changes, rules, opts = {}) =>
  selectAlerts(handle, "seismic", changes, rules, { now: NOW, ...opts });

// ---- what fires -------------------------------------------------------------

test("a matching new entity fires its rule", () => {
  const handle = db();
  const groups = select(handle, [appeared(quake())], rulesOf({ id: "major", minSeverity: 4 }));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rule.id, "major");
  assert.equal(groups[0].items.length, 1);
});

test("a closed entity never notifies", () => {
  // The chosen triggers are appear and escalate. Closed stays in the
  // classification for the Alerts panel but must not page anyone.
  const handle = db();
  const groups = select(handle, [{ reason: "closed", entity: quake() }], rulesOf({ id: "any", minSeverity: 1 }));
  assert.deepEqual(groups, []);
});

test("a seeded batch never notifies", () => {
  // Enabling the store must not page the operator with the entire current feed.
  const handle = db();
  const rules = rulesOf({ id: "any", minSeverity: 1 });
  const sent = [];
  return evaluateAlerts(handle, "seismic", { seeded: true, changes: [appeared(quake())] }, rules, { now: NOW, dryRun: true })
    .then((groups) => {
      assert.deepEqual(groups, []);
      assert.deepEqual(sent, []);
    });
});

test("an entity that does not match the rule does not fire it", () => {
  const handle = db();
  const groups = select(handle, [appeared(quake({ severity: 2 }))], rulesOf({ id: "major", minSeverity: 4 }));
  assert.deepEqual(groups, []);
});

// ---- escalation semantics ---------------------------------------------------

test("escalation fires only when the rule threshold is crossed upward", () => {
  // Without the crossing test, any bump on an already-qualifying entity
  // re-alerts: M4.1 to M4.2 is not an event, M4 to M6 is.
  const handle = db();
  const rules = rulesOf({ id: "major", minSeverity: 4 });

  const crossed = select(handle, [escalated(quake({ id: "a", severity: 5 }), 2)], rules);
  assert.equal(crossed.length, 1, "2 -> 5 crosses a threshold of 4");

  const within = select(handle, [escalated(quake({ id: "b", severity: 5 }), 4)], rules);
  assert.deepEqual(within, [], "4 -> 5 was already above the threshold");
});

test("an escalation with unusable severities does not fire", () => {
  const handle = db();
  const rules = rulesOf({ id: "major", minSeverity: 4 });
  assert.deepEqual(select(handle, [escalated(quake({ severity: null }), 1)], rules), []);
});

// ---- dedupe -----------------------------------------------------------------

test("an entity alerts once per rule, even across repeated evaluations", () => {
  // This is what the store buys: dedupe that survives restarts, so a
  // long-running event does not re-alert on every poll.
  const handle = db();
  const rules = rulesOf({ id: "major", minSeverity: 4 });
  const changes = [appeared(quake())];

  assert.equal(select(handle, changes, rules)[0].items.length, 1);
  const second = select(handle, changes, rules);
  assert.deepEqual(second, [], "the repeat has nothing new to say");
  assert.equal(hasFired(handle, "major", "seismic", "q1", "appeared"), true);
});

test("the same entity can fire separately for appearing and for escalating", () => {
  const handle = db();
  const rules = rulesOf({ id: "major", minSeverity: 4 });
  assert.equal(select(handle, [appeared(quake())], rules)[0].items.length, 1);
  assert.equal(select(handle, [escalated(quake({ severity: 5 }), 2)], rules)[0].items.length, 1);
});

test("two rules matching the same entity both fire", () => {
  const handle = db();
  const rules = rulesOf(
    { id: "major", minSeverity: 4 },
    { id: "taiwan", layers: ["seismic"], geofence: { type: "bbox", west: 118, south: 21.5, east: 123, north: 26.5 } }
  );
  const groups = select(handle, [appeared(quake())], rules);
  assert.deepEqual(groups.map((g) => g.rule.id).sort(), ["major", "taiwan"]);
});

// ---- flood guard ------------------------------------------------------------

test("a rule that exceeds its hourly cap degrades to a summary instead of flooding", () => {
  const previous = process.env.OSIRIS_ALERT_MAX_PER_HOUR;
  process.env.OSIRIS_ALERT_MAX_PER_HOUR = "3";
  try {
    const handle = db();
    const rules = rulesOf({ id: "swarm", minSeverity: 1 });
    const changes = Array.from({ length: 10 }, (_, i) => appeared(quake({ id: `q${i}` })));

    const [group] = select(handle, changes, rules);
    assert.equal(group.items.length, 3, "capped at the hourly allowance");
    assert.equal(group.suppressed, 7);
    assert.match(formatAlert(group, "seismic"), /7 further matches suppressed/);
  } finally {
    if (previous === undefined) delete process.env.OSIRIS_ALERT_MAX_PER_HOUR;
    else process.env.OSIRIS_ALERT_MAX_PER_HOUR = previous;
  }
});

test("the cap is per rule, not global", () => {
  const previous = process.env.OSIRIS_ALERT_MAX_PER_HOUR;
  process.env.OSIRIS_ALERT_MAX_PER_HOUR = "1";
  try {
    const handle = db();
    const rules = rulesOf({ id: "a", minSeverity: 1 }, { id: "b", minSeverity: 1 });
    const groups = select(handle, [appeared(quake())], rules);
    assert.equal(groups.length, 2, "one rule exhausting its budget must not mute another");
    assert.ok(groups.every((g) => g.items.length === 1));
  } finally {
    if (previous === undefined) delete process.env.OSIRIS_ALERT_MAX_PER_HOUR;
    else process.env.OSIRIS_ALERT_MAX_PER_HOUR = previous;
  }
});

// ---- dry run ----------------------------------------------------------------

test("a dry run reports matches without recording or consuming the budget", () => {
  // Dry run is how a rule gets tuned against live data, and the only way to
  // discover that a rule is silently inert. Repeating it must give the same
  // answer every time.
  const handle = db();
  const rules = rulesOf({ id: "major", minSeverity: 4 });
  const changes = [appeared(quake())];

  const first = select(handle, changes, rules, { dryRun: true });
  const second = select(handle, changes, rules, { dryRun: true });
  assert.equal(first[0].items.length, 1);
  assert.equal(second[0].items.length, 1, "a preview is repeatable");
  assert.equal(firedSince(handle, "major", "1970-01-01T00:00:00.000Z"), 0, "nothing was recorded");
  assert.equal(hasFired(handle, "major", "seismic", "q1", "appeared"), false);
});

test("a dry run sends nothing", async () => {
  const handle = db();
  const originalFetch = globalThis.fetch;
  const previousHook = process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_WEBHOOK_URL = "https://hooks.example.invalid/x";
  let posted = 0;
  globalThis.fetch = async () => { posted += 1; return new Response("ok"); };
  try {
    await evaluateAlerts(handle, "seismic", { seeded: false, changes: [appeared(quake())] },
      rulesOf({ id: "major", minSeverity: 4 }), { now: NOW, dryRun: true });
    assert.equal(posted, 0, "dry run must not reach the webhook");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHook === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = previousHook;
  }
});

// ---- delivery ---------------------------------------------------------------

test("one message is sent per rule, not per entity", async () => {
  // A swarm arriving at once is the single biggest source of alert noise.
  const handle = db();
  const originalFetch = globalThis.fetch;
  const previousHook = process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_WEBHOOK_URL = "https://hooks.example.invalid/x";
  const bodies = [];
  globalThis.fetch = async (_url, opts) => { bodies.push(JSON.parse(opts.body).text); return new Response("ok"); };
  try {
    const changes = Array.from({ length: 5 }, (_, i) => appeared(quake({ id: `q${i}` })));
    await evaluateAlerts(handle, "seismic", { seeded: false, changes },
      rulesOf({ id: "major", minSeverity: 4 }), { now: NOW, dryRun: false });
    assert.equal(bodies.length, 1, "five matches, one message");
    assert.match(bodies[0], /5 matches/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHook === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = previousHook;
  }
});

test("a Slack outage never surfaces to the caller", async () => {
  // Alerting rides the layer-response path; it must not be able to break it.
  const handle = db();
  const originalFetch = globalThis.fetch;
  const previousHook = process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_WEBHOOK_URL = "https://hooks.example.invalid/x";
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    await evaluateAlerts(handle, "seismic", { seeded: false, changes: [appeared(quake())] },
      rulesOf({ id: "major", minSeverity: 4 }), { now: NOW, dryRun: false });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHook === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = previousHook;
  }
});

test("an escalation message shows the severity transition", () => {
  const group = {
    rule: { id: "major" },
    items: [escalated(quake({ severity: 5 }), 2)],
    suppressed: 0
  };
  assert.match(formatAlert(group, "seismic"), /severity 2 → 5/);
});

test("a long match list is truncated in the message", () => {
  const group = {
    rule: { id: "swarm" },
    items: Array.from({ length: 25 }, (_, i) => appeared(quake({ id: `q${i}` }))),
    suppressed: 0
  };
  const text = formatAlert(group, "seismic");
  assert.match(text, /and 15 more/);
  assert.ok(text.split("\n").length <= 12, "the message stays readable");
});

test("no rules means no work", async () => {
  assert.deepEqual(await evaluateAlerts(db(), "seismic", { changes: [appeared(quake())] }, []), []);
  assert.deepEqual(await evaluateAlerts(null, "seismic", { changes: [] }, rulesOf({ id: "a", minSeverity: 1 })), []);
});

test("with no webhook configured the alert is logged, not silently dropped", async () => {
  // A real evaluation consumes the dedupe. If the message went nowhere AND was
  // never printed, those events could never alert again once a webhook was
  // added — the alert would be lost with no trace it ever happened.
  const handle = db();
  const previousHook = process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK_URL;
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(" "));
  try {
    await evaluateAlerts(handle, "seismic", { seeded: false, changes: [appeared(quake())] },
      rulesOf({ id: "major", minSeverity: 4 }), { now: NOW, dryRun: false });
    assert.equal(logged.length, 1, "the alert reached the log");
    assert.match(logged[0], /major/);
    // The dedupe was consumed, which is correct: it was delivered, to the log.
    assert.equal(hasFired(handle, "major", "seismic", "q1", "appeared"), true);
  } finally {
    console.log = originalLog;
    if (previousHook !== undefined) process.env.SLACK_WEBHOOK_URL = previousHook;
  }
});
