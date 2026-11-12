import { urlPattern } from '../lib/util.mjs';
import { RULES, SEVERITIES } from './catalog.mjs';

const groupOf = (rule) => rule.split('.')[0];
const worst = (severities) =>
  severities.filter(Boolean).sort((a, b) => SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b))[0];

/** A finding about the site as a whole. */
export function siteFinding(rule, evidence, overrides = {}) {
  const { severity, summary } = RULES[rule];
  return {
    id: `${rule}|site`,
    rule,
    group: groupOf(rule),
    severity,
    summary,
    scope: 'site',
    pattern: null,
    count: 1,
    urls: [],
    evidence,
    ...overrides,
  };
}

/**
 * Findings about pages, one per URL template, so a problem on a hundred similar pages is one
 * finding with a count. `matches` is `[{ url, evidence?, severity? }]`.
 *
 * Severity is the worst one a match carries; without those, `keySeverity` when a key page is
 * among the matches; otherwise the rule's default. `weigh` turns the matched URLs into search
 * traffic numbers when Search Console data is available.
 */
export function pageFindings(rule, matches, { isKey, keySeverity, weigh } = {}) {
  const { severity, summary } = RULES[rule];
  const byPattern = new Map();
  for (const match of matches) {
    const pattern = urlPattern(match.url);
    if (!byPattern.has(pattern)) byPattern.set(pattern, []);
    byPattern.get(pattern).push(match);
  }
  return [...byPattern].map(([pattern, items]) => {
    const onKeyPage = keySeverity && isKey && items.some((item) => isKey(item.url));
    const finding = {
      id: `${rule}|${pattern}`,
      rule,
      group: groupOf(rule),
      severity: worst(items.map((item) => item.severity)) ?? (onKeyPage ? keySeverity : severity),
      summary,
      scope: 'page',
      pattern,
      count: items.length,
      urls: items.slice(0, 10).map((item) => item.url),
      evidence: items
        .filter((item) => item.evidence !== undefined)
        .slice(0, 5)
        .map((item) => ({ url: item.url, ...item.evidence })),
    };
    const impact = weigh?.(items.map((item) => item.url));
    if (impact) finding.impact = impact;
    return finding;
  });
}
