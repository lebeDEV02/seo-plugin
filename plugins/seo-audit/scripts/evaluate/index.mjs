import { parseRobots } from '../lib/robots.mjs';
import { globToRegExp, pathOf } from '../lib/util.mjs';
import { SEVERITIES } from './catalog.mjs';
import { pageRules } from './rules-pages.mjs';
import { siteRules } from './rules-site.mjs';

function ignoredBy(finding, config, now) {
  return config.ignore.find((entry) => {
    if (entry.rule !== finding.rule) return false;
    if (entry.until && new Date(entry.until) < now) return false;
    if (!entry.url) return true;
    const matcher = globToRegExp(entry.url);
    return matcher.test(finding.pattern ?? '') || finding.urls.some((url) => matcher.test(pathOf(url)));
  });
}

/**
 * Turn collected facts into findings. Pure: the same input always gives the same output,
 * which is what lets two runs be compared.
 */
export function evaluate({ site, pages, skipped, config, bots }) {
  const usableRobots = site.robots.status === 200 && !site.robots.looksLikeHtml;
  const robots = parseRobots(usableRobots ? site.robots.text : '');
  const context = { site, pages, skipped, config, bots, robots };
  const now = new Date(site.collectedAt);

  const findings = [];
  const suppressed = [];
  for (const finding of [...siteRules(context), ...pageRules(context)]) {
    const ignore = ignoredBy(finding, config, now);
    if (ignore) suppressed.push({ ...finding, ignoredBecause: ignore.reason, ignoredUntil: ignore.until ?? null });
    else findings.push(finding);
  }

  const rank = (finding) => SEVERITIES.indexOf(finding.severity);
  findings.sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.id.localeCompare(b.id));
  return { findings, suppressed };
}
