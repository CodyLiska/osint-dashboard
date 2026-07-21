import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { COUNTRY_CENTROIDS as CENTROIDS } from "../lib/centroids.js";

// IODA (Georgia Tech Internet Outage Detection and Analysis) — keyless. Flags
// countries currently experiencing an internet outage, which correlates strongly
// with conflict and government shutdowns. IODA reports by country/region code
// (no coordinates), so we geolocate to a bundled country centroid.
const IODA_URL = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts";

export async function iodaLayer() {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 6 * 3600; // last 6h of alerts
  const result = await cachedResilient("ioda:outages", 10 * 60_000, () =>
    fetchJsonRetry(`${IODA_URL}?from=${from}&until=${now}`));

  // Take the most recent alert per country; an outage is a country whose latest
  // level is "critical" (a "normal" latest means it has recovered).
  const latest = new Map();
  for (const alert of result.value?.data || []) {
    if (alert.entity?.type !== "country") continue;
    const cc = alert.entity?.attrs?.country_code;
    if (!cc) continue;
    const prev = latest.get(cc);
    if (!prev || alert.time > prev.time) latest.set(cc, alert);
  }

  const entities = [];
  for (const [cc, alert] of latest) {
    if (alert.level !== "critical") continue;
    const centroid = CENTROIDS[cc];
    if (!centroid) continue;
    entities.push(entity({
      id: `ioda-${cc}`,
      layer: "ioda",
      type: "Internet outage",
      name: `Internet outage: ${alert.entity?.name || cc}`,
      lon: centroid[0],
      lat: centroid[1],
      // Constant 5 (see the severity contract in src/lib/normalize.js): a
      // country-level internet blackout has no lesser grade. Escalation can
      // never fire here, and a minSeverity below 5 does not narrow anything.
      severity: 5,
      time: alert.time ? new Date(alert.time * 1000).toISOString() : null,
      source: "IODA",
      summary: `Country-level internet outage detected via ${alert.datasource || "IODA signals"}`,
      country: alert.entity?.name,
      datasource: alert.datasource
    }));
  }

  return {
    entities: entities.filter(finiteCoordinate),
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "IODA (Georgia Tech internet-outage detection)"
    }
  };
}
