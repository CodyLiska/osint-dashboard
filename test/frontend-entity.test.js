import test from "node:test";
import assert from "node:assert/strict";
import { entityCompanyBody, entityWikidataBody, entityGravatarBody, entityGithubBody } from "../public/logic.js";

test("entityCompanyBody renders the company badge, meta rows, and filing links", () => {
  const html = entityCompanyBody({
    company: { name: "Tesla, Inc.", ticker: "TSLA", cik: "0001318605", sic: "Motor Vehicles", location: "AUSTIN, TX", exchanges: "Nasdaq" },
    filings: [{ form: "8-K", date: "2026-07-02", url: "https://www.sec.gov/x.htm" }],
    source: "SEC EDGAR"
  });
  assert.match(html, /Tesla, Inc\. · TSLA/);
  assert.match(html, /0001318605/);
  assert.match(html, /8-K · 2026-07-02/);
  assert.match(html, /Open on EDGAR/);
});

test("entityCompanyBody surfaces an error badge", () => {
  assert.match(entityCompanyBody({ error: "No SEC-registered company matching \"x\".", filings: [] }), /No SEC-registered/);
});

test("entityWikidataBody lists matches with their Q-ids and descriptions", () => {
  const html = entityWikidataBody({ matches: [
    { id: "Q567", label: "Angela Merkel", description: "chancellor of Germany", url: "https://www.wikidata.org/wiki/Q567" }
  ] });
  assert.match(html, /Angela Merkel/);
  assert.match(html, /Q567/);
  assert.match(html, /chancellor of Germany/);
});

test("entityGravatarBody shows stated pronouns and links, and escapes content", () => {
  const html = entityGravatarBody({
    found: true,
    profile: { displayName: "Beau Lebens", pronouns: "he/him", location: "Golden, CO", jobTitle: "Lead", company: "Automattic",
      profileUrl: "https://gravatar.com/beau", accounts: [{ label: "GitHub", url: "https://github.com/x" }] }
  });
  assert.match(html, /Beau Lebens · he\/him/);
  assert.match(html, /Golden, CO/);
  assert.match(html, /Lead @ Automattic/);
  assert.match(html, /GitHub/);
});

test("entityGravatarBody reports a clean not-found", () => {
  assert.match(entityGravatarBody({ found: false, message: "No public Gravatar profile for that email." }), /No public Gravatar/);
});

test("entityGithubBody renders the profile, counts, and starred repos", () => {
  const html = entityGithubBody({
    found: true,
    profile: { login: "torvalds", name: "Linus Torvalds", company: "Linux Foundation", location: "Portland, OR", publicRepos: 12, followers: 312711, created: "2011-09-03T15:26:22Z", htmlUrl: "https://github.com/torvalds" },
    repos: [{ name: "linux", stars: 240100, language: "C", url: "https://github.com/torvalds/linux" }]
  });
  assert.match(html, /Linus Torvalds \(@torvalds\)/);
  assert.match(html, /12 \/ 312711/);
  assert.match(html, /linux/);
  assert.match(html, /★ 240100/);
});

test("entityGithubBody distinguishes a rate limit from a missing user", () => {
  assert.match(entityGithubBody({ error: "GitHub rate limit reached — set GITHUB_TOKEN to raise the 60/hr keyless limit." }), /rate limit/);
  assert.match(entityGithubBody({ found: false, message: "No public GitHub user \"ghost\"." }), /No public GitHub user/);
});
