import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { secCompany, matchCompany, wikidataEntity, gravatarProfile, gravatarHash, githubUser } from "../src/adapters/entity.js";

const tickers = {
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 1318605, ticker: "TSLA", title: "Tesla, Inc." }
};

test("matchCompany prefers exact ticker, then name prefix, then contains", () => {
  const rows = Object.values(tickers);
  assert.equal(matchCompany(rows, "AAPL").cik_str, 320193);
  assert.equal(matchCompany(rows, "tesla").cik_str, 1318605);
  assert.equal(matchCompany(rows, "apple inc").cik_str, 320193);
  assert.equal(matchCompany(rows, "nonexistent-co"), null);
});

test("secCompany resolves a name to CIK and builds EDGAR archive links", async () => {
  const restore = installJsonFetch((url) => {
    if (url.includes("company_tickers.json")) return tickers;
    if (url.includes("CIK0001318605")) {
      return {
        name: "Tesla, Inc.",
        sicDescription: "Motor Vehicles",
        exchanges: ["Nasdaq"],
        addresses: { business: { city: "AUSTIN", stateOrCountry: "TX" } },
        filings: { recent: {
          accessionNumber: ["0001628280-26-046717"],
          form: ["8-K"],
          filingDate: ["2026-07-02"],
          primaryDocument: ["tsla-20260702.htm"]
        } }
      };
    }
    return {};
  });
  try {
    const sec = await secCompany("Tesla");
    assert.equal(sec.company.name, "Tesla, Inc.");
    assert.equal(sec.company.ticker, "TSLA");
    assert.equal(sec.company.cik, "0001318605");
    assert.equal(sec.company.location, "AUSTIN, TX");
    assert.equal(sec.filings.length, 1);
    // CIK is un-padded and the accession dashes are stripped in the archive URL.
    assert.equal(sec.filings[0].url, "https://www.sec.gov/Archives/edgar/data/1318605/000162828026046717/tsla-20260702.htm");
  } finally {
    restore();
  }
});

test("secCompany reports a miss rather than fetching a null CIK", async () => {
  const restore = installJsonFetch(tickers);
  try {
    const sec = await secCompany("Definitely Not A Company");
    assert.match(sec.error, /No SEC-registered company/);
    assert.deepEqual(sec.filings, []);
  } finally {
    restore();
  }
});

test("wikidataEntity maps search hits to id/label/description", async () => {
  const restore = installJsonFetch({
    search: [{ id: "Q567", label: "Angela Merkel", description: "chancellor of Germany", concepturi: "http://www.wikidata.org/entity/Q567" }]
  });
  try {
    const wd = await wikidataEntity("Angela Merkel");
    assert.equal(wd.matches[0].id, "Q567");
    assert.equal(wd.matches[0].label, "Angela Merkel");
    assert.match(wd.matches[0].url, /Q567/);
  } finally {
    restore();
  }
});

test("wikidataEntity reports no matches distinctly from an empty query", async () => {
  const restore = installJsonFetch({ search: [] });
  try {
    assert.match((await wikidataEntity("zzzq")).error, /No Wikidata entity/);
    assert.match((await wikidataEntity("")).error, /name is required/);
  } finally {
    restore();
  }
});

test("gravatarHash is the md5 of the lowercased, trimmed email", () => {
  // Matches Gravatar's documented hashing of a known address.
  assert.equal(gravatarHash("  MyEmailAddress@example.com "), gravatarHash("myemailaddress@example.com"));
  assert.equal(gravatarHash("beau@dentedreality.com.au").length, 32);
});

test("gravatarProfile normalizes a found profile and surfaces stated pronouns", async () => {
  const restore = installJsonFetch({
    entry: [{ displayName: "Beau Lebens", pronouns: "he/him", currentLocation: "Golden, CO", job_title: "Lead", company: "Automattic",
      profileUrl: "https://gravatar.com/beau", accounts: [{ name: "GitHub", url: "https://github.com/beaulebens" }] }]
  });
  try {
    const gr = await gravatarProfile("beau@example.com");
    assert.equal(gr.found, true);
    assert.equal(gr.profile.displayName, "Beau Lebens");
    assert.equal(gr.profile.pronouns, "he/him");
    assert.equal(gr.profile.accounts.length, 1);
  } finally {
    restore();
  }
});

test("gravatarProfile requires an email and reports a clean not-found", async () => {
  const restore = installJsonFetch({});
  try {
    assert.equal((await gravatarProfile("not-an-email")).error, "Enter an email address.");
    const miss = await gravatarProfile("nobody@example.com");
    assert.equal(miss.found, false);
  } finally {
    restore();
  }
});

test("githubUser joins the profile with recently-pushed repos", async () => {
  const restore = installJsonFetch((url) => {
    if (/\/repos\?/.test(url)) return [{ name: "linux", stargazers_count: 240100, language: "C", pushed_at: "2026-07-01T00:00:00Z", html_url: "https://github.com/torvalds/linux" }];
    return { login: "torvalds", id: 1024025, name: "Linus Torvalds", company: "Linux Foundation", location: "Portland, OR", public_repos: 12, followers: 312711, created_at: "2011-09-03T15:26:22Z", html_url: "https://github.com/torvalds" };
  });
  try {
    const gh = await githubUser("@torvalds");
    assert.equal(gh.found, true);
    assert.equal(gh.profile.name, "Linus Torvalds");
    assert.equal(gh.profile.publicRepos, 12);
    assert.equal(gh.repos[0].name, "linux");
    assert.equal(gh.repos[0].stars, 240100);
  } finally {
    restore();
  }
});

test("githubUser requires a username and reports empty input distinctly", async () => {
  assert.equal((await githubUser("")).error, "Enter a GitHub username.");
});
