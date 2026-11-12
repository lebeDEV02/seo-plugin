import { Parser } from 'htmlparser2';
import { normalizeUrl } from './util.mjs';

// Text inside these never reaches a reader, and an SVG <title> is not the page title.
const NON_CONTENT = new Set(['script', 'style', 'template', 'svg']);

const clean = (text) => text.replace(/\s+/g, ' ').trim();
const countWords = (text) => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;

function parseJsonLd(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { valid: false, error: String(error.message).slice(0, 160), types: [] };
  }
  const types = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node['@type']) types.push(...[].concat(node['@type']));
    if (node['@graph']) visit(node['@graph']);
  };
  visit(data);
  return { valid: true, error: null, types: [...new Set(types)] };
}

/**
 * Facts about a page taken from its raw HTML, before any JavaScript runs.
 * This is what crawlers that do not render see.
 */
export function extractPage(html, pageUrl) {
  const page = {
    lang: null,
    title: null,
    titleCount: 0,
    description: null,
    descriptionCount: 0,
    robotsMeta: [],
    canonical: [],
    viewport: null,
    h1: [],
    og: {},
    twitterCard: null,
    hreflang: [],
    images: { total: 0, missingAlt: 0, missingAltSamples: [] },
    links: [],
    anchorsWithoutHref: 0,
    jsonld: [],
    wordCount: 0,
    metaRefresh: null,
  };
  const links = new Map();
  let base = pageUrl;
  let nonContentDepth = 0;
  let capture = null; // { kind: 'title' | 'h1' | 'jsonld', text }

  const readMeta = (attrs) => {
    const name = (attrs.name ?? '').toLowerCase();
    const property = (attrs.property ?? '').toLowerCase();
    const content = attrs.content ?? '';
    if (name === 'description') {
      page.descriptionCount++;
      page.description ??= clean(content);
    } else if (name === 'robots' || name === 'googlebot') {
      page.robotsMeta.push({ name, content: content.toLowerCase() });
    } else if (name === 'viewport') {
      page.viewport = content;
    } else if (name === 'twitter:card') {
      page.twitterCard = content;
    }
    if (property.startsWith('og:')) page.og[property.slice(3)] ??= content;
    if ((attrs['http-equiv'] ?? '').toLowerCase() === 'refresh') page.metaRefresh = content;
  };

  const readLink = (attrs) => {
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical') && attrs.href !== undefined) page.canonical.push(attrs.href.trim());
    if (rel.includes('alternate') && attrs.hreflang) {
      page.hreflang.push({ lang: attrs.hreflang.trim(), href: normalizeUrl(attrs.href ?? '', base) });
    }
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'script' && (attrs.type ?? '').trim().toLowerCase() === 'application/ld+json') {
          capture = { kind: 'jsonld', text: '' };
          nonContentDepth++;
          return;
        }
        if (NON_CONTENT.has(name)) {
          nonContentDepth++;
          return;
        }
        if (nonContentDepth > 0) return;

        if (name === 'html') {
          if (attrs.lang) page.lang = attrs.lang.trim();
        } else if (name === 'base') {
          if (attrs.href) base = normalizeUrl(attrs.href, pageUrl) ?? pageUrl;
        } else if (name === 'title') {
          page.titleCount++;
          capture = { kind: 'title', text: '' };
        } else if (name === 'meta') {
          readMeta(attrs);
        } else if (name === 'link') {
          readLink(attrs);
        } else if (name === 'h1') {
          capture = { kind: 'h1', text: '' };
        } else if (name === 'img') {
          page.images.total++;
          const decorative = attrs.role === 'presentation' || attrs['aria-hidden'] === 'true';
          if (attrs.alt === undefined && !decorative) {
            page.images.missingAlt++;
            if (page.images.missingAltSamples.length < 5) {
              page.images.missingAltSamples.push(attrs.src ?? attrs['data-src'] ?? '');
            }
          }
        } else if (name === 'a') {
          if (attrs.href === undefined) {
            page.anchorsWithoutHref++;
            return;
          }
          const url = normalizeUrl(attrs.href.trim(), base);
          if (url && !links.has(url)) {
            links.set(url, { url, nofollow: /\bnofollow\b/i.test(attrs.rel ?? '') });
          }
        }
      },
      ontext(text) {
        if (capture) capture.text += text;
        if (nonContentDepth === 0 && capture?.kind !== 'title') page.wordCount += countWords(text);
      },
      onclosetag(name) {
        if (name === 'script' && capture?.kind === 'jsonld') {
          page.jsonld.push(parseJsonLd(capture.text));
          capture = null;
          nonContentDepth = Math.max(0, nonContentDepth - 1);
          return;
        }
        if (NON_CONTENT.has(name)) {
          nonContentDepth = Math.max(0, nonContentDepth - 1);
          return;
        }
        if (name === 'title' && capture?.kind === 'title') {
          page.title ??= clean(capture.text);
          capture = null;
        } else if (name === 'h1' && capture?.kind === 'h1') {
          page.h1.push(clean(capture.text));
          capture = null;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();

  page.links = [...links.values()];
  return page;
}
