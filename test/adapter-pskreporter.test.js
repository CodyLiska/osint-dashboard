import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { pskReporterLayer, parseActiveReceivers } from "../src/adapters/pskreporter.js";

const feed = (receivers) => `<?xml version="1.0"?>
<receptionReports currentSeconds="1784696382">
${receivers.map((r) => `  <activeReceiver callsign="${r.callsign}" locator="${r.locator}" frequency="14075000" bands="20m,40m" region="${r.region || ""}" DXCC="${r.dxcc || ""}" mode="${r.mode || "FT8"}" />`).join("\n")}
</receptionReports>`;

test("parseActiveReceivers reads the self-closing attribute elements", () => {
  const rows = parseActiveReceivers(feed([{ callsign: "K5JBT", locator: "EL29ds", mode: "FT4" }]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].callsign, "K5JBT");
  assert.equal(rows[0].mode, "FT4");
});

test("numeric XML entities in region text are decoded", () => {
  // "&#321;&#243;d&#378;" is "Łódź" — a raw pass-through would show the entities.
  const rows = parseActiveReceivers(feed([{ callsign: "SP7XIF", locator: "JO91qu", region: "&#321;&#243;d&#378; Voivodeship" }]));
  assert.equal(rows[0].region, "Łódź Voivodeship");
});

test("pskReporterLayer maps grid locators to coordinates and dedupes by callsign", async () => {
  const restore = installFetch(feed([
    { callsign: "K5JBT", locator: "EL29ds", region: "Texas", mode: "FT4" },
    { callsign: "K5JBT", locator: "EL29ds", region: "Texas", mode: "FT4" }, // duplicate
    { callsign: "DL0PF", locator: "JN68rn", region: "Bavaria", mode: "CW" }
  ]));
  try {
    const { entities, meta } = await pskReporterLayer();
    assert.equal(entities.length, 2, "the duplicate callsign is collapsed");
    assert.ok(entities.every((e) => e.layer === "pskreporter"));
    assert.ok(entities.every((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon)));
    const tx = entities.find((e) => e.name === "K5JBT");
    assert.ok(Math.abs(tx.lat - 29.77) < 0.1 && Math.abs(tx.lon + 95.71) < 0.1, "K5JBT lands in Texas");
    assert.match(meta.source, /PSKReporter/);
  } finally {
    restore();
  }
});

test("a receiver with an unparseable locator is dropped, not plotted at 0,0", async () => {
  const restore = installFetch(feed([{ callsign: "BADGRID", locator: "ZZ99", mode: "FT8" }]));
  try {
    const { entities } = await pskReporterLayer();
    assert.deepEqual(entities, []);
  } finally {
    restore();
  }
});
