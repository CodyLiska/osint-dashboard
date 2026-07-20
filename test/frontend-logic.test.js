import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml, clusterPoints, shouldCluster, filterBySeverity, advancePosition,
  byPriority, buildFeed, detailRows, snapshotEntity, kvRow, extLink,
  sanctionDetail, intelLinks, cveDetail, relativeTime
} from "../public/logic.js";

test("escapeHtml neutralizes every HTML metacharacter", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`),
    "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(42), "42"); // coerces non-strings
});

test("advancePosition moves a plane the expected distance (matches the live-verified case)", () => {
  // 246 m/s on heading 112° over 4 s ≈ 984 m; verified live last session.
  const start = { lat: 40, lon: -74, velocity: 246, track: 112 };
  const next = advancePosition(start, 4);
  // Great-circle-ish flat-earth distance at this scale.
  const dLatM = (next.lat - start.lat) * 111_320;
  const dLonM = (next.lon - start.lon) * 111_320 * Math.cos((start.lat * Math.PI) / 180);
  const dist = Math.hypot(dLatM, dLonM);
  assert.ok(Math.abs(dist - 984) < 5, `moved ${dist.toFixed(0)} m, expected ~984`);
  // Heading 112° (ESE) → moves east and south.
  assert.ok(next.lon > start.lon, "eastward");
  assert.ok(next.lat < start.lat, "southward");
});

test("advancePosition returns the position unchanged for unusable speed/track", () => {
  const p = { lat: 10, lon: 20 };
  assert.deepEqual(advancePosition({ ...p, velocity: 0, track: 90 }, 5), p);
  assert.deepEqual(advancePosition({ ...p, velocity: 200, track: NaN }, 5), p);
  assert.deepEqual(advancePosition({ lat: NaN, lon: 20, velocity: 200, track: 90 }, 5), { lat: NaN, lon: 20 });
});

test("clusterPoints collapses co-located points and splits them apart as zoom rises", () => {
  // Four points within ~1° of each other.
  const rows = [
    { lat: 0.1, lon: 0.1 }, { lat: 0.2, lon: 0.2 },
    { lat: 0.3, lon: 0.3 }, { lat: 0.4, lon: 0.4 }
  ];
  const low = clusterPoints(rows, 1); // cellDeg = 45° → all in one cell
  assert.equal(low.clusters.length, 1);
  assert.equal(low.clusters[0].count, 4);
  assert.equal(low.singles.length, 0);

  const high = clusterPoints(rows, 12); // tiny cells → each point its own single
  assert.equal(high.clusters.length, 0);
  assert.equal(high.singles.length, 4);
});

test("clusterPoints ignores points with non-finite coordinates", () => {
  const rows = [{ lat: 5, lon: 5 }, { lat: NaN, lon: 5 }, { lat: 5, lon: undefined }];
  const { singles, clusters } = clusterPoints(rows, 8);
  assert.equal(singles.length + clusters.reduce((n, c) => n + c.count, 0), 1);
});

test("shouldCluster only fires for a cluster layer over the point threshold below max zoom", () => {
  const many = Array.from({ length: 20 }, () => ({}));
  const few = Array.from({ length: 5 }, () => ({}));
  assert.equal(shouldCluster("aviation", many, 3), true);
  assert.equal(shouldCluster("aviation", few, 3), false);   // below CLUSTER_MIN_POINTS
  assert.equal(shouldCluster("aviation", many, 6), false);  // at/above CLUSTER_MAX_ZOOM
  assert.equal(shouldCluster("sanctions", many, 3), false); // not a cluster layer
});

test("filterBySeverity drops rows below the floor and passes everything at 1", () => {
  const rows = [{ severity: 1 }, { severity: 3 }, { severity: 5 }, {}];
  assert.equal(filterBySeverity(rows, 1).length, 4);        // minSeverity=1 short-circuits
  assert.deepEqual(filterBySeverity(rows, 3).map((r) => r.severity), [3, 5]);
  assert.equal(filterBySeverity(rows, 5).length, 1);
});

test("byPriority orders by severity, then most-recent time", () => {
  const a = { severity: 5, time: "2026-01-01" };
  const b = { severity: 3, time: "2026-02-01" };
  const c = { severity: 5, time: "2026-03-01" };
  const sorted = [a, b, c].sort(byPriority);
  assert.deepEqual(sorted, [c, a, b]); // c and a (sev5) first, newer c ahead of a; b last
});

test("buildFeed caps per layer, respects enabled+severity, sorts, and caps the total", () => {
  const data = {
    seismic: Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, layer: "seismic", lat: 1, lon: 1, severity: 2 })),
    conflict: [
      { id: "c1", layer: "conflict", lat: 2, lon: 2, severity: 5 },
      { id: "c2", layer: "conflict", lat: 3, lon: 3, severity: 4 },
      { id: "nogeo", layer: "conflict", lat: NaN, lon: 3, severity: 5 } // dropped: no coords
    ],
    telegram: [{ id: "t1", layer: "telegram", lat: 4, lon: 4, severity: 3 }]
  };
  const getVisible = (id) => data[id] || [];
  // "cyber" enabled but has no data; "space" NOT enabled so must never appear.
  const enabled = ["seismic", "conflict", "telegram", "cyber"];

  // Wide limit isolates the per-layer cap: 10 seismic → 4, conflict → 2 (nogeo
  // dropped), telegram → 1, total 7.
  const feed = buildFeed(enabled, getVisible, { limit: 20, perLayer: 4 });
  assert.equal(feed.length, 7);
  assert.equal(feed.filter((r) => r.layer === "seismic").length, 4, "noisy layer capped at perLayer");
  assert.equal(feed[0].id, "c1", "highest severity first");
  assert.ok(!feed.some((r) => r.id === "nogeo"), "non-located items excluded");
  assert.ok(!feed.some((r) => r.layer === "space"), "disabled layer excluded");

  // Tight limit exercises the final total cap independently.
  const capped = buildFeed(enabled, getVisible, { limit: 3, perLayer: 4 });
  assert.equal(capped.length, 3);
  assert.deepEqual(capped.map((r) => r.id), ["c1", "c2", "t1"]); // sorted, then top 3
});

test("detailRows emits only present fields as [label, value] string pairs", () => {
  const rows = detailRows({ magnitude: 6.1, country: "Japan", epss: 0.25, nothing: undefined });
  const map = Object.fromEntries(rows);
  assert.equal(map.Magnitude, "6.1");
  assert.equal(map.Country, "Japan");
  assert.equal(map.EPSS, "25.0%");
  assert.ok(!("nothing" in map));
  assert.ok(rows.every(([, v]) => typeof v === "string"));
});

test("snapshotEntity keeps core fields and only includes optionals when set", () => {
  const full = snapshotEntity({ id: "x", layer: "seismic", type: "Quake", name: "M6", lat: 1, lon: 2, severity: 4, magnitude: 6, summary: "big one", extra: "dropped" });
  assert.equal(full.magnitude, 6);
  assert.equal(full.note, "big one");
  assert.ok(!("extra" in full));
  const bare = snapshotEntity({ id: "y", layer: "ports", lat: 0, lon: 0, severity: 1 });
  assert.ok(!("magnitude" in bare) && !("note" in bare) && !("source" in bare));
});

test("kvRow / extLink render escaped HTML and omit empty values", () => {
  assert.equal(kvRow("Label", ""), ""); // empty value → nothing
  assert.match(kvRow("Country", ["Iran", "", "Russia"]), /Iran, Russia/); // arrays joined, blanks dropped
  const link = extLink("https://x.test/a&b", "Open <it>");
  assert.match(link, /href="https:\/\/x.test\/a&amp;b"/);
  assert.match(link, /Open &lt;it&gt; ↗/);
  assert.match(link, /rel="noreferrer"/);
});

test("sanctionDetail surfaces properties and falls back when empty", () => {
  const html = sanctionDetail({ properties: { country: ["Russia"], program: ["UKRAINE-EO13661"], uid: ["111"] }, datasets: ["OFAC SDN"] });
  assert.match(html, /Russia/);
  assert.match(html, /UKRAINE-EO13661/);
  assert.match(html, /OFAC SDN/);
  assert.match(sanctionDetail({}), /No further detail available/);
});

test("intelLinks returns the right pivot portals per indicator kind", () => {
  assert.match(intelLinks("ip", "1.2.3.4"), /abuseipdb\.com\/check\/1\.2\.3\.4/);
  assert.match(intelLinks("ip", "1.2.3.4"), /viz\.greynoise\.io/);
  assert.match(intelLinks("ip", "1.2.3.4"), /shodan\.io\/host\/1\.2\.3\.4/);
  assert.match(intelLinks("domain", "evil.test"), /otx\.alienvault\.com/);
  assert.match(intelLinks("hash", "abc123"), /bazaar\.abuse\.ch\/sample\/abc123/);
  assert.equal(intelLinks("whois", "x"), ""); // no pivot links for whois
});

test("detailRows surfaces GDELT event fields", () => {
  const rows = detailRows({ layer: "gdelt", eventClass: "Material conflict", articles: 12, tone: -6.3, source: "GDELT" });
  const map = Object.fromEntries(rows);
  assert.equal(map["Event class"], "Material conflict");
  assert.equal(map["Coverage"], "12 articles");
  assert.equal(map["Tone"], "-6.3");
  assert.equal(map["Source"], "GDELT");
});

test("relativeTime buckets an elapsed timestamp into minutes/hours/days", () => {
  const now = Date.parse("2026-07-19T12:00:00.000Z");
  assert.equal(relativeTime("2026-07-19T11:59:40.000Z", now), "just now"); // <1 min
  assert.equal(relativeTime("2026-07-19T11:45:00.000Z", now), "15m ago");
  assert.equal(relativeTime("2026-07-19T09:00:00.000Z", now), "3h ago");
  assert.equal(relativeTime("2026-07-17T12:00:00.000Z", now), "2d ago");
  assert.equal(relativeTime(undefined, now), ""); // unparseable → empty
});

test("cveDetail renders CVSS, description, and the NVD link", () => {
  const html = cveDetail({
    cve: {
      id: "CVE-2026-0001",
      published: "2026-03-14T00:00:00.000",
      descriptions: [{ lang: "en", value: "A serious flaw." }],
      metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: "CRITICAL" } }] },
      references: [{ url: "https://vendor.test/advisory" }]
    }
  });
  assert.match(html, /9\.8 \(CRITICAL\)/);
  assert.match(html, /A serious flaw\./);
  assert.match(html, /Published/);
  assert.match(html, /2026-03-14/);
  assert.match(html, /nvd\.nist\.gov\/vuln\/detail\/CVE-2026-0001/);
  assert.match(html, /vendor\.test\/advisory/);
});
