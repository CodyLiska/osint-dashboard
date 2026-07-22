import { cachedResilient } from "../lib/cache.js";
import { fetchJsonRetry } from "../lib/http.js";
import { decodeXml } from "../lib/xml.js";

// Mastodon — keyless social-signal recon. A Mastodon instance's public hashtag
// timeline (`/api/v1/timelines/tag/{tag}`) needs no auth (unlike keyword search),
// so this is "recent public posts tagged #<term>" across the fediverse as seen by
// one large instance. X/Twitter's free API is gone; this fills that gap. Default
// instance is mastodon.social; override with MASTODON_INSTANCE.
function instanceHost() {
  return (process.env.MASTODON_INSTANCE || "mastodon.social").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

// Mastodon post content is HTML (<p>, <a>, mentions, custom emoji). Strip to
// plain text for a compact feed row.
function stripHtml(html = "") {
  return decodeXml(String(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export async function mastodonTag(tag, { limit = 8 } = {}) {
  const term = String(tag || "").trim().replace(/^#/, "");
  if (!term) return { error: "Enter a hashtag or keyword.", posts: [] };

  const host = instanceHost();
  const result = await cachedResilient(`mastodon:${host}:${term.toLowerCase()}:${limit}`, 5 * 60_000, () =>
    fetchJsonRetry(`https://${host}/api/v1/timelines/tag/${encodeURIComponent(term)}?limit=${limit}`));

  const rows = Array.isArray(result.value) ? result.value : [];
  const posts = rows.map((row) => ({
    id: row.id,
    time: row.created_at || null,
    author: row.account?.display_name || row.account?.acct || "unknown",
    handle: row.account?.acct ? `@${row.account.acct}` : null,
    text: stripHtml(row.content),
    url: row.url || null,
    reblogs: row.reblogs_count || 0,
    favourites: row.favourites_count || 0
  })).filter((p) => p.text || p.url);

  return {
    posts,
    tag: term,
    instance: host,
    cached: result.cached,
    stale: Boolean(result.stale),
    source: `Mastodon (${host})`
  };
}
