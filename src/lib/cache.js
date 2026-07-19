// In-memory TTL cache with a bounded, LRU-evicted keyspace. The bound matters
// because the recon/enrich routes (whois, sanctions, cve, geocode, ip-intel) key
// entries by arbitrary user input — without a cap that keyspace grows for the life
// of the process. Layer feeds use a small fixed set of keys and, because every
// poll touches them, stay at the most-recently-used end and are never evicted.
const cache = new Map(); // insertion order == LRU order (oldest first)
const inFlight = new Map();

// Max distinct entries before least-recently-used ones are evicted. Overridable
// via OSIRIS_CACHE_MAX_ENTRIES; read per-write so it is easy to test.
function capacity() {
  const n = Number(process.env.OSIRIS_CACHE_MAX_ENTRIES);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

// Read an entry and mark it most-recently-used (re-insert at the end) so active
// keys survive eviction. Returns undefined on a miss.
function readEntry(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

// Write an entry as most-recently-used, then evict from the oldest end until the
// cache is within capacity.
function writeEntry(key, value, time) {
  cache.delete(key);
  cache.set(key, { time, value });
  const max = capacity();
  while (cache.size > max) {
    cache.delete(cache.keys().next().value); // oldest / least-recently-used
  }
}

export async function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = readEntry(key);
  if (hit && now - hit.time < ttlMs) {
    return { value: hit.value, cached: true, ageMs: now - hit.time };
  }

  const value = await loader();
  writeEntry(key, value, now);
  return { value, cached: false, ageMs: 0 };
}

// Resilient variant of cached() for single-resource feeds (e.g. the NGA port
// index): concurrent loads for the same key share one in-flight request (so a
// burst of viewport refreshes doesn't storm the origin), and if the loader fails
// but a previous — even expired — value exists, that stale value is served with a
// `stale` flag instead of throwing. Only a cold failure with nothing cached rejects.
export async function cachedResilient(key, ttlMs, loader) {
  const now = Date.now();
  const hit = readEntry(key);
  if (hit && now - hit.time < ttlMs) {
    return { value: hit.value, cached: true, ageMs: now - hit.time };
  }

  const staleOnError = (error) => {
    if (hit) return { value: hit.value, cached: true, stale: true, ageMs: now - hit.time, error: error.message };
    throw error;
  };

  const existing = inFlight.get(key);
  if (existing) {
    try {
      return { value: await existing, cached: true, ageMs: 0 };
    } catch (error) {
      return staleOnError(error);
    }
  }

  const promise = loader();
  inFlight.set(key, promise);
  try {
    const value = await promise;
    writeEntry(key, value, now);
    return { value, cached: false, ageMs: 0 };
  } catch (error) {
    return staleOnError(error);
  } finally {
    inFlight.delete(key);
  }
}

export function clearCache(prefix) {
  for (const key of cache.keys()) {
    if (!prefix || key.startsWith(prefix)) cache.delete(key);
  }
}

export function cacheSize() {
  return cache.size;
}
