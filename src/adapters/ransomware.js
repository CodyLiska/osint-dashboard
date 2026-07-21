import { cachedResilient } from "../lib/cache.js";
import { fetchTextRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { rssItems, tag, textContent } from "../lib/xml.js";
import { COUNTRY_CENTROIDS } from "../lib/centroids.js";

// Ransomware.live — ransomware leak-site victim disclosures. The JSON API moved
// behind a (free) key, but the RSS feed is keyless and carries everything this
// layer needs: victim, group, country and disclosure time for the last 200
// entries. Keyless is the reason this is the chosen endpoint, not api-pro.
const FEED_URL = "https://ransomware.live/rss.xml";

// The feed reports a country CODE, never coordinates, so each victim is placed
// on its country centroid — the same treatment as travel advisories.
//
// Every entry is the same kind of event (a group published a victim), so there
// is no signal in the feed to vary severity on. It is deliberately constant:
// this layer can alert on "appeared", never on an upward severity crossing.
const SEVERITY = 3;

// "🏴‍☠️ Qilin has just published a new victim : Postres Reina"
// The leading emoji is a ZWJ sequence, so it is stripped by dropping everything
// before the first letter/digit rather than by matching the emoji itself.
export function parseVictimTitle(title) {
  const match = String(title).match(/^(.*?)\s*has just published a new victim\s*:\s*(.+)$/is);
  if (!match) return null;
  const group = match[1].replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const victim = match[2].replace(/\s+/g, " ").trim();
  if (!group || !victim) return null;
  return { group, victim };
}

// The link is https://www.ransomware.live/id/<base64 of "victim@group">, which is
// stable per disclosure — so it is the reconcile store's identity for this row.
// Falling back to group+victim keeps an id if the link shape ever changes.
export function victimId(link, parsed) {
  const slug = String(link || "").split("/").filter(Boolean).pop();
  if (slug) return `ransomware-${slug}`;
  return `ransomware-${parsed.group}-${parsed.victim}`.replace(/\s+/g, "-").toLowerCase();
}

export function parseVictims(xml) {
  const rows = [];
  for (const item of rssItems(xml)) {
    const parsed = parseVictimTitle(tag(item, "title"));
    if (!parsed) continue;
    // "N/A" is the feed's own unknown-country marker; without a code there is
    // nothing to place the victim on, so the row is dropped rather than guessed.
    const code = tag(item, "category").toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) continue;
    const description = textContent(item, "description");
    rows.push({
      ...parsed,
      code,
      link: tag(item, "link"),
      pubDate: tag(item, "pubDate"),
      // The feed writes a literal "N/A" when it has no description.
      description: description && description !== "N/A" ? description : null
    });
  }
  return rows;
}

export async function ransomwareLayer() {
  const result = await cachedResilient("ransomware:live-rss", 30 * 60_000, () =>
    fetchTextRetry(FEED_URL, { headers: { Accept: "application/rss+xml" } }));

  const entities = parseVictims(result.value).map((row) => {
    const centroid = COUNTRY_CENTROIDS[row.code] || null;
    const time = row.pubDate ? new Date(row.pubDate) : null;
    return entity({
      id: victimId(row.link, row),
      layer: "ransomware",
      type: "Ransomware victim",
      name: `${row.group}: ${row.victim}`,
      lon: centroid?.[0],
      lat: centroid?.[1],
      severity: SEVERITY,
      time: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
      source: "Ransomware.live",
      url: row.link || null,
      summary: row.description || `${row.victim} listed by ${row.group}.`,
      group: row.group,
      victim: row.victim,
      countryCode: row.code
    });
  });

  return {
    entities: entities.filter(finiteCoordinate),
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "Ransomware.live leak-site disclosures (RSS)"
    }
  };
}
