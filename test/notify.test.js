import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Alerting reads ALERT_COOLDOWN_MS at module load, so env is configured before a
// dynamic import. A local mock server stands in for the Slack webhook and captures
// every posted message — no real Slack, no network.
let received = [];
let server;
let alertSource;
let clearSourceAlert;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rateLimit = () => Object.assign(new Error("429 Too Many Requests"), { status: 429 });
const serverErr = () => Object.assign(new Error("500 Internal Server Error"), { status: 500 });

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { received.push(JSON.parse(body).text); } catch { received.push(body); }
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/hook`;
  process.env.ALERT_COOLDOWN_MS = "200";
  ({ alertSource, clearSourceAlert } = await import("../src/lib/notify.js"));
});

after(() => server?.close());

test("a rate-limit (429) posts a message tagged as rate-limited", async () => {
  const start = received.length;
  alertSource("aviation", "OpenSky Network", rateLimit());
  await wait(80);
  assert.equal(received.length, start + 1);
  assert.match(received.at(-1), /🚫.*`aviation`.*rate-limited.*OpenSky Network/);
});

test("a repeat failure for the same source within the cooldown is suppressed", async () => {
  const start = received.length;
  alertSource("aviation", "OpenSky Network", rateLimit());
  await wait(80);
  assert.equal(received.length, start, "expected no new message within cooldown");
});

test("a non-rate-limit error posts a message tagged as an error", async () => {
  const start = received.length;
  alertSource("telegram", "Telegram public preview", serverErr());
  await wait(80);
  assert.equal(received.length, start + 1);
  assert.match(received.at(-1), /⚠️.*`telegram`.*error.*Telegram public preview/);
});

test("recovery posts a ✅ note and resets the cooldown for that source", async () => {
  const startRecovery = received.length;
  clearSourceAlert("aviation", "OpenSky Network");
  await wait(80);
  assert.equal(received.length, startRecovery + 1);
  assert.match(received.at(-1), /✅.*`aviation`.*recovered/);

  // Cooldown was reset by recovery, so the next failure alerts immediately.
  const startRealert = received.length;
  alertSource("aviation", "OpenSky Network", rateLimit());
  await wait(80);
  assert.equal(received.length, startRealert + 1);
});

test("rate-limit is detected from the message when no status is attached", async () => {
  const start = received.length;
  alertSource("space", "NOAA SWPC", new Error("429 Too Many Requests"));
  await wait(80);
  assert.equal(received.length, start + 1);
  assert.match(received.at(-1), /🚫.*rate-limited/);
});

test("ALERT_RATE_LIMIT_ONLY suppresses non-rate-limit errors but still alerts on 429/403", async () => {
  process.env.ALERT_RATE_LIMIT_ONLY = "true";
  try {
    // A plain 5xx is suppressed and does NOT consume the cooldown window...
    let start = received.length;
    alertSource("filtered", "Some Source", serverErr());
    await wait(80);
    assert.equal(received.length, start, "non-rate-limit error is suppressed");

    // ...so a rate-limit for the same source immediately after still fires.
    start = received.length;
    alertSource("filtered", "Some Source", rateLimit());
    await wait(80);
    assert.equal(received.length, start + 1, "rate-limit still alerts under the filter");
    assert.match(received.at(-1), /🚫.*rate-limited/);
  } finally {
    delete process.env.ALERT_RATE_LIMIT_ONLY;
  }
});

test("with no webhook configured, alerting is a silent no-op", async () => {
  const saved = process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK_URL;
  const start = received.length;
  alertSource("unconfigured", "Src", rateLimit());
  await wait(80);
  assert.equal(received.length, start, "no message should be posted without a webhook URL");
  process.env.SLACK_WEBHOOK_URL = saved;
});
