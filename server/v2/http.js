// fetchRetry — timeout + retry wrapper around global fetch.
// Wrap raw calls to Monday / GHL / Meta / Stripe so a single flaky external
// request doesn't take down whole dashboard endpoints.
//
// Do NOT wrap Supabase client calls — supabase-js has its own retry logic.

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;

/**
 * Fetch with timeout + retry on network error / 5xx.
 * On non-retryable non-OK response, returns the response as-is (caller decides).
 *
 * @param {string} url
 * @param {RequestInit} opts       — passed to fetch (headers, method, body, etc.)
 * @param {object} cfg
 * @param {number} [cfg.timeout]   — per-attempt timeout in ms (default 15s)
 * @param {number} [cfg.retries]   — additional attempts after the first (default 2 → 3 total)
 * @param {number} [cfg.backoffMs] — base linear backoff between attempts (default 500ms)
 */
export async function fetchRetry(url, opts = {}, cfg = {}) {
  const timeout = cfg.timeout ?? DEFAULT_TIMEOUT_MS;
  const retries = cfg.retries ?? DEFAULT_RETRIES;
  const backoffMs = cfg.backoffMs ?? DEFAULT_BACKOFF_MS;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      // Retry on 5xx (transient upstream failure). Return 4xx immediately — caller error.
      if (!res.ok && res.status >= 500 && attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr || new Error(`fetch failed after ${retries + 1} tries: ${url}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
