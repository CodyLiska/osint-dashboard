import { cached } from "../lib/cache.js";
import { fetchJson } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

const sourceAnchors = {
  "bbc-news": [-0.1276, 51.5072],
  "al-jazeera-english": [51.5310, 25.2854],
  "associated-press": [-74.0060, 40.7128],
  "reuters": [-0.1276, 51.5072],
  "cnn": [-84.3880, 33.7490],
  "the-washington-post": [-77.0369, 38.9072],
  "the-wall-street-journal": [-74.0060, 40.7128],
  "the-guardian-uk": [-0.1276, 51.5072],
  "google-news": [-122.0840, 37.4220]
};

const fallbackNews = [
  ["BBC World", 51.5072, -0.1276, "https://www.youtube.com/@BBCNews"],
  ["Al Jazeera", 25.2854, 51.5310, "https://www.youtube.com/@aljazeeraenglish"],
  ["France 24", 48.8566, 2.3522, "https://www.youtube.com/@FRANCE24English"],
  ["DW News", 52.5200, 13.4050, "https://www.youtube.com/@dwnews"],
  ["NHK World", 35.6762, 139.6503, "https://www.youtube.com/@NHKWORLDJAPAN"],
  ["Sky News", 51.5072, -0.1276, "https://www.youtube.com/@SkyNews"],
  ["CNA", 1.3521, 103.8198, "https://www.youtube.com/@channelnewsasia"],
  ["ABC News AU", -35.2809, 149.1300, "https://www.youtube.com/@abcnewsaustralia"]
];

function newsPoint(sourceId, index) {
  const [lon, lat] = sourceAnchors[sourceId] || [-0.1276, 51.5072];
  return {
    lon: lon + Math.cos(index * 0.83) * 1.4,
    lat: lat + Math.sin(index * 0.83) * 0.9
  };
}

function fallbackLayer() {
  return {
    entities: fallbackNews.map(([name, lat, lon, url]) => entity({
      id: `news-${name}`,
      layer: "news",
      type: "Live news source",
      name,
      lat,
      lon,
      url,
      severity: 1,
      source: "Static broadcaster directory",
      summary: "NewsAPI key not configured; showing curated live broadcaster links."
    })),
    meta: {
      source: "Static broadcaster directory",
      count: fallbackNews.length,
      configured: false
    }
  };
}

export async function newsLayer() {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) return fallbackLayer();

  const query = process.env.NEWSAPI_QUERY || "(sanctions OR conflict OR cyber OR earthquake OR wildfire OR aviation OR maritime)";
  const max = Number(process.env.NEWSAPI_MAX_ITEMS || 40);
  const params = new URLSearchParams({
    q: query,
    language: process.env.NEWSAPI_LANGUAGE || "en",
    sortBy: "publishedAt",
    pageSize: String(Math.min(100, max)),
    apiKey
  });

  const result = await cached(`newsapi:${query}:${max}`, 15 * 60_000, () =>
    fetchJson(`https://newsapi.org/v2/everything?${params}`)
  );

  const articles = (result.value.articles || []).slice(0, max);
  const entities = articles.map((article, index) => {
    const sourceId = article.source?.id || article.source?.name || "news";
    const point = newsPoint(sourceId, index);
    return entity({
      id: `newsapi-${index}-${encodeURIComponent(article.url || article.title || "article")}`,
      layer: "news",
      type: "News article",
      name: article.title || "News article",
      lat: point.lat,
      lon: point.lon,
      severity: 2,
      time: article.publishedAt,
      source: article.source?.name || "NewsAPI",
      url: article.url,
      summary: article.description || article.content || "NewsAPI article.",
      raw: article
    });
  }).filter(finiteCoordinate);

  return {
    entities,
    meta: {
      source: "NewsAPI",
      configured: true,
      count: entities.length,
      totalResults: result.value.totalResults,
      cached: result.cached,
      query
    }
  };
}
