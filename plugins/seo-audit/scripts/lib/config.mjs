import { readFile } from 'node:fs/promises';

export const DEFAULTS = {
  keyPages: ['/'],
  crawl: {
    maxPages: 300,
    concurrency: 4,
    delayMs: 100,
    timeoutMs: 15000,
    userAgent: 'seo-audit/0.1',
    include: [],
    // Cloudflare's own endpoints (email obfuscation and the like) are not pages of the site.
    exclude: ['/cdn-cgi/*'],
    respectRobots: true,
  },
  // Pages opened in headless Chrome: every key page plus `perTemplate` pages of each URL template.
  browser: { enabled: true, maxPages: 40, perTemplate: 2, timeoutMs: 30000, expectSelector: null },
  // Lighthouse runs on the key pages only; the median of `runs` is kept.
  performance: { enabled: true, maxPages: 5, runs: 5 },
  searchConsole: { property: null },
  expect: { noindex: [] },
  aiCrawlers: { training: 'any', search: 'allow', user: 'allow' },
  llmsTxt: 'optional',
  thresholds: {
    titleMin: 10,
    titleMax: 70,
    descriptionMin: 50,
    descriptionMax: 170,
    rawWordsMin: 100,
    renderedWordsMin: 50,
    tlsDaysHigh: 21,
    tlsDaysCritical: 7,
    labScoreMedium: 0.75,
    labScoreHigh: 0.5,
    searchMinClicks: 50,
    searchClicksDrop: 0.25,
    searchPageMinClicks: 20,
    searchPageClicksDrop: 0.5,
  },
  ignore: [],
  output: '.seo-audit',
};

const POLICIES = ['any', 'allow', 'block'];

/** Merge a parsed config object over the defaults and validate it. Throws with a readable message. */
export function resolveConfig(raw) {
  const problems = [];
  let origin = null;
  try {
    const url = new URL(raw.site);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
    origin = url.origin;
  } catch {
    problems.push('"site" must be an absolute http(s) URL, for example "https://example.com"');
  }

  const config = {
    ...DEFAULTS,
    ...raw,
    crawl: { ...DEFAULTS.crawl, ...raw.crawl },
    browser: { ...DEFAULTS.browser, ...raw.browser },
    performance: { ...DEFAULTS.performance, ...raw.performance },
    searchConsole: { ...DEFAULTS.searchConsole, ...raw.searchConsole },
    expect: { ...DEFAULTS.expect, ...raw.expect },
    aiCrawlers: { ...DEFAULTS.aiCrawlers, ...raw.aiCrawlers },
    thresholds: { ...DEFAULTS.thresholds, ...raw.thresholds },
    origin,
  };

  for (const [name, value] of Object.entries(config.aiCrawlers)) {
    if (!POLICIES.includes(value)) {
      problems.push(`"aiCrawlers.${name}" must be one of: ${POLICIES.join(', ')}`);
    }
  }
  if (!['optional', 'expected'].includes(config.llmsTxt)) {
    problems.push('"llmsTxt" must be "optional" or "expected"');
  }
  for (const key of ['keyPages', 'ignore']) {
    if (!Array.isArray(config[key])) problems.push(`"${key}" must be an array`);
  }
  if (Array.isArray(config.keyPages) && config.keyPages.some((path) => !String(path).startsWith('/'))) {
    problems.push('"keyPages" entries must be paths starting with "/"');
  }
  for (const [index, entry] of (Array.isArray(config.ignore) ? config.ignore : []).entries()) {
    if (!entry.rule || !entry.reason) problems.push(`"ignore[${index}]" needs "rule" and "reason"`);
  }

  if (problems.length > 0) throw new Error(`Invalid config:\n- ${problems.join('\n- ')}`);
  return config;
}

export async function loadConfig(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read config ${file}: ${error.message}`);
  }
  return resolveConfig(raw);
}
