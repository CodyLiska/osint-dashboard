import test from "node:test";
import assert from "node:assert/strict";
import { installFetch } from "./helpers/mock-fetch.js";
import { telegramLayer } from "../src/adapters/telegram.js";

// One t.me/s/<channel> preview page with two message blocks: one whose text
// geoparses to a real gazetteer place (Kyiv) and one with no place mention.
function previewHtml(posts) {
  return posts.map((p) => `
    <div class="tgme_widget_message js-widget_message" data-post="${p.post}">
      <div class="tgme_widget_message_text js-message_text">${p.text}</div>
      <a class="tgme_widget_message_date"><time datetime="${p.datetime}">t</time></a>
    </div>
    </div>
  `).join("\n");
}

// Restrict to one deterministic test channel so the layer fetches a single page.
function withChannel(name, fn) {
  const saved = process.env.OSIRIS_TELEGRAM_CHANNELS;
  process.env.OSIRIS_TELEGRAM_CHANNELS = name;
  return (async () => {
    try { return await fn(); }
    finally { if (saved === undefined) delete process.env.OSIRIS_TELEGRAM_CHANNELS; else process.env.OSIRIS_TELEGRAM_CHANNELS = saved; }
  })();
}

test("telegramLayer geoparses a matching post into a placed entity", async () => {
  await withChannel("testchan", async () => {
    const html = previewHtml([
      { post: "testchan/42", text: "Heavy shelling reported in Kyiv overnight.", datetime: "2026-06-01T12:00:00+00:00" },
      { post: "testchan/43", text: "Statement issued with no location mentioned at all.", datetime: "2026-06-01T13:00:00+00:00" }
    ]);
    const restore = installFetch((url) => url.includes("t.me/s/testchan") ? html : "");
    try {
      const { entities, meta } = await telegramLayer();
      assert.equal(entities.length, 1, "only the geoparsable post becomes an entity");
      const e = entities[0];
      assert.equal(e.place, "Kyiv");
      assert.equal(e.channel, "testchan");
      assert.equal(e.layer, "telegram");
      assert.match(e.url, /t\.me\/testchan\/42/);
      assert.equal(e.text, "Heavy shelling reported in Kyiv overnight.");
      assert.ok(Number.isFinite(e.lat) && Number.isFinite(e.lon));
      assert.equal(meta.matchedPosts, 1);
      assert.equal(meta.channels[0], "testchan");
    } finally {
      restore();
    }
  });
});

test("telegramLayer yields no entities when nothing geoparses", async () => {
  await withChannel("testchan", async () => {
    const html = previewHtml([
      { post: "testchan/50", text: "A generic announcement without any place name.", datetime: "2026-06-02T09:00:00+00:00" }
    ]);
    const restore = installFetch((url) => url.includes("t.me/s/testchan") ? html : "");
    try {
      const { entities, meta } = await telegramLayer();
      assert.equal(entities.length, 0);
      assert.equal(meta.matchedPosts, 0);
      assert.equal(meta.inspectedPosts, 1);
    } finally {
      restore();
    }
  });
});
