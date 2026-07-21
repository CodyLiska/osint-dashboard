import test from "node:test";
import assert from "node:assert/strict";
import { intelCard, intelCards } from "../public/logic.js";

const card = (source, data, error) => intelCard({ source, data, error });

test("a missing API key reads as unchecked, not as a clean result", () => {
  // The whole point of the card view: an analyst must never mistake "we did not
  // look" for "we looked and it was fine".
  const html = card("VirusTotal", null, "VIRUSTOTAL_API_KEY is not configured");
  assert.match(html, /NOT CONFIGURED/);
  assert.doesNotMatch(html, /CLEAN/);
});

test("a source that failed is distinguished from one that is switched off", () => {
  const failed = card("RIPEstat", null, "503 Service Unavailable");
  assert.match(failed, /UNAVAILABLE/);
  assert.doesNotMatch(failed, /NOT CONFIGURED/);
});

test("a positive threat hit is reported as flagged", () => {
  assert.match(card("Tor Exit Nodes", { torExit: true }), /FLAGGED/);
  assert.match(card("Feodo Tracker", { c2: true, malware: "Emotet" }), /FLAGGED/);
  assert.match(card("Spamhaus DROP", { listed: true, sbl: "SBL123" }), /FLAGGED/);
  assert.match(card("AbuseIPDB", { abuseConfidenceScore: 90 }), /FLAGGED/);
});

test("a negative result from the same source is reported as clean", () => {
  assert.match(card("Tor Exit Nodes", { torExit: false }), /CLEAN/);
  assert.match(card("Feodo Tracker", { c2: false }), /CLEAN/);
  assert.match(card("Spamhaus DROP", { listed: false }), /CLEAN/);
  assert.match(card("AbuseIPDB", { abuseConfidenceScore: 0 }), /CLEAN/);
});

test("GreyNoise 'riot' is a reassurance, not a threat hit", () => {
  // riot means a known-benign common service (8.8.8.8 and friends). Treating it
  // as a hit would flag the internet's most ordinary addresses.
  const html = card("GreyNoise Community", { noise: false, riot: true, name: "Google DNS" });
  assert.match(html, /CLEAN/);
  assert.match(html, /Google DNS/);
});

test("exposed ports alone do not flag a host, but known CVEs do", () => {
  // Shodan reporting open ports is a fact about the host, not a verdict; a CVE
  // list is. Conflating them would flag every web server on the internet.
  assert.match(card("Shodan InternetDB", { ports: [80, 443], vulns: [] }), /CLEAN/);
  assert.match(card("Shodan InternetDB", { ports: [80], vulns: ["CVE-2021-44228"] }), /FLAGGED/);
});

test("RIPEstat is enrichment and never renders a threat verdict", () => {
  const html = card("RIPEstat", { asns: ["13335"], prefix: "1.1.1.0/24", holder: "Cloudflare" });
  assert.match(html, /CLEAN/);
  assert.match(html, /Cloudflare/);
});

test("an unrecognised source still renders its data instead of vanishing", () => {
  // Adding a source to the fan-out must not require a renderer to appear at all.
  const html = card("Brand New Feed", { verdict: "interesting", score: 7 });
  assert.match(html, /Brand New Feed/);
  assert.match(html, /interesting/);
});

test("a flagged source is never buried below the clean ones", () => {
  const html = intelCards({
    results: [
      { source: "RIPEstat", data: { holder: "Example" } },
      { source: "VirusTotal", error: "VIRUSTOTAL_API_KEY is not configured" },
      { source: "Tor Exit Nodes", data: { torExit: true } }
    ]
  });
  assert.ok(html.indexOf("Tor Exit Nodes") < html.indexOf("RIPEstat"), "flagged sorts first");
  assert.ok(html.indexOf("RIPEstat") < html.indexOf("VirusTotal"), "unchecked sorts last");
});

test("the summary counts only sources that actually ran", () => {
  // Counting unconfigured sources as 'checked' would overstate the coverage
  // behind a clean verdict.
  const html = intelCards({
    results: [
      { source: "Tor Exit Nodes", data: { torExit: false } },
      { source: "Spamhaus DROP", data: { listed: false } },
      { source: "VirusTotal", error: "VIRUSTOTAL_API_KEY is not configured" }
    ]
  });
  assert.match(html, /No hits across 2 checked source/);
});

test("a single-source payload with no fan-out yields no cards", () => {
  // URL and hash lookups have no results[]; the caller falls back to raw JSON.
  assert.equal(intelCards({ data: { anything: true } }), "");
});
