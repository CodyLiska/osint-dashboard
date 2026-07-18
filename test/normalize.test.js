import test from "node:test";
import assert from "node:assert/strict";
import { entity, finiteCoordinate } from "../src/lib/normalize.js";

test("entity coerces coordinates and severity to numbers", () => {
  const e = entity({ id: "x", layer: "aviation", lat: "51.5", lon: "-0.12", severity: "3" });
  assert.equal(e.lat, 51.5);
  assert.equal(e.lon, -0.12);
  assert.equal(e.severity, 3);
  assert.equal(typeof e.lat, "number");
});

test("entity applies defaults: type<-layer, name<-id, severity<-1, nullables", () => {
  const e = entity({ id: "abc", layer: "seismic", lat: 1, lon: 2 });
  assert.equal(e.type, "seismic");
  assert.equal(e.name, "abc");
  assert.equal(e.severity, 1);
  assert.equal(e.time, null);
  assert.equal(e.source, null);
  assert.equal(e.url, null);
});

test("entity preserves explicit fields and passes through extras", () => {
  const e = entity({ id: "a", layer: "cyber", type: "CVE", name: "CVE-1", lat: 0, lon: 0, cvss: 9.8 });
  assert.equal(e.type, "CVE");
  assert.equal(e.name, "CVE-1");
  assert.equal(e.cvss, 9.8);
});

test("finiteCoordinate rejects NaN / missing coordinates", () => {
  assert.equal(finiteCoordinate({ lat: 10, lon: 20 }), true);
  assert.equal(finiteCoordinate({ lat: NaN, lon: 20 }), false);
  assert.equal(finiteCoordinate({ lon: 20 }), false);
  assert.equal(finiteCoordinate(entity({ id: "z", layer: "l", lat: "nope", lon: 5 })), false);
});
