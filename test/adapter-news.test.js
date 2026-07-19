import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { newsLayer } from "../src/adapters/news.js";

function withEnv(key, value, fn) {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  return (async () => {
    try { return await fn(); }
    finally { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; }
  })();
}

test("newsLayer serves the curated broadcaster fallback without a key", async () => {
  await withEnv("NEWSAPI_KEY", undefined, async () => {
    const { entities, meta } = await newsLayer();
    assert.equal(meta.configured, false);
    assert.equal(meta.source, "Static broadcaster directory");
    assert.ok(entities.length >= 6);
    assert.ok(entities.every((e) => e.layer === "news" && e.url));
    assert.ok(entities.some((e) => e.name === "BBC World"));
  });
});

test("newsLayer maps NewsAPI articles when configured", async () => {
  await withEnv("NEWSAPI_KEY", "test-key", async () => {
    const restore = installJsonFetch((url) => url.includes("newsapi.org")
      ? { totalResults: 2, articles: [
          { title: "Sanctions expanded", description: "desc", url: "https://x.test/a", publishedAt: "2026-06-01T00:00:00Z", source: { id: "reuters", name: "Reuters" } },
          { title: "Cyber incident", description: "desc2", url: "https://x.test/b", publishedAt: "2026-06-01T01:00:00Z", source: { id: "bbc-news", name: "BBC" } }
        ] }
      : {});
    try {
      const { entities, meta } = await newsLayer();
      assert.equal(meta.configured, true);
      assert.equal(meta.source, "NewsAPI");
      assert.equal(meta.totalResults, 2);
      assert.equal(entities.length, 2);
      assert.equal(entities[0].name, "Sanctions expanded");
      assert.ok(entities.every((e) => e.layer === "news" && Number.isFinite(e.lat)));
    } finally {
      restore();
    }
  });
});
