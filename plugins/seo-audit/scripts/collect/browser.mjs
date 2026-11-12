import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { mapLimit, urlPattern } from '../lib/util.mjs';

const require = createRequire(import.meta.url);

// Pages are loaded as a phone would load them: Google indexes the mobile version.
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const VIEWPORT = { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const KEEP = 20;

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/** Chrome refuses its sandbox when run as root, which is the usual case in CI containers. */
export const sandboxFlags = () => (process.getuid?.() === 0 ? ['--no-sandbox'] : []);

/**
 * Pick the pages to open in a browser: every key page, then one page per URL template in turn,
 * until the cap. The order is stable, so two runs sample the same pages.
 */
export function samplePages(pages, keyUrls, { maxPages, perTemplate }) {
  const candidates = pages
    .filter((page) => page.html && !page.url.includes('?'))
    .map((page) => page.url)
    .sort();
  const picked = candidates.filter((url) => keyUrls.has(url));
  const templates = new Map();
  for (const url of candidates) {
    if (keyUrls.has(url)) continue;
    const template = urlPattern(url);
    if (!templates.has(template)) templates.set(template, []);
    templates.get(template).push(url);
  }
  for (let round = 0; round < perTemplate; round++) {
    for (const urls of templates.values()) {
      if (urls[round]) picked.push(urls[round]);
    }
  }
  return picked.slice(0, maxPages);
}

/* Runs inside the page. */
function readRendered() {
  const text = document.body ? document.body.innerText : '';
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
  return {
    title: document.title || null,
    description: attr('meta[name="description"]', 'content'),
    canonical: [...document.querySelectorAll('link[rel~="canonical"]')].map((link) => link.getAttribute('href')),
    robotsMeta: [...document.querySelectorAll('meta[name="robots"], meta[name="googlebot"]')].map((meta) =>
      (meta.getAttribute('content') || '').toLowerCase(),
    ),
    h1: [...document.querySelectorAll('h1')].map((heading) => heading.innerText.trim()).slice(0, 5),
    lang: document.documentElement.getAttribute('lang'),
    wordCount: (text.match(/[\p{L}\p{N}]+/gu) || []).length,
    linkCount: new Set([...document.querySelectorAll('a[href]')].map((anchor) => anchor.href.split('#')[0])).size,
    jsonldCount: document.querySelectorAll('script[type="application/ld+json"]').length,
  };
}

/* Runs inside the page, after axe-core has been injected. */
async function runAxe(tags) {
  const result = await window.axe.run(document, {
    runOnly: { type: 'tag', values: tags },
    resultTypes: ['violations'],
  });
  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.length,
    samples: violation.nodes.slice(0, 3).map((node) => ({
      target: node.target.join(' '),
      html: node.html.slice(0, 200),
    })),
  }));
}

async function renderPage(browser, url, { timeoutMs, expectSelector }, axeSource) {
  const record = {
    url,
    status: null,
    finalUrl: null,
    error: null,
    settled: true,
    loadMs: null,
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    rendered: null,
    selectorFound: null,
    axe: null,
  };
  const keep = (list, item) => list.length < KEEP && list.push(item);
  const page = await browser.newPage();
  try {
    await page.setUserAgent(MOBILE_UA);
    await page.setViewport(VIEWPORT);
    page.on('pageerror', (error) => keep(record.pageErrors, String(error?.message ?? error).slice(0, 300)));
    page.on('console', (message) => {
      if (message.type() === 'error') keep(record.consoleErrors, message.text().slice(0, 300));
    });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'failed';
      // Aborted requests are the page cancelling its own work, not a failure.
      if (reason === 'net::ERR_ABORTED') return;
      keep(record.failedRequests, { url: request.url().slice(0, 300), type: request.resourceType(), reason });
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      keep(record.failedRequests, {
        url: response.url().slice(0, 300),
        type: response.request().resourceType(),
        reason: `HTTP ${response.status()}`,
      });
    });

    const started = Date.now();
    let response = null;
    try {
      response = await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    } catch (error) {
      // A page that keeps a connection open never goes idle; it can still be read.
      if (!/timeout/i.test(error.message)) throw error;
      record.settled = false;
    }
    record.loadMs = Date.now() - started;
    record.status = response?.status() ?? null;
    record.finalUrl = page.url();
    record.rendered = await page.evaluate(readRendered);
    if (expectSelector) record.selectorFound = (await page.$(expectSelector)) !== null;

    await page.evaluate(axeSource);
    record.axe = await page.evaluate(runAxe, WCAG_TAGS);
  } catch (error) {
    record.error = String(error.message).split('\n')[0].slice(0, 200);
  } finally {
    await page.close().catch(() => {});
  }
  return record;
}

/** Open the sampled pages in headless Chrome: what loads, what breaks, what the DOM ends up as. */
export async function collectBrowser(config, urls) {
  const executablePath = findChrome();
  if (!executablePath) {
    return { ran: false, reason: 'Chrome was not found; set CHROME_PATH to its executable', pages: [] };
  }
  const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: sandboxFlags() });
  } catch (error) {
    return { ran: false, reason: `Chrome did not start: ${String(error.message).split('\n')[0]}`, pages: [] };
  }
  try {
    const version = await browser.version();
    const pages = await mapLimit(urls, 2, (url) => renderPage(browser, url, config.browser, axeSource));
    return { ran: true, reason: null, chrome: version, viewport: 'mobile 412x915', pages };
  } finally {
    await browser.close().catch(() => {});
  }
}
