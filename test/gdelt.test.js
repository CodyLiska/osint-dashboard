import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { parseGdeltEvents, unzipSingleEntry } from "../src/adapters/gdelt.js";

// Build one 61-field GDELT 2.0 Event row, overriding only the columns we read.
function eventRow(over = {}) {
  const c = new Array(61).fill("");
  const set = {
    id: "1", root: "19", quad: "4", gold: "-8", articles: "10", tone: "-5",
    name: "Kyiv, Ukraine", lat: "50.45", lon: "30.52", dateAdded: "20260720001500",
    url: "http://example.test/article", ...over
  };
  const COL = { id: 0, root: 28, quad: 29, gold: 30, articles: 33, tone: 34, name: 52, lat: 56, lon: 57, dateAdded: 59, url: 60 };
  for (const [k, i] of Object.entries(COL)) c[i] = set[k];
  return c.join("\t");
}

// Minimal single-entry ZIP (matches what GDELT publishes) so unzipSingleEntry is
// tested without a network round-trip.
function makeZip(name, content, { store = false } = {}) {
  const data = Buffer.from(content, "utf8");
  const body = store ? data : deflateRawSync(data);
  const nameBuf = Buffer.from(name, "latin1");
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(store ? 0 : 8, 8); // 0 = stored, 8 = deflate
  h.writeUInt32LE(body.length, 18);
  h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  return Buffer.concat([h, nameBuf, body]);
}

test("unzipSingleEntry inflates a deflated single-entry ZIP", () => {
  const csv = "a\tb\tc\nd\te\tf";
  assert.equal(unzipSingleEntry(makeZip("x.csv", csv)), csv);
});

test("unzipSingleEntry handles a stored (uncompressed) entry", () => {
  assert.equal(unzipSingleEntry(makeZip("x.csv", "hello", { store: true })), "hello");
});

test("unzipSingleEntry rejects a non-ZIP buffer", () => {
  assert.throws(() => unzipSingleEntry(Buffer.from("not a zip")), /ZIP/);
});

test("parseGdeltEvents keeps only geolocated rows and maps CAMEO + severity", () => {
  const text = [
    eventRow({ id: "1", root: "19", quad: "4", name: "Kyiv, Ukraine", articles: "10" }), // Fight, material conflict
    eventRow({ id: "2", name: "", lat: "", lon: "" }), // no location → dropped
    eventRow({ id: "3", root: "04", quad: "1", name: "Geneva, Switzerland", lat: "46.2", lon: "6.1", articles: "3" }) // Consult, verbal coop
  ].join("\n");

  const rows = parseGdeltEvents(text);
  assert.equal(rows.length, 2); // the location-less row is filtered out

  const fight = rows.find((r) => r.id === "gdelt-1");
  assert.equal(fight.type, "Fight"); // CAMEO root 19
  assert.equal(fight.severity, 5); // QuadClass 4 = material conflict
  assert.equal(fight.eventClass, "Material conflict");
  assert.equal(fight.lat, 50.45);
  assert.equal(fight.time, "2026-07-20T00:15:00Z");
  assert.equal(fight.url, "http://example.test/article");

  const consult = rows.find((r) => r.id === "gdelt-3");
  assert.equal(consult.type, "Consult");
  assert.equal(consult.severity, 1); // QuadClass 1 = verbal cooperation
});

test("parseGdeltEvents sorts by press coverage and honors the cap", () => {
  const text = [
    eventRow({ id: "low", name: "A, X", lat: "1", lon: "1", articles: "2" }),
    eventRow({ id: "high", name: "B, Y", lat: "2", lon: "2", articles: "99" })
  ].join("\n");

  const rows = parseGdeltEvents(text, { max: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "gdelt-high"); // most-covered survives the cap
});
