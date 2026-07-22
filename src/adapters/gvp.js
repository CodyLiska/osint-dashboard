import { cachedResilient } from "../lib/cache.js";
import { fetchTextRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { rssItems, tag, textContent } from "../lib/xml.js";

// Smithsonian / USGS Weekly Volcanic Activity Report — keyless RSS, updated by
// 2300 UTC every Thursday. A comprehensive picture of ongoing global volcanic
// activity (~20-30 volcanoes), broader and more authoritative than the handful
// of "notable" volcanoes EONET surfaces. Each item carries a <georss:point>.
const FEED_URL = "https://volcano.si.edu/news/WeeklyVolcanoRSS.xml";

// "Etna (Italy) - Report for 2 July-8 July 2026 - New Eruptive Activity"
export function parseVolcanoTitle(title) {
  // The status is delimited by a SPACED hyphen. The date range ("2 July-8 July")
  // carries its own unspaced hyphen, so the period capture is greedy and the
  // split anchors on the last " - " — otherwise the range gets torn in half.
  const match = String(title).match(/^(.*?)\s*\(([^)]*)\)\s*-\s*Report for\s+(.*)\s+-\s+(.+)$/s);
  if (!match) return null;
  return {
    volcano: match[1].trim(),
    country: match[2].trim(),
    period: match[3].trim(),
    status: match[4].replace(/\s+/g, " ").trim()
  };
}

// Report status -> severity. A new eruption is the most operationally notable;
// ongoing eruption sits a step below; unrest (seismicity/deformation without
// eruption) is a watch-level signal.
export function volcanoSeverity(status = "") {
  if (/new eruptive/i.test(status)) return 4;
  if (/eruptive|eruption|ongoing activity/i.test(status)) return 3;
  if (/unrest/i.test(status)) return 2;
  return 2;
}

// <georss:point> is "lat lon", space-separated.
function parsePoint(itemXml) {
  const [lat, lon] = tag(itemXml, "georss:point").split(/\s+/).map(Number);
  return { lat, lon };
}

export function parseVolcanoes(xml) {
  const out = [];
  for (const itemXml of rssItems(xml)) {
    const parsed = parseVolcanoTitle(tag(itemXml, "title"));
    if (!parsed) continue;
    const { lat, lon } = parsePoint(itemXml);
    const link = tag(itemXml, "link");
    // The GVP volcano number in the link is a stable id across weeks; fall back
    // to a slug of the volcano name so an id is always present.
    const vn = link.match(/vn=(\d+)/)?.[1];
    out.push({
      ...parsed,
      lat,
      lon,
      id: vn || parsed.volcano.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      link,
      pubDate: tag(itemXml, "pubDate"),
      description: textContent(itemXml, "description")
    });
  }
  return out;
}

export async function volcanoLayer() {
  // volcano.si.edu's WAF returns 403 for any explicit Accept header other than
  // "*/*" (verified: application/rss+xml and text/html both 403; */* is 200), and
  // fetchText sets a default Accept, so it must be overridden here — not omitted.
  const result = await cachedResilient("gvp:weekly", 6 * 60 * 60_000, () =>
    fetchTextRetry(FEED_URL, { headers: { Accept: "*/*" } }));

  const entities = parseVolcanoes(result.value).map((row) => {
    const time = row.pubDate ? new Date(row.pubDate) : null;
    return entity({
      id: `volcano-${row.id}`,
      layer: "volcanoes",
      type: "Volcanic activity",
      name: `${row.volcano} (${row.country})`,
      lat: row.lat,
      lon: row.lon,
      severity: volcanoSeverity(row.status),
      time: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
      source: "Smithsonian GVP / USGS",
      url: row.link || null,
      summary: [`${row.status} (${row.period})`, row.description].filter(Boolean).join(". "),
      status: row.status,
      country: row.country,
      volcano: row.volcano
    });
  }).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "Smithsonian Global Volcanism Program (weekly report)"
    }
  };
}
