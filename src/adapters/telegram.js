import { cachedResilient } from "../lib/cache.js";
import { fetchTextRetry } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";
import { geoparse } from "../lib/gazetteer.js";

const channelGroups = {
  global: ["disclosetv", "Faytuks", "CIG_telegram", "BellumActaNews", "ClashReport", "AuroraIntel"],
  ukraine_russia: [
    "liveukraine_media",
    "wartranslated",
    "rybar",
    "ukrainenowenglish",
    "KyivIndependent_official",
    "DeepStateUA",
    "operativnoZSU",
    "United24media",
    "pravdaGerashchenko_en",
    "DDGeopolitics",
    "intelslava",
    "Slavyangrad",
    "milinfolive"
  ],
  middle_east: [
    "Middle_East_Spectator",
    "MiddleEastEye_TG",
    "QudsNen",
    "LebUpdate",
    "israelwarroom",
    "SyriawatanNews",
    "PressTV",
    "AlManarEnglish"
  ],
  africa: ["AfricaIntel", "HornObserver"],
  asia_pacific: ["TaiwanNews", "Focus_Taiwan", "KoreaHerald"],
  europe: ["nexta_live", "nexta_tv", "babel", "Flash_news_ua"],
  americas: ["BNONews", "Breaking911", "TheCradleMedia", "insiderpaper"]
};

const defaultChannels = [...new Set(Object.values(channelGroups).flat())];
const channelGroupLookup = new Map(Object.entries(channelGroups).flatMap(([group, channels]) =>
  channels.map((channel) => [channel.toLowerCase(), group])
));

function stripHtml(input) {
  return input
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function channelPosts(channel) {
  const html = await fetchTextRetry(`https://t.me/s/${encodeURIComponent(channel)}`);
  const blocks = html.match(/<div class="tgme_widget_message\b[\s\S]*?<\/time>[\s\S]*?<\/div>\s*<\/div>/g) || [];
  const inspected = blocks.slice(-10);
  const entities = inspected.flatMap((block, index) => {
    const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const linkMatch = block.match(/data-post="([^"]+)"/);
    const timeMatch = block.match(/datetime="([^"]+)"/);
    const text = stripHtml(textMatch?.[1] || "");
    const place = geoparse(text);
    if (!text || !place) return [];
    return entity({
      id: `tg-${channel}-${linkMatch?.[1] || index}`,
      layer: "telegram",
      type: "Telegram OSINT",
      name: place.name,
      lat: place.lat,
      lon: place.lon,
      // Constant 3: a channel post carries no impact axis of its own. A rule
      // over telegram should filter on keywords or geofence, not severity.
      severity: 3,
      time: timeMatch?.[1] || null,
      source: `Telegram / ${channel}`,
      group: channelGroupLookup.get(channel.toLowerCase()) || "custom",
      channel,
      place: place.name,
      confidence: place.confidence,
      text,
      url: linkMatch ? `https://t.me/${linkMatch[1]}` : `https://t.me/s/${channel}`
    });
  });
  return {
    group: channelGroupLookup.get(channel.toLowerCase()) || "custom",
    channel,
    inspected: inspected.length,
    matched: entities.length,
    entities
  };
}

export async function telegramLayer() {
  const channels = (process.env.OSIRIS_TELEGRAM_CHANNELS || defaultChannels.join(","))
    .split(",")
    .map((channel) => channel.trim().replace(/^@/, ""))
    .filter(Boolean)
    .slice(0, Number(process.env.OSIRIS_TELEGRAM_MAX_CHANNELS || 50));

  const result = await cachedResilient(`telegram:${channels.join(",")}`, 10 * 60_000, async () => {
    const settled = await Promise.allSettled(channels.map(channelPosts));
    return settled.map((entry, index) => entry.status === "fulfilled"
      ? entry.value
      : {
        channel: channels[index],
        inspected: 0,
        matched: 0,
        entities: [],
        error: entry.reason?.message || "Channel fetch failed"
      });
  });

  const channelStats = result.value.map(({ group, channel, inspected, matched, error }) => ({ group, channel, inspected, matched, error }));
  const entities = result.value.flatMap((row) => row.entities).filter(finiteCoordinate);
  const groupStats = Object.values(channelStats.reduce((acc, row) => {
    const group = row.group || "custom";
    acc[group] ||= { group, channels: 0, inspected: 0, matched: 0 };
    acc[group].channels += 1;
    acc[group].inspected += row.inspected;
    acc[group].matched += row.matched;
    return acc;
  }, {}));
  return {
    entities,
    meta: {
      cached: result.cached,
      stale: Boolean(result.stale),
      source: "Telegram public preview",
      channels,
      groups: Object.keys(channelGroups),
      inspectedPosts: channelStats.reduce((sum, row) => sum + row.inspected, 0),
      matchedPosts: entities.length,
      groupStats,
      channelStats
    }
  };
}
