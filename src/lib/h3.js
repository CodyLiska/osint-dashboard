import { readFileSync } from "node:fs";

// H3 resolution-4 cell -> [lon, lat], read from the table built by
// scripts/build-h3-centroids.mjs. GPSJam reports interference keyed by H3 cell
// with no coordinates, and h3-js is a build-time dependency only — the server
// stays zero-dep, so the conversion is a lookup rather than a hand-ported
// implementation of the H3 projection.
//
// The table is held as one Buffer and binary-searched. Building a 288k-entry Map
// instead would cost tens of MB of heap on a homelab container to answer a few
// hundred lookups a day.

const SCALE = 100;
const HEADER_BYTES = 12;

let table = null;

function load() {
  if (table) return table;
  const buffer = readFileSync(new URL("../../public/data/h3-res4-centroids.bin", import.meta.url));
  if (buffer.length < HEADER_BYTES || buffer.toString("ascii", 0, 4) !== "H3C1") {
    throw new Error("h3 centroid table missing or corrupt (run scripts/build-h3-centroids.mjs)");
  }
  const count = buffer.readUInt32LE(4);
  const expected = HEADER_BYTES + count * 8;
  if (buffer.length !== expected) {
    throw new Error(`h3 centroid table truncated: ${buffer.length} bytes, expected ${expected}`);
  }
  table = { buffer, count, keysAt: HEADER_BYTES, coordsAt: HEADER_BYTES + count * 4 };
  return table;
}

// "84005c7ffffffff" -> the 20-bit key the table is sorted on, or null when the id
// is not a well-formed resolution-4 cell. Returning null (rather than throwing)
// keeps one malformed upstream row from emptying the whole layer.
export function cellKey(cell) {
  const id = String(cell);
  if (id.length !== 15 || !id.startsWith("84") || !id.endsWith("ffffffff")) return null;
  const key = parseInt(id.slice(2, -8), 16);
  return Number.isInteger(key) ? key : null;
}

// [lon, lat] for a resolution-4 cell id, or null if the id is malformed or absent
// from the table. Callers must skip the row on null rather than guessing.
export function cellToLonLat(cell) {
  const key = cellKey(cell);
  if (key === null) return null;
  const { buffer, count, keysAt, coordsAt } = load();

  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = buffer.readUInt32LE(keysAt + mid * 4);
    if (value === key) {
      return [
        buffer.readInt16LE(coordsAt + mid * 4) / SCALE,
        buffer.readInt16LE(coordsAt + mid * 4 + 2) / SCALE
      ];
    }
    if (value < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

export function centroidTableSize() {
  return load().count;
}
