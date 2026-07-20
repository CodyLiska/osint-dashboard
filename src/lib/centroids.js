import { readFileSync } from "node:fs";

// ISO alpha-2 country code -> [lon, lat] centroid, for geolocating country-coded
// feeds (IODA / Cloudflare Radar outages) that report no coordinates. Loaded once
// from the bundled dataset.
export const COUNTRY_CENTROIDS = JSON.parse(
  readFileSync(new URL("../../public/data/country-centroids.json", import.meta.url))
).centroids;
