import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { samplePages } from '../scripts/collect/browser.mjs';
import { medianRun, readCruxRecord, summarizeLighthouse } from '../scripts/collect/performance.mjs';
import { comparisonPeriods, mergePeriods } from '../scripts/collect/search-console.mjs';
import { compareRuns, sourceOf } from '../scripts/evaluate/history.mjs';
import { evaluate } from '../scripts/evaluate/index.mjs';
import { missingProperties } from '../scripts/evaluate/rules-data.mjs';
import { resolveConfig } from '../scripts/lib/config.mjs';

const ORIGIN = 'https://example.com';
const richResults = JSON.parse(
  await readFile(new URL('../rules/rich-results.json', import.meta.url), 'utf8'),
);
const specsByType = new Map(richResults.types.flatMap((spec) => spec.types.map((type) => [type, spec])));

const site = {
  origin: ORIGIN,
  host: 'example.com',
  collectedAt: '2026-01-15T00:00:00.000Z',
  home: { url: `${ORIGIN}/`, finalUrl: `${ORIGIN}/`, status: 200, hops: [], headers: { 'strict-transport-security': 'x' }, error: null },
  variants: ['http://example.com/', 'https://www.example.com/', 'http://www.example.com/'].map((url) => ({
    url,
    finalUrl: `${ORIGIN}/`,
    status: 200,
    hops: [{ url, status: 301 }],
    headers: {},
    error: null,
  })),
  tls: { validTo: '2026-12-01T00:00:00.000Z', authorized: true, error: null },
  robots: { status: 200, error: null, looksLikeHtml: false, text: `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n` },
  sitemaps: { declaredInRobots: true, files: [{ url: `${ORIGIN}/sitemap.xml`, status: 200, type: 'urlset', count: 1 }], urls: [] },
  missingPageProbe: { url: `${ORIGIN}/x`, status: 404, finalUrl: `${ORIGIN}/x` },
  llmsTxt: { status: 200, looksLikeHtml: false, firstLine: '# Example', links: [] },
  botProbes: [],
};

function rawPage(path, html = {}, overrides = {}) {
  const url = `${ORIGIN}${path}`;
  return {
    url,
    finalUrl: url,
    status: 200,
    error: null,
    hops: [],
    xRobotsTag: null,
    bytes: 1000,
    inSitemap: true,
    asset: false,
    depth: 1,
    inlinkCount: 1,
    inlinkSamples: [`${ORIGIN}/`],
    internalLinkCount: 20,
    externalLinkCount: 5,
    html: {
      lang: 'en',
      title: `Unique title for ${path}`,
      description: `A description of ${path} that is long enough to pass the length check.`,
      robotsMeta: [],
      canonical: [url],
      viewport: 'width=device-width',
      h1: ['Heading'],
      og: { title: 't', description: 'd', image: 'i' },
      hreflang: [],
      images: { total: 0, missingAlt: 0, missingAltSamples: [] },
      anchorsWithoutHref: 0,
      jsonld: [],
      wordCount: 600,
      ...html,
    },
    ...overrides,
  };
}

function renderedPage(path, rendered = {}, overrides = {}) {
  const url = `${ORIGIN}${path}`;
  return {
    url,
    status: 200,
    finalUrl: url,
    error: null,
    settled: true,
    loadMs: 900,
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    selectorFound: null,
    axe: [],
    rendered: {
      title: `Unique title for ${path}`,
      description: 'A description.',
      canonical: [url],
      robotsMeta: [],
      h1: ['Heading'],
      lang: 'en',
      wordCount: 500,
      linkCount: 25,
      jsonldCount: 0,
      ...rendered,
    },
    ...overrides,
  };
}

function audit({ pages = [rawPage('/')], browser, performance, search, config = {} } = {}) {
  return evaluate({
    site,
    pages,
    skipped: { byRobots: [], byFilters: 0, byLimit: 0 },
    config: resolveConfig({ site: ORIGIN, ...config }),
    bots: [],
    browser,
    performance,
    search,
    richResults,
  }).findings;
}
const rules = (findings) => findings.map((finding) => finding.rule);
const browserRun = (pages) => ({ ran: true, reason: null, pages });

test('samplePages: key pages first, then templates in turn, in a stable order', () => {
  const pages = ['/', '/pricing', '/blog/a', '/blog/b', '/blog/c', '/docs/x', '/docs/y', '/blog/a?ref=1'].map((path) =>
    rawPage(path),
  );
  pages.push(rawPage('/gone', {}, { html: null }));
  const picked = samplePages(pages, new Set([`${ORIGIN}/`]), { maxPages: 10, perTemplate: 2 });
  assert.deepEqual(
    picked.map((url) => url.replace(ORIGIN, '')),
    ['/', '/blog/a', '/docs/x', '/pricing', '/blog/b', '/docs/y'],
  );
  assert.equal(samplePages(pages, new Set(), { maxPages: 2, perTemplate: 2 }).length, 2);
});

test('structured data: required properties per Google feature', () => {
  const check = (node) => missingProperties(node, specsByType.get(node['@type']), specsByType);

  assert.deepEqual(check({ '@type': 'BreadcrumbList', itemListElement: [{ position: 1, name: 'Home' }] }), [
    'itemListElement (needs at least 2 items)',
  ]);
  assert.deepEqual(
    check({
      '@type': 'BreadcrumbList',
      itemListElement: [{ position: 1, item: { name: 'Home' } }, { name: 'Blog' }],
    }),
    ['itemListElement.position'],
  );
  assert.deepEqual(check({ '@type': 'SoftwareApplication', name: 'App', offers: { priceCurrency: 'USD' } }), [
    'offers.price',
    'aggregateRating | review',
  ]);
  // A free app has price 0, and 0 is a value.
  assert.deepEqual(
    check({
      '@type': 'SoftwareApplication',
      name: 'App',
      offers: { price: 0 },
      aggregateRating: { ratingValue: 4.8 },
    }),
    ['aggregateRating.ratingCount | reviewCount'],
  );
  assert.deepEqual(
    check({ '@type': 'Product', name: 'Thing', offers: [{ price: '9.99' }, { priceSpecification: { price: 5 } }] }),
    [],
  );
});

test('structured data findings name the type and what is missing', () => {
  const jsonld = [
    {
      valid: true,
      types: ['SoftwareApplication', 'FAQPage', 'Organization'],
      nodes: [{ '@type': 'SoftwareApplication', name: 'App' }, { '@type': 'FAQPage' }, { '@type': 'Organization' }],
    },
  ];
  const findings = audit({ pages: [rawPage('/', { jsonld }), rawPage('/app', { jsonld }), rawPage('/plain')] });
  const missing = findings.find((finding) => finding.rule === 'schema.missing-required');
  assert.equal(missing.id, 'schema.missing-required|SoftwareApplication');
  assert.equal(missing.count, 2, 'one finding for the type, counting the pages that carry it');
  assert.deepEqual(missing.evidence.missing, ['offers.price', 'aggregateRating | review']);
  const retired = findings.find((finding) => finding.rule === 'schema.no-rich-result');
  assert.equal(retired.id, 'schema.no-rich-result|FAQPage');
  assert.equal(retired.severity, 'info');
});

test('rendering: a clean page produces nothing; no browser run produces nothing', () => {
  assert.deepEqual(audit({ browser: browserRun([renderedPage('/')]) }), []);
  assert.deepEqual(audit({ browser: { ran: false, reason: 'no Chrome', pages: [] } }), []);
});

test('rendering: failures, blank pages and broken requests', () => {
  const pages = [rawPage('/'), rawPage('/a'), rawPage('/b'), rawPage('/c')];
  const browser = browserRun([
    renderedPage('/', {}, { status: null, rendered: null, error: 'net::ERR_CONNECTION_RESET' }),
    renderedPage('/a', { wordCount: 3 }, { pageErrors: ['TypeError: x is undefined'] }),
    renderedPage(
      '/b',
      {},
      {
        failedRequests: [
          { url: 'https://api.other.test/banner', type: 'fetch', reason: 'HTTP 422' },
          { url: 'https://tracker.other.test/pixel.gif', type: 'image', reason: 'HTTP 404' },
          { url: `${ORIGIN}/img/hero.png`, type: 'image', reason: 'HTTP 404' },
        ],
      },
    ),
    renderedPage(
      '/c',
      {},
      { settled: false, failedRequests: [{ url: 'https://api.other.test/banner?x=2', type: 'fetch', reason: 'HTTP 422' }] },
    ),
  ]);
  const findings = audit({ pages, browser });
  const banner = findings.find((finding) => finding.id === 'render.request-failed|https://api.other.test/banner');
  assert.equal(banner.count, 2, 'one endpoint failing on two pages is one finding');
  const byRule = Object.fromEntries(findings.map((finding) => [finding.rule, finding]));

  assert.equal(byRule['render.load-failed'].severity, 'critical', 'the home page is a key page');
  assert.equal(byRule['render.blank-page'].evidence[0].words, 3);
  assert.ok(byRule['render.js-error']);
  assert.deepEqual(
    findings.filter((finding) => finding.rule === 'render.request-failed').map((finding) => finding.evidence.request),
    ['https://api.other.test/banner', `${ORIGIN}/img/hero.png`],
    "a third-party image is not the site's problem; a failed API call and an own image are",
  );
  assert.equal(byRule['render.never-idle'].severity, 'info');
});

test('rendering: differences between the HTML and the DOM after JavaScript', () => {
  const pages = [
    rawPage('/'),
    rawPage('/changed', { title: 'Server title', canonical: [`${ORIGIN}/changed`] }),
    rawPage('/added', { title: null, description: null, canonical: [] }),
    rawPage('/spa', { wordCount: 40 }, { internalLinkCount: 2, externalLinkCount: 0 }),
  ];
  const browser = browserRun([
    renderedPage('/'),
    renderedPage('/changed', { title: 'Client title', canonical: [`${ORIGIN}/other`], robotsMeta: ['noindex'] }),
    renderedPage('/added', { title: 'Late title', description: 'Late', canonical: [`${ORIGIN}/added`] }),
    renderedPage('/spa', { title: 'Unique title for /spa', wordCount: 800, linkCount: 40 }),
  ]);
  const findings = audit({ pages, browser }).filter((finding) => finding.group === 'render');
  const byRule = Object.fromEntries(findings.map((finding) => [finding.rule, finding]));

  assert.deepEqual(
    byRule['render.head-changed-by-js'].evidence[0].changes.map((change) => change.field),
    ['title', 'canonical', 'robots'],
  );
  assert.deepEqual(byRule['render.head-added-by-js'].evidence[0].onlyAfterJs, ['title', 'canonical', 'description']);
  assert.deepEqual(byRule['render.content-needs-js'].evidence[0], {
    url: `${ORIGIN}/spa`,
    htmlWords: 40,
    renderedWords: 800,
  });
  assert.ok(byRule['render.links-need-js']);
});

test('accessibility: one finding per axe rule across pages, worst impact wins', () => {
  const contrast = (impact, nodes) => ({
    id: 'color-contrast',
    impact,
    help: 'Elements must meet minimum color contrast ratio thresholds',
    helpUrl: 'https://example.test/color-contrast',
    nodes,
    samples: [{ target: '.cta', html: '<a class="cta">Go</a>' }],
  });
  const browser = browserRun([
    renderedPage('/', {}, { axe: [contrast('moderate', 2)] }),
    renderedPage('/a', {}, { axe: [contrast('serious', 3)] }),
    renderedPage('/b'),
  ]);
  const findings = audit({ pages: [rawPage('/'), rawPage('/a'), rawPage('/b')], browser });
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.id, 'a11y.violation|color-contrast');
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.summary, 'Elements must meet minimum color contrast ratio thresholds');
  assert.deepEqual(
    { pagesAffected: finding.evidence.pagesAffected, pagesChecked: finding.evidence.pagesChecked, elements: finding.evidence.elements },
    { pagesAffected: 2, pagesChecked: 3, elements: 5 },
  );
});

test('lighthouse: summary and median run', () => {
  const lhr = {
    categories: {
      performance: {
        score: 0.62,
        auditRefs: [
          { id: 'largest-contentful-paint', group: 'metrics' },
          { id: 'unused-javascript', group: 'diagnostics' },
          { id: 'layout-shifts', group: 'insights' },
          { id: 'passing-audit', group: 'diagnostics' },
        ],
      },
    },
    audits: {
      'first-contentful-paint': { numericValue: 1200 },
      'largest-contentful-paint': { numericValue: 4100, score: 0.4 },
      'total-blocking-time': { numericValue: 350 },
      'cumulative-layout-shift': { numericValue: 0.02 },
      'speed-index': { numericValue: 3000 },
      'total-byte-weight': { numericValue: 1_500_000 },
      'unused-javascript': { id: 'unused-javascript', title: 'Reduce unused JavaScript', score: 0.5, displayValue: '300 KiB', metricSavings: { LCP: 450, FCP: 100 } },
      'layout-shifts': { id: 'layout-shifts', title: 'Layout shift culprits', score: 0.6, metricSavings: { CLS: 0.08 } },
      'passing-audit': { id: 'passing-audit', title: 'Fine', score: 1 },
    },
  };
  const summary = summarizeLighthouse(lhr);
  assert.equal(summary.score, 0.62);
  assert.equal(summary.metrics.lcpMs, 4100);
  assert.deepEqual(
    summary.opportunities.map(({ id, savingsMs }) => ({ id, savingsMs })),
    [
      { id: 'unused-javascript', savingsMs: 450 },
      { id: 'layout-shifts', savingsMs: 0 },
    ],
  );
  assert.equal(medianRun([{ score: 0.9 }, { score: 0.4 }, { score: 0.6 }]).score, 0.6);
});

test('performance: lab and field numbers are graded against the Core Web Vitals limits', () => {
  const lab = {
    ran: true,
    pages: [
      { url: `${ORIGIN}/`, error: null, score: 0.45, scores: [0.4, 0.45, 0.5], metrics: { lcpMs: 4500, tbtMs: 300, cls: 0.02 }, totalBytes: 2e6, opportunities: [] },
      { url: `${ORIGIN}/fast`, error: null, score: 0.97, scores: [0.97], metrics: { lcpMs: 1500, tbtMs: 50, cls: 0 }, totalBytes: 3e5, opportunities: [] },
      { url: `${ORIGIN}/broken`, error: 'PROTOCOL_TIMEOUT', runs: 0 },
    ],
  };
  const field = {
    ran: true,
    origin: { origin: ORIGIN, period: null, lcpMs: 2900, inpMs: 180, cls: 0.31, ttfbMs: 900 },
    pages: [{ url: `${ORIGIN}/`, lcpMs: 4200, inpMs: 150, cls: 0.05 }, { url: `${ORIGIN}/quiet`, noData: true }],
    history: { lcpMs: [2700, 2800, 2900] },
  };
  const findings = audit({ performance: { lab, field } });
  const severity = Object.fromEntries(findings.map((finding) => [finding.id, finding.severity]));
  assert.deepEqual(severity, {
    'perf.lab-score|/': 'high',
    'perf.lab-lcp|/': 'high',
    'perf.lab-tbt|/': 'medium',
    'perf.lab-failed|/broken': 'info',
    'perf.field-lcp|origin': 'medium',
    'perf.field-cls|origin': 'high',
    'perf.field-lcp|/': 'high',
    'perf.field-ttfb|site': 'low',
  });
  const originLcp = findings.find((finding) => finding.id === 'perf.field-lcp|origin');
  assert.deepEqual(originLcp.evidence.weeklyHistory, [2700, 2800, 2900]);
});

test('crux: p75 values are read as numbers and missing metrics stay null', () => {
  const values = readCruxRecord({
    record: {
      metrics: {
        largest_contentful_paint: { percentiles: { p75: 2345 } },
        cumulative_layout_shift: { percentiles: { p75: '0.07' } },
      },
    },
  });
  assert.deepEqual(values, { lcpMs: 2345, inpMs: null, cls: 0.07, ttfbMs: null, fcpMs: null });
});

test('search console: periods, merging and rules', () => {
  assert.deepEqual(comparisonPeriods('2026-01-15T00:00:00.000Z'), {
    current: { startDate: '2026-01-06', endDate: '2026-01-12' },
    previous: { startDate: '2025-12-30', endDate: '2026-01-05' },
  });

  const pages = mergePeriods(
    [
      { keys: [`${ORIGIN}/`], clicks: 40, impressions: 1000, position: 3.2 },
      { keys: [`${ORIGIN}/blog/a`], clicks: 5, impressions: 600, position: 8 },
    ],
    [
      { keys: [`${ORIGIN}/`], clicks: 100, impressions: 1500 },
      { keys: [`${ORIGIN}/blog/a`], clicks: 30, impressions: 700 },
      { keys: [`${ORIGIN}/blog/gone`], clicks: 25, impressions: 300 },
    ],
  );
  assert.equal(pages.find((page) => page.url.endsWith('/blog/gone')).clicks, 0);

  const search = {
    ran: true,
    periods: {},
    totals: { clicks: 45, impressions: 1600, previousClicks: 155, previousImpressions: 2500 },
    pages,
    inspections: [
      { url: `${ORIGIN}/`, verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', googleCanonical: `${ORIGIN}/home`, userCanonical: `${ORIGIN}/` },
    ],
    sitemaps: [{ path: `${ORIGIN}/sitemap.xml`, errors: 2, warnings: 0 }],
  };
  const findings = audit({ pages: [rawPage('/'), rawPage('/blog/a', { h1: [] })], search });
  const byId = Object.fromEntries(findings.map((finding) => [finding.id, finding]));

  assert.equal(byId['search.clicks-drop|site'].evidence.changePercent, -71);
  assert.equal(byId['search.page-clicks-drop|/'].severity, 'high');
  assert.equal(byId['search.page-clicks-drop|/blog/*'].count, 2);
  assert.equal(byId['search.not-indexed|/'].severity, 'critical');
  assert.ok(byId['search.google-canonical-differs|/']);
  assert.ok(byId['search.sitemap-errors|site']);
  // With Search Console data, a page finding carries the traffic of the pages it affects.
  assert.deepEqual(byId['onpage.h1-missing|/blog/*'].impact, {
    impressions: 600,
    clicks: 5,
    shareOfImpressions: 0.375,
  });
});

test('history: new, regressed, persisting, fixed and not rechecked', () => {
  const finding = (id, severity, count) => ({ id, rule: id.split('|')[0], severity, count, summary: '', pattern: null });
  const previous = {
    collectedAt: '2026-01-08T00:00:00.000Z',
    findings: [
      { ...finding('onpage.h1-missing|/blog/*', 'medium', 10), firstSeen: '2026-01-01T00:00:00.000Z' },
      { ...finding('onpage.title-missing|/', 'high', 1), firstSeen: '2026-01-08T00:00:00.000Z' },
      { ...finding('index.noindex|/a', 'high', 1), firstSeen: '2026-01-08T00:00:00.000Z' },
      { ...finding('render.js-error|/', 'medium', 1), firstSeen: '2026-01-08T00:00:00.000Z' },
      { ...finding('perf.lab-lcp|/', 'medium', 1), firstSeen: '2026-01-08T00:00:00.000Z' },
    ],
  };
  const current = [
    finding('onpage.h1-missing|/blog/*', 'medium', 13),
    finding('onpage.title-missing|/', 'high', 1),
    finding('perf.lab-lcp|/', 'high', 1),
    finding('llm.raw-html-thin|/', 'high', 1),
  ];
  const collectors = { http: { ran: true }, browser: { ran: false }, lab: { ran: true } };
  const result = compareRuns(previous, current, collectors, '2026-01-15T00:00:00.000Z');

  assert.deepEqual(
    Object.fromEntries(result.findings.map((item) => [item.id, item.status])),
    {
      'onpage.h1-missing|/blog/*': 'regressed', // 10 -> 13 pages
      'onpage.title-missing|/': 'persisting',
      'perf.lab-lcp|/': 'regressed', // medium -> high
      'llm.raw-html-thin|/': 'new',
    },
  );
  assert.equal(result.findings[0].firstSeen, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(result.fixed.map((item) => item.id), ['index.noindex|/a']);
  assert.deepEqual(
    result.notRechecked.map((item) => item.id),
    ['render.js-error|/'],
    'the browser did not run, so a missing render finding proves nothing',
  );
  assert.deepEqual(result.summary, { new: 1, regressed: 2, persisting: 1, fixed: 1, notRechecked: 1 });

  assert.equal(compareRuns(null, current, collectors, 'now').firstRun, true);
  assert.equal(sourceOf('a11y.violation'), 'browser');
  assert.equal(sourceOf('perf.field-inp'), 'field');
  assert.equal(sourceOf('schema.missing-required'), 'http');
});
