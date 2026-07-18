import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { portsLayer } from "../src/adapters/ports.js";

const port = (num, name, size, lat, lon, flags = {}) => ({
  portNumber: num, portName: name, harborSize: size, ycoord: lat, xcoord: lon,
  countryName: "Testland", ...flags
});

const dataset = () => ({
  ports: [
    port(1, "Big", "L", 10, 10, { firstPortOfEntry: "Y", loContainer: "Y", vts: "Y" }), // sev 5
    port(2, "Tiny", "V", 50, 50), // sev 1
    port(3, "Mid", "M", -80, -80) // sev 3
  ]
});

test("portsLayer scores severity from harbor size + facility flags", async () => {
  const restore = installJsonFetch(dataset());
  try {
    const byId = Object.fromEntries((await portsLayer()).entities.map((e) => [e.portNumber, e]));
    assert.equal(byId[1].severity, 5); // L(4)+entry+container+vts, clamped to 5
    assert.equal(byId[2].severity, 1); // V(1), no flags
    assert.equal(byId[3].severity, 3); // M(3)
  } finally {
    restore();
  }
});

test("portsLayer sorts by severity (highest first) and reports size counts", async () => {
  const restore = installJsonFetch(dataset());
  try {
    const { entities, meta } = await portsLayer();
    assert.equal(entities[0].portNumber, 1);
    assert.equal(meta.totalPorts, 3);
    assert.deepEqual(meta.sizeCounts, { Large: 1, "Very small": 1, Medium: 1 });
    assert.equal(meta.viewportAware, false);
  } finally {
    restore();
  }
});

test("portsLayer filters to the viewport when bounds are supplied", async () => {
  const restore = installJsonFetch(dataset());
  try {
    const { entities, meta } = await portsLayer({ lamin: 5, lomin: 5, lamax: 15, lomax: 15 });
    assert.deepEqual(entities.map((e) => e.portNumber), [1]);
    assert.equal(meta.viewportAware, true);
    assert.equal(meta.matchedPorts, 1);
  } finally {
    restore();
  }
});

test("portsLayer caps output at PORTS_MAX_ITEMS", async () => {
  const restore = installJsonFetch(dataset());
  const saved = process.env.PORTS_MAX_ITEMS;
  process.env.PORTS_MAX_ITEMS = "1";
  try {
    const { entities, meta } = await portsLayer();
    assert.equal(entities.length, 1);
    assert.equal(entities[0].portNumber, 1); // the highest-severity one survives the cap
    assert.equal(meta.cappedAt, 1);
    assert.equal(meta.matchedPorts, 3);
  } finally {
    if (saved === undefined) delete process.env.PORTS_MAX_ITEMS; else process.env.PORTS_MAX_ITEMS = saved;
    restore();
  }
});
