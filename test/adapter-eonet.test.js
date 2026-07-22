import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { eonetLayer, severityForCategory } from "../src/adapters/eonet.js";

const events = (list) => ({ events: list });

test("eonetLayer normalizes events and uses the most recent geometry", async () => {
  const restore = installJsonFetch(events([{
    id: "EV1",
    title: "Storm One",
    categories: [{ id: "severeStorms", title: "Severe Storms" }],
    sources: [{ id: "GDACS" }],
    link: "http://e/1",
    geometry: [
      { coordinates: [10, 10], date: "2026-01-01T00:00:00Z" },
      { coordinates: [40, 25], date: "2026-01-02T00:00:00Z" }
    ]
  }]));
  try {
    const { entities, meta } = await eonetLayer("weather", ["severeStorms"]);
    assert.equal(entities.length, 1);
    const e = entities[0];
    assert.equal(e.id, "weather-EV1");
    assert.equal(e.type, "Severe Storms");
    assert.equal(e.lon, 40); // last geometry, coords[0]
    assert.equal(e.lat, 25); // last geometry, coords[1]
    assert.equal(e.severity, 4); // severeStorms weight
    assert.equal(e.source, "GDACS");
    assert.deepEqual(meta.categories, ["severeStorms"]);
  } finally {
    restore();
  }
});

test("eonetLayer derives severity per-category, not per-layer", async () => {
  const restore = installJsonFetch(events([
    { id: "V1", title: "Volcano", categories: [{ id: "volcanoes", title: "Volcanoes" }], geometry: [{ coordinates: [5, 5], date: "d" }] },
    { id: "S1", title: "Snow", categories: [{ id: "snow", title: "Snow" }], geometry: [{ coordinates: [6, 6], date: "d" }] },
    { id: "U1", title: "Odd", categories: [{ id: "mysteryCategory", title: "Odd" }], geometry: [{ coordinates: [7, 7], date: "d" }] }
  ]));
  try {
    // Same layer, three categories, three different severities — the whole point.
    const { entities } = await eonetLayer("weather", ["volcanoes", "snow"]);
    const byId = Object.fromEntries(entities.map((e) => [e.id, e]));
    assert.equal(byId["weather-V1"].severity, 5); // volcanoes
    assert.equal(byId["weather-S1"].severity, 2); // snow
    assert.equal(byId["weather-U1"].severity, 3); // unknown → default
  } finally {
    restore();
  }
});

test("severityForCategory ranks known categories and defaults the rest", () => {
  assert.equal(severityForCategory("volcanoes"), 5);
  assert.equal(severityForCategory("floods"), 4);
  assert.equal(severityForCategory("dustHaze"), 2);
  assert.equal(severityForCategory("nope"), 3);
  assert.equal(severityForCategory(undefined), 3);
});

test("eonetLayer skips events whose geometry has no finite coordinates", async () => {
  const restore = installJsonFetch(events([
    { id: "ok", title: "ok", categories: [{ title: "Floods" }], geometry: [{ coordinates: [1, 2], date: "d" }] },
    { id: "nogeo", title: "nogeo", categories: [{ title: "Floods" }] },
    { id: "badcoord", title: "bad", categories: [{ title: "Floods" }], geometry: [{ coordinates: [10], date: "d" }] }
  ]));
  try {
    const ids = (await eonetLayer("weather", ["floods"]).then((r) => r.entities)).map((e) => e.id);
    assert.deepEqual(ids, ["weather-ok"]);
  } finally {
    restore();
  }
});
