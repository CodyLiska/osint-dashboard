export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": "OSIRIS-Situational-Dashboard/0.2",
      accept: "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw httpError(response);
  return response.json();
}

// Preserve the numeric HTTP status on the thrown error so callers (source-health
// alerting) can distinguish a rate-limit (429/403) from other failures.
function httpError(response) {
  const error = new Error(`${response.status} ${response.statusText}`);
  error.status = response.status;
  return error;
}

export async function fetchBuffer(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": "OSIRIS-Situational-Dashboard/0.2",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw httpError(response);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": "Mozilla/5.0 OSIRIS-Situational-Dashboard/0.2",
      accept: "text/html,application/xhtml+xml,text/plain",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw httpError(response);
  return response.text();
}

// Retry a fetch fn on transient failures (5xx / network / timeout), not on 4xx
// (client errors won't recover — and this keeps us from hammering a 429).
export async function withRetry(fn, retries = 1) {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0 && (!error.status || error.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return withRetry(fn, retries - 1);
    }
    throw error;
  }
}

// Resilient fetch wrappers: a per-attempt timeout (so a stalled origin fails fast
// instead of hanging) plus one retry on transient failures. Pair with
// cachedResilient() so a flaky single-resource upstream degrades to stale/cached
// data rather than surfacing an error.
export function fetchJsonRetry(url, options = {}, { retries = 1, timeoutMs = 10_000 } = {}) {
  return withRetry(() => fetchJson(url, { signal: AbortSignal.timeout(timeoutMs), ...options }), retries);
}

export function fetchTextRetry(url, options = {}, { retries = 1, timeoutMs = 20_000 } = {}) {
  return withRetry(() => fetchText(url, { signal: AbortSignal.timeout(timeoutMs), ...options }), retries);
}

export function fetchBufferRetry(url, options = {}, { retries = 1, timeoutMs = 30_000 } = {}) {
  return withRetry(() => fetchBuffer(url, { signal: AbortSignal.timeout(timeoutMs), ...options }), retries);
}
