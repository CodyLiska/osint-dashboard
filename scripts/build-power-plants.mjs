// Builds public/data/power-plants.json from the WRI Global Power Plant Database.
//
// Run: node scripts/build-power-plants.mjs
//
// The upstream is a frozen dataset (v1.3.0, 2021) of 34,936 plants shipped as a
// CSV inside a ZIP, so it is bundled as a static layer rather than fetched at
// runtime. Bundling all of it would be ~12MB of mostly small solar and hydro
// sites; the layer keeps grid-scale generation (>=500MW) plus every nuclear
// plant regardless of size, since reactor sites are strategically significant at
// any capacity and they also cover what IAEA PRIS would have provided.

import { writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const ZIP_URL = "https://datasets.wri.org/private-admin/dataset/53623dfd-3df6-4f15-a091-67457cdb571f/resource/66bcdacc-3d0e-46ad-9271-a5a76b1853d2/download/globalpowerplantdatabasev130.zip";
const OUT = new URL("../public/data/power-plants.json", import.meta.url);
const MIN_CAPACITY_MW = 500;

// Fuel -> 1-5 severity, read as "strategic significance of losing this plant".
// Nuclear tops the scale (safety + proliferation interest), then dispatchable
// thermal, then renewables whose loss is more easily absorbed.
const FUEL_SEVERITY = {
  Nuclear: 5,
  Coal: 4,
  Gas: 4,
  Oil: 3,
  Hydro: 3,
  Geothermal: 2,
  Biomass: 2,
  Waste: 2,
  Wind: 2,
  Solar: 2,
  Storage: 2,
  Cogeneration: 3,
  "Petcoke": 3,
  "Wave and Tidal": 1,
  Other: 2
};

// Extracts one named entry from a ZIP. node:zlib does raw DEFLATE, not the ZIP
// container, so the 30-byte local header plus its variable-length name/extra
// fields are skipped by hand (same approach as the GDELT adapter).
function extractFromZip(buffer, wantedName) {
  let offset = 0;
  while (offset < buffer.length - 4) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString();
    const dataStart = nameStart + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (name === wantedName) {
      return compressionMethod === 0 ? data : inflateRawSync(data);
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`${wantedName} not found in archive`);
}

// The CSV has quoted fields containing commas (plant and owner names), so it
// needs a real quote-aware split rather than line.split(",").
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i += 1; } else { quoted = false; }
      } else field += char;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const response = await fetch(ZIP_URL);
if (!response.ok) throw new Error(`upstream ${response.status}`);
const csv = extractFromZip(Buffer.from(await response.arrayBuffer()), "global_power_plant_database.csv").toString();

const rows = parseCsv(csv);
const header = rows[0];
const index = Object.fromEntries(header.map((name, i) => [name, i]));
const required = ["gppd_idnr", "name", "capacity_mw", "latitude", "longitude", "primary_fuel", "country_long"];
for (const column of required) {
  if (!(column in index)) throw new Error(`upstream schema changed: missing ${column}`);
}

const records = [];
for (const row of rows.slice(1)) {
  if (row.length < header.length) continue;
  const fuel = row[index.primary_fuel];
  const capacity = Number(row[index.capacity_mw]);
  const lat = Number(row[index.latitude]);
  const lon = Number(row[index.longitude]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  if (!(capacity >= MIN_CAPACITY_MW || fuel === "Nuclear")) continue;

  const year = Number(row[index.commissioning_year]);
  records.push({
    id: `plant-${row[index.gppd_idnr]}`,
    type: `${fuel} power plant`,
    name: row[index.name],
    lat: Math.round(lat * 10000) / 10000,
    lon: Math.round(lon * 10000) / 10000,
    severity: FUEL_SEVERITY[fuel] || 2,
    country: row[index.country_long],
    fuel,
    capacityMw: Math.round(capacity * 10) / 10,
    owner: row[index.owner] || undefined,
    commissioned: Number.isFinite(year) && year > 0 ? Math.trunc(year) : undefined,
    summary: `${Math.round(capacity)} MW ${fuel.toLowerCase()} · ${row[index.country_long]}`
  });
}

records.sort((a, b) => b.capacityMw - a.capacityMw);

const doc = {
  dataset: "power-plants",
  version: 1,
  updated: new Date().toISOString().slice(0, 10),
  source: "WRI Global Power Plant Database v1.3.0",
  license: "CC-BY 4.0 (World Resources Institute)",
  filter: `capacity_mw >= ${MIN_CAPACITY_MW} OR primary_fuel = Nuclear`,
  count: records.length,
  records
};

writeFileSync(OUT, `${JSON.stringify(doc)}\n`);
const nuclear = records.filter((r) => r.fuel === "Nuclear").length;
console.log(`wrote ${records.length} plants (${nuclear} nuclear) from ${rows.length - 1} upstream rows`);
