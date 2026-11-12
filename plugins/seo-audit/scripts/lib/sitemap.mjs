import { gunzipSync } from 'node:zlib';
import { normalizeUrl } from './util.mjs';

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function readTag(block, name) {
  const match = block.match(
    new RegExp(`<${name}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${name}>`, 'i'),
  );
  if (!match) return null;
  return match[1].trim().replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity]);
}

/** Parse one sitemap file: a sitemap index or a urlset. */
export function parseSitemap(xml) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const isUrlset = /<urlset[\s>]/i.test(xml);
  if (!isIndex && !isUrlset) return { type: 'invalid', entries: [] };

  const blocks = xml.match(isIndex ? /<sitemap[\s>][\s\S]*?<\/sitemap>/gi : /<url[\s>][\s\S]*?<\/url>/gi);
  const entries = [];
  for (const block of blocks ?? []) {
    const loc = readTag(block, 'loc');
    if (loc) entries.push({ loc, lastmod: readTag(block, 'lastmod') });
  }
  return { type: isIndex ? 'index' : 'urlset', entries };
}

const isGzip = (buffer) => buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

/** Fetch sitemaps starting from `startUrls`, following sitemap indexes. */
export async function loadSitemaps(startUrls, client, { maxFiles = 500, maxUrls = 50000 } = {}) {
  const files = [];
  const urls = new Map();
  const queue = [...startUrls];
  const seen = new Set();

  while (queue.length > 0 && files.length < maxFiles) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const response = await client.get(url, { binary: true });
    const file = { url, status: response.status, error: response.error, type: null, count: 0 };
    files.push(file);
    if (response.status !== 200 || !response.body) continue;

    let xml;
    try {
      xml = (isGzip(response.body) ? gunzipSync(response.body) : response.body).toString('utf8');
    } catch {
      file.type = 'invalid';
      continue;
    }
    const parsed = parseSitemap(xml);
    file.type = parsed.type;
    file.count = parsed.entries.length;

    for (const entry of parsed.entries) {
      const loc = normalizeUrl(entry.loc, url);
      if (!loc) continue;
      if (parsed.type === 'index') queue.push(loc);
      else if (urls.size < maxUrls && !urls.has(loc)) urls.set(loc, entry.lastmod);
    }
  }
  return {
    files,
    urls: [...urls].map(([loc, lastmod]) => ({ loc, lastmod })),
    // True when a limit stopped the walk, so the URL list is not the whole sitemap.
    truncated: queue.some((url) => !seen.has(url)) || urls.size >= maxUrls,
  };
}
