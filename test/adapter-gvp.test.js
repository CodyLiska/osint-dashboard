import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { volcanoLayer, parseVolcanoes, parseVolcanoTitle, volcanoSeverity } from "../src/adapters/gvp.js";

const item = ({ title, lat, lon, vn }) => `<item>
  <title>${title}</title>
  <link>https://volcano.si.edu/volcano.cfm?vn=${vn}</link>
  <description>Background activity narrative.</description>
  <pubDate>Thu, 09 Jul 2026 02:29:28 -0400</pubDate>
  <georss:point>${lat} ${lon}</georss:point>
</item>`;

const feed = (...items) => `<?xml version="1.0" encoding="ISO-8859-1"?>
<rss version="2.0" xmlns:georss="http://www.georss.org/georss"><channel>
  <title>Smithsonian / USGS Weekly Volcanic Activity Report</title>
  ${items.join("")}
</channel></rss>`;

test("a report title splits into volcano, country, period, and status", () => {
  assert.deepEqual(
    parseVolcanoTitle("Etna (Italy) - Report for 2 July-8 July 2026 - New Eruptive Activity"),
    { volcano: "Etna", country: "Italy", period: "2 July-8 July 2026", status: "New Eruptive Activity" }
  );
});

test("status maps to severity, with a new eruption above ongoing eruption above unrest", () => {
  assert.equal(volcanoSeverity("New Eruptive Activity"), 4);
  assert.equal(volcanoSeverity("Continuing Eruptive Activity"), 3);
  assert.equal(volcanoSeverity("Continuing Unrest"), 2);
});

test("parseVolcanoes reads the georss point and derives a stable id from the volcano number", () => {
  const rows = parseVolcanoes(feed(
    item({ title: "Krakatau (Indonesia) - Report for 2 July-8 July 2026 - New Eruptive Activity", lat: "-6.1009", lon: "105.4233", vn: "262000" })
  ));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lat, -6.1009);
  assert.equal(rows[0].lon, 105.4233);
  assert.equal(rows[0].id, "262000");
});

test("volcanoLayer normalizes entities onto the volcanoes layer with real coordinates", async () => {
  const restore = installFetch(feed(
    item({ title: "Etna (Italy) - Report for 2 July-8 July 2026 - New Eruptive Activity", lat: "37.748", lon: "14.999", vn: "211060" }),
    item({ title: "Aira (Japan) - Report for 2 July-8 July 2026 - Continuing Unrest", lat: "31.5772", lon: "130.6589", vn: "282080" })
  ));
  try {
    const { entities, meta } = await volcanoLayer();
    assert.equal(entities.length, 2);
    assert.ok(entities.every((e) => e.layer === "volcanoes"));
    assert.ok(entities.every((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon)));
    const etna = entities.find((e) => e.volcano === "Etna");
    assert.equal(etna.id, "volcano-211060");
    assert.equal(etna.severity, 4, "a new eruption is severity 4");
    const aira = entities.find((e) => e.volcano === "Aira");
    assert.equal(aira.severity, 2, "unrest is severity 2");
    assert.ok(etna.severity > aira.severity, "the severity filter can separate eruption from unrest");
    assert.match(meta.source, /Global Volcanism Program/);
  } finally {
    restore();
  }
});

test("a malformed title (no ' - Report for ') is skipped, not plotted as a null volcano", () => {
  const rows = parseVolcanoes(feed(
    item({ title: "Some banner text with no report structure", lat: "10", lon: "20", vn: "1" })
  ));
  assert.deepEqual(rows, []);
});
