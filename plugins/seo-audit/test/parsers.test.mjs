import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPage } from '../scripts/lib/html.mjs';
import { isAllowed, parseRobots } from '../scripts/lib/robots.mjs';
import { parseSitemap } from '../scripts/lib/sitemap.mjs';
import { urlPattern } from '../scripts/lib/util.mjs';

test('robots: a crawler uses its own group and ignores "*"', () => {
  const robots = parseRobots(`
    User-agent: *
    Disallow: /private/

    User-agent: GPTBot
    User-agent: ClaudeBot
    Disallow: /
  `);
  assert.equal(isAllowed(robots, 'Googlebot', '/private/x').allowed, false);
  assert.equal(isAllowed(robots, 'Googlebot', '/public').allowed, true);
  assert.equal(isAllowed(robots, 'GPTBot', '/public').allowed, false);
  assert.equal(isAllowed(robots, 'ClaudeBot', '/public').allowed, false);
  // GPTBot's group has no rule about /private/, and "*" does not apply to it.
  assert.equal(isAllowed(robots, 'GPTBot', '/private/x').agent, 'gptbot');
});

test('robots: longest rule wins, allow wins a tie, * and $ work', () => {
  const robots = parseRobots(`
    User-agent: *
    Disallow: /shop
    Allow: /shop/sale
    Disallow: /*.pdf$
    Disallow: /tie
    Allow: /tie
  `);
  assert.equal(isAllowed(robots, 'x', '/shop/item').allowed, false);
  assert.equal(isAllowed(robots, 'x', '/shop/sale/1').allowed, true);
  assert.equal(isAllowed(robots, 'x', '/files/a.pdf').allowed, false);
  assert.equal(isAllowed(robots, 'x', '/files/a.pdf?download=1').allowed, true);
  assert.equal(isAllowed(robots, 'x', '/tie').allowed, true);
});

test('robots: an empty Disallow allows everything, and sitemaps are collected', () => {
  const robots = parseRobots('User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml # main\n');
  assert.equal(isAllowed(robots, 'x', '/anything').allowed, true);
  assert.deepEqual(robots.sitemaps, ['https://example.com/sitemap.xml']);
});

test('robots: a file with only Allow rules blocks nothing', () => {
  const robots = parseRobots('User-agent: *\nAllow: /swap/\n');
  assert.equal(isAllowed(robots, 'Googlebot', '/').allowed, true);
  assert.equal(isAllowed(robots, 'Googlebot', '/blog/post').allowed, true);
});

test('sitemap: index, urlset and non-sitemap documents', () => {
  const index = parseSitemap(
    '<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap></sitemapindex>',
  );
  assert.equal(index.type, 'index');
  assert.deepEqual(index.entries, [{ loc: 'https://example.com/a.xml', lastmod: null }]);

  const urlset = parseSitemap(`<urlset>
    <url><loc><![CDATA[https://example.com/?a=1&b=2]]></loc><lastmod>2026-01-02</lastmod></url>
    <url><loc>https://example.com/x?a=1&amp;b=2</loc></url>
  </urlset>`);
  assert.equal(urlset.type, 'urlset');
  assert.deepEqual(urlset.entries, [
    { loc: 'https://example.com/?a=1&b=2', lastmod: '2026-01-02' },
    { loc: 'https://example.com/x?a=1&b=2', lastmod: null },
  ]);

  assert.equal(parseSitemap('<!doctype html><html><body>Not found</body></html>').type, 'invalid');
});

test('html: head elements, headings, links and images', () => {
  const page = extractPage(
    `<!doctype html><html lang="en"><head>
      <title> Hello   world </title>
      <meta name="description" content="A page.">
      <meta name="robots" content="max-image-preview:large">
      <meta name="viewport" content="width=device-width">
      <meta property="og:title" content="OG title">
      <link rel="canonical" href="/hello">
      <link rel="alternate" hreflang="de" href="/de/hello">
    </head><body>
      <svg><title>Icon title</title><text>ignored words here</text></svg>
      <h1>Main <em>heading</em></h1>
      <p>Three plain words</p>
      <script>var ignored = "these words do not count";</script>
      <style>.ignored { color: red }</style>
      <a href="/a#top">A</a><a href="/a">A again</a><a href="https://other.test/x" rel="nofollow">X</a>
      <a href="mailto:hi@example.com">mail</a><a>no href</a>
      <img src="/1.png"><img src="/2.png" alt=""><img src="/3.png" alt="three">
    </body></html>`,
    'https://example.com/hello',
  );
  assert.equal(page.lang, 'en');
  assert.equal(page.title, 'Hello world');
  assert.equal(page.titleCount, 1, 'the SVG <title> is not a page title');
  assert.equal(page.description, 'A page.');
  assert.deepEqual(page.canonical, ['/hello']);
  assert.deepEqual(page.hreflang, [{ lang: 'de', href: 'https://example.com/de/hello' }]);
  assert.deepEqual(page.h1, ['Main heading']);
  assert.equal(page.og.title, 'OG title');
  assert.deepEqual(
    page.links.map((link) => link.url),
    ['https://example.com/a', 'https://other.test/x'],
  );
  assert.equal(page.links[1].nofollow, true);
  assert.equal(page.anchorsWithoutHref, 1);
  assert.deepEqual(page.images, { total: 3, missingAlt: 1, missingAltSamples: ['/1.png'] });
  // "Main heading" + "Three plain words" + link texts "A", "A again", "X", "mail", "no href"
  assert.equal(page.wordCount, 2 + 3 + 1 + 2 + 1 + 1 + 2);
});

test('html: JSON-LD blocks are parsed and broken ones are reported', () => {
  const page = extractPage(
    `<html><body>
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script>
      <script type="application/ld+json">{"@type": "Article", }</script>
    </body></html>`,
    'https://example.com/',
  );
  assert.equal(page.jsonld[0].valid, true);
  assert.deepEqual(page.jsonld[0].types, ['Organization', 'WebSite', 'Thing']);
  assert.deepEqual(page.jsonld[0].nodes, [{ '@type': 'Organization' }, { '@type': ['WebSite', 'Thing'] }]);
  assert.equal(page.jsonld[1].valid, false);
  assert.equal(page.wordCount, 0, 'JSON-LD is not page text');
});

test('html: a client-rendered shell has no words', () => {
  const page = extractPage(
    '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    'https://example.com/',
  );
  assert.equal(page.wordCount, 0);
  assert.equal(page.title, 'App');
});

test('urlPattern: shallow paths stay exact, deeper ones collapse to their parent', () => {
  assert.equal(urlPattern('https://example.com/'), '/');
  assert.equal(urlPattern('https://example.com/pricing'), '/pricing');
  assert.equal(urlPattern('https://example.com/blog/post-1?x=1'), '/blog/*');
  assert.equal(urlPattern('https://example.com/learn/glossary/term/'), '/learn/glossary/*');
  assert.equal(urlPattern('https://example.com/learn/blog/tag/news/'), '/learn/blog/tag/*');
});
