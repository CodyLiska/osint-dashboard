import { cachedResilient } from "../lib/cache.js";
import { fetchTextRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { rssItems, tag } from "../lib/xml.js";
import { centroidForCountry, countryCodeForName } from "../lib/centroids.js";

// US State Department travel advisories — keyless RSS, US Gov public domain.
// Country-level risk ratings (1-4) with the Department's standing advice. The
// feed carries no coordinates, so each country is placed on its centroid.
const FEED_URL = "https://travel.state.gov/_res/rss/TAsTWs.xml";

// Levels 1-4 spread across the app's 1-5 severity scale. 3 ("Reconsider
// Travel") and 4 ("Do Not Travel") are the operationally interesting ones, so
// they sit at the top of the scale rather than compressing into the middle.
const LEVEL_SEVERITY = { 1: 1, 2: 2, 3: 4, 4: 5 };

// "Bhutan - Level 1: Exercise Normal Precautions" -> country / level / advice.
// Composite entries ("Mainland China, Hong Kong & Macau - See Summaries") carry
// no level and are dropped by the null return.
export function parseAdvisoryTitle(title) {
  const match = String(title).match(/^(.*?)\s*-\s*Level\s*([1-4])\s*:\s*(.*)$/s);
  if (!match) return null;
  return {
    country: match[1].trim(),
    level: Number(match[2]),
    advice: match[3].replace(/\s+/g, " ").trim()
  };
}

export function parseAdvisories(xml) {
  // The feed lists every country roughly twice (advisories and warnings share
  // the channel). Keep one entry per country, at its highest level.
  const byCode = new Map();
  for (const item of rssItems(xml)) {
    const parsed = parseAdvisoryTitle(tag(item, "title"));
    if (!parsed) continue;
    const code = countryCodeForName(parsed.country);
    if (!code) continue;
    const existing = byCode.get(code);
    if (existing && existing.level >= parsed.level) continue;
    byCode.set(code, {
      ...parsed,
      code,
      link: tag(item, "link"),
      pubDate: tag(item, "pubDate")
    });
  }
  return [...byCode.values()];
}

export async function advisoriesLayer() {
  const result = await cachedResilient("advisories:state-dept", 6 * 60 * 60_000, () =>
    fetchTextRetry(FEED_URL, { headers: { Accept: "application/rss+xml" } }));

  const entities = parseAdvisories(result.value).map((row) => {
    const centroid = centroidForCountry(row.country);
    const time = row.pubDate ? new Date(row.pubDate) : null;
    return entity({
      id: `advisory-${row.code}`,
      layer: "advisories",
      type: "Travel advisory",
      name: `${row.country}: Level ${row.level}`,
      lon: centroid?.[0],
      lat: centroid?.[1],
      severity: LEVEL_SEVERITY[row.level] || 1,
      time: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
      source: "US State Department",
      url: row.link || null,
      summary: row.advice,
      country: row.country,
      countryCode: row.code,
      level: row.level
    });
  });

  return {
    entities: entities.filter(finiteCoordinate),
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "US State Department travel advisories"
    }
  };
}
