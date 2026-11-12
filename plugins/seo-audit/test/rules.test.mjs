import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from '../scripts/evaluate/index.mjs';
import { hasNoindex } from '../scripts/evaluate/rules-pages.mjs';
import { resolveConfig } from '../scripts/lib/config.mjs';

const ORIGIN = 'https://example.com';
const BOTS = [
  { token: 'GPTBot', class: 'training', probeUserAgent: 'GPTBot' },
  { token: 'OAI-SearchBot', class: 'search', probeUserAgent: 'OAI-SearchBot' },
];

const redirected = (url) => ({
  url,
  finalUrl: `${ORIGIN}/`,
  status: 200,
  hops: [{ url, status: 301 }],
  headers: {},
  error: null,
});

function makeSite(overrides = {}) {
  return {
    origin: ORIGIN,
    host: 'example.com',
    collectedAt: '2026-01-01T00:00:00.000Z',
    home: {
      url: `${ORIGIN}/`,
      finalUrl: `${ORIGIN}/`,
      status: 200,
      hops: [],
      headers: { 'strict-transport-security': 'max-age=31536000' },
      error: null,
    },
    variants: [
      redirected('http://example.com/'),
      redirected('https://www.example.com/'),
      redirected('http://www.example.com/'),
    ],
    tls: { validTo: '2026-06-01T00:00:00.000Z', authorized: true, issuer: 'Test CA', error: null },
    robots: {
      status: 200,
      error: null,
      looksLikeHtml: false,
      text: `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    },
    sitemaps: {
      declaredInRobots: true,
      files: [{ url: `${ORIGIN}/sitemap.xml`, status: 200, error: null, type: 'urlset', count: 3 }],
      urls: [{ loc: `${ORIGIN}/`, lastmod: null }],
    },
    missingPageProbe: { url: `${ORIGIN}/missing`, status: 404, finalUrl: `${ORIGIN}/missing` },
    llmsTxt: { status: 200, error: null, looksLikeHtml: false, firstLine: '# Example', links: [] },
    botProbes: [],
    ...overrides,
  };
}

function makePage(path, overrides = {}, html = {}) {
  const url = `${ORIGIN}${path}`;
  return {
    url,
    finalUrl: url,
    status: 200,
    error: null,
    hops: [],
    contentType: 'text/html',
    xRobotsTag: null,
    bytes: 20000,
    inSitemap: true,
    asset: false,
    depth: 1,
    inlinkCount: 1,
    inlinkSamples: [`${ORIGIN}/`],
    html: {
      lang: 'en',
      title: `Unique title for ${path}`,
      description: `A description of ${path} that is long enough to pass the length check.`,
      robotsMeta: [],
      canonical: [url],
      viewport: 'width=device-width, initial-scale=1',
      h1: ['Heading'],
      og: { title: 'Title', description: 'Description', image: `${ORIGIN}/og.png` },
      hreflang: [],
      images: { total: 2, missingAlt: 0, missingAltSamples: [] },
      anchorsWithoutHref: 0,
      jsonld: [],
      wordCount: 600,
      ...html,
    },
    ...overrides,
  };
}

function audit({ site = makeSite(), pages = [makePage('/')], config = {}, skipped } = {}) {
  return evaluate({
    site,
    pages,
    skipped: skipped ?? { byRobots: [], byFilters: 0, byLimit: 0 },
    config: resolveConfig({ site: ORIGIN, ...config }),
    bots: BOTS,
  });
}

const rules = (result) => result.findings.map((finding) => finding.rule);

test('hasNoindex reads directives, not substrings', () => {
  assert.equal(hasNoindex(['index, follow']), false);
  assert.equal(hasNoindex(['max-image-preview:none, max-snippet:-1']), false);
  assert.equal(hasNoindex(['NOINDEX, nofollow']), true);
  assert.equal(hasNoindex(['none']), true);
  assert.equal(hasNoindex(['', 'googlebot: noindex']), true);
});

test('a healthy site produces no findings', () => {
  const result = audit({ pages: [makePage('/'), makePage('/pricing'), makePage('/blog/post')] });
  assert.deepEqual(result.findings, []);
});

test('site-level reachability problems are reported', () => {
  const site = makeSite({
    variants: [
      { url: 'http://example.com/', finalUrl: 'http://example.com/', status: 200, hops: [], headers: {}, error: null },
      { url: 'https://www.example.com/', finalUrl: 'https://www.example.com/', status: 0, hops: [], headers: {}, error: 'ENOTFOUND' },
      redirected('http://www.example.com/'),
    ],
    tls: { validTo: '2026-01-04T00:00:00.000Z', authorized: true, issuer: 'Test CA', error: null },
    robots: { status: 503, error: null, looksLikeHtml: false, text: '' },
    missingPageProbe: { url: `${ORIGIN}/missing`, status: 200, finalUrl: `${ORIGIN}/missing` },
  });
  const result = audit({ site });
  const found = rules(result);
  for (const rule of [
    'reach.http-not-redirected',
    'reach.host-variant-not-redirected',
    'reach.tls-expiring',
    'reach.robots-unavailable',
    'reach.soft-404',
  ]) {
    assert.ok(found.includes(rule), `expected ${rule}`);
  }
  const tls = result.findings.find((finding) => finding.rule === 'reach.tls-expiring');
  assert.equal(tls.severity, 'critical', '3 days left is below the critical threshold');
  assert.equal(tls.evidence.daysLeft, 3);
});

test('noindex is critical on a key page and silent where the config expects it', () => {
  const pages = [
    makePage('/', {}, { robotsMeta: [{ name: 'robots', content: 'noindex' }] }),
    makePage('/thanks', { xRobotsTag: 'noindex' }),
  ];
  const result = audit({ pages, config: { expect: { noindex: ['/thanks'] } } });
  const noindex = result.findings.filter((finding) => finding.rule === 'index.noindex');
  assert.equal(noindex.length, 1);
  assert.equal(noindex[0].severity, 'critical');
  assert.deepEqual(noindex[0].urls, [`${ORIGIN}/`]);
  // A noindex page listed in the sitemap contradicts itself whether or not it is expected.
  assert.equal(result.findings.filter((finding) => finding.rule === 'reach.sitemap-url-noindex').length, 2);
});

test('canonical problems are told apart', () => {
  const pages = [
    makePage('/'),
    makePage('/none', {}, { canonical: [] }),
    makePage('/two', {}, { canonical: [`${ORIGIN}/two`, `${ORIGIN}/other`] }),
    makePage('/away', {}, { canonical: ['https://elsewhere.test/away'] }),
    makePage('/dupe', {}, { canonical: [`${ORIGIN}/gone`] }),
    makePage('/gone', { status: 404, html: null }),
  ];
  const found = rules(audit({ pages }));
  for (const rule of [
    'index.canonical-missing',
    'index.canonical-multiple',
    'index.canonical-other-host',
    'index.canonical-not-self',
    'index.canonical-target-not-200',
  ]) {
    assert.ok(found.includes(rule), `expected ${rule}`);
  }
});

test('a parameterised URL that canonicalises to its clean path is not a finding', () => {
  const pages = [
    makePage('/'),
    makePage('/post/'),
    makePage('/post/?ref=example.com', { inSitemap: false }, { canonical: [`${ORIGIN}/post/`] }),
    makePage('/slash/', {}, { canonical: [`${ORIGIN}/slash`] }),
  ];
  const notSelf = audit({ pages }).findings.filter((finding) => finding.rule === 'index.canonical-not-self');
  assert.deepEqual(notSelf.flatMap((finding) => finding.urls), [`${ORIGIN}/slash/`]);
});

test('the same problem on many similar pages is one finding with a count', () => {
  const pages = [
    makePage('/'),
    ...[1, 2, 3].map((n) => makePage(`/blog/post-${n}`, {}, { h1: [] })),
    makePage('/docs/intro', {}, { h1: [] }),
  ];
  const h1 = audit({ pages }).findings.filter((finding) => finding.rule === 'onpage.h1-missing');
  assert.deepEqual(
    h1.map(({ id, pattern, count }) => ({ id, pattern, count })),
    [
      { id: 'onpage.h1-missing|/blog/*', pattern: '/blog/*', count: 3 },
      { id: 'onpage.h1-missing|/docs/*', pattern: '/docs/*', count: 1 },
    ],
  );
});

test('duplicate titles are grouped, and deliberate duplicates are left out', () => {
  const pages = [
    makePage('/'),
    makePage('/a', {}, { title: 'Same title' }),
    makePage('/b', {}, { title: 'same title ' }),
    makePage('/b?ref=1', {}, { title: 'Same title', canonical: [`${ORIGIN}/b`] }),
  ];
  const finding = audit({ pages }).findings.find((item) => item.rule === 'index.duplicate-title');
  assert.equal(finding.count, 2);
  assert.deepEqual(finding.evidence.groups[0].urls, [`${ORIGIN}/a`, `${ORIGIN}/b`]);
});

test('broken links, redirects and orphans', () => {
  const pages = [
    makePage('/'),
    makePage('/missing', { status: 404, html: null, inSitemap: false }),
    makePage('/old', {
      finalUrl: `${ORIGIN}/new`,
      hops: [{ url: `${ORIGIN}/old`, status: 301 }],
      html: null,
      inSitemap: false,
    }),
    makePage('/lonely', { depth: null, inlinkCount: 0, inlinkSamples: [] }),
  ];
  const result = audit({ pages });
  const found = rules(result);
  assert.ok(found.includes('onpage.broken-internal-link'));
  assert.ok(found.includes('onpage.link-to-redirect'));
  assert.ok(found.includes('onpage.orphan-page'));

  const cutShort = audit({ pages, skipped: { byRobots: [], byFilters: 0, byLimit: 5 } });
  assert.ok(!rules(cutShort).includes('onpage.orphan-page'), 'a truncated crawl cannot prove a page is orphaned');
});

test('AI crawler policy is compared with robots.txt', () => {
  const site = makeSite({
    robots: {
      status: 200,
      error: null,
      looksLikeHtml: false,
      text: `User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    },
  });
  const defaults = audit({ site }).findings.find((item) => item.rule === 'llm.robots-policy-mismatch');
  assert.deepEqual(
    defaults.evidence.mismatches.map(({ bot, expected, actual }) => ({ bot, expected, actual })),
    [{ bot: 'OAI-SearchBot', expected: 'allow', actual: 'blocked' }],
  );

  const strict = audit({ site, config: { aiCrawlers: { training: 'block', search: 'block' } } });
  const mismatch = strict.findings.find((item) => item.rule === 'llm.robots-policy-mismatch');
  assert.deepEqual(
    mismatch.evidence.mismatches.map(({ bot }) => bot),
    ['GPTBot'],
    'the training crawler is allowed although the policy says block',
  );
});

test('a crawler refused by the server is reported with low confidence', () => {
  const site = makeSite({
    botProbes: [
      {
        url: `${ORIGIN}/`,
        baseline: { status: 200, bytes: 1000 },
        bots: [
          { token: 'GPTBot', class: 'training', status: 403, error: null, bytes: 50, cfMitigated: 'challenge' },
          { token: 'OAI-SearchBot', class: 'search', status: 200, error: null, bytes: 1000, cfMitigated: null },
        ],
      },
    ],
  });
  const finding = audit({ site }).findings.find((item) => item.rule === 'llm.bot-blocked-by-server');
  assert.equal(finding.confidence, 'low');
  assert.deepEqual(finding.evidence.blocked.map(({ bot }) => bot), ['GPTBot']);
});

test('thin raw HTML is raised to high on a key page', () => {
  const pages = [makePage('/', {}, { wordCount: 4 }), makePage('/blog/a', {}, { wordCount: 4 })];
  const thin = audit({ pages }).findings.filter((item) => item.rule === 'llm.raw-html-thin');
  assert.deepEqual(
    thin.map(({ pattern, severity }) => ({ pattern, severity })),
    [
      { pattern: '/', severity: 'high' },
      { pattern: '/blog/*', severity: 'medium' },
    ],
  );
});

test('llms.txt: absence is informational unless the config expects the file', () => {
  const site = makeSite({ llmsTxt: { status: 200, error: null, looksLikeHtml: true, firstLine: '<!doctype html>', links: [] } });
  const optional = audit({ site }).findings.find((item) => item.rule === 'llm.llms-txt-missing');
  assert.equal(optional.severity, 'info');
  assert.equal(optional.evidence.servedHtmlInstead, true);
  const expected = audit({ site, config: { llmsTxt: 'expected' } }).findings.find(
    (item) => item.rule === 'llm.llms-txt-missing',
  );
  assert.equal(expected.severity, 'medium');
});

test('ignore entries move a finding to the suppressed list until they expire', () => {
  const pages = [makePage('/'), makePage('/blog/a', {}, { h1: [] })];
  const ignore = [{ rule: 'onpage.h1-missing', url: '/blog/*', reason: 'template has a visual heading', until: '2026-02-01' }];
  const active = audit({ pages, config: { ignore } });
  assert.deepEqual(rules(active), []);
  assert.equal(active.suppressed[0].ignoredBecause, 'template has a visual heading');

  const later = audit({ pages, site: makeSite({ collectedAt: '2026-03-01T00:00:00.000Z' }), config: { ignore } });
  assert.deepEqual(rules(later), ['onpage.h1-missing']);
});

test('config validation names every problem', () => {
  assert.throws(
    () => resolveConfig({ site: 'example.com', aiCrawlers: { search: 'maybe' }, keyPages: ['pricing'] }),
    (error) =>
      error.message.includes('"site" must be') &&
      error.message.includes('"aiCrawlers.search"') &&
      error.message.includes('"keyPages" entries'),
  );
});
