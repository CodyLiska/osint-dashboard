const cache = new Map();
const inFlight = new Map();

export async function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.time < ttlMs) {
    return { value: hit.value, cached: true, ageMs: now - hit.time };
  }

  const value = await loader();
  cache.set(key, { time: now, value });
  return { value, cached: false, ageMs: 0 };
}

// Resilient variant of cached() for single-resource feeds (e.g. the NGA port
// index): concurrent loads for the same key share one in-flight request (so a
// burst of viewport refreshes doesn't storm the origin), and if the loader fails
// but a previous — even expired — value exists, that stale value is served with a
// `stale` flag instead of throwing. Only a cold failure with nothing cached rejects.
export async function cachedResilient(key, ttlMs, loader) {
  const now = Date.now();
  const hit = cache.get(key);
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
    cache.set(key, { time: now, value });
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
