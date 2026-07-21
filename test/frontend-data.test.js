import test from "node:test";
import assert from "node:assert/strict";
import { LAYER_GROUPS, layerDefinitions, loadStaticLayers } from "../public/data.js";

// public/data.js is import-safe in Node: it only touches `fetch` inside
// loadStaticLayers(), so the static layer definitions and loader are testable.

test("layerDefinitions have unique ids and valid rgb colors", () => {
  const ids = layerDefinitions.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const layer of layerDefinitions) {
    assert.ok(layer.label, `${layer.id} has a label`);
    assert.equal(layer.color.length, 3, `${layer.id} color is rgb`);
    assert.ok(layer.color.every((c) => c >= 0 && c <= 255), `${layer.id} color channels in range`);
    assert.ok(layer.live || layer.staticKey, `${layer.id} is either live or static`);
  }
});

test("loadStaticLayers keys datasets by name and tolerates a missing one", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("chokepoints")) {
      return new Response(JSON.stringify({ records: [{ id: "c1" }, { id: "c2" }] }), { status: 200 });
    }
    return new Response("not found", { status: 404 }); // cctv / conflict / military miss
  };
  try {
    const layers = await loadStaticLayers();
    assert.deepEqual(layers.chokepoints, [{ id: "c1" }, { id: "c2" }]);
    assert.deepEqual(layers.cctv, [], "a failed fetch yields an empty layer, not a throw");
    assert.deepEqual(layers.conflict, []);
    assert.ok("military" in layers);
  } finally {
    globalThis.fetch = original;
  }
});

test("every layer declares a group that exists", () => {
  // The sidebar renders one collapsible section per group. A layer with a
  // missing or unknown group would simply not render — invisible rather than
  // broken, which is the failure mode this codebase keeps hitting.
  const known = new Set(LAYER_GROUPS.map((g) => g.id));
  for (const layer of layerDefinitions) {
    assert.ok(known.has(layer.group), `${layer.id} has no valid group (got ${layer.group})`);
  }
});

test("no group is defined without layers in it", () => {
  // An empty group would render as a header that opens onto nothing.
  for (const group of LAYER_GROUPS) {
    const members = layerDefinitions.filter((l) => l.group === group.id);
    assert.ok(members.length, `group ${group.id} has no layers`);
  }
});
