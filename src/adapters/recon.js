import { cached } from "../lib/cache.js";
import { fetchJson, fetchText } from "../lib/http.js";
import { entity, finiteCoordinate } from "../lib/normalize.js";

function decodeXml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
  return decodeXml(match?.[1] || "");
}

function tags(block, name) {
  return [...block.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "g"))]
    .map((match) => decodeXml(match[1]));
}

function parseOfacCryptoAddresses(xml) {
  const rows = [];
  const entries = xml.match(/<sdnEntry>[\s\S]*?<\/sdnEntry>/g) || [];
  for (const entry of entries) {
    if (!entry.includes("Digital Currency Address")) continue;
    const uid = tag(entry, "uid");
    const name = tag(entry, "lastName") || tag(entry, "firstName") || `OFAC SDN ${uid}`;
    const sdnType = tag(entry, "sdnType");
    const programs = tags(entry, "program");
    const ids = entry.match(/<id>[\s\S]*?<\/id>/g) || [];
    for (const idBlock of ids) {
      const idType = tag(idBlock, "idType");
      if (!idType.startsWith("Digital Currency Address")) continue;
      rows.push({
        uid,
        name,
        sdnType,
        programs,
        chain: idType.replace("Digital Currency Address", "").replace(/^\s*-\s*/, "").trim() || "UNKNOWN",
        address: tag(idBlock, "idNumber"),
        idType
      });
    }
  }
  return rows.filter((row) => row.address);
}

async function ofacSdnXml() {
  const result = await cached("ofac:sdn-xml", 24 * 60 * 60_000, () =>
    fetchText("https://www.treasury.gov/ofac/downloads/sdn.xml", {
      headers: { accept: "application/xml,text/xml,text/plain" }
    })
  );
  return result.value;
}

const officialSanctionsSources = [
  {
    id: "ofac-sdn",
    label: "OFAC SDN",
    url: "https://www.treasury.gov/ofac/downloads/sdn.xml",
    parser: (xml) => parseOfacEntities(xml, "ofac-sdn", "OFAC SDN")
  },
  {
    id: "ofac-consolidated",
    label: "OFAC Consolidated",
    url: "https://www.treasury.gov/ofac/downloads/consolidated/consolidated.xml",
    parser: (xml) => parseOfacEntities(xml, "ofac-consolidated", "OFAC Consolidated")
  },
  {
    id: "un-sc",
    label: "UN Security Council",
    url: "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
    parser: parseUnSecurityCouncilEntities
  },
  {
    id: "uk-ofsi",
    label: "UK OFSI",
    url: "https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.xml",
    parser: parseUkOfsiEntities
  }
];

async function sourceXml(source) {
  const result = await cached(`sanctions:${source.id}:xml`, 24 * 60 * 60_000, () =>
    fetchText(source.url, {
      headers: { accept: "application/xml,text/xml,text/plain" }
    })
  );
  return result.value;
}

export async function sanctionedCrypto() {
  const result = await cached("ofac-crypto:sdn-xml", 24 * 60 * 60_000, async () => {
    const xml = await ofacSdnXml();
    return parseOfacCryptoAddresses(xml);
  });
  return result.value;
}

function containsAddress(dataset, address) {
  return dataset.some((row) => row.address?.toLowerCase() === address.toLowerCase());
}

export async function btcLookup(address) {
  const [addressData, ofac] = await Promise.all([
    fetchJson(`https://blockstream.info/api/address/${encodeURIComponent(address)}`),
    sanctionedCrypto().catch(() => [])
  ]);
  return {
    chain: "BTC",
    address,
    sanctioned: containsAddress(ofac, address),
    data: addressData
  };
}

export async function ethLookup(address) {
  const [addressData, ofac] = await Promise.all([
    fetchJson(`https://eth.blockscout.com/api/v2/addresses/${encodeURIComponent(address)}`),
    sanctionedCrypto().catch(() => [])
  ]);
  return {
    chain: "ETH",
    address,
    sanctioned: containsAddress(ofac, address),
    data: addressData
  };
}

function chainPoint(chain, index) {
  const normalized = chain.toUpperCase();
  const anchors = {
    BTC: [-74.0060, 40.7128],
    ETH: [-0.1276, 51.5072],
    TRX: [55.2708, 25.2048],
    XMR: [8.5417, 47.3769],
    LTC: [-122.4194, 37.7749],
    USDT: [103.8198, 1.3521]
  };
  const [lon, lat] = anchors[normalized] || [13.4050, 52.52];
  return {
    lon: lon + Math.cos(index * 0.9) * 2.4,
    lat: lat + Math.sin(index * 0.9) * 1.6
  };
}

export async function cryptoLayer() {
  const rows = await sanctionedCrypto();
  const max = Number(process.env.CRYPTO_MAX_ITEMS || 250);
  const entities = rows.slice(0, max).map((row, index) => {
    const point = chainPoint(row.chain, index);
    return entity({
      id: `crypto-${row.chain}-${row.address}`,
      layer: "crypto",
      type: "OFAC sanctioned wallet",
      name: `${row.chain} sanctioned address`,
      lat: point.lat,
      lon: point.lon,
      severity: 5,
      source: "OFAC SDN",
      summary: `${row.name} · ${row.address}`,
      address: row.address,
      chain: row.chain,
      sdnName: row.name,
      sdnType: row.sdnType,
      programs: row.programs,
      raw: row
    });
  }).filter(finiteCoordinate);

  const chainCounts = rows.reduce((acc, row) => {
    acc[row.chain] = (acc[row.chain] || 0) + 1;
    return acc;
  }, {});

  return {
    entities,
    meta: {
      source: "OFAC SDN",
      count: entities.length,
      totalAddresses: rows.length,
      chainCounts,
      cappedAt: max
    }
  };
}

const countryPoints = {
  Afghanistan: [67.71, 33.94],
  Belarus: [27.95, 53.71],
  China: [104.2, 35.86],
  Cuba: [-77.78, 21.52],
  Iran: [53.69, 32.43],
  Iraq: [43.68, 33.22],
  Lebanon: [35.86, 33.85],
  Libya: [17.23, 26.34],
  Mali: [-3.99, 17.57],
  Myanmar: [95.96, 21.92],
  Nicaragua: [-85.2, 12.86],
  "North Korea": [127.51, 40.34],
  Russia: [105.32, 61.52],
  Somalia: [46.2, 5.15],
  Sudan: [30.22, 12.86],
  Syria: [38.99, 34.8],
  Venezuela: [-66.59, 6.42],
  Yemen: [48.52, 15.55],
  Zimbabwe: [29.15, -19.02],
  "United States": [-95.71, 37.09]
};

function countryPoint(country, index) {
  const normalized = normalizeCountry(country);
  const [lon, lat] = countryPoints[normalized] || [-77.0369, 38.9072];
  return {
    lon: lon + Math.cos(index * 0.72) * 1.8,
    lat: lat + Math.sin(index * 0.72) * 1.2
  };
}

function normalizeCountry(country) {
  const value = String(country || "").trim();
  return {
    "Korea, North": "North Korea",
    "Democratic People's Republic of Korea": "North Korea",
    "Russian Federation": "Russia",
    "Syrian Arab Republic": "Syria",
    "Iran (Islamic Republic of)": "Iran",
    "United States of America": "United States"
  }[value] || value;
}

function parseOfacEntities(xml, sourceId = "ofac-sdn", source = "OFAC SDN") {
  const entries = xml.match(/<sdnEntry>[\s\S]*?<\/sdnEntry>/g) || [];
  return entries.map((entry) => {
    const uid = tag(entry, "uid");
    const firstName = tag(entry, "firstName");
    const lastName = tag(entry, "lastName");
    const name = [firstName, lastName].filter(Boolean).join(" ") || lastName || `OFAC SDN ${uid}`;
    const countries = tags(entry, "country");
    const programs = tags(entry, "program");
    const akaCount = (entry.match(/<aka>/g) || []).length;
    const idCount = (entry.match(/<id>/g) || []).length;
    const aliases = (entry.match(/<aka>[\s\S]*?<\/aka>/g) || []).map((aka) =>
      [tag(aka, "firstName"), tag(aka, "lastName")].filter(Boolean).join(" ") || tag(aka, "lastName")
    ).filter(Boolean);
    const ids = (entry.match(/<id>[\s\S]*?<\/id>/g) || []).map((idBlock) =>
      [tag(idBlock, "idType"), tag(idBlock, "idNumber")].filter(Boolean).join(" ")
    ).filter(Boolean);
    return {
      uid,
      name,
      sdnType: tag(entry, "sdnType") || "SDN",
      sourceId,
      source,
      programs,
      countries: countries.map(normalizeCountry),
      country: normalizeCountry(countries[0]) || null,
      remarks: tag(entry, "remarks"),
      aliases,
      ids,
      akaCount,
      idCount
    };
  }).filter((row) => row.uid && row.name);
}

function parseOfacSdnEntities(xml) {
  return parseOfacEntities(xml, "ofac-sdn", "OFAC SDN");
}

function parseUnSecurityCouncilEntities(xml) {
  const blocks = xml.match(/<(INDIVIDUAL|ENTITY)>[\s\S]*?<\/\1>/g) || [];
  return blocks.map((block) => {
    const isEntity = block.startsWith("<ENTITY>");
    const uid = tag(block, "DATAID") || tag(block, "REFERENCE_NUMBER");
    const nameParts = isEntity
      ? [tag(block, "FIRST_NAME")]
      : [tag(block, "FIRST_NAME"), tag(block, "SECOND_NAME"), tag(block, "THIRD_NAME"), tag(block, "FOURTH_NAME")];
    const aliases = tags(block, "ALIAS_NAME").filter(Boolean);
    const countries = [
      ...tags(block, "COUNTRY"),
      ...tags(block, "VALUE").filter((value) => !["UN List"].includes(value))
    ].map(normalizeCountry).filter(Boolean);
    const programs = [tag(block, "UN_LIST_TYPE"), tag(block, "REFERENCE_NUMBER")].filter(Boolean);
    const comments = tag(block, "COMMENTS1");
    return {
      uid,
      name: nameParts.filter(Boolean).join(" ") || aliases[0] || `UN sanctions ${uid}`,
      sdnType: isEntity ? "Entity" : "Individual",
      sourceId: "un-sc",
      source: "UN Security Council",
      programs,
      countries,
      country: countries[0] || null,
      remarks: comments,
      aliases,
      ids: [tag(block, "REFERENCE_NUMBER")].filter(Boolean),
      akaCount: aliases.length,
      idCount: tag(block, "REFERENCE_NUMBER") ? 1 : 0
    };
  }).filter((row) => row.uid && row.name);
}

function parseUkOfsiEntities(xml) {
  const blocks = xml.match(/<FinancialSanctionsTarget>[\s\S]*?<\/FinancialSanctionsTarget>/g) || [];
  const grouped = new Map();
  for (const block of blocks) {
    const uid = tag(block, "GroupID") || tag(block, "UKSanctionsListRef");
    if (!uid) continue;
    const nameParts = ["name1", "name2", "name3", "name4", "name5", "Name6"]
      .map((name) => tag(block, name))
      .filter(Boolean);
    const row = grouped.get(uid) || {
      uid,
      name: "",
      sdnType: tag(block, "GroupTypeDescription") || "Target",
      sourceId: "uk-ofsi",
      source: "UK OFSI",
      programs: [],
      countries: [],
      country: null,
      remarks: "",
      aliases: [],
      ids: [],
      akaCount: 0,
      idCount: 0
    };
    const name = nameParts.join(" ");
    const aliasType = tag(block, "AliasType");
    if (!row.name || aliasType.toLowerCase().includes("primary")) row.name = name || row.name;
    if (name && !row.aliases.includes(name)) row.aliases.push(name);
    for (const program of [tag(block, "RegimeName"), tag(block, "UKSanctionsListRef"), tag(block, "UNRef")].filter(Boolean)) {
      if (!row.programs.includes(program)) row.programs.push(program);
    }
    for (const country of [
      tag(block, "Country"),
      tag(block, "Individual_CountryOfBirth"),
      tag(block, "Individual_Nationality"),
      tag(block, "Ship_Flag")
    ].map(normalizeCountry).filter(Boolean)) {
      if (!row.countries.includes(country)) row.countries.push(country);
    }
    row.country ||= row.countries[0] || null;
    row.remarks ||= tag(block, "UKStatementOfReasons") || tag(block, "OtherInformation");
    for (const id of [tag(block, "UKSanctionsListRef"), tag(block, "UNRef"), tag(block, "Ship_IMONumber")].filter(Boolean)) {
      if (!row.ids.includes(id)) row.ids.push(id);
    }
    row.akaCount = row.aliases.length;
    row.idCount = row.ids.length;
    grouped.set(uid, row);
  }
  return [...grouped.values()].filter((row) => row.uid && row.name);
}

async function officialSanctionsRows() {
  const result = await cached("sanctions:official-entities", 24 * 60 * 60_000, async () => {
    const groups = await Promise.all(officialSanctionsSources.map(async (source) => {
      const xml = source.id === "ofac-sdn" ? await ofacSdnXml() : await sourceXml(source);
      return source.parser(xml);
    }));
    return groups.flat();
  });
  return result;
}

function balancedCap(rows, max) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.sourceId || row.source || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const selected = [];
  const groupedRows = [...groups.values()];
  let index = 0;
  while (selected.length < max) {
    let added = false;
    for (const group of groupedRows) {
      if (group[index]) {
        selected.push(group[index]);
        added = true;
        if (selected.length >= max) break;
      }
    }
    if (!added) break;
    index += 1;
  }
  return selected;
}

function topCounts(values, limit = 5) {
  const counts = values.filter(Boolean).reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function topCountsFromRows(rows, selector, limit = 5) {
  const counts = rows.reduce((acc, row) => {
    for (const value of new Set(selector(row).filter(Boolean))) {
      acc[value] = (acc[value] || 0) + 1;
    }
    return acc;
  }, {});
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function groupedSanctions(rows, maxGroups) {
  const groups = new Map();
  for (const row of rows) {
    const locationLabel = row.country || row.programs[0] || "Unspecified";
    const key = [row.sourceId, locationLabel, row.sdnType].join("|");
    const group = groups.get(key) || {
      sourceId: row.sourceId,
      source: row.source,
      locationLabel,
      country: row.country || null,
      sdnType: row.sdnType,
      rows: []
    };
    group.rows.push(row);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, maxGroups)
    .map((group) => {
      const programs = topCountsFromRows(group.rows, (row) => row.programs, 6);
      const countries = topCountsFromRows(group.rows, (row) => row.countries, 6);
      return {
        ...group,
        count: group.rows.length,
        programs,
        countries,
        sample: group.rows.slice(0, 6).map((row) => ({
          uid: row.uid,
          name: row.name,
          programs: row.programs.slice(0, 3)
        }))
      };
    });
}

export async function sanctionsLayer() {
  const displayMode = process.env.SANCTIONS_DISPLAY_MODE || "grouped";
  const max = Number(process.env.SANCTIONS_MAX_ITEMS || 500);
  const maxGroups = Number(process.env.SANCTIONS_MAX_GROUPS || 180);
  const result = await officialSanctionsRows();

  const entities = displayMode === "individual"
    ? balancedCap(result.value, max).map((row, index) => {
      const point = countryPoint(row.country, index);
      return entity({
        id: `sanction-${row.sourceId}-${row.uid}`,
        layer: "sanctions",
        type: `${row.sdnType} sanctions entry`,
        name: row.name,
        lat: point.lat,
        lon: point.lon,
        severity: 5,
        source: row.source,
        summary: [row.country, row.programs.slice(0, 4).join(", "), row.remarks].filter(Boolean).join(" · "),
        uid: row.uid,
        sdnName: row.name,
        sdnType: row.sdnType,
        country: row.country,
        programs: row.programs,
        aliases: row.aliases,
        akaCount: row.akaCount,
        idCount: row.idCount,
        raw: row
      });
    }).filter(finiteCoordinate)
    : groupedSanctions(result.value, maxGroups).map((group, index) => {
      const point = countryPoint(group.country, index);
      const topPrograms = group.programs.map((program) => `${program.name} (${program.count})`).join(", ");
      return entity({
        id: `sanction-group-${group.sourceId}-${group.locationLabel}-${group.sdnType}`.replace(/\s+/g, "-"),
        layer: "sanctions",
        type: "Sanctions group",
        name: `${group.locationLabel} · ${group.source} · ${group.sdnType}`,
        lat: point.lat,
        lon: point.lon,
        severity: Math.min(5, Math.max(2, Math.ceil(Math.log10(group.count + 1)) + 1)),
        source: group.source,
        summary: `${group.count.toLocaleString()} ${group.sdnType.toLowerCase()} entries${topPrograms ? ` · ${topPrograms}` : ""}`,
        sdnType: group.sdnType,
        country: group.country,
        groupCount: group.count,
        groupLabel: group.locationLabel,
        programs: group.programs.map((program) => program.name),
        topPrograms: group.programs,
        topCountries: group.countries,
        sampleEntries: group.sample
      });
    }).filter(finiteCoordinate);

  const typeCounts = result.value.reduce((acc, row) => {
    acc[row.sdnType] = (acc[row.sdnType] || 0) + 1;
    return acc;
  }, {});
  const countryCounts = result.value.reduce((acc, row) => {
    const country = row.country || "Unspecified";
    acc[country] = (acc[country] || 0) + 1;
    return acc;
  }, {});
  const sourceCounts = result.value.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] || 0) + 1;
    return acc;
  }, {});

  return {
    entities,
    meta: {
      source: "Official sanctions feeds",
      count: entities.length,
      totalEntries: result.value.length,
      displayMode,
      sourceCounts,
      typeCounts,
      topCountries: Object.entries(countryCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([country, count]) => ({ country, count })),
      cappedAt: displayMode === "individual" ? max : maxGroups,
      cached: result.cached
    }
  };
}

export async function sanctionsSearch(q) {
  const query = String(q || "").trim();
  if (!query) return { results: [], total: { value: 0 }, source: "OFAC SDN" };

  if (process.env.OPENSANCTIONS_API_KEY) {
    return fetchJson(`https://api.opensanctions.org/search/default?limit=12&q=${encodeURIComponent(query)}`, {
      headers: { authorization: `ApiKey ${process.env.OPENSANCTIONS_API_KEY}` }
    });
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const result = await officialSanctionsRows();

  const matches = result.value.filter((row) => {
    const haystack = [
      row.uid,
      row.name,
      row.sdnType,
      row.country,
      row.remarks,
      ...row.programs,
      ...row.countries,
      ...row.aliases,
      ...row.ids
    ].filter(Boolean).join(" ").toLowerCase();
    const tokens = haystack.match(/[\p{L}\p{N}]+/gu) || [];
    return terms.every((term) =>
      tokens.some((token) => token === term || token.startsWith(term))
    );
  });

  return {
    source: "OFAC SDN",
    fallback: "local-official-sanctions",
    total: { value: matches.length },
    results: matches.slice(0, 12).map((row) => ({
      id: `${row.sourceId}-${row.uid}`,
      caption: row.name,
      schema: row.sdnType,
      datasets: [row.source],
      properties: {
        uid: [row.uid],
        country: row.country ? [row.country] : [],
        program: row.programs,
        alias: row.aliases.slice(0, 8),
        notes: row.remarks ? [row.remarks] : []
      }
    }))
  };
}

export async function cveSearch(keyword = "kev") {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60_000);
  const fmt = (date) => date.toISOString().replace(/\.\d{3}Z$/, ".000");
  const result = await cached(`cves:${keyword}`, 30 * 60_000, () =>
    fetchJson(`https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(keyword)}&pubStartDate=${fmt(start)}&pubEndDate=${fmt(end)}`, {
      headers: process.env.NVD_API_KEY ? { apiKey: process.env.NVD_API_KEY } : {}
    })
  );
  return {
    ...result.value,
    meta: {
      cached: result.cached,
      source: "NVD"
    }
  };
}
