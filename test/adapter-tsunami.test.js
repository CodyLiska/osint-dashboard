import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { tsunamiLayer, parseTsunamiFeed, tsunamiSeverity } from "../src/adapters/tsunami.js";

// A minimal NOAA-shaped Atom feed: the feed-level <title> is the message class,
// and each <entry> carries the affected location plus geo:lat / geo:long.
const feed = (messageClass, entries) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#">
  <title>${messageClass}</title>
  <updated>2026-07-17T14:56:39Z</updated>
  ${entries.map((e) => `<entry>
    <title>${e.title}</title>
    <updated>${e.updated}</updated>
    <geo:lat>${e.lat}</geo:lat>
    <geo:long>${e.lon}</geo:long>
  </entry>`).join("")}
</feed>`;

test("message class maps to severity, with Warning above Watch above Advisory", () => {
  assert.equal(tsunamiSeverity("Tsunami Warning Number 3"), 5);
  assert.equal(tsunamiSeverity("Tsunami Watch"), 4);
  assert.equal(tsunamiSeverity("Tsunami Advisory"), 3);
  assert.equal(tsunamiSeverity("Tsunami Information Statement Number 1"), 2);
});

test("a Cancellation outranks the Warning word it contains and reads as severity 1", () => {
  // A cancellation message cancels a prior warning, so the word "Warning" can
  // appear in it; the Cancellation check must win or a stand-down reads as alarm.
  assert.equal(tsunamiSeverity("Tsunami Warning Cancellation"), 1);
});

test("parseTsunamiFeed pulls coordinates and stamps every entry with the feed's severity", () => {
  const rows = parseTsunamiFeed(
    feed("Tsunami Warning Number 2", [
      { title: "near the coast of Chiapas, Mexico", updated: "2026-07-17T14:56:39Z", lat: "14.4", lon: "-93.0" }
    ]),
    "NTWC"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].center, "NTWC");
  assert.equal(rows[0].severity, 5);
  assert.equal(rows[0].lat, 14.4);
  assert.equal(rows[0].lon, -93.0);
  assert.equal(rows[0].location, "near the coast of Chiapas, Mexico");
});

test("an entry with no coordinates is dropped rather than plotted at 0,0", () => {
  const rows = parseTsunamiFeed(
    feed("Tsunami Advisory", [{ title: "no coords here", updated: "2026-07-17T14:56:39Z", lat: "", lon: "" }]),
    "PTWC"
  );
  assert.equal(rows.length, 0);
});

test("tsunamiLayer merges both warning centers into normalized entities", async () => {
  const restore = installFetch((url) => {
    if (url.includes("PAAQAtom")) {
      return feed("Tsunami Warning Number 1", [
        { title: "Gulf of Alaska", updated: "2026-07-17T14:56:39Z", lat: "58.3", lon: "-152.0" }
      ]);
    }
    return feed("Tsunami Information Statement Number 1", [
      { title: "Pacific Ocean", updated: "2026-07-17T15:00:00Z", lat: "19.7", lon: "-155.1" }
    ]);
  });
  try {
    const { entities, meta } = await tsunamiLayer();
    assert.equal(entities.length, 2);
    assert.ok(entities.every((e) => e.layer === "tsunami"));
    assert.ok(entities.every((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon)));
    const warning = entities.find((e) => e.center === "NTWC");
    assert.equal(warning.severity, 5, "the NTWC warning stays at severity 5");
    const statement = entities.find((e) => e.center === "PTWC");
    assert.equal(statement.severity, 2, "the PTWC information statement is severity 2");
    assert.match(meta.source, /Tsunami Warning System/);
  } finally {
    restore();
  }
});

test("an empty feed (no active event) yields an empty layer, not a throw", async () => {
  const restore = installFetch(feed("Tsunami Information Statement", []));
  try {
    const { entities } = await tsunamiLayer();
    assert.deepEqual(entities, []);
  } finally {
    restore();
  }
});
