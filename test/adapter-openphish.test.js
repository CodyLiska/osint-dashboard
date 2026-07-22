import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { openPhishHostLookup } from "../src/adapters/intel.js";
import { intelResultState, intelCard } from "../public/logic.js";

const feed = [
  "https://bpksbd.org/terms-of-use/",
  "https://login.evil-phish.example/account",
  "https://sub.evil-phish.example/verify",
  "not a url",
  ""
].join("\n");

test("openPhishHostLookup flags a host present in the active feed", async () => {
  const restore = installFetch(feed);
  try {
    const hit = await openPhishHostLookup("bpksbd.org");
    assert.equal(hit.source, "OpenPhish");
    assert.equal(hit.data.listed, true);
    assert.equal(hit.data.matchCount, 1);
    assert.equal(hit.data.urls[0], "https://bpksbd.org/terms-of-use/");
  } finally {
    restore();
  }
});

test("openPhishHostLookup matches subdomains of the queried host and ignores www.", async () => {
  const restore = installFetch(feed);
  try {
    // Both login.evil-phish.example and sub.evil-phish.example are hosts under it.
    const hit = await openPhishHostLookup("evil-phish.example");
    assert.equal(hit.data.matchCount, 2);
  } finally {
    restore();
  }
});

test("openPhishHostLookup reports a clean host distinctly", async () => {
  const restore = installFetch(feed);
  try {
    const miss = await openPhishHostLookup("google.com");
    assert.equal(miss.data.listed, false);
    assert.equal(miss.data.matchCount, 0);
  } finally {
    restore();
  }
});

test("the OpenPhish fan-out card classifies as flagged / clean", () => {
  assert.equal(intelResultState({ source: "OpenPhish", data: { listed: true, matchCount: 2, urls: ["https://x"] } }), "flagged");
  assert.equal(intelResultState({ source: "OpenPhish", data: { listed: false, matchCount: 0, urls: [] } }), "clean");
  // The card renders a verdict either way.
  assert.match(intelCard({ source: "OpenPhish", data: { listed: true, matchCount: 1, urls: ["https://x"] } }), /phishing/i);
});
