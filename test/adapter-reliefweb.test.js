import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { parseDisasters, reliefWebLayer } from "../src/adapters/reliefweb.js";

const disaster = (id, name, status, country, type = "Flood") => ({
  id,
  fields: {
    name, status,
    primary_country: { name: country },
    primary_type: { name: type },
    date: { event: "2026-07-01T00:00:00+00:00" },
    url_alias: `https://reliefweb.int/disaster/${id}`
  }
});

test("without a registered appname the layer reports itself off rather than empty", async (t) => {
  // ReliefWeb v2 rejects unregistered callers, so an operator with no appname
  // must see the amber "not configured" flag, not a silently empty layer.
  const previous = process.env.RELIEFWEB_APPNAME;
  delete process.env.RELIEFWEB_APPNAME;
  t.after(() => { if (previous) process.env.RELIEFWEB_APPNAME = previous; });

  const { entities, meta } = await reliefWebLayer();
  assert.equal(entities.length, 0);
  assert.equal(meta.configured, false);
  assert.match(meta.message, /RELIEFWEB_APPNAME/);
});

test("closed disasters are not presented as current situational awareness", async (t) => {
  const previous = process.env.RELIEFWEB_APPNAME;
  process.env.RELIEFWEB_APPNAME = "osiris-test";
  t.after(() => {
    if (previous) process.env.RELIEFWEB_APPNAME = previous;
    else delete process.env.RELIEFWEB_APPNAME;
  });

  const restore = installJsonFetch({
    data: [
      disaster(1, "Sudan Floods", "current", "Sudan"),
      disaster(2, "Chad Drought", "alert", "Chad", "Drought"),
      disaster(3, "Old Kenya Flood", "past", "Kenya")
    ]
  });
  try {
    const { entities, meta } = await reliefWebLayer();
    assert.equal(meta.configured, true);
    assert.deepEqual(entities.map((e) => e.name).sort(), ["Chad Drought", "Sudan Floods"]);
    // An alert is a forward-looking warning and must outrank an ongoing event.
    const bySeverity = Object.fromEntries(entities.map((e) => [e.name, e.severity]));
    assert.ok(bySeverity["Chad Drought"] > bySeverity["Sudan Floods"]);
    assert.ok(entities.every((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon)));
  } finally {
    restore();
  }
});

test("a record whose country cannot be placed is dropped, not plotted at 0,0", async (t) => {
  const previous = process.env.RELIEFWEB_APPNAME;
  process.env.RELIEFWEB_APPNAME = "osiris-test";
  t.after(() => {
    if (previous) process.env.RELIEFWEB_APPNAME = previous;
    else delete process.env.RELIEFWEB_APPNAME;
  });

  const restore = installJsonFetch({ data: [disaster(9, "Nowhere Crisis", "current", "Atlantis")] });
  try {
    const { entities } = await reliefWebLayer();
    assert.equal(entities.length, 0, "an unplaceable country must not land in the Gulf of Guinea");
  } finally {
    restore();
  }
});

test("the v2 envelope is read from fields, tolerating a missing primary country", () => {
  const rows = parseDisasters({
    data: [{ id: 7, fields: { name: "X", status: "current", country: [{ name: "Peru" }] } }]
  });
  assert.equal(rows[0].country, "Peru");
});
