// Minimal XML/RSS helpers shared by the feed adapters (OFAC SDN, CISA ICS,
// travel advisories). Regex-based on purpose: the feeds are shallow and
// well-formed, and a real parser would mean an npm dependency.

export function decodeXml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

export function tag(block, name) {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
  return decodeXml(match?.[1] || "");
}

export function tags(block, name) {
  return [...block.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "g"))]
    .map((match) => decodeXml(match[1]));
}

// Splits an RSS document into its <item> bodies. Returns [] for a feed with no
// items so a malformed or empty response degrades to an empty layer.
export function rssItems(xml) {
  return String(xml)
    .split(/<item[\s>]/)
    .slice(1)
    .map((chunk) => chunk.split("</item>")[0]);
}

// Atom counterpart to rssItems: splits a document into its <entry> bodies, for
// feeds that use Atom rather than RSS (e.g. the NOAA tsunami warning centers).
export function atomEntries(xml) {
  return String(xml)
    .split(/<entry[\s>]/)
    .slice(1)
    .map((chunk) => chunk.split("</entry>")[0]);
}

// Strips CDATA wrappers and markup from a tag body, for feeds that embed HTML
// inside <description>.
export function textContent(block, name) {
  return tag(block, name)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
