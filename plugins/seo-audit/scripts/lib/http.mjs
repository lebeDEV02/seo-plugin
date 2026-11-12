import { sleep } from './util.mjs';

const KEPT_HEADERS = [
  'content-type',
  'x-robots-tag',
  'strict-transport-security',
  'server',
  'cf-mitigated',
  'retry-after',
];

/**
 * Fetch a URL following redirects by hand, so every hop is recorded.
 * Never throws: network failures come back as `status: 0` with an `error` code.
 */
export async function fetchChain(url, options = {}) {
  const {
    userAgent,
    timeoutMs = 15000,
    method = 'GET',
    readBody = true,
    binary = false,
    maxHops = 10,
    maxBytes = 5_000_000,
  } = options;
  const hops = [];
  let current = url;
  const result = (extra) => ({
    url,
    finalUrl: current,
    status: 0,
    hops,
    headers: {},
    ttfbMs: null,
    body: null,
    bytes: null,
    error: null,
    ...extra,
  });

  for (let hop = 0; hop <= maxHops; hop++) {
    const started = performance.now();
    let response;
    try {
      response = await fetch(current, {
        method,
        redirect: 'manual',
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return result({ error: error?.cause?.code ?? error?.name ?? 'fetch-failed' });
    }
    const ttfbMs = Math.round(performance.now() - started);

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      hops.push({ url: current, status: response.status });
      let next;
      try {
        next = new URL(location, current).href;
      } catch {
        return result({ status: response.status, error: 'bad-location' });
      }
      current = next;
      continue;
    }

    const headers = {};
    for (const name of KEPT_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }

    if (!readBody || method === 'HEAD') {
      await response.body?.cancel();
      return result({ status: response.status, headers, ttfbMs });
    }
    try {
      const buffer = Buffer.from(await response.arrayBuffer());
      const limited = buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
      return result({
        status: response.status,
        headers,
        ttfbMs,
        bytes: buffer.length,
        body: binary ? limited : limited.toString('utf8'),
      });
    } catch {
      return result({ status: response.status, headers, ttfbMs, error: 'body-read-failed' });
    }
  }
  return result({ error: 'too-many-redirects' });
}

/** Client that caps concurrency and spaces request starts, so the audit stays polite to the site. */
export function createClient({ userAgent, concurrency = 4, delayMs = 100, timeoutMs = 15000 }) {
  let active = 0;
  let nextStart = 0;
  const waiters = [];

  async function acquire() {
    if (active >= concurrency) await new Promise((resolve) => waiters.push(resolve));
    else active++;
    const now = Date.now();
    const wait = Math.max(0, nextStart - now);
    nextStart = Math.max(now, nextStart) + delayMs;
    if (wait > 0) await sleep(wait);
  }

  function release() {
    const waiter = waiters.shift();
    if (waiter) waiter();
    else active--;
  }

  return {
    userAgent,
    async get(url, options = {}) {
      await acquire();
      try {
        return await fetchChain(url, { userAgent, timeoutMs, ...options });
      } finally {
        release();
      }
    },
  };
}
