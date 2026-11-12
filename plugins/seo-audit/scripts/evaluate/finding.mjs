import { urlPattern } from '../lib/util.mjs';
import { RULES } from './catalog.mjs';

const groupOf = (rule) => rule.split('.')[0];

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
 * finding with a count. `matches` is `[{ url, evidence? }]`.
 * `keySeverity` replaces the default severity when a key page is among the matches.
 */
export function pageFindings(rule, matches, { isKey, keySeverity } = {}) {
  const { severity, summary } = RULES[rule];
  const byPattern = new Map();
  for (const match of matches) {
    const pattern = urlPattern(match.url);
    if (!byPattern.has(pattern)) byPattern.set(pattern, []);
    byPattern.get(pattern).push(match);
  }
  return [...byPattern].map(([pattern, items]) => ({
    id: `${rule}|${pattern}`,
    rule,
    group: groupOf(rule),
    severity: keySeverity && isKey && items.some((item) => isKey(item.url)) ? keySeverity : severity,
    summary,
    scope: 'page',
    pattern,
    count: items.length,
    urls: items.slice(0, 10).map((item) => item.url),
    evidence: items
      .filter((item) => item.evidence !== undefined)
      .slice(0, 5)
      .map((item) => ({ url: item.url, ...item.evidence })),
  }));
}
