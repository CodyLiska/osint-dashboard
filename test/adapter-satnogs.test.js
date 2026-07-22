import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { satnogsLayer } from "../src/adapters/satnogs.js";

const stations = [
  { id: 26, name: "SV1IYO/A", lat: 38.395, lng: 21.828, qthlocator: "KM08vj", status: "Online", antenna: [{ band: "VHF" }, { band: "UHF" }], last_seen: "2026-07-21T00:00:00Z" },
  { id: 99, name: "OFFLINE-1", lat: 50.75, lng: 6.22, status: "Offline", antenna: [] },
  { id: 5, name: "NO-COORDS", lat: null, lng: null, status: "Online" }
];

test("satnogsLayer normalizes stations, drops coordinate-less ones, and ranks online higher", async () => {
  const restore = installJsonFetch(stations);
  try {
    const { entities, meta } = await satnogsLayer();
    assert.equal(entities.length, 2, "the station with null coords is dropped");
    assert.ok(entities.every((e) => e.layer === "satnogs"));
    const online = entities.find((e) => e.name === "SV1IYO/A");
    const offline = entities.find((e) => e.name === "OFFLINE-1");
    assert.equal(online.lon, 21.828, "lng maps to lon");
    assert.ok(online.severity > offline.severity, "online stations outrank offline on severity");
    assert.match(online.summary, /2 antenna/);
    assert.match(meta.source, /SatNOGS/);
  } finally {
    restore();
  }
});

test("a non-array response degrades to an empty layer", async () => {
  const restore = installJsonFetch({ detail: "Not found" });
  try {
    const { entities } = await satnogsLayer();
    assert.deepEqual(entities, []);
  } finally {
    restore();
  }
});
