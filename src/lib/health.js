const health = new Map();

export function markSource(id, patch) {
  const previous = health.get(id) || {};
  const next = {
    id,
    status: "ok",
    lastChecked: new Date().toISOString(),
    ...previous,
    ...patch
  };
  health.set(id, next);
  return next;
}

export async function withHealth(id, source, action) {
  try {
    const result = await action();
    const count = Array.isArray(result?.entities) ? result.entities.length : undefined;
    markSource(id, {
      source,
      status: "ok",
      error: null,
      count,
      cached: Boolean(result?.meta?.cached),
      lastSuccess: new Date().toISOString()
    });
    return result;
  } catch (error) {
    markSource(id, {
      source,
      status: "error",
      error: error.message,
      cached: false
    });
    throw error;
  }
}

export function getHealth() {
  return [...health.values()].sort((a, b) => a.id.localeCompare(b.id));
}
