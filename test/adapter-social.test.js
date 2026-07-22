import test from "node:test";
import assert from "node:assert/strict";
import { installJsonFetch } from "./helpers/mock-fetch.js";
import { mastodonTag } from "../src/adapters/social.js";
import { socialResults } from "../public/logic.js";

const timeline = [
  {
    id: "1", created_at: "2026-07-22T15:32:32.000Z",
    content: "<p>Drone attack on <a href=\"x\">#Sumy</a> &amp; Chernihiv</p>",
    url: "https://social.example/@a/1", reblogs_count: 3, favourites_count: 7,
    account: { acct: "analytics@social.vir.group", display_name: "Kraken", url: "https://social.example/@a" }
  },
  { id: "2", created_at: "2026-07-22T15:00:00.000Z", content: "", url: "", account: { acct: "x", display_name: "X" } }
];

test("mastodonTag normalizes posts and strips HTML + decodes entities", async () => {
  const restore = installJsonFetch(timeline);
  try {
    const out = await mastodonTag("#osint");
    assert.equal(out.tag, "osint", "the leading # is stripped");
    assert.equal(out.instance, "mastodon.social");
    assert.equal(out.posts.length, 1, "the empty post (no text, no url) is dropped");
    const post = out.posts[0];
    assert.equal(post.author, "Kraken");
    assert.equal(post.handle, "@analytics@social.vir.group");
    assert.equal(post.text, "Drone attack on #Sumy & Chernihiv", "HTML stripped, &amp; decoded");
    assert.equal(post.reblogs, 3);
  } finally {
    restore();
  }
});

test("mastodonTag requires a term", async () => {
  assert.equal((await mastodonTag("")).error, "Enter a hashtag or keyword.");
});

test("mastodonTag honors MASTODON_INSTANCE and normalizes the host", async () => {
  const prev = process.env.MASTODON_INSTANCE;
  process.env.MASTODON_INSTANCE = "https://infosec.exchange/";
  const restore = installJsonFetch(timeline);
  try {
    const out = await mastodonTag("cyber");
    assert.equal(out.instance, "infosec.exchange", "scheme + trailing slash stripped");
  } finally {
    restore();
    if (prev === undefined) delete process.env.MASTODON_INSTANCE;
    else process.env.MASTODON_INSTANCE = prev;
  }
});

test("socialResults renders the post feed and reports empty/error distinctly", () => {
  const html = socialResults({ tag: "osint", instance: "mastodon.social", posts: [
    { author: "Kraken", handle: "@a@b", time: "2026-07-22T15:32:00Z", text: "hi", url: "https://x", reblogs: 3, favourites: 7 }
  ], source: "Mastodon (mastodon.social)" });
  assert.match(html, /#osint/);
  assert.match(html, /Kraken/);
  assert.match(html, /♺ 3/);
  assert.match(socialResults({ tag: "zzz", posts: [] }), /No recent posts/);
  assert.match(socialResults({ error: "Enter a hashtag or keyword." }), /Enter a hashtag/);
});
