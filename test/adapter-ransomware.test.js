import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { ransomwareLayer, parseVictims, parseVictimTitle, victimId } from "../src/adapters/ransomware.js";

const item = ({ title, country = "DE", link = "https://www.ransomware.live/id/YWJjQGRlZg==", description = "N/A" }) =>
  `<item><title>${title}</title><link>${link}</link>
   <description>${description}</description><category>${country}</category>
   <pubDate>Mon, 20 Jul 2026 19:07:03 +0000</pubDate></item>`;

const feed = (...items) =>
  `<?xml version="1.0"?><rss><channel><title>Ransomware.live RSS Feed</title>${items.join("")}</channel></rss>`;

test("a victim title yields the group and the victim separately", () => {
  // The real feed prefixes every title with a 🏴‍☠️ ZWJ emoji sequence; the group
  // name must come back clean or every entity is labelled with a stray glyph.
  assert.deepEqual(
    parseVictimTitle("🏴‍☠️ Qilin has just published a new victim : Postres Reina"),
    { group: "Qilin", victim: "Postres Reina" }
  );
  // Without the emoji too, in case the feed ever drops it.
  assert.deepEqual(
    parseVictimTitle("Safepay has just published a new victim : wdk.de"),
    { group: "Safepay", victim: "wdk.de" }
  );
});

test("a title that is not a victim disclosure is not plotted", () => {
  assert.equal(parseVictimTitle("Ransomware.live weekly summary"), null);
  assert.equal(parseVictimTitle(""), null);
});

test("victims with no resolvable country are dropped rather than guessed", () => {
  // The feed writes a literal "N/A" category when it does not know the country.
  // Placing those anywhere would be an invented location.
  const rows = parseVictims(feed(
    item({ title: "🏴‍☠️ Qilin has just published a new victim : Known Corp", country: "ES" }),
    item({ title: "🏴‍☠️ Qilin has just published a new victim : Unknown Corp", country: "N/A" })
  ));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].victim, "Known Corp");
});

test("the entity id is stable across refetches of the same disclosure", () => {
  // The reconcile store keys on this; an unstable id would report the same
  // victim as appearing again on every poll.
  const link = "https://www.ransomware.live/id/UG9zdHJlcyBSZWluYUBxaWxpbg==";
  const parsed = { group: "Qilin", victim: "Postres Reina" };
  assert.equal(victimId(link, parsed), "ransomware-UG9zdHJlcyBSZWluYUBxaWxpbg==");
  // Falls back to group+victim if the link shape ever changes.
  assert.equal(victimId("", parsed), "ransomware-qilin-postres-reina");
});

test("a victim is placed on its country centroid with a real coordinate", async () => {
  const restore = installFetch(feed(
    item({ title: "🏴‍☠️ Safepay has just published a new victim : wdk.de", country: "DE" })
  ));
  try {
    const { entities, meta } = await ransomwareLayer();
    assert.equal(entities.length, 1);
    const [row] = entities;
    assert.equal(row.layer, "ransomware");
    assert.equal(row.group, "Safepay");
    assert.equal(row.countryCode, "DE");
    assert.ok(Number.isFinite(row.lat) && Number.isFinite(row.lon), "placed on a centroid");
    assert.match(row.name, /Safepay: wdk\.de/);
    assert.equal(row.time, "2026-07-20T19:07:03.000Z");
    assert.equal(meta.stale, false);
  } finally {
    restore();
  }
});

test("an empty description falls back to a summary instead of showing N/A", async () => {
  const restore = installFetch(feed(
    item({ title: "🏴‍☠️ Qilin has just published a new victim : Postres Reina", country: "ES", description: "N/A" })
  ));
  try {
    const { entities } = await ransomwareLayer();
    assert.doesNotMatch(entities[0].summary, /N\/A/);
    assert.match(entities[0].summary, /Postres Reina listed by Qilin/);
  } finally {
    restore();
  }
});
