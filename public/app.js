import { layerDefinitions, loadStaticLayers } from "./data.js";

// Populated from the versioned public/data/*.json datasets before initial hydrate.
let staticLayers = {};

// Persisted UI state (layer visibility, map viewport, recon history) lives under
// one namespaced localStorage key. All access is best-effort: private-mode blocks
// or a full quota must never break the dashboard.
const STORAGE_KEY = "osiris.ui.v1";
const RECON_HISTORY_LIMIT = 20;
const DEFAULT_LAYERS = ["conflict", "seismic", "ports", "chokepoints", "telegram"];

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
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
  fetched: new Set(),
  refreshing: new Set(),
  lastFetched: new Map(),
  minSeverity: Math.min(5, Math.max(1, Number(store.minSeverity) || 1)),
  deckOverlay: null,
  map: null
};

// Per-layer poll cadence (ms). Only live (API-backed) layers appear here; static
// layers never poll. Fast-moving feeds refresh often, slow reference feeds rarely.
const LAYER_REFRESH_MS = {
  seismic: 60_000,
  aviation: 60_000,
  maritime: 60_000,
  telegram: 120_000,
  fires: 300_000,
  weather: 300_000,
  news: 300_000,
  space: 300_000,
  crypto: 300_000,
  ports: 600_000,
  cyber: 900_000,
  sanctions: 1_800_000
};
// One ticker checks every layer's elapsed time against its cadence, so intervals
// are measured from the last actual fetch (a manual or viewport refresh resets the
// clock) rather than fixed wall-clock multiples.
const POLL_TICK_MS = 15_000;
const VIEWPORT_AWARE_LAYERS = new Set(["aviation", "fires", "weather", "ports"]);

// Dense layers that collapse into count badges when zoomed out. A layer only
// clusters once it has at least CLUSTER_MIN_POINTS visible entities and the map
// is below CLUSTER_MAX_ZOOM; past that zoom every point renders individually.
const CLUSTER_LAYERS = new Set(["aviation", "fires", "seismic", "news", "telegram", "maritime", "ports"]);
const CLUSTER_MIN_POINTS = 15;
const CLUSTER_MAX_ZOOM = 5;

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
const menuIcons = {
  aviation: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M33.8 4.8c-1-1.9-2.6-1.9-3.6 0-1 1.8-1.4 7.1-1.4 12.2v8.2L7.1 36.8c-1.6.9-2.7 2.6-2.7 4.5v3.1l24.4-7.6v9.7l-7.3 5.6v2.9l9.3-2.8 9.3 2.8v-2.9l-7.3-5.6v-9.7l24.4 7.6v-3.1c0-1.9-1-3.6-2.7-4.5L32.8 25.2V17c0-5.1-.1-10.4 1-12.2Z"/></svg>`,
  ports: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M29 23h6v25c7.3-1.1 12-5.4 14.3-12.9l-6.6 1.9-1.7-5.8 15.6-4.5L61 42.4l-5.8 1.7-1.7-5.8C49.8 48.5 42.6 54 32 54S14.2 48.5 10.5 38.3l-1.7 5.8L3 42.4l4.4-15.7L23 31.2 21.3 37l-6.6-1.9C17 42.6 21.7 46.9 29 48V23Z"/></svg>`,
  fires: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M33 59c-11.7 0-21-8.4-21-20 0-8.5 5.3-14.5 10.2-20.2 2.8-3.2 5.4-6.2 6.5-9.8.3-1.1 1.7-1.4 2.4-.5 3.6 4.4 5.3 9.2 5.1 14.5 2.1-1.7 3.7-4.1 4.8-7.1.4-1.1 1.9-1.2 2.5-.2C48.4 23.4 52 30.2 52 38.5 52 50.3 44.4 59 33 59Zm-1.2-8.5c5.4 0 9.2-3.8 9.2-9 0-4.2-1.9-7.7-4.7-11.7-.9 2.6-2.4 4.9-4.8 6.8-.9.7-2.3 0-2.1-1.2.5-3.9-.3-7.2-2.2-10.3-3.3 4-6.2 8.2-6.2 14.2 0 6.4 4.7 11.2 10.8 11.2Z"/></svg>`,
  seismic: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 7 47h17l-4 13 27-38H32l8-18h-8Z"/><path d="M9 56h12v4H9zm18 0h11v4H27zm16 0h12v4H43z"/></svg>`,
  weather: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M46 48H18C9.7 48 4 42.3 4 34.7c0-6.8 4.8-12.2 11.4-13.2C18.2 13.1 26.1 7 35.5 7 46.9 7 56 16.1 56 27.3 61 29.4 64 33.8 64 39c0 5.2-4 9-18 9Z"/><path d="m28 51-6 10h9l-3 9 12-16h-9l4-8z"/></svg>`,
  space: `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="13"/><path d="M32 4a3 3 0 0 1 3 3v8a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Zm0 42a3 3 0 0 1 3 3v8a3 3 0 1 1-6 0v-8a3 3 0 0 1 3-3ZM4 32a3 3 0 0 1 3-3h8a3 3 0 1 1 0 6H7a3 3 0 0 1-3-3Zm42 0a3 3 0 0 1 3-3h8a3 3 0 1 1 0 6h-8a3 3 0 0 1-3-3ZM12.2 12.2a3 3 0 0 1 4.2 0l5.6 5.6a3 3 0 0 1-4.2 4.2l-5.6-5.6a3 3 0 0 1 0-4.2Zm29.8 29.8a3 3 0 0 1 4.2 0l5.6 5.6a3 3 0 0 1-4.2 4.2L42 46.2a3 3 0 0 1 0-4.2Zm9.8-29.8a3 3 0 0 1 0 4.2L46.2 22a3 3 0 0 1-4.2-4.2l5.6-5.6a3 3 0 0 1 4.2 0ZM22 42a3 3 0 0 1 0 4.2l-5.6 5.6a3 3 0 0 1-4.2-4.2l5.6-5.6A3 3 0 0 1 22 42Z"/></svg>`,
  telegram: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M58.8 8.5 49.3 54c-.7 3.2-2.6 4-5.2 2.5L29.6 45.8l-7 6.8c-.8.8-1.4 1.4-2.9 1.4l1-14.8L47.8 14.7c1.2-1.1-.3-1.7-1.8-.6L12.5 35.2 1.9 31.9c-3.1-1-3.2-3.1.7-4.6L54.1 7.4c2.4-.9 4.5.6 4.7 1.1Z"/></svg>`,
  cyber: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 9 13v17c0 15.2 9.7 25.8 23 30 13.3-4.2 23-14.8 23-30V13L32 4Zm0 9.2 14 5.5V30c0 9.9-5.3 17.3-14 21-8.7-3.7-14-11.1-14-21V18.7l14-5.5Z"/><path d="M31.8 20c4.4 0 7.8 3.1 8.2 7.3h4.5v5H40v4h4.5v5H39c-1.4 3.3-4.1 5.3-7.2 5.3s-5.8-2-7.2-5.3H19v-5h4.5v-4H19v-5h4.5c.5-4.2 3.9-7.3 8.3-7.3Zm-3.4 12.3v4.2c0 3.1 1.4 5 3.4 5s3.4-1.9 3.4-5v-4.2h-6.8Zm.2-5h6.4c-.5-1.5-1.6-2.4-3.2-2.4s-2.7.9-3.2 2.4Z"/></svg>`,
  crypto: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4c15.5 0 28 6.3 28 14v28c0 7.7-12.5 14-28 14S4 53.7 4 46V18C4 10.3 16.5 4 32 4Zm0 8C20.4 12 12 15.6 12 18s8.4 6 20 6 20-3.6 20-6-8.4-6-20-6Zm20 17.1C47 32.1 40 34 32 34s-15-1.9-20-4.9V34c0 2.4 8.4 6 20 6s20-3.6 20-6v-4.9Zm0 15.8C47 47.9 40 50 32 50s-15-2.1-20-5.1V46c0 2.4 8.4 6 20 6s20-3.6 20-6v-1.1Z"/><path d="M34.8 14.5v2.3c3.5.5 6.2 2.3 6.2 5.4 0 2.4-1.5 4-4.1 4.9 3 .8 4.9 2.6 4.9 5.5 0 3.6-2.9 5.8-7 6.3v2.6h-4.1V39h-5.1v2.5h-3.8V14.5h3.8V17h5.1v-2.5h4.1Zm-5.1 6.4v4.5h3.4c2 0 3.2-.7 3.2-2.2s-1.2-2.3-3.3-2.3h-3.3Zm0 8.4v5.5h3.9c2.1 0 3.4-1 3.4-2.7s-1.3-2.8-3.6-2.8h-3.7Z"/></svg>`,
  sanctions: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 8 14v16c0 15.6 10.1 26.1 24 30 13.9-3.9 24-14.4 24-30V14L32 4Zm0 8.8 16 6.7V30c0 10.5-5.8 18.1-16 21.5C21.8 48.1 16 40.5 16 30V19.5l16-6.7Z"/><path d="M24 24h16v5H24zm0 9h16v5H24zm0 9h10v5H24z"/><path d="m44.4 40.2 3.4 3.4 3.4-3.4 3.6 3.6-3.4 3.4 3.4 3.4-3.6 3.6-3.4-3.4-3.4 3.4-3.6-3.6 3.4-3.4-3.4-3.4z"/></svg>`
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

function renderLayerControls() {
  els.layerList.innerHTML = "";
  for (const layer of layerDefinitions) {
    const count = visibleEntities(layer.id).length;
    const menuIcon = menuIcons[layer.id] || "";
    // No live adapter and no static dataset — nothing to load, so the toggle is
    // disabled rather than silently doing nothing when checked.
    const unavailable = !layer.live && !layer.staticKey;
    const row = document.createElement("label");
    row.className = `layer-row${unavailable ? " unavailable" : ""}`;
    row.innerHTML = `
      <input type="checkbox" ${state.enabled.has(layer.id) ? "checked" : ""}${unavailable ? " disabled title=\"No data source yet\"" : ""} data-layer="${layer.id}">
      <span class="swatch ${menuIcon ? "icon-swatch" : ""}" style="--swatch: rgb(${layer.color.join(",")})">${menuIcon}</span>
      <span class="layer-label">${layer.label}${unavailable ? " (soon)" : ""}</span>
      <strong>${count}</strong>
    `;
    els.layerList.append(row);
  }
}

// Attached once at startup. Event delegation on the container means a single
// listener survives every renderLayerControls() re-render — re-attaching it per
// render (as before) leaked listeners and fired duplicate fetches on each toggle.
function wireLayerControls() {
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
    if (id === "seismic") {
      state.data.set(id, await fetchLayer(id));
    } else if (id === "fires" || id === "weather" || id === "ports") {
      state.data.set(id, await fetchLayer(id, true));
    } else if (id === "aviation") {
      state.data.set(id, await fetchLayer(id, true));
    } else if (id === "telegram" || id === "space" || id === "crypto" || id === "sanctions" || id === "news") {
      state.data.set(id, await fetchLayer(id));
    } else if (id === "cyber") {
      state.data.set(id, await fetchLayer(id));
    } else if (id === "maritime") {
      state.data.set(id, await fetchLayer(id, true));
    }
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

async function fetchLayer(id, withBounds = false) {
  const params = new URLSearchParams();
  if (withBounds && state.map) {
    const b = state.map.getBounds();
    params.set("lamin", b.getSouth().toFixed(2));
    params.set("lomin", b.getWest().toFixed(2));
    params.set("lamax", b.getNorth().toFixed(2));
    params.set("lomax", b.getEast().toFixed(2));
  }
  const suffix = params.toString() ? `?${params}` : "";
  const payload = await fetchJson(`/api/layers/${id}${suffix}`);
  await refreshHealth();
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
  const rows = state.data.get(id) || [];
  if (state.minSeverity <= 1) return rows;
  return rows.filter((row) => (Number(row.severity) || 1) >= state.minSeverity);
}

function shouldCluster(id, rows, zoom) {
  return CLUSTER_LAYERS.has(id) && rows.length >= CLUSTER_MIN_POINTS && zoom < CLUSTER_MAX_ZOOM;
}

// Grid-bin points into clusters. Cells shrink as you zoom in, so clusters split
// apart. A cell with one point is returned as a single (rendered as its normal
// icon); multi-point cells collapse into one count badge at the cell centroid.
function clusterPoints(rows, zoom) {
  const cellDeg = 90 / 2 ** zoom;
  const bins = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
    const key = `${Math.floor(row.lon / cellDeg)}:${Math.floor(row.lat / cellDeg)}`;
    let bin = bins.get(key);
    if (!bin) {
      bin = { sumLon: 0, sumLat: 0, items: [] };
      bins.set(key, bin);
    }
    bin.sumLon += row.lon;
    bin.sumLat += row.lat;
    bin.items.push(row);
  }
  const singles = [];
  const clusters = [];
  for (const bin of bins.values()) {
    if (bin.items.length === 1) {
      singles.push(bin.items[0]);
    } else {
      clusters.push({
        lon: bin.sumLon / bin.items.length,
        lat: bin.sumLat / bin.items.length,
        count: bin.items.length
      });
    }
  }
  return { singles, clusters };
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

function renderAll() {
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
  renderLayerControls();
  renderFeeds();
  refreshHealth();
}

function buildIconLayer(id, data) {
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
  els.detail.hidden = false;
  els.detail.innerHTML = `
    <button type="button" class="close-detail">×</button>
    <span class="detail-kicker" style="color: rgb(${color.join(",")})">${item.type || item.layer}</span>
    <h3>${escapeHtml(item.name || item.id)}</h3>
    <p>${escapeHtml(item.text || item.summary || item.status || item.source || "No additional detail available.")}</p>
    ${item.magnitude ? `<p>Magnitude ${item.magnitude}</p>` : ""}
    ${item.cvss ? `<p>CVSS ${item.cvss}</p>` : ""}
    ${item.epss ? `<p>EPSS ${(Number(item.epss) * 100).toFixed(1)}%</p>` : ""}
    ${item.kev ? `<p>Known exploited vulnerability</p>` : ""}
    ${item.dueDate ? `<p>Due ${escapeHtml(item.dueDate)}</p>` : ""}
    ${item.chain ? `<p>Chain ${escapeHtml(item.chain)}</p>` : ""}
    ${item.address ? `<p>Address ${escapeHtml(item.address)}</p>` : ""}
    ${item.groupCount ? `<p>Entries ${Number(item.groupCount).toLocaleString()}</p>` : ""}
    ${item.groupLabel ? `<p>Group ${escapeHtml(item.groupLabel)}</p>` : ""}
    ${item.mmsi ? `<p>MMSI ${escapeHtml(item.mmsi)}</p>` : ""}
    ${Number.isFinite(item.speedKnots) ? `<p>Speed ${Number(item.speedKnots).toFixed(1)} kn</p>` : ""}
    ${Number.isFinite(item.course) ? `<p>Course ${Number(item.course).toFixed(1)}</p>` : ""}
    ${Number.isFinite(item.altitudeKm) ? `<p>Altitude ${Number(item.altitudeKm).toFixed(1)} km</p>` : ""}
    ${item.sdnName ? `<p>SDN ${escapeHtml(item.sdnName)}</p>` : ""}
    ${item.sdnType ? `<p>SDN type ${escapeHtml(item.sdnType)}</p>` : ""}
    ${item.country ? `<p>Country ${escapeHtml(item.country)}</p>` : ""}
    ${item.region ? `<p>Region ${escapeHtml(item.region)}</p>` : ""}
    ${item.portNumber ? `<p>WPI ${escapeHtml(item.portNumber)}</p>` : ""}
    ${item.harborSize ? `<p>Harbor size ${escapeHtml(item.harborSize)}</p>` : ""}
    ${item.harborType ? `<p>Harbor type ${escapeHtml(item.harborType)}</p>` : ""}
    ${item.navArea ? `<p>NAVAREA ${escapeHtml(item.navArea)}</p>` : ""}
    ${item.unloCode ? `<p>UN/LOCODE ${escapeHtml(item.unloCode)}</p>` : ""}
    ${item.chartNumber ? `<p>Chart ${escapeHtml(item.chartNumber)}</p>` : ""}
    ${item.facilities?.length ? `<p>Facilities ${escapeHtml(item.facilities.join(", "))}</p>` : ""}
    ${item.programs?.length ? `<p>Programs ${escapeHtml(item.programs.slice(0, 6).join(", "))}</p>` : ""}
    ${item.topPrograms?.length ? `<p>Top programs ${escapeHtml(item.topPrograms.map((row) => `${row.name} (${row.count})`).join(", "))}</p>` : ""}
    ${item.topCountries?.length ? `<p>Top countries ${escapeHtml(item.topCountries.map((row) => `${row.name} (${row.count})`).join(", "))}</p>` : ""}
    ${item.sampleEntries?.length ? `<p>Sample ${escapeHtml(item.sampleEntries.map((row) => row.name).join("; "))}</p>` : ""}
    ${item.uid ? `<p>OFAC UID ${escapeHtml(item.uid)}</p>` : ""}
    ${Number.isFinite(item.akaCount) ? `<p>Aliases ${item.akaCount}</p>` : ""}
    ${Number.isFinite(item.idCount) ? `<p>IDs ${item.idCount}</p>` : ""}
    ${item.altitude ? `<p>Altitude ${Math.round(item.altitude).toLocaleString()} m</p>` : ""}
    ${item.confidence ? `<p>Confidence ${escapeHtml(item.confidence)}</p>` : ""}
    ${item.source ? `<p>Source ${escapeHtml(item.source)}</p>` : ""}
    ${item.url ? `<a href="${item.url}" target="_blank" rel="noreferrer">Open source</a>` : ""}
  `;
  els.detail.querySelector(".close-detail").addEventListener("click", () => {
    els.detail.hidden = true;
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[char]));
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

function renderFeeds() {
  const conflicts = state.data.get("conflict") || [];
  const telegram = state.data.get("telegram") || [];
  const seismic = state.data.get("seismic") || [];
  const rows = [...telegram.slice(0, 4), ...conflicts.slice(0, 5), ...seismic.slice(0, 4)];
  els.feedList.innerHTML = rows.map((row) => `
    <button class="feed-item" type="button" data-id="${row.id}" data-layer="${row.layer}">
      <strong>${escapeHtml(row.name || row.place || row.channel)}</strong>
      <span>${escapeHtml(row.type || row.status || "Live item")}</span>
    </button>
  `).join("");

  els.feedList.querySelectorAll(".feed-item").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.data.get(button.dataset.layer)?.find((row) => row.id === button.dataset.id);
      if (!item) return;
      state.map.flyTo({ center: [item.lon, item.lat], zoom: 5 });
      showDetail(item);
    });
  });
}

async function refreshViewportAware() {
  await Promise.all([...VIEWPORT_AWARE_LAYERS].map((id) => refreshLiveLayer(id)));
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
    result.innerHTML = `
      <div class="${payload.sanctioned ? "badge danger" : "badge ok"}">${payload.sanctioned ? "SANCTIONED - OFAC SDN" : "No OFAC crypto match"}</div>
      <pre>${escapeHtml(JSON.stringify(payload.data, null, 2).slice(0, 1800))}</pre>
    `;
  } catch (error) {
    result.textContent = error.message;
  }
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
    result.innerHTML = results.length ? results.map((row) => `
      <article class="result-item">
        <strong>${escapeHtml(row.caption || row.id)}</strong>
        <span>${escapeHtml((row.schema || "Entity") + " · " + (row.datasets?.[0] || "OpenSanctions"))}</span>
      </article>
    `).join("") : "No matches.";
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
    ip: `/api/intel/ip?ip=${encodeURIComponent(q)}`,
    domain: `/api/intel/virustotal/domain?domain=${encodeURIComponent(q)}`,
    url: `/api/intel/virustotal/url?url=${encodeURIComponent(q)}`,
    whois: `/api/intel/whois?query=${encodeURIComponent(q)}`
  }[kind];
  try {
    const payload = await fetchJson(route);
    result.innerHTML = kind === "whois"
      ? renderWhois(payload)
      : `<pre>${escapeHtml(JSON.stringify(payload, null, 2).slice(0, 2400))}</pre>`;
  } catch (error) {
    result.textContent = error.message;
  }
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
    result.innerHTML = (payload.vulnerabilities || []).slice(0, 8).map((row) => `
      <article class="result-item">
        <strong>${escapeHtml(row.cve.id)}</strong>
        <span>${escapeHtml(row.cve.descriptions?.[0]?.value || "No description").slice(0, 220)}</span>
      </article>
    `).join("") || "No CVEs found.";
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

  document.querySelector("#refresh-active").addEventListener("click", async () => {
    [...state.enabled].forEach((id) => state.fetched.delete(id));
    await hydrateInitialLayers();
  });

  document.querySelector("#export-snapshot").addEventListener("click", exportSnapshot);

  document.querySelector("#place-search").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    runPlaceSearch();
  });

  renderReconHistory();
}

function runPlaceSearch() {
  const q = document.querySelector("#place-search").value.trim();
  if (!q) return;
  recordRecon("place", q, { "#place-search": q });
  const needle = q.toLowerCase();
  const item = [...state.data.values()].flat().find((row) => row.name?.toLowerCase().includes(needle) || row.place?.toLowerCase().includes(needle));
  if (item) {
    state.map.flyTo({ center: [item.lon, item.lat], zoom: 5 });
    showDetail(item);
  }
}

function tickClock() {
  els.clock.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(new Date());
}

// Trim an entity to the fields worth putting in an exported analyst snapshot.
function snapshotEntity(item) {
  return {
    id: item.id,
    layer: item.layer,
    type: item.type,
    name: item.name,
    lat: item.lat,
    lon: item.lon,
    severity: item.severity,
    ...(item.magnitude != null ? { magnitude: item.magnitude } : {}),
    ...(item.confidence ? { confidence: item.confidence } : {}),
    ...(item.time ? { time: item.time } : {}),
    ...(item.source ? { source: item.source } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(item.summary || item.text ? { note: String(item.summary || item.text).slice(0, 300) } : {})
  };
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
tickClock();
setInterval(tickClock, 1000);
setInterval(pollDueLayers, POLL_TICK_MS);
loadStaticLayers()
  .then((data) => { staticLayers = data; })
  .finally(hydrateInitialLayers);
refreshHealth();
