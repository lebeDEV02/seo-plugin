import { matchesAny, normalizeUrl, pathOf } from '../lib/util.mjs';
import { pageFindings, siteFinding } from './finding.mjs';

const HREFLANG = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

/**
 * True when a robots directive list (meta content or X-Robots-Tag) contains noindex.
 * "googlebot: noindex" names a crawler before the colon; "max-image-preview:none" is a
 * directive with a value and does not mean noindex.
 */
export function hasNoindex(directives) {
  return directives
    .flatMap((value) => value.toLowerCase().split(','))
    .map((token) => {
      const text = token.trim();
      const colon = text.indexOf(':');
      if (colon < 0) return text;
      const name = text.slice(0, colon).trim();
      return /^(max-|unavailable_after)/.test(name) ? '' : text.slice(colon + 1).trim();
    })
    .some((token) => token === 'noindex' || token === 'none');
}

function withoutQuery(url) {
  const clean = new URL(url);
  clean.search = '';
  return clean.href;
}

function duplicates(pages, pick) {
  const byValue = new Map();
  for (const page of pages) {
    const value = pick(page)?.trim().toLowerCase();
    if (!value) continue;
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(page);
  }
  return [...byValue.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((group) => ({ value: pick(group[0]), count: group.length, urls: group.slice(0, 5).map((p) => p.url) }));
}

/** Rules that look at each crawled URL: status, indexability, on-page elements, raw content. */
export function pageRules({ site, pages, skipped, config, isKey, weigh }) {
  const findings = [];
  const limits = config.thresholds;
  const add = (rule, matches, options) =>
    findings.push(...pageFindings(rule, matches, { isKey, weigh, ...options }));

  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const otherHost = site.host.startsWith('www.') ? site.host.slice(4) : `www.${site.host}`;
  const isInternal = (url) => [site.host, otherHost].includes(new URL(url).hostname);

  // A page here means: answered 200 with HTML and was not a redirect.
  const htmlPages = pages.filter((page) => page.html);
  const noindex = (page) =>
    hasNoindex([page.xRobotsTag ?? '', ...page.html.robotsMeta.map((meta) => meta.content)]);
  const indexable = htmlPages.filter((page) => !noindex(page));
  const canonicalOf = (page) =>
    page.html.canonical.length === 1 ? normalizeUrl(page.html.canonical[0], page.url) : null;

  // --- Reachability -------------------------------------------------------------------------
  add(
    'reach.page-error',
    pages
      .filter((page) => !page.asset && (page.status === 0 || page.status >= 500))
      .map((page) => ({ url: page.url, evidence: { status: page.status, error: page.error } })),
  );
  add(
    'reach.redirect-chain',
    pages
      .filter((page) => page.hops.length > 1)
      .map((page) => ({ url: page.url, evidence: { hops: page.hops, finalUrl: page.finalUrl } })),
  );
  add(
    'reach.sitemap-url-not-200',
    pages
      .filter((page) => page.inSitemap && (page.status !== 200 || page.hops.length > 0))
      .map((page) => ({ url: page.url, evidence: { status: page.status, finalUrl: page.finalUrl } })),
  );
  const sitemapUrls = new Set(site.sitemaps.urls.map((entry) => entry.loc));
  add(
    'reach.sitemap-url-blocked',
    skipped.byRobots.filter((url) => sitemapUrls.has(url)).map((url) => ({ url })),
  );
  add(
    'reach.sitemap-url-noindex',
    htmlPages.filter((page) => page.inSitemap && noindex(page)).map((page) => ({ url: page.url })),
  );
  add(
    'reach.sitemap-url-not-canonical',
    htmlPages
      .filter((page) => page.inSitemap && canonicalOf(page) && canonicalOf(page) !== page.url)
      .map((page) => ({ url: page.url, evidence: { canonical: canonicalOf(page) } })),
  );

  // --- Indexability -------------------------------------------------------------------------
  add(
    'index.noindex',
    htmlPages
      .filter((page) => noindex(page) && !matchesAny(config.expect.noindex, pathOf(page.url)))
      .map((page) => ({
        url: page.url,
        evidence: { metaRobots: page.html.robotsMeta, xRobotsTag: page.xRobotsTag },
      })),
    { keySeverity: 'critical' },
  );

  const canonical = { missing: [], multiple: [], otherHost: [], notSelf: [], badTarget: [] };
  for (const page of indexable) {
    const declared = page.html.canonical;
    if (declared.length > 1) {
      canonical.multiple.push({ url: page.url, evidence: { canonicals: declared } });
      continue;
    }
    const target = canonicalOf(page);
    if (!target) {
      canonical.missing.push({ url: page.url, evidence: { declared: declared[0] ?? null } });
    } else if (!isInternal(target)) {
      canonical.otherHost.push({ url: page.url, evidence: { canonical: target } });
    } else if (target !== page.url) {
      // A URL with parameters that canonicalises to its own clean path is set up as intended.
      if (target !== withoutQuery(page.url)) {
        canonical.notSelf.push({ url: page.url, evidence: { canonical: target } });
      }
      const record = byUrl.get(target);
      if (record && (record.status !== 200 || record.hops.length > 0)) {
        canonical.badTarget.push({
          url: page.url,
          evidence: { canonical: target, status: record.status, finalUrl: record.finalUrl },
        });
      }
    }
  }
  add('index.canonical-missing', canonical.missing);
  add('index.canonical-multiple', canonical.multiple);
  add('index.canonical-other-host', canonical.otherHost);
  add('index.canonical-not-self', canonical.notSelf);
  add('index.canonical-target-not-200', canonical.badTarget);

  // Pages that canonicalise elsewhere are duplicates on purpose, so they are left out here.
  const primary = indexable.filter((page) => [null, page.url].includes(canonicalOf(page)));
  for (const [rule, pick] of [
    ['index.duplicate-title', (page) => page.html.title],
    ['index.duplicate-description', (page) => page.html.description],
  ]) {
    const groups = duplicates(primary, pick);
    if (groups.length > 0) {
      findings.push(
        siteFinding(rule, { groups: groups.slice(0, 10) }, { count: groups.reduce((n, g) => n + g.count, 0) }),
      );
    }
  }

  add(
    'index.hreflang-invalid',
    htmlPages
      .map((page) => ({ page, bad: page.html.hreflang.map((alt) => alt.lang).filter((lang) => !HREFLANG.test(lang)) }))
      .filter(({ bad }) => bad.length > 0)
      .map(({ page, bad }) => ({ url: page.url, evidence: { codes: bad } })),
  );
  const noReturn = [];
  for (const page of htmlPages) {
    for (const alternate of page.html.hreflang) {
      const target = alternate.href && alternate.href !== page.url ? byUrl.get(alternate.href) : null;
      if (target?.html && !target.html.hreflang.some((back) => back.href === page.url)) {
        noReturn.push({ url: page.url, evidence: { alternate: alternate.href, lang: alternate.lang } });
        break;
      }
    }
  }
  add('index.hreflang-no-return-link', noReturn);

  // --- On-page ------------------------------------------------------------------------------
  const lengthOutside = (text, min, max) => text.length < min || text.length > max;
  add('onpage.title-missing', indexable.filter((page) => !page.html.title).map((page) => ({ url: page.url })), {
    keySeverity: 'critical',
  });
  add(
    'onpage.title-length',
    indexable
      .filter((page) => page.html.title && lengthOutside(page.html.title, limits.titleMin, limits.titleMax))
      .map((page) => ({ url: page.url, evidence: { length: page.html.title.length, title: page.html.title } })),
  );
  add(
    'onpage.description-missing',
    indexable.filter((page) => !page.html.description).map((page) => ({ url: page.url })),
  );
  add(
    'onpage.description-length',
    indexable
      .filter(
        (page) =>
          page.html.description &&
          lengthOutside(page.html.description, limits.descriptionMin, limits.descriptionMax),
      )
      .map((page) => ({ url: page.url, evidence: { length: page.html.description.length } })),
  );
  add(
    'onpage.h1-missing',
    indexable.filter((page) => !page.html.h1.some((text) => text !== '')).map((page) => ({ url: page.url })),
  );
  add(
    'onpage.h1-multiple',
    indexable
      .filter((page) => page.html.h1.length > 1)
      .map((page) => ({ url: page.url, evidence: { h1: page.html.h1.slice(0, 4) } })),
  );
  add('onpage.lang-missing', htmlPages.filter((page) => !page.html.lang).map((page) => ({ url: page.url })));
  add(
    'onpage.viewport-missing',
    htmlPages.filter((page) => !page.html.viewport).map((page) => ({ url: page.url })),
  );
  add(
    'onpage.image-alt-missing',
    htmlPages
      .filter((page) => page.html.images.missingAlt > 0)
      .map((page) => ({
        url: page.url,
        evidence: {
          missing: page.html.images.missingAlt,
          total: page.html.images.total,
          samples: page.html.images.missingAltSamples,
        },
      })),
  );
  add(
    'onpage.og-incomplete',
    indexable
      .map((page) => ({ page, missing: ['title', 'description', 'image'].filter((key) => !page.html.og[key]) }))
      .filter(({ missing }) => missing.length > 0)
      .map(({ page, missing }) => ({ url: page.url, evidence: { missing: missing.map((key) => `og:${key}`) } })),
  );
  add(
    'onpage.anchor-without-href',
    htmlPages
      .filter((page) => page.html.anchorsWithoutHref > 0)
      .map((page) => ({ url: page.url, evidence: { anchors: page.html.anchorsWithoutHref } })),
  );
  add(
    'onpage.broken-internal-link',
    pages
      .filter((page) => page.status >= 400 && page.status < 500 && page.inlinkCount > 0)
      .map((page) => ({ url: page.url, evidence: { status: page.status, linkedFrom: page.inlinkSamples } })),
  );
  add(
    'onpage.link-to-redirect',
    pages
      .filter((page) => page.hops.length > 0 && page.inlinkCount > 0)
      .map((page) => ({ url: page.url, evidence: { finalUrl: page.finalUrl, linkedFrom: page.inlinkSamples } })),
  );
  // When the crawl was cut short, "not reached from the home page" proves nothing.
  if (skipped.byLimit === 0) {
    add(
      'onpage.orphan-page',
      indexable
        .filter((page) => page.inSitemap && page.depth === null && !isKey(page.url))
        .map((page) => ({ url: page.url, evidence: { inlinks: page.inlinkCount } })),
    );
  }

  // --- Structured data ----------------------------------------------------------------------
  add(
    'schema.jsonld-invalid',
    htmlPages
      .map((page) => ({ page, bad: page.html.jsonld.filter((block) => !block.valid) }))
      .filter(({ bad }) => bad.length > 0)
      .map(({ page, bad }) => ({ url: page.url, evidence: { error: bad[0].error, blocks: bad.length } })),
  );

  // --- LLM access ---------------------------------------------------------------------------
  add(
    'llm.raw-html-thin',
    indexable
      .filter((page) => page.html.wordCount < limits.rawWordsMin)
      .map((page) => ({ url: page.url, evidence: { words: page.html.wordCount, bytes: page.bytes } })),
    { keySeverity: 'high' },
  );

  return findings;
}
