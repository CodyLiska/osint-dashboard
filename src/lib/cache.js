const cache = new Map();

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

export function clearCache(prefix) {
  for (const key of cache.keys()) {
    if (!prefix || key.startsWith(prefix)) cache.delete(key);
  }
}
