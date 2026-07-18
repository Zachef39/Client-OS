// Simple TTL cache — no deps, single-instance in-memory.
// Used by hot v2 endpoints to avoid re-hitting Monday / GHL / Meta / Stripe / Supabase
// on every dashboard load. Prune to keep memory bounded.

const store = new Map();
const MAX_ENTRIES = 500;
const PRUNE_TARGET = 100; // when over MAX, drop the 100 oldest-expiring entries

export function getCached(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

export function setCached(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (store.size > MAX_ENTRIES) {
    const oldest = [...store.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, PRUNE_TARGET);
    for (const [k] of oldest) store.delete(k);
  }
}

/**
 * Fetch-or-compute helper. Cache-hit returns instantly; miss runs `fn`, caches
 * result, and returns it. Failed `fn()` is NOT cached — next caller retries.
 */
export async function cachedFetch(key, ttlMs, fn) {
  const hit = getCached(key);
  if (hit != null) return hit;
  const value = await fn();
  setCached(key, value, ttlMs);
  return value;
}

/**
 * Drop every entry whose key starts with `prefix`. Use after writes that
 * invalidate downstream summaries (e.g. after /ads/sync clear ad cache).
 */
export function invalidate(prefix) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

/** Diagnostic — surface cache size + keys via an admin route if needed. */
export function inspect() {
  return {
    size: store.size,
    keys: [...store.keys()],
  };
}
