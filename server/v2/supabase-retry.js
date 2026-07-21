// Supabase retry wrapper — Railway's outbound network to Supabase flakes
// transiently (`TypeError: fetch failed`, `ECONNRESET`, etc.) and
// @supabase/supabase-js surfaces these without any retry. This wrapper
// catches transient network + gateway errors and retries with exponential
// backoff. Postgres errors (bad SQL, RLS denial) are returned untouched.
//
// SELECT reads only. Do NOT wrap writes (insert/update/upsert/delete) —
// they can be non-idempotent and retrying could double-write.

const TRANSIENT_MESSAGE_FRAGMENTS = [
  'fetch failed',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'socket hang up',
  'network',
];

const TRANSIENT_CAUSE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const TRANSIENT_STATUS = new Set([502, 503, 504]);

/**
 * True if `err` (or the { error } embedded in a builder response) looks like
 * a transient network / gateway hiccup worth retrying.
 */
function isTransient(err) {
  if (!err) return false;

  const msg = String(err.message || err).toLowerCase();
  for (const frag of TRANSIENT_MESSAGE_FRAGMENTS) {
    if (msg.includes(frag.toLowerCase())) return true;
  }

  // TypeError from undici carries the real socket error on .cause
  const causeCode = err.cause?.code || err.code;
  if (causeCode && TRANSIENT_CAUSE_CODES.has(causeCode)) return true;

  // Supabase pooler / edge gateway blips surface as HTTP status
  const status = err.status ?? err.statusCode;
  if (status && TRANSIENT_STATUS.has(Number(status))) return true;

  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a Supabase builder call on transient network errors.
 *
 * Usage:
 *   const { data, error } = await sbRetry(() =>
 *     supabase.from('expenses').select('*').gte('date', start)
 *   );
 *
 * Retries on `TypeError: fetch failed`, ECONNRESET, ETIMEDOUT, ENOTFOUND,
 * socket hang up, and 502/503/504 responses.
 *
 * Does NOT retry on Postgres errors (bad SQL, permission denied) — those
 * return { data, error } normally and are the caller's problem.
 *
 * @param {() => PromiseLike<{data:any,error:any}>} builder
 *   A thunk that returns a Supabase query-builder chain (which is awaitable).
 * @param {{ attempts?: number, baseMs?: number, factor?: number }} [cfg]
 * @returns {Promise<{data:any,error:any}>}
 */
export async function sbRetry(builder, cfg = {}) {
  const attempts = Math.max(1, cfg.attempts ?? 3);
  const baseMs = cfg.baseMs ?? 300;
  const factor = cfg.factor ?? 3;

  let lastThrown = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await builder();
      // Supabase returns { data, error }. If error is transient we retry;
      // otherwise (real Postgres error or success) return as-is.
      if (result && result.error && isTransient(result.error) && attempt < attempts) {
        const wait = baseMs * Math.pow(factor, attempt - 1);
        console.warn(`[sbRetry] transient supabase error on attempt ${attempt}/${attempts}: ${result.error.message || result.error}. retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return result;
    } catch (err) {
      lastThrown = err;
      if (!isTransient(err) || attempt >= attempts) {
        throw err;
      }
      const wait = baseMs * Math.pow(factor, attempt - 1);
      console.warn(`[sbRetry] transient throw on attempt ${attempt}/${attempts}: ${err.message || err}. retrying in ${wait}ms`);
      await sleep(wait);
    }
  }

  // Loop only exits via return/throw above; this is defensive.
  if (lastThrown) throw lastThrown;
  return { data: null, error: new Error('sbRetry: exhausted attempts') };
}

/**
 * Convenience wrapper for the common `.select(...)` pattern.
 *
 * Usage:
 *   const { data, error } = await sbSelect(supabase, 'expenses',
 *     q => q.select('*').gte('date', start)
 *   );
 */
export async function sbSelect(supabase, table, buildQuery, cfg = {}) {
  return sbRetry(() => buildQuery(supabase.from(table)), cfg);
}
