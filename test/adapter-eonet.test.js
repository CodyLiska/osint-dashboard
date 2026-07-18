import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { eonetLayer } from "../src/adapters/eonet.js";

const events = (list) => ({ events: list });

test("eonetLayer normalizes events and uses the most recent geometry", async () => {
  const restore = installJsonFetch(events([{
    id: "EV1",
    title: "Storm One",
    categories: [{ title: "Severe Storms" }],
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
    assert.equal(e.severity, 3); // weather layer
    assert.equal(e.source, "GDACS");
    assert.deepEqual(meta.categories, ["severeStorms"]);
  } finally {
    restore();
  }
});

test("eonetLayer assigns severity 4 to non-weather layers", async () => {
  const restore = installJsonFetch(events([{
    id: "V1", title: "Volcano", categories: [{ title: "Volcanoes" }],
    geometry: [{ coordinates: [5, 5], date: "2026-01-01T00:00:00Z" }]
  }]));
  try {
    const { entities } = await eonetLayer("hazard", ["volcanoes"]);
    assert.equal(entities[0].severity, 4);
  } finally {
    restore();
  }
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
