import { clearCache } from "../../src/lib/cache.js";

// Test helper (not a test file). Replaces the global fetch with one that returns
// canned JSON, so adapter and server tests exercise real normalization logic
// without touching the network. `resolve` is either a payload object (returned
// for every request) or a (url, opts) => payload function for URL-aware routing.
// The shared adapter cache is cleared on install and restore so a cached response
// never leaks between tests.
export function installJsonFetch(resolve) {
  clearCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const payload = typeof resolve === "function" ? resolve(String(url), opts) : resolve;
    return new Response(JSON.stringify(payload ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  return () => {
    globalThis.fetch = original;
    clearCache();
  };
}

// Like installJsonFetch but the resolver may return a raw string (served as-is —
// used for XML/HTML feeds read via fetchText) or an object (JSON-stringified for
// fetchJson). Lets one mock serve mixed JSON and text upstreams by URL.
export function installFetch(resolve) {
  clearCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const out = typeof resolve === "function" ? resolve(String(url), opts) : resolve;
    const body = typeof out === "string" ? out : JSON.stringify(out ?? {});
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return () => {
    globalThis.fetch = original;
    clearCache();
  };
}
