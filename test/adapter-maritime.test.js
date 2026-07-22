import test from "node:test";
import assert from "node:assert/strict";
import { maritimeLayer } from "../src/adapters/maritime.js";

// Minimal fake WebSocket standing in for the AISStream stream. Fires 'open' after
// the adapter has attached its listeners (microtask), then on send() delivers the
// canned AIS messages (and optionally an error). Static OPEN/CONNECTING match what
// the adapter reads via the global WebSocket.* constants.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static messages = [];
  static emitError = false;
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this._listeners = {};
    this._closed = false;
    queueMicrotask(() => {
      if (this._closed) return;
      this.readyState = MockWebSocket.OPEN;
      this._emit("open", {});
    });
  }
  addEventListener(type, cb) { (this._listeners[type] ||= []).push(cb); }
  send() {
    queueMicrotask(() => {
      for (const msg of MockWebSocket.messages) this._emit("message", { data: JSON.stringify(msg) });
      if (MockWebSocket.emitError) this._emit("error", {});
    });
  }
  close() { this._closed = true; this.readyState = MockWebSocket.CLOSED; }
  _emit(type, ev) { for (const cb of this._listeners[type] || []) cb(ev); }
}

function aisReport({ mmsi, name, lat, lon, sog, cog }) {
  return {
    MetaData: { MMSI: mmsi, ShipName: name, time_utc: "2026-07-21T00:00:00Z" },
    Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: sog, Cog: cog, TrueHeading: cog } }
  };
}

function withMockSocket(messages, { emitError = false } = {}) {
  const original = globalThis.WebSocket;
  MockWebSocket.messages = messages;
  MockWebSocket.emitError = emitError;
  globalThis.WebSocket = MockWebSocket;
  return () => { globalThis.WebSocket = original; };
}

test("maritimeLayer collects and normalizes AIS position reports over the WebSocket when keyed", async () => {
  const savedKey = process.env.AISSTREAM_API_KEY;
  const savedMax = process.env.AISSTREAM_MAX_ITEMS;
  process.env.AISSTREAM_API_KEY = "test-key";
  process.env.AISSTREAM_MAX_ITEMS = "2"; // resolve as soon as both messages arrive (no timeout wait)
  const restore = withMockSocket([
    aisReport({ mmsi: 111111111, name: "SLOW BOAT", lat: 1.5, lon: 103.8, sog: 12.3, cog: 90 }),
    aisReport({ mmsi: 222222222, name: "FAST BOAT", lat: 2.0, lon: 104.0, sog: 25, cog: 180 })
  ]);
  try {
    const { entities, meta } = await maritimeLayer({ lamin: -10, lomin: 100, lamax: 10, lomax: 110 });
    assert.equal(meta.configured, true);
    assert.equal(meta.source, "AISStream");
    assert.equal(entities.length, 2);
    const slow = entities.find((e) => e.mmsi === 111111111);
    const fast = entities.find((e) => e.mmsi === 222222222);
    assert.equal(slow.name, "SLOW BOAT");
    assert.equal(slow.lat, 1.5);
    assert.equal(slow.severity, 2); // Sog <= 20
    assert.equal(fast.severity, 3); // Sog > 20
    assert.equal(slow.id, "ais-111111111");
  } finally {
    restore();
    if (savedKey === undefined) delete process.env.AISSTREAM_API_KEY; else process.env.AISSTREAM_API_KEY = savedKey;
    if (savedMax === undefined) delete process.env.AISSTREAM_MAX_ITEMS; else process.env.AISSTREAM_MAX_ITEMS = savedMax;
  }
});

test("maritimeLayer rejects when the AIS socket errors", async () => {
  const savedKey = process.env.AISSTREAM_API_KEY;
  process.env.AISSTREAM_API_KEY = "test-key";
  const restore = withMockSocket([], { emitError: true }); // no messages, socket errors
  try {
    await assert.rejects(maritimeLayer(), /AISStream connection failed/);
  } finally {
    restore();
    if (savedKey === undefined) delete process.env.AISSTREAM_API_KEY; else process.env.AISSTREAM_API_KEY = savedKey;
  }
});

test("maritimeLayer surfaces a clear error when the runtime has no WebSocket", async () => {
  const savedKey = process.env.AISSTREAM_API_KEY;
  const savedWs = globalThis.WebSocket;
  process.env.AISSTREAM_API_KEY = "test-key";
  delete globalThis.WebSocket;
  try {
    await assert.rejects(maritimeLayer(), /WebSocket runtime unavailable/);
  } finally {
    globalThis.WebSocket = savedWs;
    if (savedKey === undefined) delete process.env.AISSTREAM_API_KEY; else process.env.AISSTREAM_API_KEY = savedKey;
  }
});

// The keyless fallback — the common case in this LAN homelab deploy — is testable.
test("maritimeLayer serves the static port fallback without an AISStream key", async () => {
  const saved = process.env.AISSTREAM_API_KEY;
  delete process.env.AISSTREAM_API_KEY;
  try {
    const { entities, meta } = await maritimeLayer();
    assert.equal(meta.configured, false);
    assert.equal(meta.source, "Static port directory");
    assert.equal(meta.count, entities.length);
    assert.ok(entities.length >= 30, "a useful set of global ports is returned");
    assert.ok(entities.every((e) => e.layer === "maritime" && Number.isFinite(e.lat) && Number.isFinite(e.lon)));
    assert.ok(entities.some((e) => e.name === "Singapore"));
  } finally {
    if (saved === undefined) delete process.env.AISSTREAM_API_KEY; else process.env.AISSTREAM_API_KEY = saved;
  }
});
