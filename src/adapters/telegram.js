import { cached } from "../lib/cache.js";
import { fetchText } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

const placeDictionary = [
  ["Kyiv", 50.4501, 30.5234, ["Київ", "Киев"]],
  ["Kharkiv", 49.9935, 36.2304, ["Харків", "Харьков"]],
  ["Odesa", 46.4825, 30.7233, ["Одеса", "Одесса"]],
  ["Dnipro", 48.4647, 35.0462, ["Дніпро", "Днепр"]],
  ["Zaporizhzhia", 47.8388, 35.1396, ["Запоріжжя", "Запорожье"]],
  ["Kherson", 46.6354, 32.6169, ["Херсон"]],
  ["Mykolaiv", 46.9750, 31.9946, ["Миколаїв", "Николаев"]],
  ["Lviv", 49.8397, 24.0297, ["Львів", "Львов"]],
  ["Kramatorsk", 48.7381, 37.5844, ["Краматорськ", "Краматорск"]],
  ["Pokrovsk", 48.2820, 37.1758, ["Покровськ", "Покровск"]],
  ["Bakhmut", 48.5944, 38.0000, ["Бахмут", "Артемовск"]],
  ["Mariupol", 47.0971, 37.5434, ["Маріуполь", "Мариуполь"]],
  ["Luhansk", 48.5740, 39.3078, ["Луганськ", "Луганск"]],
  ["Donetsk", 48.0159, 37.8029, ["Донецьк", "Донецк"]],
  ["Gaza", 31.5017, 34.4668, ["غزة"]],
  ["Khan Younis", 31.3462, 34.3032, ["خان يونس"]],
  ["Rafah", 31.2969, 34.2435, ["رفح"]],
  ["Jerusalem", 31.7683, 35.2137, ["القدس", "ירושלים"]],
  ["Tel Aviv", 32.0853, 34.7818, ["تل أبيب", "תל אביב"]],
  ["Haifa", 32.7940, 34.9896, ["حيفا", "חיפה"]],
  ["West Bank", 31.9466, 35.3027, ["الضفة الغربية"]],
  ["Jenin", 32.4594, 35.3009, ["جنين"]],
  ["Nablus", 32.2211, 35.2544, ["نابلس"]],
  ["Khartoum", 15.5007, 32.5599, ["الخرطوم"]],
  ["Sanaa", 15.3694, 44.1910, ["صنعاء"]],
  ["Tehran", 35.6892, 51.3890, ["تهران"]],
  ["Baghdad", 33.3152, 44.3661, ["بغداد"]],
  ["Taipei", 25.0330, 121.5654, ["台北"]],
  ["Seoul", 37.5665, 126.9780, ["서울"]],
  ["Tokyo", 35.6762, 139.6503, ["東京"]],
  ["Beijing", 39.9042, 116.4074, ["北京"]],
  ["Shanghai", 31.2304, 121.4737, ["上海"]],
  ["Hong Kong", 22.3193, 114.1694, ["香港"]],
  ["Manila", 14.5995, 120.9842],
  ["Jakarta", -6.2088, 106.8456],
  ["Bangkok", 13.7563, 100.5018],
  ["Hanoi", 21.0278, 105.8342],
  ["Yangon", 16.8409, 96.1735, ["Rangoon"]],
  ["Naypyidaw", 19.7633, 96.0785],
  ["Mogadishu", 2.0469, 45.3182, ["Muqdisho"]],
  ["Hargeisa", 9.5624, 44.0770],
  ["Addis Ababa", 8.9806, 38.7578],
  ["Nairobi", -1.2921, 36.8219],
  ["Kampala", 0.3476, 32.5825],
  ["Kinshasa", -4.4419, 15.2663],
  ["Goma", -1.6585, 29.2205],
  ["Bamako", 12.6392, -8.0029],
  ["Niamey", 13.5116, 2.1254],
  ["Ouagadougou", 12.3714, -1.5197],
  ["Lagos", 6.5244, 3.3792],
  ["Abuja", 9.0765, 7.3986],
  ["Cairo", 30.0444, 31.2357, ["القاهرة"]],
  ["Tripoli", 32.8872, 13.1913, ["طرابلس"]],
  ["Tunis", 36.8065, 10.1815],
  ["Algiers", 36.7538, 3.0588],
  ["Rabat", 34.0209, -6.8416],
  ["Damascus", 33.5138, 36.2765, ["دمشق"]],
  ["Beirut", 33.8938, 35.5018, ["بيروت"]],
  ["Amman", 31.9539, 35.9106, ["عمان"]],
  ["Doha", 25.2854, 51.5310],
  ["Riyadh", 24.7136, 46.6753, ["الرياض"]],
  ["Dubai", 25.2048, 55.2708],
  ["Abu Dhabi", 24.4539, 54.3773],
  ["Istanbul", 41.0082, 28.9784],
  ["Ankara", 39.9334, 32.8597],
  ["Belgorod", 50.5997, 36.5983, ["Белгород"]],
  ["Kursk", 51.7304, 36.1926, ["Курск"]],
  ["Rostov", 47.2357, 39.7015, ["Ростов"]],
  ["Moscow", 55.7558, 37.6173, ["Москва"]],
  ["Bryansk", 53.2436, 34.3640, ["Брянск"]],
  ["Sevastopol", 44.6167, 33.5254, ["Севастополь"]],
  ["Crimea", 45.3453, 34.4997, ["Крым", "Крим"]],
  ["Sumy", 50.9077, 34.7981, ["Суми"]],
  ["London", 51.5072, -0.1276],
  ["Paris", 48.8566, 2.3522],
  ["Berlin", 52.5200, 13.4050],
  ["Brussels", 50.8503, 4.3517],
  ["Warsaw", 52.2297, 21.0122],
  ["Prague", 50.0755, 14.4378],
  ["Vienna", 48.2082, 16.3738],
  ["Budapest", 47.4979, 19.0402],
  ["Bucharest", 44.4268, 26.1025],
  ["Chisinau", 47.0105, 28.8638],
  ["Tbilisi", 41.7151, 44.8271],
  ["Yerevan", 40.1872, 44.5152],
  ["Baku", 40.4093, 49.8671],
  ["New York", 40.7128, -74.0060],
  ["Washington", 38.9072, -77.0369, ["Washington DC", "Washington, DC"]],
  ["Los Angeles", 34.0522, -118.2437],
  ["Chicago", 41.8781, -87.6298],
  ["Miami", 25.7617, -80.1918],
  ["Mexico City", 19.4326, -99.1332],
  ["Bogota", 4.7110, -74.0721, ["Bogotá"]],
  ["Caracas", 10.4806, -66.9036],
  ["Quito", -0.1807, -78.4678],
  ["Lima", -12.0464, -77.0428],
  ["Santiago", -33.4489, -70.6693],
  ["Buenos Aires", -34.6037, -58.3816],
  ["Brasilia", -15.7939, -47.8828, ["Brasília"]],
  ["Sao Paulo", -23.5558, -46.6396, ["São Paulo"]],
  ["Rio de Janeiro", -22.9068, -43.1729],
  ["Havana", 23.1136, -82.3666],
  ["Port-au-Prince", 18.5944, -72.3074],
  ["Ottawa", 45.4215, -75.6972],
  ["Toronto", 43.6532, -79.3832],
  ["Vancouver", 49.2827, -123.1207],
  ["Canberra", -35.2809, 149.1300],
  ["Sydney", -33.8688, 151.2093],
  ["Melbourne", -37.8136, 144.9631],
  ["Auckland", -36.8509, 174.7645]
];

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

function geoparse(text) {
  const haystack = text.toLocaleLowerCase();
  for (const [name, lat, lon, aliases = []] of placeDictionary) {
    if ([name, ...aliases].some((candidate) => haystack.includes(candidate.toLocaleLowerCase()))) {
      return { name, lat, lon };
    }
  }
  return null;
}

async function channelPosts(channel) {
  const html = await fetchText(`https://t.me/s/${encodeURIComponent(channel)}`);
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
      severity: 3,
      time: timeMatch?.[1] || null,
      source: `Telegram / ${channel}`,
      group: channelGroupLookup.get(channel.toLowerCase()) || "custom",
      channel,
      place: place.name,
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

  const result = await cached(`telegram:${channels.join(",")}`, 10 * 60_000, async () => {
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
