import { cachedResilient } from "../lib/cache.js";
import { fetchTextRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { atomEntries, tag } from "../lib/xml.js";

// NOAA Tsunami Warning System — the two US warning centers each publish an Atom
// feed for their most recent event. NTWC (Palmer, AK) covers the US/Canada
// Pacific + Atlantic/Caribbean coasts; PTWC (Honolulu) covers the Pacific basin.
// Keyless, US Gov public domain. Each feed carries ONLY the latest event's
// message thread, so the layer is empty when nothing is active — the correct
// resting state for a warning layer (like the NWS alerts layer).
const FEEDS = [
  { center: "NTWC", url: "https://www.tsunami.gov/events/xml/PAAQAtom.xml" },
  { center: "PTWC", url: "https://www.tsunami.gov/events/xml/PHEBAtom.xml" }
];

// Tsunami message class -> severity. A Warning is an imminent-threat evacuation
// message; an Information Statement explicitly means no threat. Cancellation is
// checked first because it cancels a prior Warning and the word can co-occur.
export function tsunamiSeverity(text = "") {
  if (/\bCancellation\b/i.test(text)) return 1;
  if (/\bWarning\b/i.test(text)) return 5;
  if (/\bWatch\b/i.test(text)) return 4;
  if (/\bAdvisory\b/i.test(text)) return 3;
  return 2; // Information Statement / other
}

// tag() returns "" for a missing coordinate, and Number("") is 0 — which would
// silently plot at the equator. Treat an empty tag as NaN so it gets dropped.
function num(value) {
  return value === "" ? NaN : Number(value);
}

export function parseTsunamiFeed(xml, center) {
  // The document's first <title> is the feed-level message class; per-entry
  // <title>s are the affected location.
  const messageClass = tag(xml, "title");
  const severity = tsunamiSeverity(messageClass);
  return atomEntries(xml).map((entryXml) => {
    const lat = num(tag(entryXml, "geo:lat"));
    const lon = num(tag(entryXml, "geo:long"));
    return {
      center,
      messageClass,
      severity,
      lat,
      lon,
      location: tag(entryXml, "title"),
      updated: tag(entryXml, "updated")
    };
  }).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon));
}

export async function tsunamiLayer() {
  const results = await Promise.all(FEEDS.map((feed) =>
    cachedResilient(`tsunami:${feed.center}`, 10 * 60_000, () =>
      fetchTextRetry(feed.url, { headers: { Accept: "application/atom+xml" } }))
      .then((result) => ({ result, feed }))
      .catch(() => null)));

  const entities = [];
  let stale = false;
  for (const item of results) {
    if (!item) continue;
    if (item.result.stale) stale = true;
    for (const row of parseTsunamiFeed(item.result.value, item.feed.center)) {
      const time = row.updated ? new Date(row.updated) : null;
      entities.push(entity({
        id: `tsunami-${row.center}-${row.lat.toFixed(2)}-${row.lon.toFixed(2)}`,
        layer: "tsunami",
        type: "Tsunami message",
        name: row.location || row.messageClass,
        lat: row.lat,
        lon: row.lon,
        severity: row.severity,
        time: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
        source: `NOAA ${row.center}`,
        summary: [row.messageClass, row.location].filter(Boolean).join(" — "),
        messageClass: row.messageClass,
        center: row.center
      }));
    }
  }

  return {
    entities: entities.filter(finiteCoordinate),
    meta: {
      stale,
      source: "NOAA Tsunami Warning System (PTWC/NTWC)"
    }
  };
}
