import { extractPage } from '../lib/html.mjs';
import { isAllowed } from '../lib/robots.mjs';
import { mapLimit, matchesAny, normalizeUrl, pathOf, unique } from '../lib/util.mjs';

const ASSET = /\.(pdf|png|jpe?g|gif|webp|avif|svg|ico|zip|gz|mp4|webm|mp3|woff2?|ttf|css|js|json|xml|txt)$/i;
const CRAWLER_TOKEN = 'seo-audit';

/**
 * Crawl the site: breadth-first from the home page and key pages, then every sitemap URL the
 * crawl did not reach. Pages reached only through the sitemap get `depth: null`.
 */
export async function collectPages(config, client, { robots, sitemapUrls }) {
  const { origin, crawl } = config;
  const host = new URL(origin).hostname;
  const internalHosts = new Set([host, host.startsWith('www.') ? host.slice(4) : `www.${host}`]);
  const isInternal = (url) => internalHosts.has(new URL(url).hostname);

  const sitemapSet = new Set(sitemapUrls);
  const records = new Map();
  const inlinks = new Map();
  const seen = new Set();
  const skipped = { byRobots: [], byFilters: 0, byLimit: 0 };

  function admit(url) {
    if (seen.has(url)) return false;
    seen.add(url);
    const path = pathOf(url);
    if ((crawl.include.length > 0 && !matchesAny(crawl.include, path)) || matchesAny(crawl.exclude, path)) {
      skipped.byFilters++;
      return false;
    }
    if (crawl.respectRobots && !isAllowed(robots, CRAWLER_TOKEN, path).allowed) {
      skipped.byRobots.push(url);
      return false;
    }
    return true;
  }

  async function fetchPage(url) {
    const asset = ASSET.test(new URL(url).pathname);
    let response = await client.get(url, asset ? { method: 'HEAD' } : {});
    if (asset && [0, 405, 501].includes(response.status)) {
      response = await client.get(url, { readBody: false });
    }
    const record = {
      url,
      finalUrl: response.finalUrl,
      status: response.status,
      error: response.error,
      hops: response.hops,
      contentType: response.headers['content-type'] ?? null,
      xRobotsTag: response.headers['x-robots-tag'] ?? null,
      ttfbMs: response.ttfbMs,
      bytes: response.bytes,
      inSitemap: sitemapSet.has(url),
      asset,
      depth: null,
      html: null,
      internalLinks: [],
      externalLinkCount: 0,
    };
    const isHtml = /text\/html|application\/xhtml/i.test(record.contentType ?? '');
    // A redirected URL is not a page of its own: its target is crawled separately.
    if (response.status === 200 && isHtml && response.body && response.hops.length === 0) {
      const { links, ...page } = extractPage(response.body, url);
      record.html = page;
      const internal = links.filter((link) => isInternal(link.url)).map((link) => link.url);
      record.internalLinks = unique(internal).filter((link) => link !== url);
      record.externalLinkCount = links.length - internal.length;
    } else if (response.hops.length > 0 && isInternal(response.finalUrl)) {
      record.internalLinks = [response.finalUrl];
    }
    return record;
  }

  async function crawlFrom(seeds, startDepth) {
    let level = seeds.filter(admit);
    let depth = startDepth;
    while (level.length > 0) {
      const room = crawl.maxPages - records.size;
      const batch = level.slice(0, Math.max(0, room));
      skipped.byLimit += level.length - batch.length;
      if (batch.length === 0) return;

      const fetched = await mapLimit(batch, crawl.concurrency, fetchPage);
      const next = [];
      for (const record of fetched) {
        record.depth = depth;
        records.set(record.url, record);
        for (const link of record.internalLinks) {
          if (!inlinks.has(link)) inlinks.set(link, new Set());
          // A redirect is not a link: do not count it as a reason the target is reachable.
          if (record.hops.length === 0) inlinks.get(link).add(record.url);
          if (admit(link)) next.push(link);
        }
      }
      level = next;
      depth = depth === null ? null : depth + 1;
    }
  }

  const home = normalizeUrl('/', origin);
  const keyPages = config.keyPages.map((path) => normalizeUrl(path, origin)).filter(Boolean);
  await crawlFrom(unique([home, ...keyPages]), 0);
  await crawlFrom(sitemapUrls.filter(isInternal), null);

  // A link to a redirecting URL is, for reachability, a link to the redirect's target.
  for (const record of records.values()) {
    if (record.hops.length === 0 || !inlinks.has(record.finalUrl)) continue;
    for (const source of inlinks.get(record.url) ?? []) inlinks.get(record.finalUrl).add(source);
  }

  const pages = [...records.values()].map(({ internalLinks, ...record }) => {
    const sources = [...(inlinks.get(record.url) ?? [])];
    return {
      ...record,
      internalLinkCount: internalLinks.length,
      inlinkCount: sources.length,
      inlinkSamples: sources.slice(0, 3),
    };
  });
  return { pages, skipped };
}
