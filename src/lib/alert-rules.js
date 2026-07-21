import { readFileSync } from "node:fs";
import { geoProvenance, knownLayerIds } from "../adapters/layers.js";

// Alert rule loading and matching. Everything except loadRules() is pure, so the
// validation and matching semantics are unit-testable without touching the
// filesystem — the same seam every adapter here uses (a pure parseX plus a thin
// impure wrapper).
//
// A rule reads: on these layers, in this area, matching these words, at or above
// this severity — tell me. All present conditions must match (AND); separate
// rules are independent (OR).
//
// See docs/PLAN-alert-rules.md for the design and the decisions behind it.

const VALID_GEOFENCE_TYPES = new Set(["bbox", "circle"]);

// A geofence only means what an operator expects when the coordinates are a real
// position. "country" layers sit on a country centroid (spatially misleading —
// a Russia-wide outage plots in central Siberia) and "synthetic" layers scatter
// entities around a fixed anchor by array index (not a location at all, and it
// moves between fetches). Those must use `countries` or `keywords` instead.
const GEOFENCEABLE = new Set(["real", "inferred"]);

const EARTH_RADIUS_KM = 6371;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// ---- Validation (pure) -----------------------------------------------------

function validateGeofence(geofence, layers, errors, ruleId) {
  if (!isPlainObject(geofence)) {
    errors.push(`rule "${ruleId}": geofence must be an object`);
    return;
  }
  if (!VALID_GEOFENCE_TYPES.has(geofence.type)) {
    errors.push(`rule "${ruleId}": geofence.type must be "bbox" or "circle"`);
    return;
  }

  if (geofence.type === "bbox") {
    for (const key of ["west", "south", "east", "north"]) {
      if (!isFiniteNumber(geofence[key])) {
        errors.push(`rule "${ruleId}": geofence.${key} must be a number`);
        return;
      }
    }
    if (geofence.south > geofence.north) {
      errors.push(`rule "${ruleId}": geofence.south is north of geofence.north`);
    }
    // A west > east bbox is the antimeridian wrap. It is supported by
    // matchGeofence, but it is also exactly what a transposed coordinate looks
    // like, so say plainly that it was read as a wrap rather than guessing.
    if (geofence.west > geofence.east && Math.abs(geofence.west - geofence.east) < 180) {
      errors.push(`rule "${ruleId}": geofence west (${geofence.west}) is east of east (${geofence.east}) but does not look like an antimeridian wrap — check for transposed values`);
    }
  } else {
    if (!isFiniteNumber(geofence.lat) || !isFiniteNumber(geofence.lon)) {
      errors.push(`rule "${ruleId}": geofence.lat and geofence.lon must be numbers`);
      return;
    }
    if (!isFiniteNumber(geofence.radiusKm) || geofence.radiusKm <= 0) {
      errors.push(`rule "${ruleId}": geofence.radiusKm must be a positive number`);
    }
  }

  // Reject rather than silently match nonsense. A rule file that stops loading
  // is visible; a rule quietly firing on array-index coordinates is not.
  const unusable = layers.filter((id) => !GEOFENCEABLE.has(geoProvenance(id)));
  if (unusable.length) {
    const detail = unusable.map((id) => `${id} (${geoProvenance(id)})`).join(", ");
    errors.push(`rule "${ruleId}": geofence cannot apply to ${detail} — those coordinates are not real positions; use "countries" or "keywords" instead`);
  }
}

function validateRule(raw, index, seenIds) {
  const errors = [];
  const ruleId = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : null;

  if (!isPlainObject(raw)) return { errors: [`rule at index ${index} is not an object`] };
  if (!ruleId) return { errors: [`rule at index ${index} is missing a string "id"`] };
  if (seenIds.has(ruleId)) {
    // Ids are part of the dedupe key, so duplicates would share alert state.
    return { errors: [`rule "${ruleId}" is defined more than once`] };
  }

  const known = new Set(knownLayerIds());
  let layers = known.size ? [...known] : [];
  if (raw.layers !== undefined) {
    if (!Array.isArray(raw.layers) || !raw.layers.length) {
      errors.push(`rule "${ruleId}": layers must be a non-empty array when present`);
    } else {
      const unknown = raw.layers.filter((id) => !known.has(id));
      if (unknown.length) {
        errors.push(`rule "${ruleId}": unknown layer(s) ${unknown.join(", ")}`);
      }
      layers = raw.layers.filter((id) => known.has(id));
    }
  }

  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords) || !raw.keywords.length
      || raw.keywords.some((word) => typeof word !== "string" || !word.trim())) {
      errors.push(`rule "${ruleId}": keywords must be a non-empty array of non-empty strings`);
    }
  }

  if (raw.countries !== undefined) {
    if (!Array.isArray(raw.countries) || !raw.countries.length
      || raw.countries.some((code) => typeof code !== "string" || !code.trim())) {
      errors.push(`rule "${ruleId}": countries must be a non-empty array of country names or ISO codes`);
    }
  }

  if (raw.minSeverity !== undefined
    && (!isFiniteNumber(raw.minSeverity) || raw.minSeverity < 1 || raw.minSeverity > 5)) {
    errors.push(`rule "${ruleId}": minSeverity must be a number from 1 to 5`);
  }

  if (raw.geofence !== undefined) validateGeofence(raw.geofence, layers, errors, ruleId);

  // A rule with no conditions matches every entity on every layer. That is a
  // typo, not an intent, so it is refused rather than warned about. An explicit
  // `layers` list counts as a condition; the implicit all-layers default does not.
  const hasCondition = raw.geofence !== undefined || raw.keywords !== undefined
    || raw.countries !== undefined || raw.minSeverity !== undefined
    || raw.layers !== undefined;
  if (!hasCondition) {
    errors.push(`rule "${ruleId}": has no conditions and would match every entity on every layer`);
  }

  if (errors.length) return { errors };

  return {
    errors: [],
    rule: {
      id: ruleId,
      enabled: raw.enabled !== false,
      layers,
      // Layers were defaulted to "all known" above; remember whether the rule
      // actually named any, so reporting can tell the two apart.
      explicitLayers: Array.isArray(raw.layers),
      geofence: raw.geofence,
      keywords: raw.keywords?.map((word) => word.trim().toLowerCase()),
      countries: raw.countries?.map((code) => code.trim().toLowerCase()),
      minSeverity: raw.minSeverity ?? 1
    }
  };
}

// Validate a parsed rules document. Never throws and never does I/O: returns the
// rules that are usable plus an error line for each one that is not, so a single
// bad rule cannot disable the rest of the file.
export function parseRules(input) {
  if (!Array.isArray(input)) {
    return { rules: [], errors: ["alert rules file must contain a JSON array of rules"] };
  }

  const rules = [];
  const errors = [];
  const seenIds = new Set();
  input.forEach((raw, index) => {
    const { rule, errors: ruleErrors } = validateRule(raw, index, seenIds);
    if (rule) {
      seenIds.add(rule.id);
      rules.push(rule);
    }
    errors.push(...ruleErrors);
  });

  return { rules, errors };
}

// ---- Matching (pure) -------------------------------------------------------

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function matchGeofence(geofence, entity) {
  const { lat, lon } = entity;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;

  if (geofence.type === "circle") {
    return haversineKm(geofence.lat, geofence.lon, lat, lon) <= geofence.radiusKm;
  }

  if (lat < geofence.south || lat > geofence.north) return false;
  // A bbox with west > east crosses the antimeridian (e.g. 170 to -170), where
  // the longitude range is the union of two spans rather than one.
  return geofence.west > geofence.east
    ? lon >= geofence.west || lon <= geofence.east
    : lon >= geofence.west && lon <= geofence.east;
}

// Word-boundary match, not substring. A substring match fires "London" inside
// "Londonderry" — the gazetteer has already been through this exact bug.
export function matchKeyword(keyword, text) {
  if (!keyword || !text) return false;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, "iu").test(text);
}

function entityText(entity) {
  return [entity.name, entity.summary, entity.text, entity.type]
    .filter(Boolean).join(" ");
}

function matchCountry(countries, entity) {
  const candidates = [entity.country, entity.countryCode]
    .filter(Boolean).map((value) => String(value).toLowerCase());
  return candidates.some((value) => countries.includes(value));
}

// Does one rule match one entity? The primitive everything else composes from.
export function matchRule(rule, entity) {
  if (!rule.enabled) return false;
  if (!entity || entity.layer === undefined) return false;
  if (!rule.layers.includes(entity.layer)) return false;
  if ((Number(entity.severity) || 1) < rule.minSeverity) return false;
  if (rule.geofence && !matchGeofence(rule.geofence, entity)) return false;
  if (rule.countries && !matchCountry(rule.countries, entity)) return false;
  if (rule.keywords) {
    const text = entityText(entity);
    if (!rule.keywords.some((keyword) => matchKeyword(keyword, text))) return false;
  }
  return true;
}

// Match a batch of entities and group the hits BY RULE, because that is what
// delivery consumes — one notification per rule listing its matches, rather than
// one per entity. Returns a Map so rule ids can never collide with Object keys;
// callers convert at the API boundary. Rules with no matches are omitted.
export function matchBatch(rules, entities) {
  const grouped = new Map();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const matches = (entities || []).filter((entity) => matchRule(rule, entity));
    if (matches.length) grouped.set(rule.id, matches);
  }
  return grouped;
}

// ---- Loading (impure) ------------------------------------------------------

// Last successfully parsed rule set. A malformed file leaves this untouched, so
// a bad edit degrades to the previous working rules rather than to no alerting.
let lastGood = [];

export function loadRules(path = process.env.OSIRIS_ALERT_RULES_PATH || "./config/alert-rules.json") {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      // No rules file is a valid configuration: alerting is simply off.
      return { rules: [], errors: [], path, present: false };
    }
    console.error(`[alerts] cannot read ${path}: ${error.message}`);
    return { rules: lastGood, errors: [error.message], path, present: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Distinct from a single invalid rule: the whole document is unreadable, so
    // keep every previously loaded rule rather than dropping to zero.
    console.error(`[alerts] ${path} is not valid JSON, keeping ${lastGood.length} previously loaded rule(s): ${error.message}`);
    return { rules: lastGood, errors: [error.message], path, present: true };
  }

  const { rules, errors } = parseRules(parsed);
  for (const message of errors) console.error(`[alerts] ${message}`);
  lastGood = rules;
  console.log(`[alerts] loaded ${rules.length} rule(s) from ${path}${errors.length ? ` (${errors.length} rejected)` : ""}`);
  return { rules, errors, path, present: true };
}

// Test seam: reset the last-good cache between cases.
export function resetLoadedRules() {
  lastGood = [];
}
