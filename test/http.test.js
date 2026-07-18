import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchJson, fetchText } from "../src/lib/http.js";

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
