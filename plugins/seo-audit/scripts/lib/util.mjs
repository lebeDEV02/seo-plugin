export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const unique = (items) => [...new Set(items)];

/** Run `fn` over `items` with at most `limit` calls in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Glob where `*` matches any run of characters. Used for URL paths in the config. */
export function globToRegExp(glob) {
  return new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`);
}

export function matchesAny(globs, value) {
  return globs.some((glob) => globToRegExp(glob).test(value));
}

/** Absolute http(s) URL without the fragment, or null when `href` is not a crawlable link. */
export function normalizeUrl(href, base) {
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.href;
}

export function pathOf(url) {
  const { pathname, search } = new URL(url);
  return pathname + search;
}

/**
 * Collapse a URL into a template so that many pages with the same problem become one finding:
 * "/" and one-segment paths stay as they are, deeper paths become "/parent/path/*".
 * Pages that share a parent path are almost always built from one template.
 */
export function urlPattern(url) {
  const { pathname } = new URL(url);
  const segments = pathname.split('/').filter(Boolean);
  return segments.length <= 1 ? pathname : `/${segments.slice(0, -1).join('/')}/*`;
}
