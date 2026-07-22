import test from "node:test";
import assert from "node:assert/strict";
import { attackUrl, cwesFromCve, techniquesForCwes, TECHNIQUES, CWE_TO_TECHNIQUE } from "../src/lib/attack.js";

test("attackUrl builds technique and sub-technique deep links", () => {
  assert.equal(attackUrl("T1190"), "https://attack.mitre.org/techniques/T1190/");
  assert.equal(attackUrl("T1505.003"), "https://attack.mitre.org/techniques/T1505/003/");
});

test("cwesFromCve extracts real CWE ids and drops NVD placeholders", () => {
  const cve = {
    weaknesses: [
      { description: [{ lang: "en", value: "CWE-89" }, { lang: "en", value: "NVD-CWE-noinfo" }] },
      { description: [{ lang: "en", value: "CWE-89" }] }, // duplicate collapses
      { description: [{ lang: "en", value: "CWE-78" }] }
    ]
  };
  assert.deepEqual(cwesFromCve(cve), ["CWE-89", "CWE-78"]);
});

test("cwesFromCve is safe on missing/empty weaknesses", () => {
  assert.deepEqual(cwesFromCve({}), []);
  assert.deepEqual(cwesFromCve(null), []);
  assert.deepEqual(cwesFromCve({ weaknesses: [] }), []);
});

test("techniquesForCwes maps, dedupes, and resolves catalog metadata", () => {
  // CWE-89 → T1190, CWE-22 → T1190 (same technique, must dedupe), CWE-78 → T1059.
  const tags = techniquesForCwes(["CWE-89", "CWE-22", "CWE-78"]);
  assert.deepEqual(tags.map((t) => t.id), ["T1190", "T1059"]);
  const t1190 = tags.find((t) => t.id === "T1190");
  assert.equal(t1190.name, "Exploit Public-Facing Application");
  assert.equal(t1190.tactic, "Initial Access");
  assert.equal(t1190.url, "https://attack.mitre.org/techniques/T1190/");
});

test("techniquesForCwes yields nothing for unmapped or empty input", () => {
  assert.deepEqual(techniquesForCwes(["CWE-99999"]), []);
  assert.deepEqual(techniquesForCwes([]), []);
  assert.deepEqual(techniquesForCwes(null), []);
});

test("every mapped technique id exists in the catalog", () => {
  for (const ids of Object.values(CWE_TO_TECHNIQUE)) {
    for (const id of ids) {
      assert.ok(TECHNIQUES[id], `technique ${id} referenced by mapping but missing from TECHNIQUES`);
    }
  }
});
