// Builds public/data/h3-res4-centroids.bin — the H3 resolution-4 cell -> centroid
// table that the GPSJam layer needs.
//
// Run:
//   npm install --no-save h3-js
//   node scripts/build-h3-centroids.mjs
//   rm -rf node_modules            # nothing else in this project has deps
//
// Why this exists: GPSJam publishes GPS-interference counts keyed by H3 cell id
// with NO coordinates. Turning "84005c7ffffffff" into a lat/lon is the H3
// algorithm (icosahedral face lookup, gnomonic projection, IJK coordinates) —
// several hundred lines of maths that fails silently when subtly wrong. So the
// conversion is done ONCE here against the real library, and the runtime ships a
// lookup table instead of a hand port. h3-js is a build-time dependency only and
// is deliberately never added to package.json; the server stays zero-dep.
//
// Format (little-endian), chosen after measuring the alternatives at 288,122
// cells: naive JSON keyed by the full 15-char id is 16MB, short-keyed JSON is
// 6.3MB, this is 2.2MB — and it needs no JSON.parse, so the server holds one
// Buffer instead of a 288k-key object.
//
//   0..3    magic "H3C1"
//   4..7    uint32  cell count
//   8..11   uint32  resolution
//   12..    uint32  cell keys, ASCENDING (binary-searchable)
//   then    int16 lon, int16 lat per cell, scaled x100, in the same order
//
// x100 gives ~1.1km precision; res-4 cells are ~22km across, so the rounding is
// far below the size of the cell it labels.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let h3;
try {
  h3 = require("h3-js");
} catch {
  console.error("h3-js not installed. Run: npm install --no-save h3-js");
  process.exit(1);
}

const RESOLUTION = 4;
const SCALE = 100;
const OUT = new URL("../public/data/h3-res4-centroids.bin", import.meta.url);

// Every res-4 id is "84" + 5 variable hex chars + "ffffffff", so the 5 middle
// chars (20 bits) are the whole key and fit in a uint32. Asserted below rather
// than assumed — if H3 ever changes its encoding this must fail loudly.
function cellKey(cell) {
  if (cell.length !== 15 || !cell.startsWith("84") || !cell.endsWith("ffffffff")) {
    throw new Error(`unexpected res-4 cell id shape: ${cell}`);
  }
  return parseInt(cell.slice(2, -8), 16);
}

const cells = h3.getRes0Cells().flatMap((cell) => h3.cellToChildren(cell, RESOLUTION));
console.log(`res-${RESOLUTION} cells: ${cells.length}`);

const rows = cells.map((cell) => {
  const [lat, lon] = h3.cellToLatLng(cell);
  return { key: cellKey(cell), lon, lat };
});

rows.sort((a, b) => a.key - b.key);

// Duplicate keys would make the binary search silently return the wrong cell.
for (let i = 1; i < rows.length; i++) {
  if (rows[i].key === rows[i - 1].key) throw new Error(`duplicate key ${rows[i].key}`);
}

const count = rows.length;
const buffer = Buffer.alloc(12 + count * 4 + count * 4);
buffer.write("H3C1", 0, "ascii");
buffer.writeUInt32LE(count, 4);
buffer.writeUInt32LE(RESOLUTION, 8);

const keysAt = 12;
const coordsAt = 12 + count * 4;
rows.forEach((row, i) => {
  buffer.writeUInt32LE(row.key, keysAt + i * 4);
  buffer.writeInt16LE(Math.round(row.lon * SCALE), coordsAt + i * 4);
  buffer.writeInt16LE(Math.round(row.lat * SCALE), coordsAt + i * 4 + 2);
});

writeFileSync(OUT, buffer);
console.log(`wrote ${OUT.pathname} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
