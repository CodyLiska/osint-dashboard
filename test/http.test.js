import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchJson, fetchText, fetchJsonRetry } from "../src/lib/http.js";

// Spin up a local origin so these tests never touch the network.
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    } else if (req.url === "/ratelimited") {
      res.writeHead(429, "Too Many Requests");
      res.end("slow down");
    } else {
      res.writeHead(500, "Internal Server Error");
      res.end("nope");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("fetchJson returns parsed JSON on 200", async () => {
  const server = await startServer();
  const { port } = server.address();
  try {
    const body = await fetchJson(`http://127.0.0.1:${port}/ok`);
    assert.deepEqual(body, { hello: "world" });
  } finally {
    server.close();
  }
});

test("fetchJson throws an error carrying the HTTP status on 429", async () => {
  const server = await startServer();
  const { port } = server.address();
  try {
    await assert.rejects(fetchJson(`http://127.0.0.1:${port}/ratelimited`), (err) => {
      assert.equal(err.status, 429, "error.status should be 429 for alert detection");
      assert.match(err.message, /429/);
      return true;
    });
  } finally {
    server.close();
  }
});

test("fetchText throws an error carrying the HTTP status on 500", async () => {
  const server = await startServer();
  const { port } = server.address();
  try {
    await assert.rejects(fetchText(`http://127.0.0.1:${port}/boom`), (err) => {
      assert.equal(err.status, 500);
      return true;
    });
  } finally {
    server.close();
  }
});

test("fetchJsonRetry retries a transient 503 then succeeds", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("busy", { status: 503, statusText: "Service Unavailable" });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const body = await fetchJsonRetry("http://origin/data");
    assert.equal(calls, 2);
    assert.deepEqual(body, { ok: true });
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchJsonRetry does not retry a 4xx client error", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("bad", { status: 400, statusText: "Bad Request" }); };
  try {
    await assert.rejects(fetchJsonRetry("http://origin/data"), (err) => { assert.equal(err.status, 400); return true; });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
