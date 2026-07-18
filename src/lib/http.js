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
