import { aviationLayer } from "./opensky.js";
import { firesLayer } from "./firms.js";
import { eonetLayer } from "./eonet.js";
import { seismicLayer } from "./usgs.js";
import { telegramLayer } from "./telegram.js";
import { spaceWeatherLayer } from "./space.js";
import { cyberLayer } from "./cyber.js";
import { cryptoLayer, sanctionsLayer } from "./recon.js";
import { maritimeLayer } from "./maritime.js";
import { newsLayer } from "./news.js";
import { portsLayer } from "./ports.js";

export async function layerEntities(layer, bounds = {}) {
  if (layer === "aviation") return aviationLayer(bounds);
  if (layer === "fires") return firesLayer(bounds);
  if (layer === "weather") return eonetLayer("weather", ["severeStorms", "floods", "volcanoes"], bounds);
  if (layer === "ports") return portsLayer(bounds);
  if (layer === "seismic") return seismicLayer();
  if (layer === "telegram") return telegramLayer();
  if (layer === "cyber") return cyberLayer();
  if (layer === "space") return spaceWeatherLayer();
  if (layer === "crypto") return cryptoLayer();
  if (layer === "sanctions") return sanctionsLayer();
  if (layer === "maritime") return maritimeLayer(bounds);
  if (layer === "news") return newsLayer();
  return null;
}
