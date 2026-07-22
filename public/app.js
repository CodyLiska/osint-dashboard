import { LAYER_GROUPS, layerDefinitions, loadStaticLayers } from "./data.js";
import {
  escapeHtml, clusterPoints, shouldCluster, buildFeed, advancePosition, filterBySeverity,
  detailRows, snapshotEntity, extLink, sanctionDetail, intelLinks, intelCards, cveDetail, relativeTime, ruleHealth,
  attackTags, correlationBanner, scrubberTime, replayEntities, boundsKey, CLUSTER_MAX_ZOOM
} from "./logic.js";

// Populated from the versioned public/data/*.json datasets before initial hydrate.
let staticLayers = {};

// Gazetteer places (name/lat/lon/aliases) used as the place-search fallback so
// typing any known city/port/capital recentres the map even when no live entity
// for it is loaded. Best-effort: an empty list just limits search to entities.
let gazetteerPlaces = [];

async function loadGazetteer() {
  try {
    const response = await fetch("/data/gazetteer.json");
    if (!response.ok) return;
    const doc = await response.json();
    gazetteerPlaces = Array.isArray(doc.records) ? doc.records : [];
  } catch {
    // best-effort; place search falls back to loaded entities only
  }
}

// Persisted UI state (layer visibility, map viewport, recon history) lives under
// one namespaced localStorage key. All access is best-effort: private-mode blocks
// or a full quota must never break the dashboard.
const STORAGE_KEY = "osiris.ui.v1";
const RECON_HISTORY_LIMIT = 20;
// Keep in step with --pane-transition in styles.css so the camera pan tracks the
// pane's slide.
const PANE_TRANSITION_MS = 220;
const DEFAULT_LAYERS = ["conflict", "seismic", "ports", "chokepoints", "telegram"];

function loadStore() {
  // The recon pane holds burst-use tooling, so it starts closed and gives the
  // width back to the map. Spread saved LAST so an explicit `hideRight: false`
  // survives; only an absent key picks up the default.
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    return { hideRight: true, ...saved };
  } catch {
    return { hideRight: true };
  }
}

const store = loadStore();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage unavailable (private mode) or over quota — skip persistence
  }
}

const state = {
  enabled: new Set(Array.isArray(store.enabled) ? store.enabled : DEFAULT_LAYERS),
  data: new Map(),
  meta: new Map(),
  fetched: new Set(),
  refreshing: new Set(),
  lastFetched: new Map(),
  // Per layer: the bbox key its current data was fetched for, and whether a map
  // move arrived while that fetch was still in flight. See refreshForViewport().
  fetchedBounds: new Map(),
  staleViewport: new Set(),
  minSeverity: Math.min(5, Math.max(1, Number(store.minSeverity) || 1)),
  deckOverlay: null,
  map: null
};

// Per-layer poll cadence (ms). Only live (API-backed) layers appear here; static
// layers never poll. Fast-moving feeds refresh often, slow reference feeds rarely.
const LAYER_REFRESH_MS = {
  seismic: 60_000,
  aviation: 60_000,
  "military-air": 60_000,
  maritime: 60_000,
  telegram: 120_000,
  fires: 300_000,
  weather: 300_000,
  news: 300_000,
  space: 300_000,
  crypto: 300_000,
  ports: 600_000,
  cyber: 900_000,
  gdelt: 900_000,
  gdacs: 300_000,
  ucdp: 1_800_000,
  nws: 300_000,
  ioda: 300_000,
  cloudflare: 1_800_000,
  sanctions: 1_800_000,
  // Advisories change on the order of weeks and OSM infrastructure barely at
  // all; both upstreams are courtesy-use, so they poll slowly.
  advisories: 3_600_000,
  reliefweb: 900_000,
  infrastructure: 1_800_000
};
// One ticker checks every layer's elapsed time against its cadence, so intervals
// are measured from the last actual fetch (a manual or viewport refresh resets the
// clock) rather than fixed wall-clock multiples.
const POLL_TICK_MS = 15_000;
const VIEWPORT_AWARE_LAYERS = new Set(["aviation", "military-air", "fires", "weather", "ports", "infrastructure"]);

// Live layers fetched with the current viewport bbox; every other live layer
// fetches globally. (A superset of VIEWPORT_AWARE_LAYERS — maritime also loads
// with bounds but isn't re-fetched on map move.) Any live layer not listed here
// simply fetches globally, so a new source needs no change to ensureLayer.
const BOUNDS_LAYERS = new Set(["aviation", "military-air", "fires", "weather", "ports", "maritime", "infrastructure"]);

const els = {
  layerList: document.querySelector("#layer-list"),
  activeCount: document.querySelector("#active-count"),
  entityCount: document.querySelector("#entity-count"),
  detail: document.querySelector("#entity-detail"),
  feedList: document.querySelector("#feed-list"),
  sourceHealth: document.querySelector("#source-health"),
  clock: document.querySelector("#clock")
};

const palette = new Map(layerDefinitions.map((layer) => [layer.id, layer.color]));
const layerLabels = new Map(layerDefinitions.map((layer) => [layer.id, layer.label]));
const aircraftIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M33.8 4.8c-1-1.9-2.6-1.9-3.6 0-1 1.8-1.4 7.1-1.4 12.2v8.2L7.1 36.8c-1.6.9-2.7 2.6-2.7 4.5v3.1l24.4-7.6v9.7l-7.3 5.6v2.9l9.3-2.8 9.3 2.8v-2.9l-7.3-5.6v-9.7l24.4 7.6v-3.1c0-1.9-1-3.6-2.7-4.5L32.8 25.2V17c0-5.1-.1-10.4 1-12.2Z"/>
</svg>
`)}`;
const aircraftIconMapping = {
  plane: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true }
};
const portIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M32 4a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/>
  <path fill="white" d="M29 23h6v25c7.3-1.1 12-5.4 14.3-12.9l-6.6 1.9-1.7-5.8 15.6-4.5L61 42.4l-5.8 1.7-1.7-5.8C49.8 48.5 42.6 54 32 54S14.2 48.5 10.5 38.3l-1.7 5.8L3 42.4l4.4-15.7L23 31.2 21.3 37l-6.6-1.9C17 42.6 21.7 46.9 29 48V23Z"/>
</svg>
`)}`;
const portIconMapping = {
  port: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 54, mask: true }
};
const fireIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M33 59c-11.7 0-21-8.4-21-20 0-8.5 5.3-14.5 10.2-20.2 2.8-3.2 5.4-6.2 6.5-9.8.3-1.1 1.7-1.4 2.4-.5 3.6 4.4 5.3 9.2 5.1 14.5 2.1-1.7 3.7-4.1 4.8-7.1.4-1.1 1.9-1.2 2.5-.2C48.4 23.4 52 30.2 52 38.5 52 50.3 44.4 59 33 59Zm-1.2-8.5c5.4 0 9.2-3.8 9.2-9 0-4.2-1.9-7.7-4.7-11.7-.9 2.6-2.4 4.9-4.8 6.8-.9.7-2.3 0-2.1-1.2.5-3.9-.3-7.2-2.2-10.3-3.3 4-6.2 8.2-6.2 14.2 0 6.4 4.7 11.2 10.8 11.2Z"/>
</svg>
`)}`;
const fireIconMapping = {
  fire: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 54, mask: true }
};
const quakeIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M32 4 7 47h17l-4 13 27-38H32l8-18h-8Z"/>
  <path fill="white" d="M9 56h12v4H9zm18 0h11v4H27zm16 0h12v4H43z"/>
</svg>
`)}`;
const quakeIconMapping = {
  quake: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 46, mask: true }
};
const weatherIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="192" height="64" viewBox="0 0 192 64">
  <g id="storm">
    <path fill="white" d="M46 48H18C9.7 48 4 42.3 4 34.7c0-6.8 4.8-12.2 11.4-13.2C18.2 13.1 26.1 7 35.5 7 46.9 7 56 16.1 56 27.3 61 29.4 64 33.8 64 39c0 5.2-4 9-18 9Z"/>
    <path fill="white" d="m28 51-6 10h9l-3 9 12-16h-9l4-8z"/>
  </g>
  <g id="flood" transform="translate(64 0)">
    <path fill="white" d="M47 34H19C10.7 34 5 28.3 5 20.7 5 13.1 11.2 7 18.9 7c2.9 0 5.7.9 8 2.6C30.1 5.6 35 3 40.5 3 51.3 3 60 11.7 60 22.5 60 29 55.6 34 47 34Z"/>
    <path fill="white" d="M8 45c5.6-4 11.4-4 17 0s11.4 4 17 0 11.4-4 17 0v6c-5.6-4-11.4-4-17 0s-11.4 4-17 0-11.4-4-17 0v-6Zm0 12c5.6-4 11.4-4 17 0s11.4 4 17 0 11.4-4 17 0v6c-5.6-4-11.4-4-17 0s-11.4 4-17 0-11.4-4-17 0v-6Z"/>
  </g>
  <g id="volcano" transform="translate(128 0)">
    <path fill="white" d="m17 58 13-31h8l13 31H17Z"/>
    <path fill="white" d="M28 18c-4-4-4-9 0-13 2 4 5 5 9 2 4 5 3 10-1 14 7 0 13 5 15 12H13c1-8 7-14 15-15Z"/>
  </g>
</svg>
`)}`;
const weatherIconMapping = {
  storm: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 42, mask: true },
  flood: { x: 64, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 44, mask: true },
  volcano: { x: 128, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 54, mask: true }
};
const spaceIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64" viewBox="0 0 128 64">
  <g id="kp">
    <circle fill="white" cx="32" cy="32" r="13"/>
    <path fill="white" d="M32 4a3 3 0 0 1 3 3v8a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Zm0 42a3 3 0 0 1 3 3v8a3 3 0 1 1-6 0v-8a3 3 0 0 1 3-3ZM4 32a3 3 0 0 1 3-3h8a3 3 0 1 1 0 6H7a3 3 0 0 1-3-3Zm42 0a3 3 0 0 1 3-3h8a3 3 0 1 1 0 6h-8a3 3 0 0 1-3-3ZM12.2 12.2a3 3 0 0 1 4.2 0l5.6 5.6a3 3 0 0 1-4.2 4.2l-5.6-5.6a3 3 0 0 1 0-4.2Zm29.8 29.8a3 3 0 0 1 4.2 0l5.6 5.6a3 3 0 0 1-4.2 4.2L42 46.2a3 3 0 0 1 0-4.2Zm9.8-29.8a3 3 0 0 1 0 4.2L46.2 22a3 3 0 0 1-4.2-4.2l5.6-5.6a3 3 0 0 1 4.2 0ZM22 42a3 3 0 0 1 0 4.2l-5.6 5.6a3 3 0 0 1-4.2-4.2l5.6-5.6A3 3 0 0 1 22 42Z"/>
  </g>
  <g id="alert" transform="translate(64 0)">
    <path fill="white" d="M32 5 3 57h58L32 5Zm0 16a3 3 0 0 1 3 3v15a3 3 0 1 1-6 0V24a3 3 0 0 1 3-3Zm0 28a3.8 3.8 0 1 1 0-7.6 3.8 3.8 0 0 1 0 7.6Z"/>
  </g>
</svg>
`)}`;
const spaceIconMapping = {
  kp: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true },
  alert: { x: 64, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 54, mask: true }
};
const telegramIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M58.8 8.5 49.3 54c-.7 3.2-2.6 4-5.2 2.5L29.6 45.8l-7 6.8c-.8.8-1.4 1.4-2.9 1.4l1-14.8L47.8 14.7c1.2-1.1-.3-1.7-1.8-.6L12.5 35.2 1.9 31.9c-3.1-1-3.2-3.1.7-4.6L54.1 7.4c2.4-.9 4.5.6 4.7 1.1Z"/>
</svg>
`)}`;
const telegramIconMapping = {
  telegram: { x: 0, y: 0, width: 64, height: 64, anchorX: 28, anchorY: 42, mask: true }
};
const cyberIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M32 4 9 13v17c0 15.2 9.7 25.8 23 30 13.3-4.2 23-14.8 23-30V13L32 4Zm0 9.2 14 5.5V30c0 9.9-5.3 17.3-14 21-8.7-3.7-14-11.1-14-21V18.7l14-5.5Z"/>
  <path fill="white" d="M31.8 20c4.4 0 7.8 3.1 8.2 7.3h4.5v5H40v4h4.5v5H39c-1.4 3.3-4.1 5.3-7.2 5.3s-5.8-2-7.2-5.3H19v-5h4.5v-4H19v-5h4.5c.5-4.2 3.9-7.3 8.3-7.3Zm-3.4 12.3v4.2c0 3.1 1.4 5 3.4 5s3.4-1.9 3.4-5v-4.2h-6.8Zm.2-5h6.4c-.5-1.5-1.6-2.4-3.2-2.4s-2.7.9-3.2 2.4Z"/>
</svg>
`)}`;
const cyberIconMapping = {
  cyber: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 48, mask: true }
};
const cryptoIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M32 4c15.5 0 28 6.3 28 14v28c0 7.7-12.5 14-28 14S4 53.7 4 46V18C4 10.3 16.5 4 32 4Zm0 8C20.4 12 12 15.6 12 18s8.4 6 20 6 20-3.6 20-6-8.4-6-20-6Zm20 17.1C47 32.1 40 34 32 34s-15-1.9-20-4.9V34c0 2.4 8.4 6 20 6s20-3.6 20-6v-4.9Zm0 15.8C47 47.9 40 50 32 50s-15-2.1-20-5.1V46c0 2.4 8.4 6 20 6s20-3.6 20-6v-1.1Z"/>
  <path fill="white" d="M34.8 14.5v2.3c3.5.5 6.2 2.3 6.2 5.4 0 2.4-1.5 4-4.1 4.9 3 .8 4.9 2.6 4.9 5.5 0 3.6-2.9 5.8-7 6.3v2.6h-4.1V39h-5.1v2.5h-3.8V14.5h3.8V17h5.1v-2.5h4.1Zm-5.1 6.4v4.5h3.4c2 0 3.2-.7 3.2-2.2s-1.2-2.3-3.3-2.3h-3.3Zm0 8.4v5.5h3.9c2.1 0 3.4-1 3.4-2.7s-1.3-2.8-3.6-2.8h-3.7Z"/>
</svg>
`)}`;
const cryptoIconMapping = {
  crypto: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 44, mask: true }
};
const sanctionsIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M32 4 8 14v16c0 15.6 10.1 26.1 24 30 13.9-3.9 24-14.4 24-30V14L32 4Zm0 8.8 16 6.7V30c0 10.5-5.8 18.1-16 21.5C21.8 48.1 16 40.5 16 30V19.5l16-6.7Z"/>
  <path fill="white" d="M24 24h16v5H24zm0 9h16v5H24zm0 9h10v5H24z"/>
  <path fill="white" d="m44.4 40.2 3.4 3.4 3.4-3.4 3.6 3.6-3.4 3.4 3.4 3.4-3.6 3.6-3.4-3.4-3.4 3.4-3.6-3.6 3.4-3.4-3.4-3.4z"/>
</svg>
`)}`;
const sanctionsIconMapping = {
  sanctions: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 50, mask: true }
};
const chokepointsIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M8 14 L8 50 L28 32 Z M56 14 L56 50 L36 32 Z"/>
</svg>
`)}`;
const chokepointsIconMapping = {
  chokepoint: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true }
};
const cctvIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M10 20 h24 v14 h-24 z M34 24 l10 -3 v12 l-10 -3 z M20 34 h4 v8 h8 v3 h-20 v-3 h8 z"/>
</svg>
`)}`;
const cctvIconMapping = {
  cctv: { x: 0, y: 0, width: 64, height: 64, anchorX: 22, anchorY: 45, mask: true }
};
const newsIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M13 46 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 z"/>
  <path fill="white" d="M18 36 A10 10 0 0 1 28 46 L33 46 A15 15 0 0 0 18 31 Z"/>
  <path fill="white" d="M18 26 A20 20 0 0 1 38 46 L43 46 A25 25 0 0 0 18 21 Z"/>
</svg>
`)}`;
const newsIconMapping = {
  news: { x: 0, y: 0, width: 64, height: 64, anchorX: 18, anchorY: 46, mask: true }
};
const conflictSword = "M32 4 L35 9 L35 38 L29 38 L29 9 Z M22 37 H42 V43 H22 Z M30 43 H34 V52 H30 Z M28.5 55 a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0 Z";
const conflictIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <g fill="white">
    <path transform="rotate(45 32 32)" d="${conflictSword}"/>
    <path transform="rotate(-45 32 32)" d="${conflictSword}"/>
  </g>
</svg>
`)}`;
const conflictIconMapping = {
  conflict: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true }
};
const maritimeIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M8 40 H56 L49 51 H15 Z M22 28 H42 V40 H22 Z M30 20 H36 V28 H30 Z"/>
</svg>
`)}`;
const maritimeIconMapping = {
  maritime: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 51, mask: true }
};
const militaryStar = "M32 6 L38.5 23.1 L56.7 24 L42.5 35.4 L47.3 53 L32 43 L16.7 53 L21.5 35.4 L7.3 24 L25.5 23.1 Z";
const militaryIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="${militaryStar}"/>
</svg>
`)}`;
const militaryIconMapping = {
  military: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true }
};
const gdeltIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" fill-rule="evenodd" d="M32 6a26 26 0 1 0 0 52 26 26 0 0 0 0-52Zm0 6a20 20 0 1 1 0 40 20 20 0 0 1 0-40Z"/>
  <path fill="white" fill-rule="evenodd" d="M32 18a14 14 0 1 0 0 28 14 14 0 0 0 0-28Zm0 6a8 8 0 1 1 0 16 8 8 0 0 1 0-16Z"/>
  <circle fill="white" cx="32" cy="32" r="4"/>
</svg>
`)}`;
const gdeltIconMapping = {
  gdelt: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true }
};
const gdacsIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="M32 6 3 58h58L32 6Zm0 13a3.2 3.2 0 0 1 3.2 3.4l-1 18a2.2 2.2 0 0 1-4.4 0l-1-18A3.2 3.2 0 0 1 32 19Zm0 27a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2Z"/>
</svg>
`)}`;
const gdacsIconMapping = {
  gdacs: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 54, mask: true }
};
const iodaIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" fill-rule="evenodd" d="M32 6a26 26 0 1 0 0 52 26 26 0 0 0 0-52Zm0 6a20 20 0 1 1 0 40 20 20 0 0 1 0-40Z"/>
  <path fill="white" d="M18.9 15.3 48.7 45.1l-3.6 3.6L15.3 18.9z"/>
</svg>
`)}`;
const iodaIconMapping = {
  ioda: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true }
};
// Travel advisories: a passport-style shield with a warning bar.
const advisoriesIconPath = "M32 5 10 14v18c0 13.7 9.2 23.6 22 27 12.8-3.4 22-13.3 22-27V14L32 5Zm-3 12h6v18h-6V17Zm0 23h6v6h-6v-6Z";
const advisoriesIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="${advisoriesIconPath}"/>
</svg>
`)}`;
const advisoriesIconMapping = {
  advisories: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true }
};
// ReliefWeb: humanitarian aid / relief hands.
const reliefIconPath = "M32 10c-4 0-7 2.6-8.4 6.2C22.2 15.4 20.6 15 19 15c-5 0-9 4-9 9 0 6.4 5.6 12.4 12.5 17.6L32 49l9.5-7.4C48.4 36.4 54 30.4 54 24c0-5-4-9-9-9-1.6 0-3.2.4-4.6 1.2C39 12.6 36 10 32 10Zm-3 34H15v6h34v-6H35v-3h-6v3Z";
const reliefIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="${reliefIconPath}"/>
</svg>
`)}`;
const reliefIconMapping = {
  reliefweb: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 44, mask: true }
};
// Infrastructure: a transmission pylon.
const infraIconPath = "M22 6h20v5H22V6Zm-1 9h22l9 43h-6l-2-10H20l-2 10h-6l9-43Zm4.5 6-1.5 7h16l-1.5-7h-13Zm-2.8 13-1.5 7h23.6l-1.5-7H22.7Z";
const infraIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="${infraIconPath}"/>
</svg>
`)}`;
const infraIconMapping = {
  infrastructure: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 56, mask: true }
};
// Power plants: cooling tower with a plume.
const powerIconPath = "M20 24h24l6 34H14l6-34Zm4 6-1 6h18l-1-6H24Zm-3 12-2 10h26l-2-10H21ZM31 4h6l-4 10h6L29 22l3-9h-5l4-9Z";
const powerIconAtlas = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <path fill="white" d="${powerIconPath}"/>
</svg>
`)}`;
const powerIconMapping = {
  "power-plants": { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 56, mask: true }
};
const menuIcons = {
  advisories: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="${advisoriesIconPath}"/></svg>`,
  reliefweb: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="${reliefIconPath}"/></svg>`,
  infrastructure: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="${infraIconPath}"/></svg>`,
  "power-plants": `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="${powerIconPath}"/></svg>`,
  aviation: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M33.8 4.8c-1-1.9-2.6-1.9-3.6 0-1 1.8-1.4 7.1-1.4 12.2v8.2L7.1 36.8c-1.6.9-2.7 2.6-2.7 4.5v3.1l24.4-7.6v9.7l-7.3 5.6v2.9l9.3-2.8 9.3 2.8v-2.9l-7.3-5.6v-9.7l24.4 7.6v-3.1c0-1.9-1-3.6-2.7-4.5L32.8 25.2V17c0-5.1-.1-10.4 1-12.2Z"/></svg>`,
  ports: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M29 23h6v25c7.3-1.1 12-5.4 14.3-12.9l-6.6 1.9-1.7-5.8 15.6-4.5L61 42.4l-5.8 1.7-1.7-5.8C49.8 48.5 42.6 54 32 54S14.2 48.5 10.5 38.3l-1.7 5.8L3 42.4l4.4-15.7L23 31.2 21.3 37l-6.6-1.9C17 42.6 21.7 46.9 29 48V23Z"/></svg>`,
  fires: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M33 59c-11.7 0-21-8.4-21-20 0-8.5 5.3-14.5 10.2-20.2 2.8-3.2 5.4-6.2 6.5-9.8.3-1.1 1.7-1.4 2.4-.5 3.6 4.4 5.3 9.2 5.1 14.5 2.1-1.7 3.7-4.1 4.8-7.1.4-1.1 1.9-1.2 2.5-.2C48.4 23.4 52 30.2 52 38.5 52 50.3 44.4 59 33 59Zm-1.2-8.5c5.4 0 9.2-3.8 9.2-9 0-4.2-1.9-7.7-4.7-11.7-.9 2.6-2.4 4.9-4.8 6.8-.9.7-2.3 0-2.1-1.2.5-3.9-.3-7.2-2.2-10.3-3.3 4-6.2 8.2-6.2 14.2 0 6.4 4.7 11.2 10.8 11.2Z"/></svg>`,
  seismic: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 7 47h17l-4 13 27-38H32l8-18h-8Z"/><path d="M9 56h12v4H9zm18 0h11v4H27zm16 0h12v4H43z"/></svg>`,
  weather: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M46 48H18C9.7 48 4 42.3 4 34.7c0-6.8 4.8-12.2 11.4-13.2C18.2 13.1 26.1 7 35.5 7 46.9 7 56 16.1 56 27.3 61 29.4 64 33.8 64 39c0 5.2-4 9-18 9Z"/><path d="m28 51-6 10h9l-3 9 12-16h-9l4-8z"/></svg>`,
  space: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="13"/><path d="M32 4a3 3 0 0 1 3 3v8a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Zm0 42a3 3 0 0 1 3 3v8a3 3 0 1 1-6 0v-8a3 3 0 0 1 3-3ZM4 32a3 3 0 0 1 3-3h8a3 3 0 1 1 0 6H7a3 3 0 0 1-3-3Zm42 0a3 3 0 0 1 3-3h8a3 3 0 1 1 0 6h-8a3 3 0 0 1-3-3ZM12.2 12.2a3 3 0 0 1 4.2 0l5.6 5.6a3 3 0 0 1-4.2 4.2l-5.6-5.6a3 3 0 0 1 0-4.2Zm29.8 29.8a3 3 0 0 1 4.2 0l5.6 5.6a3 3 0 0 1-4.2 4.2L42 46.2a3 3 0 0 1 0-4.2Zm9.8-29.8a3 3 0 0 1 0 4.2L46.2 22a3 3 0 0 1-4.2-4.2l5.6-5.6a3 3 0 0 1 4.2 0ZM22 42a3 3 0 0 1 0 4.2l-5.6 5.6a3 3 0 0 1-4.2-4.2l5.6-5.6A3 3 0 0 1 22 42Z"/></svg>`,
  telegram: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M58.8 8.5 49.3 54c-.7 3.2-2.6 4-5.2 2.5L29.6 45.8l-7 6.8c-.8.8-1.4 1.4-2.9 1.4l1-14.8L47.8 14.7c1.2-1.1-.3-1.7-1.8-.6L12.5 35.2 1.9 31.9c-3.1-1-3.2-3.1.7-4.6L54.1 7.4c2.4-.9 4.5.6 4.7 1.1Z"/></svg>`,
  cyber: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 9 13v17c0 15.2 9.7 25.8 23 30 13.3-4.2 23-14.8 23-30V13L32 4Zm0 9.2 14 5.5V30c0 9.9-5.3 17.3-14 21-8.7-3.7-14-11.1-14-21V18.7l14-5.5Z"/><path d="M31.8 20c4.4 0 7.8 3.1 8.2 7.3h4.5v5H40v4h4.5v5H39c-1.4 3.3-4.1 5.3-7.2 5.3s-5.8-2-7.2-5.3H19v-5h4.5v-4H19v-5h4.5c.5-4.2 3.9-7.3 8.3-7.3Zm-3.4 12.3v4.2c0 3.1 1.4 5 3.4 5s3.4-1.9 3.4-5v-4.2h-6.8Zm.2-5h6.4c-.5-1.5-1.6-2.4-3.2-2.4s-2.7.9-3.2 2.4Z"/></svg>`,
  crypto: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4c15.5 0 28 6.3 28 14v28c0 7.7-12.5 14-28 14S4 53.7 4 46V18C4 10.3 16.5 4 32 4Zm0 8C20.4 12 12 15.6 12 18s8.4 6 20 6 20-3.6 20-6-8.4-6-20-6Zm20 17.1C47 32.1 40 34 32 34s-15-1.9-20-4.9V34c0 2.4 8.4 6 20 6s20-3.6 20-6v-4.9Zm0 15.8C47 47.9 40 50 32 50s-15-2.1-20-5.1V46c0 2.4 8.4 6 20 6s20-3.6 20-6v-1.1Z"/><path d="M34.8 14.5v2.3c3.5.5 6.2 2.3 6.2 5.4 0 2.4-1.5 4-4.1 4.9 3 .8 4.9 2.6 4.9 5.5 0 3.6-2.9 5.8-7 6.3v2.6h-4.1V39h-5.1v2.5h-3.8V14.5h3.8V17h5.1v-2.5h4.1Zm-5.1 6.4v4.5h3.4c2 0 3.2-.7 3.2-2.2s-1.2-2.3-3.3-2.3h-3.3Zm0 8.4v5.5h3.9c2.1 0 3.4-1 3.4-2.7s-1.3-2.8-3.6-2.8h-3.7Z"/></svg>`,
  sanctions: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 8 14v16c0 15.6 10.1 26.1 24 30 13.9-3.9 24-14.4 24-30V14L32 4Zm0 8.8 16 6.7V30c0 10.5-5.8 18.1-16 21.5C21.8 48.1 16 40.5 16 30V19.5l16-6.7Z"/><path d="M24 24h16v5H24zm0 9h16v5H24zm0 9h10v5H24z"/><path d="m44.4 40.2 3.4 3.4 3.4-3.4 3.6 3.6-3.4 3.4 3.4 3.4-3.6 3.6-3.4-3.4-3.4 3.4-3.6-3.6 3.4-3.4-3.4-3.4z"/></svg>`,
  chokepoints: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 14 L8 50 L28 32 Z M56 14 L56 50 L36 32 Z"/></svg>`,
  cctv: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 20 h24 v14 h-24 z M34 24 l10 -3 v12 l-10 -3 z M20 34 h4 v8 h8 v3 h-20 v-3 h8 z"/></svg>`,
  news: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M13 46 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 z"/><path d="M18 36 A10 10 0 0 1 28 46 L33 46 A15 15 0 0 0 18 31 Z"/><path d="M18 26 A20 20 0 0 1 38 46 L43 46 A25 25 0 0 0 18 21 Z"/></svg>`,
  gdelt: `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill-rule="evenodd" d="M32 6a26 26 0 1 0 0 52 26 26 0 0 0 0-52Zm0 6a20 20 0 1 1 0 40 20 20 0 0 1 0-40Z"/><path fill-rule="evenodd" d="M32 18a14 14 0 1 0 0 28 14 14 0 0 0 0-28Zm0 6a8 8 0 1 1 0 16 8 8 0 0 1 0-16Z"/><circle cx="32" cy="32" r="4"/></svg>`,
  gdacs: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6 3 58h58L32 6Zm0 13a3.2 3.2 0 0 1 3.2 3.4l-1 18a2.2 2.2 0 0 1-4.4 0l-1-18A3.2 3.2 0 0 1 32 19Zm0 27a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2Z"/></svg>`,
  nws: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6a13 13 0 0 0-13 13c0 12-5 16-7 19a2 2 0 0 0 1.7 3h36.6a2 2 0 0 0 1.7-3c-2-3-7-7-7-19A13 13 0 0 0 32 6Zm0 52a7 7 0 0 0 6.7-5H25.3A7 7 0 0 0 32 58Z"/></svg>`,
  ioda: `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill-rule="evenodd" d="M32 6a26 26 0 1 0 0 52 26 26 0 0 0 0-52Zm0 6a20 20 0 1 1 0 40 20 20 0 0 1 0-40Z"/><path d="M18.9 15.3 48.7 45.1l-3.6 3.6L15.3 18.9z"/></svg>`,
  conflict: `<svg viewBox="0 0 64 64" aria-hidden="true"><path transform="rotate(45 32 32)" d="${conflictSword}"/><path transform="rotate(-45 32 32)" d="${conflictSword}"/></svg>`,
  maritime: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 40 H56 L49 51 H15 Z M22 28 H42 V40 H22 Z M30 20 H36 V28 H30 Z"/></svg>`,
  military: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="${militaryStar}"/></svg>`,
  "military-air": `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M33.8 4.8c-1-1.9-2.6-1.9-3.6 0-1 1.8-1.4 7.1-1.4 12.2v8.2L7.1 36.8c-1.6.9-2.7 2.6-2.7 4.5v3.1l24.4-7.6v9.7l-7.3 5.6v2.9l9.3-2.8 9.3 2.8v-2.9l-7.3-5.6v-9.7l24.4 7.6v-3.1c0-1.9-1-3.6-2.7-4.5L32.8 25.2V17c0-5.1-.1-10.4 1-12.2Z"/></svg>`
};

function initMap() {
  const savedView = store.viewport;
  state.map = new maplibregl.Map({
    container: "map",
    center: Array.isArray(savedView?.center) ? savedView.center : [20, 24],
    zoom: Number.isFinite(savedView?.zoom) ? savedView.zoom : 2.1,
    attributionControl: false,
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "OpenStreetMap"
        }
      },
      layers: [{ id: "osm", type: "raster", source: "osm", paint: { "raster-opacity": 0.42 } }]
    }
  });

  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
  state.deckOverlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
  state.map.addControl(state.deckOverlay);
  state.map.on("moveend", () => {
    saveViewport();
    renderAll();
    refreshViewportAware();
  });
}

function saveViewport() {
  const center = state.map.getCenter();
  store.viewport = { center: [center.lng, center.lat], zoom: state.map.getZoom() };
  persist();
}

// Collapsed group ids, persisted alongside the other UI state. A group the user
// closed stays closed across reloads.
function isCollapsed(groupId) {
  return (store.collapsedGroups || []).includes(groupId);
}

function toggleGroup(groupId) {
  const collapsed = new Set(store.collapsedGroups || []);
  collapsed.has(groupId) ? collapsed.delete(groupId) : collapsed.add(groupId);
  store.collapsedGroups = [...collapsed];
  persist();
  renderLayerControls();
}

function renderLayerControls() {
  els.layerList.innerHTML = "";
  for (const group of LAYER_GROUPS) {
    const members = layerDefinitions.filter((layer) => layer.group === group.id);
    if (!members.length) continue;
    const enabledCount = members.filter((layer) => state.enabled.has(layer.id)).length;
    const collapsed = isCollapsed(group.id);

    const header = document.createElement("button");
    header.type = "button";
    header.className = `layer-group${collapsed ? " collapsed" : ""}`;
    header.dataset.group = group.id;
    header.setAttribute("aria-expanded", String(!collapsed));
    // The enabled/total count is what makes a collapsed group readable — you can
    // see a group is doing something without opening it.
    header.innerHTML = `
      <span class="group-caret" aria-hidden="true">${collapsed ? "▸" : "▾"}</span>
      <span class="group-label">${group.label}</span>
      <span class="group-count${enabledCount ? " on" : ""}">${enabledCount}/${members.length}</span>
    `;
    els.layerList.append(header);
    if (collapsed) continue;
    renderLayerRows(members);
  }
}

function renderLayerRows(layers) {
  for (const layer of layers) {
    // Static datasets are preloaded, so show their available size even when the
    // layer is off; live layers only have a count once fetched.
    const count = layer.staticKey && !state.data.has(layer.id)
      ? (staticLayers[layer.staticKey] || []).length
      : visibleEntities(layer.id).length;
    const menuIcon = menuIcons[layer.id] || "";
    // No live adapter and no static dataset — nothing to load, so the toggle is
    // disabled rather than silently doing nothing when checked.
    const unavailable = !layer.live && !layer.staticKey;
    // Warn on an enabled live layer that is running keyless/fallback (e.g. FIRMS
    // with no key returns 0) or serving stale cached data because its upstream is
    // down — so an empty or old count isn't misread as "no data".
    const meta = state.meta.get(layer.id) || {};
    const enabled = state.enabled.has(layer.id);
    let flag = "";
    if (enabled && meta.configured === false) flag = meta.message || "Running without an API key — add one for live data.";
    else if (enabled && meta.stale) flag = "Showing cached data — upstream currently unavailable.";
    const row = document.createElement("label");
    row.className = `layer-row${unavailable ? " unavailable" : ""}${flag ? " flagged" : ""}`;
    if (flag) row.title = flag;
    row.innerHTML = `
      <input type="checkbox" ${enabled ? "checked" : ""}${unavailable ? " disabled title=\"No data source yet\"" : ""} data-layer="${layer.id}">
      <span class="swatch ${menuIcon ? "icon-swatch" : ""}" style="--swatch: rgb(${layer.color.join(",")})">${menuIcon}</span>
      <span class="layer-label">${layer.label}${unavailable ? " (soon)" : ""}${flag ? ` <span class="flag-mark" aria-hidden="true">⚠</span>` : ""}</span>
      <strong>${count}</strong>
    `;
    els.layerList.append(row);
  }
}

// Attached once at startup. Event delegation on the container means a single
// listener survives every renderLayerControls() re-render — re-attaching it per
// render (as before) leaked listeners and fired duplicate fetches on each toggle.
function wireLayerControls() {
  // Delegated, wired once. Per-render listeners on these rows previously
  // accumulated and fired duplicate upstream fetches on every toggle.
  els.layerList.addEventListener("click", (event) => {
    const header = event.target.closest(".layer-group");
    if (header) toggleGroup(header.dataset.group);
  });
  els.layerList.addEventListener("change", async (event) => {
    const id = event.target.dataset.layer;
    if (!id) return;
    event.target.checked ? state.enabled.add(id) : state.enabled.delete(id);
    store.enabled = [...state.enabled];
    persist();
    await ensureLayer(id);
    renderAll();
  });
}

function normalizeStatic(layer) {
  return (staticLayers[layer.staticKey] || []).map((item) => ({ ...item, layer: layer.id }));
}

async function ensureLayer(id, force = false) {
  const layer = layerDefinitions.find((entry) => entry.id === id);
  if (!layer || (!force && state.fetched.has(id))) return;

  if (layer.staticKey) {
    state.data.set(id, normalizeStatic(layer));
    state.fetched.add(id);
    return;
  }

  try {
    state.data.set(id, await fetchLayer(id, BOUNDS_LAYERS.has(id)));
    state.fetched.add(id);
  } catch (error) {
    state.data.set(id, [{
      id: `${id}-error`,
      layer: id,
      type: "Source error",
      name: `${layer.label} unavailable`,
      lat: 0,
      lon: 0,
      severity: 1,
      summary: error.message
    }]);
    state.fetched.add(id);
  } finally {
    // Reached only for live layers (static returns earlier). Records the attempt
    // even on error so a failing source is retried on its cadence, not every tick.
    state.lastFetched.set(id, Date.now());
  }
}

function currentBoundsKey() {
  if (!state.map) return "";
  const b = state.map.getBounds();
  return boundsKey(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
}

async function fetchLayer(id, withBounds = false) {
  const params = new URLSearchParams();
  if (withBounds && state.map) {
    // Derive the query from the key so the recorded bbox and the one on the wire
    // cannot drift apart.
    const key = currentBoundsKey();
    const [lamin, lomin, lamax, lomax] = key.split(",");
    params.set("lamin", lamin);
    params.set("lomin", lomin);
    params.set("lamax", lamax);
    params.set("lomax", lomax);
    // Recorded before the await, so a failed fetch still counts as "this bbox was
    // attempted" — matching lastFetched, and stopping a broken source from being
    // retried on every single moveend.
    state.fetchedBounds.set(id, key);
  }
  const suffix = params.toString() ? `?${params}` : "";
  const payload = await fetchJson(`/api/layers/${id}${suffix}`);
  await refreshHealth();
  state.meta.set(id, payload.meta || {});
  return payload.entities || [];
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

function visibleEntities(id) {
  return filterBySeverity(state.data.get(id) || [], state.minSeverity);
}

function buildClusterLayers(id, clusters) {
  const color = palette.get(id) || [255, 255, 255];
  return [
    new deck.ScatterplotLayer({
      id: `cluster-${id}`,
      data: clusters,
      pickable: true,
      stroked: true,
      filled: true,
      radiusUnits: "pixels",
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => 12 + Math.min(22, Math.log10(d.count + 1) * 14),
      getFillColor: [...color, 205],
      getLineColor: [255, 255, 255, 220],
      lineWidthMinPixels: 1.5,
      onClick: ({ object }) => {
        if (!object) return;
        state.map.flyTo({ center: [object.lon, object.lat], zoom: Math.min(CLUSTER_MAX_ZOOM + 1, state.map.getZoom() + 2) });
      }
    }),
    new deck.TextLayer({
      id: `cluster-label-${id}`,
      data: clusters,
      pickable: false,
      getPosition: (d) => [d.lon, d.lat],
      getText: (d) => String(d.count),
      getSize: 13,
      getColor: [8, 15, 15, 255],
      getTextAnchor: "middle",
      getAlignmentBaseline: "center"
    })
  ];
}

// Rebuild only the map layers + top-line counts. Cheap enough to run on the
// animation tick; deliberately does NOT touch the DOM panels or hit /api/health.
function renderMap() {
  // Replay mode short-circuits the live pipeline: render only the reconstructed
  // historical snapshot, grouped by layer so each point keeps its normal icon
  // (buildIconLayer reads entity.layer). The scrubber banner makes clear the map
  // is showing the past, not live data.
  if (state.replay) {
    const byLayer = new Map();
    for (const entity of state.replay.entities) {
      if (!byLayer.has(entity.layer)) byLayer.set(entity.layer, []);
      byLayer.get(entity.layer).push(entity);
    }
    const replayLayers = [];
    for (const [id, rows] of byLayer) replayLayers.push(buildIconLayer(id, rows));
    state.deckOverlay.setProps({ layers: replayLayers });
    els.entityCount.textContent = state.replay.entities.length.toLocaleString();
    return;
  }

  const active = [...state.enabled];
  const zoom = state.map ? state.map.getZoom() : 0;
  const layers = [];
  let visibleTotal = 0;

  for (const id of active) {
    const rows = visibleEntities(id);
    visibleTotal += rows.length;
    if (shouldCluster(id, rows, zoom)) {
      const { singles, clusters } = clusterPoints(rows, zoom);
      layers.push(buildIconLayer(id, singles));
      layers.push(...buildClusterLayers(id, clusters));
    } else {
      layers.push(buildIconLayer(id, rows));
    }
  }

  state.deckOverlay.setProps({ layers });
  els.activeCount.textContent = active.length;
  els.entityCount.textContent = visibleTotal.toLocaleString();
}

function renderAll() {
  renderMap();
  renderLayerControls();
  renderFeeds();
  refreshHealth();
}

// Between server refreshes an aircraft's position is static, so at map scale it
// looks frozen. Dead-reckon each plane forward from its last known ground speed
// and heading every tick so motion is continuous; the next server refresh snaps
// it back to truth. Only the map is re-rendered (not the panels).
const DEAD_RECKON_MS = 1000;
const DEAD_RECKON_LAYERS = ["aviation", "military-air"];
let lastReckonAt = Date.now();

function deadReckonAircraft() {
  const now = Date.now();
  const dt = (now - lastReckonAt) / 1000;
  lastReckonAt = now;
  if (dt <= 0 || dt > 10) return; // skip idle/backgrounded gaps

  let moved = false;
  for (const layerId of DEAD_RECKON_LAYERS) {
    if (!state.enabled.has(layerId)) continue;
    const rows = state.data.get(layerId);
    if (!rows || !rows.length) continue;
    for (const row of rows) {
      const next = advancePosition(row, dt);
      if (next.lat !== row.lat || next.lon !== row.lon) {
        row.lat = next.lat;
        row.lon = next.lon;
        moved = true;
      }
    }
  }
  if (moved) renderMap();
}

function buildIconLayer(id, data) {
    if (id === "nws") {
      // NWS alerts are areas, not points — draw the warning polygons.
      const color = palette.get("nws") || [255, 255, 255];
      return new deck.PolygonLayer({
        id: "nws-polygons",
        data,
        pickable: true,
        stroked: true,
        filled: true,
        getPolygon: (d) => d.polygon,
        getFillColor: (d) => [...color, d.severity >= 4 ? 90 : 55],
        getLineColor: [...color, 220],
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "aviation") {
      return new deck.IconLayer({
        id: "aircraft-icons",
        data,
        pickable: true,
        iconAtlas: aircraftIconAtlas,
        iconMapping: aircraftIconMapping,
        getIcon: () => "plane",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 18 + Math.min(10, (d.severity || 1) * 2),
        getAngle: (d) => Number.isFinite(d.track) ? -d.track : 0,
        getColor: () => [92, 200, 255, 240],
        sizeUnits: "pixels",
        billboard: false,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "military-air") {
      return new deck.IconLayer({
        id: "military-air-icons",
        data,
        pickable: true,
        iconAtlas: aircraftIconAtlas,
        iconMapping: aircraftIconMapping,
        getIcon: () => "plane",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 20 + Math.min(12, (d.severity || 1) * 2),
        getAngle: (d) => Number.isFinite(d.track) ? -d.track : 0,
        getColor: (d) => d.severity >= 5 ? [253, 186, 116, 245] : [245, 158, 11, 240],
        sizeUnits: "pixels",
        billboard: false,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "fires") {
      return new deck.IconLayer({
        id: "fire-icons",
        data,
        pickable: true,
        iconAtlas: fireIconAtlas,
        iconMapping: fireIconMapping,
        getIcon: () => "fire",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 18 + Math.min(14, (d.severity || 1) * 3),
        getColor: (d) => d.severity >= 5 ? [255, 80, 40, 245] : [255, 170, 50, 235],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "ports") {
      return new deck.IconLayer({
        id: "port-icons",
        data,
        pickable: true,
        iconAtlas: portIconAtlas,
        iconMapping: portIconMapping,
        getIcon: () => "port",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 17 + Math.min(13, (d.severity || 1) * 3),
        getColor: (d) => d.severity >= 5 ? [45, 212, 191, 245] : [20, 184, 166, 235],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "seismic") {
      return new deck.IconLayer({
        id: "quake-icons",
        data,
        pickable: true,
        iconAtlas: quakeIconAtlas,
        iconMapping: quakeIconMapping,
        getIcon: () => "quake",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 17 + Math.min(18, (d.magnitude || d.severity || 1) * 3),
        getColor: (d) => d.magnitude >= 5 ? [255, 95, 80, 245] : [255, 190, 80, 235],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "weather") {
      return new deck.IconLayer({
        id: "weather-icons",
        data,
        pickable: true,
        iconAtlas: weatherIconAtlas,
        iconMapping: weatherIconMapping,
        getIcon: (d) => {
          const type = String(d.type || "").toLowerCase();
          if (type.includes("flood")) return "flood";
          if (type.includes("volcano")) return "volcano";
          return "storm";
        },
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 22 + Math.min(10, (d.severity || 1) * 2),
        getColor: (d) => {
          const type = String(d.type || "").toLowerCase();
          if (type.includes("flood")) return [96, 165, 250, 240];
          if (type.includes("volcano")) return [248, 113, 113, 240];
          return [125, 211, 252, 240];
        },
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "space") {
      return new deck.IconLayer({
        id: "space-weather-icons",
        data,
        pickable: true,
        iconAtlas: spaceIconAtlas,
        iconMapping: spaceIconMapping,
        getIcon: (d) => String(d.type || "").toLowerCase().includes("alert") ? "alert" : "kp",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 21 + Math.min(12, (d.severity || 1) * 2),
        getColor: (d) => String(d.type || "").toLowerCase().includes("alert")
          ? [251, 191, 36, 240]
          : [129, 140, 248, 240],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "telegram") {
      return new deck.IconLayer({
        id: "telegram-icons",
        data,
        pickable: true,
        iconAtlas: telegramIconAtlas,
        iconMapping: telegramIconMapping,
        getIcon: () => "telegram",
        getPosition: (d) => [d.lon, d.lat],
        getSize: () => 24,
        getColor: () => [34, 211, 238, 240],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "cyber") {
      return new deck.IconLayer({
        id: "cyber-icons",
        data,
        pickable: true,
        iconAtlas: cyberIconAtlas,
        iconMapping: cyberIconMapping,
        getIcon: () => "cyber",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 20 + Math.min(14, (d.severity || 1) * 3),
        getColor: (d) => d.severity >= 5 ? [74, 222, 128, 245] : [34, 197, 94, 235],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "crypto") {
      return new deck.IconLayer({
        id: "crypto-icons",
        data,
        pickable: true,
        iconAtlas: cryptoIconAtlas,
        iconMapping: cryptoIconMapping,
        getIcon: () => "crypto",
        getPosition: (d) => [d.lon, d.lat],
        getSize: () => 24,
        getColor: () => [234, 179, 8, 240],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "sanctions") {
      return new deck.IconLayer({
        id: "sanctions-icons",
        data,
        pickable: true,
        iconAtlas: sanctionsIconAtlas,
        iconMapping: sanctionsIconMapping,
        getIcon: () => "sanctions",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => d.groupCount ? 24 + Math.min(20, Math.log10(d.groupCount + 1) * 8) : 25,
        getColor: () => [220, 38, 38, 242],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "chokepoints") {
      return new deck.IconLayer({
        id: "chokepoint-icons",
        data,
        pickable: true,
        iconAtlas: chokepointsIconAtlas,
        iconMapping: chokepointsIconMapping,
        getIcon: () => "chokepoint",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 20 + Math.min(12, (d.severity || 1) * 2),
        getColor: () => [...(palette.get("chokepoints") || [255, 255, 255]), 240],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "cctv") {
      return new deck.IconLayer({
        id: "cctv-icons",
        data,
        pickable: true,
        iconAtlas: cctvIconAtlas,
        iconMapping: cctvIconMapping,
        getIcon: () => "cctv",
        getPosition: (d) => [d.lon, d.lat],
        getSize: () => 22,
        getColor: () => [...(palette.get("cctv") || [255, 255, 255]), 240],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "gdelt") {
      return new deck.IconLayer({
        id: "gdelt-icons",
        data,
        pickable: true,
        iconAtlas: gdeltIconAtlas,
        iconMapping: gdeltIconMapping,
        getIcon: () => "gdelt",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 16 + Math.min(14, (d.severity || 1) * 3),
        getColor: (d) => d.severity >= 4 ? [232, 121, 249, 245] : [216, 180, 254, 225],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "ioda") {
      return new deck.IconLayer({
        id: "ioda-icons",
        data,
        pickable: true,
        iconAtlas: iodaIconAtlas,
        iconMapping: iodaIconMapping,
        getIcon: () => "ioda",
        getPosition: (d) => [d.lon, d.lat],
        getSize: () => 30,
        getColor: () => [...(palette.get("ioda") || [255, 255, 255]), 245],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "gdacs") {
      return new deck.IconLayer({
        id: "gdacs-icons",
        data,
        pickable: true,
        iconAtlas: gdacsIconAtlas,
        iconMapping: gdacsIconMapping,
        getIcon: () => "gdacs",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 20 + Math.min(14, (d.severity || 1) * 3),
        getColor: (d) => d.severity >= 5 ? [239, 68, 68, 245] : d.severity >= 4 ? [249, 115, 22, 240] : [250, 204, 21, 230],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "news") {
      return new deck.IconLayer({
        id: "news-icons",
        data,
        pickable: true,
        iconAtlas: newsIconAtlas,
        iconMapping: newsIconMapping,
        getIcon: () => "news",
        getPosition: (d) => [d.lon, d.lat],
        getSize: () => 22,
        getColor: () => [...(palette.get("news") || [255, 255, 255]), 240],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "conflict") {
      return new deck.IconLayer({
        id: "conflict-icons",
        data,
        pickable: true,
        iconAtlas: conflictIconAtlas,
        iconMapping: conflictIconMapping,
        getIcon: () => "conflict",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 22 + Math.min(12, (d.severity || 1) * 2),
        getColor: (d) => d.severity >= 5 ? [244, 63, 94, 245] : [251, 146, 120, 235],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "maritime") {
      return new deck.IconLayer({
        id: "maritime-icons",
        data,
        pickable: true,
        iconAtlas: maritimeIconAtlas,
        iconMapping: maritimeIconMapping,
        getIcon: () => "maritime",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 20 + Math.min(12, (d.severity || 1) * 2),
        getColor: () => [...(palette.get("maritime") || [255, 255, 255]), 240],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "military") {
      return new deck.IconLayer({
        id: "military-icons",
        data,
        pickable: true,
        iconAtlas: militaryIconAtlas,
        iconMapping: militaryIconMapping,
        getIcon: () => "military",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 20 + Math.min(12, (d.severity || 1) * 2),
        getColor: (d) => d.severity >= 5 ? [203, 213, 225, 245] : [148, 163, 184, 235],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "advisories") {
      return new deck.IconLayer({
        id: "advisory-icons",
        data,
        pickable: true,
        iconAtlas: advisoriesIconAtlas,
        iconMapping: advisoriesIconMapping,
        getIcon: () => "advisories",
        getPosition: (d) => [d.lon, d.lat],
        // Size tracks the advisory level so Level 4 countries read at a glance.
        getSize: (d) => 16 + Math.min(14, (d.severity || 1) * 3),
        getColor: (d) => d.severity >= 5 ? [220, 38, 38, 245]
          : d.severity >= 4 ? [234, 88, 12, 240]
            : [217, 119, 6, 210],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "reliefweb") {
      return new deck.IconLayer({
        id: "reliefweb-icons",
        data,
        pickable: true,
        iconAtlas: reliefIconAtlas,
        iconMapping: reliefIconMapping,
        getIcon: () => "reliefweb",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 20 + Math.min(12, (d.severity || 1) * 2),
        getColor: (d) => d.severity >= 5 ? [125, 211, 252, 245] : [56, 189, 248, 235],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "infrastructure") {
      return new deck.IconLayer({
        id: "infrastructure-icons",
        data,
        pickable: true,
        iconAtlas: infraIconAtlas,
        iconMapping: infraIconMapping,
        getIcon: () => "infrastructure",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 18 + Math.min(10, (d.severity || 1) * 2),
        getColor: () => [...(palette.get("infrastructure") || [255, 255, 255]), 235],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    if (id === "power-plants") {
      return new deck.IconLayer({
        id: "power-plant-icons",
        data,
        pickable: true,
        iconAtlas: powerIconAtlas,
        iconMapping: powerIconMapping,
        getIcon: () => "power-plants",
        getPosition: (d) => [d.lon, d.lat],
        getSize: (d) => 18 + Math.min(12, (d.severity || 1) * 2),
        // Nuclear (severity 5) reads hot; everything else stays amber.
        getColor: (d) => d.severity >= 5 ? [248, 113, 113, 245] : [250, 204, 21, 225],
        sizeUnits: "pixels",
        billboard: true,
        onClick: ({ object }) => object && showDetail(object)
      });
    }

    return new deck.ScatterplotLayer({
      id: `scatter-${id}`,
      data,
      pickable: true,
      opacity: 0.86,
      stroked: true,
      filled: true,
      radiusUnits: "pixels",
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => 5 + (d.severity || 1) * 2,
      getFillColor: () => [...(palette.get(id) || [255, 255, 255]), 210],
      getLineColor: [255, 255, 255, 160],
      lineWidthMinPixels: 1,
      onClick: ({ object }) => object && showDetail(object)
    });
}

function showDetail(item) {
  const color = palette.get(item.layer) || [255, 255, 255];
  const description = item.text || item.summary || item.status || "";
  const rows = detailRows(item);
  els.detail.hidden = false;
  els.detail.innerHTML = `
    <button type="button" class="close-detail">×</button>
    <span class="detail-kicker" style="color: rgb(${color.join(",")})">${escapeHtml(item.type || item.layer)}</span>
    <h3>${escapeHtml(item.name || item.id)}</h3>
    ${description ? `<p class="detail-desc">${escapeHtml(description)}</p>` : ""}
    ${rows.length ? `<dl class="detail-grid">${rows.map(([label, value]) =>
      `<div class="detail-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : ""}
    ${attackTags(item)}
    ${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open source</a>` : ""}
  `;
  els.detail.querySelector(".close-detail").addEventListener("click", () => {
    els.detail.hidden = true;
  });
}

async function refreshHealth() {
  if (!els.sourceHealth) return;
  try {
    const payload = await fetchJson("/api/health");
    const rows = (payload.sources || []).filter((row) => row.id !== "last-error").slice(0, 8);
    els.sourceHealth.innerHTML = rows.length ? rows.map((row) => `
      <div class="health-row ${row.status === "ok" ? "ok" : "bad"}">
        <span>${escapeHtml(row.id)}</span>
        <strong>${row.status === "ok" ? "live" : "error"}</strong>
      </div>
    `).join("") : `<div class="health-empty">Source health appears after live layers load.</div>`;
  } catch {
    els.sourceHealth.innerHTML = `<div class="health-empty">Source health unavailable.</div>`;
  }
}

const FEED_LIMIT = 14;
const FEED_PER_LAYER = 4;

function renderFeeds() {
  // The Live Desk shows the most notable located items across all enabled layers
  // (severity-filtered, never from a toggled-off layer), with each layer capped so
  // one noisy layer can't crowd out the rest. See buildFeed in logic.js.
  const rows = buildFeed(state.enabled, visibleEntities, { limit: FEED_LIMIT, perLayer: FEED_PER_LAYER });

  els.feedList.innerHTML = rows.length ? rows.map((row) => `
    <button class="feed-item" type="button" data-id="${escapeHtml(String(row.id))}" data-layer="${escapeHtml(String(row.layer))}">
      <strong>${escapeHtml(row.name || row.place || row.channel || String(row.id))}</strong>
      <span>${escapeHtml(`${layerLabels.get(row.layer) || row.layer} · ${row.type || row.status || "Live item"}`)}</span>
    </button>
  `).join("") : `<div class="health-empty">Enable a layer to populate the live desk.</div>`;

  els.feedList.querySelectorAll(".feed-item").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.data.get(button.dataset.layer)?.find((row) => String(row.id) === button.dataset.id);
      if (!item) return;
      state.map.flyTo({ center: [item.lon, item.lat], zoom: 5 });
      showDetail(item);
    });
  });
}

// Combined added+closed change objects for the currently rendered What-Changed
// panel, so a clicked item maps back to its stored entity (which carries lat/lon
// and everything showDetail needs — no re-fetch).
let changeItems = [];

async function renderChanges() {
  const panel = document.querySelector("#changes-result");
  if (!panel) return;
  panel.innerHTML = `<div class="health-empty">Loading changes…</div>`;
  const since = store.changesSince;
  let payload;
  try {
    payload = await fetchJson(`/api/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`);
  } catch {
    panel.innerHTML = `<div class="health-empty">Change history unavailable.</div>`;
    return;
  }
  if (!payload.enabled) {
    panel.innerHTML = `<div class="health-empty">Historical persistence is disabled. Set <code>OSIRIS_DB_PATH</code> on the server to track what appeared or dropped out between visits.</div>`;
    return;
  }

  // Persistence is on, so point-in-time replay is available: reveal the scrubber
  // and (re)anchor its window to a fresh "now".
  setupScrubber();

  const added = payload.added || [];
  const closed = payload.closed || [];
  changeItems = [...added, ...closed];
  const sinceLabel = payload.since ? new Date(payload.since).toLocaleString() : "recently";
  panel.innerHTML = `
    <div class="changes-since">Since ${escapeHtml(sinceLabel)}</div>
    ${changeGroupHtml("Appeared", "up", added)}
    ${changeGroupHtml("Dropped off", "down", closed)}
    ${changeItems.length === 0 ? `<div class="health-empty">No changes in persistable layers since then.</div>` : ""}
  `;

  // Buttons render in changeItems order (added then closed), so the NodeList
  // index lines up with the array.
  panel.querySelectorAll(".feed-item").forEach((button, index) => {
    button.addEventListener("click", () => {
      const entity = changeItems[index]?.entity;
      if (!entity || !Number.isFinite(entity.lat) || !Number.isFinite(entity.lon)) return;
      state.map.flyTo({ center: [entity.lon, entity.lat], zoom: 5 });
      showDetail(entity);
    });
  });
}

// ---- Timeline scrubber (Phase 5 point-in-time replay) ----------------------
// A slider over the last REPLAY_WINDOW_MS. Dragging updates the readout live;
// releasing fetches the historical snapshot for every enabled layer and renders
// it on the map (via renderMap's replay branch) plus a click-to-fly list. The far
// right of the slider means "live" and returns to the normal pipeline. Only usable
// when persistence is on — revealed by renderChanges once /api/changes reports it.
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const SCRUBBER_MAX = 1000;
let replayWindow = null; // { startMs, endMs } anchored when the panel renders
let replayItems = [];
let scrubberWired = false;

function setupScrubber() {
  const scrubber = document.querySelector("#scrubber");
  if (!scrubber) return;
  scrubber.hidden = false;
  const endMs = Date.now();
  replayWindow = { startMs: endMs - REPLAY_WINDOW_MS, endMs };
  const windowEl = document.querySelector("#scrubber-window");
  if (windowEl) windowEl.textContent = `last 24h · ${new Date(replayWindow.startMs).toLocaleTimeString()} → now`;

  if (scrubberWired) return; // wire the listeners exactly once
  scrubberWired = true;
  const slider = document.querySelector("#scrubber-slider");
  slider.addEventListener("input", onScrubInput);
  slider.addEventListener("change", onScrubCommit);
  document.querySelector("#scrubber-exit").addEventListener("click", exitReplay);
}

function currentScrubTime(value) {
  return scrubberTime(value, SCRUBBER_MAX, replayWindow.startMs, replayWindow.endMs);
}

function onScrubInput(event) {
  if (!replayWindow) return;
  const t = currentScrubTime(event.target.value);
  document.querySelector("#scrubber-time").textContent = t.live ? "live" : new Date(t.ms).toLocaleString();
}

function onScrubCommit(event) {
  if (!replayWindow) return;
  const t = currentScrubTime(event.target.value);
  if (t.live) exitReplay();
  else enterReplayAt(t.iso);
}

async function enterReplayAt(iso) {
  const layers = [...state.enabled];
  const payloads = await Promise.all(layers.map((id) =>
    fetchJson(`/api/snapshot/${id}?at=${encodeURIComponent(iso)}`).catch(() => ({ enabled: false }))));
  const entities = replayEntities(payloads);
  state.replay = { at: iso, entities };
  document.querySelector("#scrubber").classList.add("active");
  document.querySelector("#scrubber-exit").hidden = false;
  renderMap();
  renderReplayList(iso, entities);
}

function exitReplay() {
  state.replay = null;
  replayItems = [];
  const slider = document.querySelector("#scrubber-slider");
  if (slider) slider.value = SCRUBBER_MAX;
  const timeEl = document.querySelector("#scrubber-time");
  if (timeEl) timeEl.textContent = "live";
  document.querySelector("#scrubber")?.classList.remove("active");
  const exit = document.querySelector("#scrubber-exit");
  if (exit) exit.hidden = true;
  renderMap();
  renderChanges(); // restore the What-Changed list into #changes-result
}

// Reconstructed entities at instant `iso`, as a click-to-fly list (reuses the
// feed-item pattern). Overwrites the What-Changed panel while replaying; exit
// restores it.
function renderReplayList(iso, entities) {
  const panel = document.querySelector("#changes-result");
  if (!panel) return;
  replayItems = entities.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
  const rows = replayItems.slice(0, 80).map((entity) => `
    <button class="feed-item" type="button">
      <strong>${escapeHtml(String(entity.name || entity.id))}</strong>
      <span>${escapeHtml(layerLabels.get(entity.layer) || entity.layer)}</span>
    </button>`).join("");
  panel.innerHTML = `
    <div class="changes-since">Replay · ${escapeHtml(new Date(iso).toLocaleString())} · ${replayItems.length} entit${replayItems.length === 1 ? "y" : "ies"}</div>
    ${replayItems.length ? `<div class="feed-list">${rows}</div>` : `<div class="health-empty">Nothing was live at that moment (in persistable layers).</div>`}
  `;
  panel.querySelectorAll(".feed-item").forEach((button, index) => {
    button.addEventListener("click", () => {
      const entity = replayItems[index];
      if (!entity) return;
      state.map.flyTo({ center: [entity.lon, entity.lat], zoom: 5 });
      showDetail(entity);
    });
  });
}

let alertItems = [];

async function renderAlerts() {
  const panel = document.querySelector("#alerts-result");
  if (!panel) return;
  panel.innerHTML = `<div class="health-empty">Loading alerts…</div>`;
  let payload;
  try {
    payload = await fetchJson("/api/alerts");
  } catch {
    panel.innerHTML = `<div class="health-empty">Alert history unavailable.</div>`;
    return;
  }
  if (!payload.enabled) {
    panel.innerHTML = `<div class="health-empty">Alerting is disabled. It needs <code>OSIRIS_DB_PATH</code> (the dedupe lives in the history store) plus a rules file — see <code>config/alert-rules.example.json</code>.</div>`;
    return;
  }

  const rules = payload.rules || [];
  alertItems = payload.alerts || [];

  const ruleRows = rules.map((rule) => {
    const { state, label } = ruleHealth(rule);
    const last = rule.lastFiredAt ? ` · ${relativeTime(rule.lastFiredAt)}` : "";
    return `
      <div class="rule-row ${state}">
        <strong>${escapeHtml(rule.id)}</strong>
        <span>${escapeHtml(label + last)}</span>
      </div>`;
  }).join("");

  const alertRows = alertItems.map((alert) => `
    <button class="feed-item" type="button">
      <strong>${escapeHtml(String(alert.name || alert.id))}</strong>
      <span>${escapeHtml(`${alert.ruleId} · ${alert.reason} · ${layerLabels.get(alert.layer) || alert.layer} · ${relativeTime(alert.firedAt)}`)}</span>
    </button>`).join("");

  panel.innerHTML = `
    <div class="change-group">
      <h3>Configured rules</h3>
      ${rules.length ? ruleRows : `<div class="health-empty">No rules loaded. Create <code>config/alert-rules.json</code> to enable alerting.</div>`}
    </div>
    <div class="change-group">
      <h3>Recent alerts</h3>
      ${alertItems.length ? alertRows : `<div class="health-empty">No alerts have fired yet.</div>`}
    </div>
  `;

  panel.querySelectorAll(".feed-item").forEach((button, index) => {
    button.addEventListener("click", () => {
      const entity = alertItems[index]?.entity;
      if (!entity || !Number.isFinite(entity.lat) || !Number.isFinite(entity.lon)) return;
      state.map.flyTo({ center: [entity.lon, entity.lat], zoom: 5 });
      showDetail(entity);
    });
  });
}

function changeGroupHtml(title, dir, items) {
  if (!items.length) return "";
  const rows = items.map((change) => {
    const entity = change.entity || {};
    const name = entity.name || entity.id || change.id;
    const when = dir === "up" ? change.firstSeen : change.closedAt;
    return `
      <button class="feed-item" type="button">
        <strong>${escapeHtml(String(name))}</strong>
        <span>${escapeHtml(`${layerLabels.get(change.layer) || change.layer} · ${relativeTime(when)}`)}</span>
      </button>`;
  }).join("");
  return `
    <div class="change-group">
      <h3 class="change-head change-${dir}">${dir === "up" ? "▲" : "▼"} ${escapeHtml(title)} <span>${items.length}</span></h3>
      <div class="feed-list">${rows}</div>
    </div>`;
}

async function refreshViewportAware() {
  await Promise.all([...VIEWPORT_AWARE_LAYERS].map((id) => refreshForViewport(id)));
}

// A map move wants the layer to match wherever the map ENDED UP, which plain
// refreshLiveLayer cannot express — it drops any request that arrives while a
// fetch is in flight. During a fast pan the moveend that lands mid-fetch was the
// one that mattered, so the layer settled a pan behind the map.
//
// So: skip when the bbox the server would see is unchanged (a pane toggle, or a
// nudge inside the rounding, is not navigation), and when a move lands mid-fetch
// remember it and go again afterwards instead of dropping it. Repeated moves
// coalesce into one trailing re-check rather than a queue of stale fetches.
//
// Time-based polling deliberately does NOT come through here: it wants fresh data
// for the SAME bbox, which is exactly what the skip suppresses.
async function refreshForViewport(id) {
  if (!state.enabled.has(id)) return;
  if (state.fetchedBounds.get(id) === currentBoundsKey()) return;
  if (state.refreshing.has(id)) {
    state.staleViewport.add(id);
    return;
  }
  await refreshLiveLayer(id);
}

async function refreshLiveLayer(id) {
  if (!state.enabled.has(id) || state.refreshing.has(id)) return;
  state.refreshing.add(id);
  try {
    state.fetched.delete(id);
    await ensureLayer(id, true);
    renderAll();
  } finally {
    state.refreshing.delete(id);
  }
  // A move deferred while the lock was held is serviced here rather than dropped.
  // This lives after the lock release (not in refreshForViewport) because a
  // timed poll holds the same lock, and a poll can swallow a moveend just as
  // easily as a pan can. refreshForViewport re-reads the CURRENT bbox, so a burst
  // of moves collapses into one trailing fetch for wherever the map settled.
  if (state.staleViewport.delete(id)) await refreshForViewport(id);
}

function pollDueLayers() {
  const now = Date.now();
  for (const [id, interval] of Object.entries(LAYER_REFRESH_MS)) {
    if (!state.enabled.has(id)) continue;
    const last = state.lastFetched.get(id) || 0;
    if (now - last >= interval) refreshLiveLayer(id);
  }
}

async function hydrateInitialLayers() {
  await Promise.all([...state.enabled].map((id) => ensureLayer(id)));
  renderAll();
}

// Short labels used to tag each recon-history row by its source tool.
const RECON_TAB_LABELS = { crypto: "Wallet", sanctions: "SDN", intel: "IOC", cyber: "CVE", place: "Place" };
// Maps a history entry's tool back to the function that re-runs the lookup.
// `place` is the top-bar map search, which has no recon tab (handled below).
const RECON_TOOLS = {
  crypto: { run: runWalletLookup },
  sanctions: { run: runSanctionsSearch },
  intel: { run: runIntelLookup },
  cyber: { run: runCveSearch },
  place: { run: runPlaceSearch }
};

function switchReconTab(tabId) {
  document.querySelectorAll(".tab, .tool-panel").forEach((el) => el.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tabId}"]`)?.classList.add("active");
  document.querySelector(`#${tabId}`)?.classList.add("active");
  // The What-Changed panel is fetched lazily each time it is opened.
  if (tabId === "changes") renderChanges();
  if (tabId === "alerts") renderAlerts();
}

// Push a lookup onto the persisted history. `restore` maps input selectors to the
// values needed to replay it. Identical prior lookups are dropped so the entry
// re-surfaces at the top instead of duplicating.
function recordRecon(tool, label, restore) {
  const history = Array.isArray(store.reconHistory) ? store.reconHistory : [];
  const deduped = history.filter((entry) => !(entry.tool === tool && entry.label === label));
  deduped.unshift({ tool, label, restore, ts: Date.now() });
  store.reconHistory = deduped.slice(0, RECON_HISTORY_LIMIT);
  persist();
  renderReconHistory();
}

function renderReconHistory() {
  const panel = document.querySelector("#recon-history-panel");
  const list = document.querySelector("#recon-history");
  if (!panel || !list) return;
  const history = Array.isArray(store.reconHistory) ? store.reconHistory : [];
  panel.hidden = history.length === 0;
  list.innerHTML = history.map((entry, index) => `
    <button class="history-item" type="button" data-index="${index}">
      <strong>${escapeHtml(entry.label)}</strong>
      <span>${escapeHtml(RECON_TAB_LABELS[entry.tool] || entry.tool)}</span>
    </button>
  `).join("");
  list.querySelectorAll(".history-item").forEach((button) => {
    button.addEventListener("click", () => activateReconHistoryItem(history[Number(button.dataset.index)]));
  });
}

function activateReconHistoryItem(entry) {
  const tool = entry && RECON_TOOLS[entry.tool];
  if (!tool) return;
  // Only switch tabs for tools that have one — place search has no tab, so
  // switching would blank the recon panel.
  if (document.querySelector(`.tab[data-tab="${entry.tool}"]`)) switchReconTab(entry.tool);
  for (const [selector, value] of Object.entries(entry.restore || {})) {
    const field = document.querySelector(selector);
    if (field) field.value = value;
  }
  tool.run();
}

async function runWalletLookup() {
  const chain = document.querySelector("#chain").value;
  const address = document.querySelector("#wallet").value.trim();
  const result = document.querySelector("#wallet-result");
  if (!address) return;
  recordRecon("crypto", `${chain.toUpperCase()} ${address}`, { "#chain": chain, "#wallet": address });
  result.textContent = "Checking chain data and SDN exposure...";
  try {
    const payload = await fetchJson(`/api/crypto/${chain}?address=${encodeURIComponent(address)}`);
    const explorer = chain === "eth"
      ? { url: `https://etherscan.io/address/${encodeURIComponent(address)}`, label: "View on Etherscan" }
      : { url: `https://blockstream.info/address/${encodeURIComponent(address)}`, label: "View on Blockstream" };
    result.innerHTML = `
      <div class="${payload.sanctioned ? "badge danger" : "badge ok"}">${payload.sanctioned ? "SANCTIONED - OFAC SDN" : "No OFAC crypto match"}</div>
      ${payload.ransomware ? `<div class="badge danger">KNOWN RANSOMWARE ADDRESS (Ransomwhere)</div>` : ""}
      ${extLink(explorer.url, explorer.label)}
      <pre>${escapeHtml(JSON.stringify(payload.data, null, 2).slice(0, 1800))}</pre>
    `;
  } catch (error) {
    result.textContent = error.message;
  }
}

// Attach expand/collapse toggles to every `.result-head` in a result container.
// New buttons are created on each render, so listeners never accumulate.
function wireAccordion(container) {
  container.querySelectorAll(".result-head").forEach((head) => {
    head.addEventListener("click", () => {
      const detail = head.nextElementSibling;
      detail.hidden = !detail.hidden;
      head.setAttribute("aria-expanded", String(!detail.hidden));
    });
  });
}

async function runSanctionsSearch() {
  const q = document.querySelector("#sanctions-query").value.trim();
  const result = document.querySelector("#sanctions-result");
  if (!q) return;
  recordRecon("sanctions", q, { "#sanctions-query": q });
  result.textContent = "Searching SDN mirror...";
  try {
    const payload = await fetchJson(`/api/sanctions?q=${encodeURIComponent(q)}`);
    const results = payload.results || [];
    if (!results.length) {
      result.textContent = "No matches.";
      return;
    }
    result.innerHTML = results.map((row) => `
      <article class="result-item">
        <button class="result-head" type="button" aria-expanded="false">
          <strong>${escapeHtml(row.caption || row.id)}</strong>
          <span>${escapeHtml((row.schema || "Entity") + " · " + (row.datasets?.[0] || "OpenSanctions"))}</span>
        </button>
        <div class="result-detail" hidden>${sanctionDetail(row)}</div>
      </article>
    `).join("");
    wireAccordion(result);
  } catch (error) {
    result.textContent = error.message;
  }
}

async function runIntelLookup() {
  const kind = document.querySelector("#intel-kind").value;
  const q = document.querySelector("#intel-query").value.trim();
  const result = document.querySelector("#intel-result");
  if (!q) return;
  recordRecon("intel", `${kind}: ${q}`, { "#intel-kind": kind, "#intel-query": q });
  result.textContent = "Checking intelligence sources...";
  const route = {
    ip: `/api/intel/correlate?ip=${encodeURIComponent(q)}`,
    domain: `/api/intel/domain?domain=${encodeURIComponent(q)}`,
    url: `/api/intel/virustotal/url?url=${encodeURIComponent(q)}`,
    hash: `/api/intel/malwarebazaar?hash=${encodeURIComponent(q)}`,
    whois: `/api/intel/whois?query=${encodeURIComponent(q)}`
  }[kind];
  try {
    const payload = await fetchJson(route);
    if (kind === "whois") {
      result.innerHTML = renderWhois(payload);
    } else if (kind === "ip") {
      // The correlate endpoint returns the same results[] plus a correlation
      // header; render the summary banner above the per-source cards.
      result.innerHTML = `${correlationBanner(payload)}<div class="result-refs">${intelLinks(kind, q)}</div>${renderIntelResult(payload)}`;
      wireCorrelateLocate(result);
    } else {
      result.innerHTML = `<div class="result-refs">${intelLinks(kind, q)}</div>${renderIntelResult(payload)}`;
    }
  } catch (error) {
    result.textContent = error.message;
  }
}

// Wire the "Locate on map" button in the correlation banner: fly to the country
// centroid and drop a detail-card pin. User-initiated rather than auto-flying, so
// an IP lookup never yanks the analyst's viewport out from under them.
function wireCorrelateLocate(container) {
  const btn = container.querySelector(".correlate-locate");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const lat = Number(btn.dataset.lat);
    const lon = Number(btn.dataset.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    state.map.flyTo({ center: [lon, lat], zoom: 4 });
    showDetail({ type: "IP correlation", name: btn.dataset.label, lat, lon, source: "Country geolocation (centroid)" });
  });
}

// Fan-out lookups (IP, domain) render as per-source cards. Single-source kinds
// (URL, file hash) have no results[] array and keep the raw JSON view.
function renderIntelResult(payload) {
  const cards = intelCards(payload);
  return cards || `<pre>${escapeHtml(JSON.stringify(payload, null, 2).slice(0, 10000))}</pre>`;
}

function renderWhois(payload) {
  const summary = payload.summary || {};
  const sanctions = payload.sanctions || {};
  const badge = sanctions.sanctioned
    ? `<div class="badge danger">SANCTIONS MATCH — ${sanctions.flagged.map((row) => escapeHtml(row.name)).join(", ")}</div>`
    : `<div class="badge ok">No OpenSanctions name match</div>`;
  const rows = Object.entries(summary)
    .filter(([, value]) => value != null && (!Array.isArray(value) || value.length))
    .map(([key, value]) => `<p><strong>${escapeHtml(key)}</strong> ${escapeHtml(Array.isArray(value) ? value.join(", ") : String(value))}</p>`)
    .join("");
  const checked = (sanctions.checked || []).length
    ? `<p><strong>names checked</strong> ${escapeHtml(sanctions.checked.join(", "))}</p>`
    : "";
  return `${badge}${rows}${checked}<pre>${escapeHtml(JSON.stringify(payload.rdap, null, 2).slice(0, 1200))}</pre>`;
}

async function runCveSearch() {
  const q = document.querySelector("#cve-query").value.trim() || "kev";
  const result = document.querySelector("#cve-result");
  recordRecon("cyber", q, { "#cve-query": q });
  result.textContent = "Searching NVD...";
  try {
    const payload = await fetchJson(`/api/cves?q=${encodeURIComponent(q)}`);
    const rows = (payload.vulnerabilities || []).slice(0, 8);
    if (!rows.length) {
      result.textContent = payload.message || "No CVEs found.";
      return;
    }
    result.innerHTML = rows.map((row) => `
      <article class="result-item">
        <button class="result-head" type="button" aria-expanded="false">
          <strong>${escapeHtml(row.cve.id)}</strong>
          <span>${escapeHtml(row.cve.descriptions?.[0]?.value || "No description").slice(0, 160)}</span>
        </button>
        <div class="result-detail" hidden>${cveDetail(row)}</div>
      </article>
    `).join("");
    wireAccordion(result);
  } catch (error) {
    result.textContent = error.message;
  }
}

function wireReconTools() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchReconTab(tab.dataset.tab));
  });

  document.querySelector("#wallet-lookup").addEventListener("click", runWalletLookup);
  document.querySelector("#sanctions-search").addEventListener("click", runSanctionsSearch);
  document.querySelector("#intel-lookup").addEventListener("click", runIntelLookup);
  document.querySelector("#cve-search").addEventListener("click", runCveSearch);

  document.querySelector("#clear-recon-history").addEventListener("click", () => {
    store.reconHistory = [];
    persist();
    renderReconHistory();
  });

  document.querySelector("#changes-refresh").addEventListener("click", renderChanges);
  document.querySelector("#alerts-refresh").addEventListener("click", renderAlerts);
  document.querySelector("#changes-mark-seen").addEventListener("click", () => {
    // Acknowledge the current picture: subsequent "what changed" is relative to now.
    store.changesSince = new Date().toISOString();
    persist();
    renderChanges();
  });

  document.querySelector("#refresh-active").addEventListener("click", async () => {
    [...state.enabled].forEach((id) => state.fetched.delete(id));
    await hydrateInitialLayers();
  });

  document.querySelector("#export-snapshot").addEventListener("click", exportSnapshot);

  document.querySelector("#clear-layers").addEventListener("click", () => {
    state.enabled.clear();
    store.enabled = [];
    persist();
    renderAll();
  });

  document.querySelector("#place-search").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    runPlaceSearch();
  });

  renderReconHistory();
}

function flashNoMatch(input) {
  const box = input.closest(".search-box");
  box.classList.remove("no-match");
  void box.offsetWidth; // reflow so the animation restarts on repeat misses
  box.classList.add("no-match");
  box.addEventListener("animationend", () => box.classList.remove("no-match"), { once: true });
}

async function runPlaceSearch() {
  const input = document.querySelector("#place-search");
  const q = input.value.trim();
  if (!q) return;
  recordRecon("place", q, { "#place-search": q });
  const needle = q.toLowerCase();

  // 1. Prefer a live entity match (also opens its detail card).
  const item = [...state.data.values()].flat().find((row) =>
    row.name?.toLowerCase().includes(needle) || row.place?.toLowerCase().includes(needle));
  if (item) {
    state.map.flyTo({ center: [item.lon, item.lat], zoom: 5 });
    showDetail(item);
    return;
  }

  // 2. Fall back to the gazetteer so any known city/port recentres the map.
  const place = gazetteerPlaces.find((row) =>
    row.name?.toLowerCase().includes(needle) ||
    (row.aliases || []).some((alias) => String(alias).toLowerCase().includes(needle)));
  if (place) {
    state.map.flyTo({ center: [place.lon, place.lat], zoom: 5 });
    return;
  }

  // 3. Geocode arbitrary addresses/places via the server (Nominatim proxy).
  try {
    const geo = await fetchJson(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (geo.found && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
      state.map.flyTo({ center: [geo.lon, geo.lat], zoom: 14 });
      showDetail({ type: "Location", name: geo.name, lat: geo.lat, lon: geo.lon, source: geo.source });
      return;
    }
  } catch {
    // fall through to the no-match flash
  }

  // Nothing matched anywhere — flash the search box so the miss is visible.
  flashNoMatch(input);
}

function tickClock() {
  els.clock.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(new Date());
}

// Build a self-contained snapshot of the current situational picture: what is
// active, how it is filtered, where the map is, and every currently visible
// entity — the machine-readable artifact behind an analyst report.
function buildSnapshot() {
  const active = [...state.enabled];
  const layers = active.map((id) => {
    const rows = visibleEntities(id);
    return {
      id,
      label: layerDefinitions.find((layer) => layer.id === id)?.label || id,
      count: rows.length,
      entities: rows.map(snapshotEntity)
    };
  });
  const center = state.map ? state.map.getCenter() : null;
  return {
    tool: "OSIRIS Situational Dashboard",
    generatedAt: new Date().toISOString(),
    viewport: center ? { center: [center.lng, center.lat], zoom: state.map.getZoom() } : null,
    filters: { minSeverity: state.minSeverity },
    summary: {
      activeLayers: active.length,
      visibleEntities: layers.reduce((sum, layer) => sum + layer.count, 0)
    },
    layers,
    reconHistory: (Array.isArray(store.reconHistory) ? store.reconHistory : [])
      .map((entry) => ({ tool: entry.tool, label: entry.label, at: new Date(entry.ts).toISOString() }))
  };
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function exportSnapshot() {
  const snapshot = buildSnapshot();
  // Attach live source telemetry for provenance; best-effort so export never fails on it.
  try {
    const health = await fetchJson("/api/health");
    snapshot.sources = (health.sources || []).filter((row) => row.id !== "last-error");
  } catch {
    snapshot.sources = [];
  }
  const stamp = snapshot.generatedAt.replace(/[:.]/g, "-").slice(0, 19);
  downloadJson(snapshot, `osiris-snapshot-${stamp}.json`);
}

// The recon pane overlays the map instead of holding a grid column, so the
// visible map area is narrower than the canvas. MapLibre's camera padding is
// sticky transform state, so setting it here re-centres EVERY camera move —
// all seven flyTo call sites, plus fitBounds and the restored viewport — without
// any of them knowing the pane exists.
//
// Width comes from the live element rather than a constant so the padding cannot
// drift from --recon-width, and the breakpoint is read as computed `position`
// rather than duplicating the 1081px media query in JS: below it the pane stacks
// under the map and overlays nothing.
function reconOverlayWidth() {
  const recon = document.querySelector(".recon");
  if (!recon || store.hideRight) return 0;
  if (getComputedStyle(recon).position !== "absolute") return 0;
  return recon.getBoundingClientRect().width;
}

function syncMapPadding(animate) {
  if (!state.map) return;
  const padding = { right: reconOverlayWidth() };
  // Either form shifts the rendered extent by half the padding; easing just makes
  // it track the CSS slide instead of jumping.
  if (animate) state.map.easeTo({ padding, duration: PANE_TRANSITION_MS });
  else state.map.setPadding(padding);
}

// Collapse/restore the left (layers) and right (recon) panes. State persists so a
// preferred single-pane layout survives reloads. The left pane still holds a grid
// column, so the map is resized after a toggle; the recon overlay never changes
// the canvas size and only moves the camera padding.
function applyPaneState({ animate = true } = {}) {
  const shell = document.querySelector(".app-shell");
  shell.classList.toggle("hide-left", Boolean(store.hideLeft));
  shell.classList.toggle("hide-right", Boolean(store.hideRight));
  const left = document.querySelector("#toggle-left");
  const right = document.querySelector("#toggle-right");
  // Chevron points the direction the pane will move: collapse ‹ / expand ›.
  left.textContent = store.hideLeft ? "›" : "‹";
  right.textContent = store.hideRight ? "‹" : "›";
  left.setAttribute("aria-pressed", String(Boolean(store.hideLeft)));
  right.setAttribute("aria-pressed", String(Boolean(store.hideRight)));
  if (state.map) {
    requestAnimationFrame(() => {
      state.map.resize();
      syncMapPadding(animate);
    });
  }
}

function wirePanes() {
  document.querySelector("#toggle-left").addEventListener("click", () => {
    store.hideLeft = !store.hideLeft;
    persist();
    applyPaneState();
  });
  document.querySelector("#toggle-right").addEventListener("click", () => {
    store.hideRight = !store.hideRight;
    persist();
    applyPaneState();
  });
  // Crossing the overlay breakpoint changes whether the pane covers the map at
  // all, so the padding has to be recomputed — otherwise a window narrowed below
  // 1081px keeps padding for a pane that is now stacked underneath.
  window.addEventListener("resize", () => syncMapPadding(false));
  applyPaneState({ animate: false });
}

function wireSeverityFilter() {
  const slider = document.querySelector("#min-severity");
  const label = document.querySelector("#severity-value");
  slider.value = String(state.minSeverity);
  label.textContent = String(state.minSeverity);
  slider.addEventListener("input", () => {
    state.minSeverity = Number(slider.value);
    label.textContent = slider.value;
    store.minSeverity = state.minSeverity;
    persist();
    renderAll();
  });
}

initMap();
renderLayerControls();
wireLayerControls();
wireReconTools();
wireSeverityFilter();
wirePanes();
tickClock();
setInterval(tickClock, 1000);
setInterval(pollDueLayers, POLL_TICK_MS);
setInterval(deadReckonAircraft, DEAD_RECKON_MS);
loadGazetteer();
loadStaticLayers()
  .then((data) => { staticLayers = data; })
  .finally(hydrateInitialLayers);
refreshHealth();
