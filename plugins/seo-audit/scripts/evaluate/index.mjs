import { parseRobots } from '../lib/robots.mjs';
import { globToRegExp, normalizeUrl, pathOf } from '../lib/util.mjs';
import { SEVERITIES } from './catalog.mjs';
import { performanceRules, schemaRules, searchRules } from './rules-data.mjs';
import { pageRules } from './rules-pages.mjs';
import { a11yRules, renderRules } from './rules-render.mjs';
import { siteRules } from './rules-site.mjs';

const NO_RICH_RESULT_RULES = { types: [], withoutRichResult: {} };

function ignoredBy(finding, config, now) {
  return config.ignore.find((entry) => {
    if (entry.rule !== finding.rule) return false;
    if (entry.until && new Date(entry.until) < now) return false;
    if (!entry.url) return true;
    const matcher = globToRegExp(entry.url);
    return matcher.test(finding.pattern ?? '') || finding.urls.some((url) => matcher.test(pathOf(url)));
  });
}

/** Search traffic of a set of URLs, when Search Console data is there to weigh a finding with. */
function buildWeigh(search) {
  if (!search?.ran) return undefined;
  const byUrl = new Map(search.pages.map((page) => [page.url, page]));
  const total = search.totals.impressions;
  return (urls) => {
    let impressions = 0;
    let clicks = 0;
    for (const url of urls) {
      impressions += byUrl.get(url)?.impressions ?? 0;
      clicks += byUrl.get(url)?.clicks ?? 0;
    }
    return { impressions, clicks, shareOfImpressions: total > 0 ? Math.round((impressions / total) * 1000) / 1000 : 0 };
  };
}

/**
 * Turn collected facts into findings. Pure: the same input always gives the same output,
 * which is what lets two runs be compared. Collectors that did not run contribute nothing.
 */
export function evaluate({ site, pages, skipped, config, bots, browser, performance, search, richResults }) {
  const usableRobots = site.robots.status === 200 && !site.robots.looksLikeHtml;
  const keyUrls = new Set(config.keyPages.map((path) => normalizeUrl(path, config.origin)));
  const context = {
    site,
    pages,
    skipped,
    config,
    bots,
    browser,
    performance,
    search,
    richResults: richResults ?? NO_RICH_RESULT_RULES,
    robots: parseRobots(usableRobots ? site.robots.text : ''),
    isKey: (url) => keyUrls.has(url),
    weigh: buildWeigh(search),
  };
  const now = new Date(site.collectedAt);

  const findings = [];
  const suppressed = [];
  const all = [
    ...siteRules(context),
    ...pageRules(context),
    ...schemaRules(context),
    ...renderRules(context),
    ...a11yRules(context),
    ...performanceRules(context),
    ...searchRules(context),
  ];
  for (const finding of all) {
    const ignore = ignoredBy(finding, config, now);
    if (ignore) suppressed.push({ ...finding, ignoredBecause: ignore.reason, ignoredUntil: ignore.until ?? null });
    else findings.push(finding);
  }

  const rank = (finding) => SEVERITIES.indexOf(finding.severity);
  findings.sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.id.localeCompare(b.id));
  return { findings, suppressed };
}
