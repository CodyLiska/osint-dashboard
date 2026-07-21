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
    // Status is carried for display but must not drive severity.
    const byStatus = Object.fromEntries(entities.map((e) => [e.name, e.status]));
    assert.equal(byStatus["Chad Drought"], "alert");
    assert.equal(byStatus["Sudan Floods"], "current");
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

test("severity reflects disaster impact, not lifecycle stage", async (t) => {
  // A disaster's normal progression is alert -> current. Mapping status onto
  // severity made every disaster appear to get LESS severe as it developed,
  // which corrupts the severity filter and makes escalation alerting
  // impossible. See the severity contract in src/lib/normalize.js.
  const previous = process.env.RELIEFWEB_APPNAME;
  process.env.RELIEFWEB_APPNAME = "osiris-test";
  t.after(() => {
    if (previous) process.env.RELIEFWEB_APPNAME = previous;
    else delete process.env.RELIEFWEB_APPNAME;
  });

  const restore = installJsonFetch({
    data: [
      disaster(1, "Quake", "current", "Nepal", "Earthquake"),
      disaster(2, "Slide", "alert", "Nepal", "Land Slide")
    ]
  });
  try {
    const { entities } = await reliefWebLayer();
    const bySeverity = Object.fromEntries(entities.map((e) => [e.name, e.severity]));
    // An earthquake outranks a landslide regardless of which one is merely an
    // alert and which is already under way.
    assert.ok(bySeverity.Quake > bySeverity.Slide);
  } finally {
    restore();
  }
});
