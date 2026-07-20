import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

// GDACS (Global Disaster Alert and Coordination System) — keyless GeoJSON of
// current global hazards (floods, quakes, cyclones, droughts, volcanoes, fires),
// each with a Green/Orange/Red alert level. Fills the hazard gap FIRMS (fire) and
// EONET (partial) leave open.
const GDACS_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP";

const EVENT_LABEL = {
  EQ: "Earthquake", TC: "Tropical Cyclone", FL: "Flood",
  DR: "Drought", VO: "Volcano", WF: "Wildfire", TS: "Tsunami"
};

// GDACS alert level → OSIRIS 1-5 severity.
const ALERT_SEVERITY = { Green: 2, Orange: 4, Red: 5 };

// GDACS timestamps have no timezone; they are UTC, so force it (a local parse
// would shift the time — see the orbit epoch lesson).
function isoUtc(value) {
  if (!value) return null;
  return /[Zz]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
}

export async function gdacsLayer() {
  const result = await cachedResilient("gdacs:events", 15 * 60_000, () => fetchJsonRetry(GDACS_URL));
  const features = result.value?.features || [];

  const entities = features.map((feature) => {
    const p = feature.properties || {};
    const [lon, lat] = feature.geometry?.coordinates || [];
    return entity({
      id: `gdacs-${p.eventtype}-${p.eventid}`,
      layer: "gdacs",
      type: EVENT_LABEL[p.eventtype] || "Disaster",
      name: p.name || p.eventname || `${EVENT_LABEL[p.eventtype] || "Disaster"} ${p.eventid}`,
      lat,
      lon,
      severity: ALERT_SEVERITY[p.alertlevel] || 2,
      time: isoUtc(p.fromdate),
      source: "GDACS",
      url: p.url?.report || null,
      summary: [p.severitydata?.severitytext, p.alertlevel && `${p.alertlevel} alert`]
        .filter(Boolean).join(" · "),
      alertLevel: p.alertlevel,
      country: p.country
    });
  }).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "GDACS (Global Disaster Alert and Coordination System)"
    }
  };
}
