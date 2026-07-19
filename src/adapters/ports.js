import { readFileSync } from "node:fs";
import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

// The NGA World Port Index endpoint intermittently 503s or stalls; fetchJsonRetry
// adds a timeout + retry, and cachedResilient serves the last-good data on failure.
const wpiUrl = "https://msi.nga.mil/api/publications/world-port-index?output=json";

// Bundled cold-start fallback: cachedResilient can only serve stale data once
// something has been fetched, so a cold boot while NGA is 503-ing has nothing to
// serve and would throw. This static subset (Large + Medium harbors from the WPI,
// public-domain U.S. Gov data) keeps the layer populated in that case.
const fallbackPorts = JSON.parse(
  readFileSync(new URL("../../public/data/ports-fallback.json", import.meta.url), "utf8")
).ports || [];

function sizeRank(size) {
  return { V: 1, S: 2, M: 3, L: 4 }[String(size || "").toUpperCase()] || 1;
}

function harborSizeLabel(size) {
  return {
    V: "Very small",
    S: "Small",
    M: "Medium",
    L: "Large"
  }[String(size || "").toUpperCase()] || "Unknown";
}

function yes(value) {
  return String(value || "").toUpperCase() === "Y";
}

function portSeverity(port) {
  let score = sizeRank(port.harborSize);
  if (yes(port.firstPortOfEntry)) score += 1;
  if (yes(port.loContainer) || yes(port.loOilTerm) || yes(port.loRoro)) score += 1;
  if (yes(port.vts) || yes(port.tss)) score += 1;
  return Math.min(5, Math.max(1, score));
}

function normalizeBounds(bounds = {}) {
  if (["lamin", "lomin", "lamax", "lomax"].some((key) => bounds[key] === null || bounds[key] === undefined || bounds[key] === "")) {
    return null;
  }
  const lamin = Number(bounds.lamin);
  const lomin = Number(bounds.lomin);
  const lamax = Number(bounds.lamax);
  const lomax = Number(bounds.lomax);
  if (![lamin, lomin, lamax, lomax].every(Number.isFinite)) return null;
  return {
    south: Math.max(-90, Math.min(lamin, lamax)),
    north: Math.min(90, Math.max(lamin, lamax)),
    west: Math.max(-180, Math.min(180, lomin)),
    east: Math.max(-180, Math.min(180, lomax))
  };
}

function inBounds(port, bounds) {
  if (!bounds) return true;
  const lat = Number(port.ycoord);
  const lon = Number(port.xcoord);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const latOk = lat >= bounds.south && lat <= bounds.north;
  const lonOk = bounds.west <= bounds.east
    ? lon >= bounds.west && lon <= bounds.east
    : lon >= bounds.west || lon <= bounds.east;
  return latOk && lonOk;
}

function sortPorts(a, b) {
  return portSeverity(b) - portSeverity(a)
    || sizeRank(b.harborSize) - sizeRank(a.harborSize)
    || String(a.portName).localeCompare(String(b.portName));
}

function portEntity(port) {
  const facilities = [
    yes(port.firstPortOfEntry) && "entry",
    yes(port.loContainer) && "container",
    yes(port.loOilTerm) && "oil terminal",
    yes(port.loRoro) && "roro",
    yes(port.tugsAssist) && "tugs",
    yes(port.suFuel) && "fuel",
    yes(port.vts) && "VTS"
  ].filter(Boolean);

  return entity({
    id: `wpi-port-${port.portNumber}`,
    layer: "ports",
    type: "World Port Index port",
    name: port.portName,
    lat: port.ycoord,
    lon: port.xcoord,
    severity: portSeverity(port),
    source: "NGA World Port Index",
    summary: [
      port.countryName,
      `${harborSizeLabel(port.harborSize)} harbor`,
      port.unloCode && `UN/LOCODE ${port.unloCode}`,
      facilities.length && facilities.join(", ")
    ].filter(Boolean).join(" · "),
    country: port.countryName,
    countryCode: port.countryCode,
    region: port.regionName,
    portNumber: port.portNumber,
    harborSize: harborSizeLabel(port.harborSize),
    harborSizeCode: port.harborSize,
    harborType: port.harborType,
    navArea: port.navArea,
    unloCode: port.unloCode,
    chartNumber: port.chartNumber,
    publicationNumber: port.publicationNumber,
    facilities,
    raw: port
  });
}

export async function portsLayer(bounds = {}) {
  // On a cold failure (nothing cached + NGA down) cachedResilient throws; fall
  // back to the bundled subset and flag it stale so the UI shows the ⚠ indicator.
  let result;
  try {
    result = await cachedResilient("nga:wpi", 24 * 60 * 60_000, () => fetchJsonRetry(wpiUrl));
  } catch {
    result = { value: { ports: fallbackPorts }, cached: true, stale: true, fallback: true };
  }
  const allPorts = result.value.ports || [];
  const normalizedBounds = normalizeBounds(bounds);
  const max = Number(process.env.PORTS_MAX_ITEMS || 1200);
  const filtered = allPorts
    .filter((port) => Number.isFinite(Number(port.ycoord)) && Number.isFinite(Number(port.xcoord)))
    .filter((port) => inBounds(port, normalizedBounds))
    .sort(sortPorts);

  const entities = filtered.slice(0, max).map(portEntity).filter(finiteCoordinate);

  const sizeCounts = allPorts.reduce((acc, port) => {
    const key = harborSizeLabel(port.harborSize);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    entities,
    meta: {
      source: "NGA World Port Index",
      count: entities.length,
      totalPorts: allPorts.length,
      matchedPorts: filtered.length,
      cappedAt: max,
      sizeCounts,
      viewportAware: Boolean(normalizedBounds),
      cached: result.cached,
      stale: Boolean(result.stale),
      fallback: Boolean(result.fallback)
    }
  };
}
