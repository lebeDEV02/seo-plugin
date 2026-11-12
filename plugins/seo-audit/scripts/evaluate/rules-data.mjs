import { pageFindings, siteFinding } from './finding.mjs';

// Core Web Vitals limits: at or below the first is "good", above the second is "poor".
const LCP_MS = [2500, 4000];
const INP_MS = [200, 500];
const TBT_MS = [200, 600];
const CLS = [0.1, 0.25];
const TTFB_MS = [800, 1800];

const grade = (value, [good, poor]) => {
  if (value === null || value === undefined) return null;
  return value > poor ? 'high' : value > good ? 'medium' : null;
};
const round = (value) => (value === null || value === undefined ? null : Math.round(value));

/** Rules from Lighthouse (lab) and the Chrome UX Report (field). */
export function performanceRules({ performance, config, isKey, weigh }) {
  const findings = [];
  const limits = config.thresholds;
  const add = (rule, matches) => findings.push(...pageFindings(rule, matches, { isKey, weigh }));

  const lab = performance?.lab;
  if (lab?.ran) {
    add(
      'perf.lab-failed',
      lab.pages.filter((page) => page.error).map((page) => ({ url: page.url, evidence: { error: page.error } })),
    );
    const measured = lab.pages.filter((page) => !page.error);
    add(
      'perf.lab-score',
      measured
        .map((page) => ({
          page,
          severity: page.score < limits.labScoreHigh ? 'high' : page.score < limits.labScoreMedium ? 'medium' : null,
        }))
        .filter(({ severity }) => severity)
        .map(({ page, severity }) => ({
          url: page.url,
          severity,
          evidence: {
            score: Math.round(page.score * 100),
            scoresOfAllRuns: page.scores.map((score) => Math.round(score * 100)),
            lcpMs: round(page.metrics.lcpMs),
            tbtMs: round(page.metrics.tbtMs),
            cls: page.metrics.cls,
            totalBytes: round(page.totalBytes),
            opportunities: page.opportunities.slice(0, 5),
          },
        })),
    );
    for (const [rule, metric, range] of [
      ['perf.lab-lcp', 'lcpMs', LCP_MS],
      ['perf.lab-tbt', 'tbtMs', TBT_MS],
      ['perf.lab-cls', 'cls', CLS],
    ]) {
      add(
        rule,
        measured
          .map((page) => ({ page, severity: grade(page.metrics[metric], range) }))
          .filter(({ severity }) => severity)
          .map(({ page, severity }) => ({
            url: page.url,
            severity,
            evidence: {
              [metric]: metric === 'cls' ? page.metrics.cls : round(page.metrics[metric]),
              good: range[0],
              poor: range[1],
            },
          })),
      );
    }
  }

  const field = performance?.field;
  if (field?.ran) {
    const vitals = [
      ['perf.field-lcp', 'lcpMs', LCP_MS],
      ['perf.field-inp', 'inpMs', INP_MS],
      ['perf.field-cls', 'cls', CLS],
    ];
    for (const [rule, metric, range] of vitals) {
      const severity = grade(field.origin?.[metric], range);
      if (severity) {
        findings.push(
          siteFinding(
            rule,
            {
              scope: 'whole origin, phone users, 75th percentile',
              p75: field.origin[metric],
              good: range[0],
              poor: range[1],
              period: field.origin.period,
              weeklyHistory: field.history?.[metric] ?? null,
            },
            { id: `${rule}|origin`, severity },
          ),
        );
      }
      add(
        rule,
        field.pages
          .map((page) => ({ page, severity: grade(page[metric], range) }))
          .filter(({ severity: pageSeverity }) => pageSeverity)
          .map(({ page, severity: pageSeverity }) => ({
            url: page.url,
            severity: pageSeverity,
            evidence: { p75: page[metric], good: range[0], poor: range[1] },
          })),
      );
    }
    const ttfb = field.origin?.ttfbMs;
    if (ttfb !== null && ttfb !== undefined && ttfb > TTFB_MS[0]) {
      findings.push(
        siteFinding(
          'perf.field-ttfb',
          { p75: ttfb, good: TTFB_MS[0], poor: TTFB_MS[1] },
          ttfb > TTFB_MS[1] ? { severity: 'medium' } : {},
        ),
      );
    }
  }
  return findings;
}

/** Rules from Search Console: traffic against the previous week, index status, sitemap errors. */
export function searchRules({ search, config, isKey }) {
  if (!search?.ran) return [];
  const findings = [];
  const limits = config.thresholds;
  const lost = (now, before) => (before > 0 ? (before - now) / before : 0);
  const { totals } = search;

  if (
    totals.previousClicks >= limits.searchMinClicks &&
    lost(totals.clicks, totals.previousClicks) >= limits.searchClicksDrop
  ) {
    findings.push(
      siteFinding('search.clicks-drop', {
        clicks: totals.clicks,
        previousClicks: totals.previousClicks,
        changePercent: -Math.round(lost(totals.clicks, totals.previousClicks) * 100),
        impressions: totals.impressions,
        previousImpressions: totals.previousImpressions,
        periods: search.periods,
      }),
    );
  }
  findings.push(
    ...pageFindings(
      'search.page-clicks-drop',
      search.pages
        .filter(
          (page) =>
            page.previousClicks >= limits.searchPageMinClicks &&
            lost(page.clicks, page.previousClicks) >= limits.searchPageClicksDrop,
        )
        .map((page) => ({
          url: page.url,
          evidence: { clicks: page.clicks, previousClicks: page.previousClicks, position: page.position },
        })),
      { isKey, keySeverity: 'high' },
    ),
    ...pageFindings(
      'search.not-indexed',
      search.inspections
        .filter((inspection) => inspection.verdict && inspection.verdict !== 'PASS')
        .map(({ url, ...state }) => ({ url, evidence: state })),
      { isKey, keySeverity: 'critical' },
    ),
    ...pageFindings(
      'search.google-canonical-differs',
      search.inspections
        .filter(
          (inspection) =>
            inspection.googleCanonical &&
            inspection.userCanonical &&
            inspection.googleCanonical !== inspection.userCanonical,
        )
        .map(({ url, googleCanonical, userCanonical }) => ({ url, evidence: { googleCanonical, userCanonical } })),
    ),
  );
  const broken = search.sitemaps.filter((sitemap) => sitemap.errors > 0);
  if (broken.length > 0) {
    findings.push(siteFinding('search.sitemap-errors', { sitemaps: broken }, { count: broken.length }));
  }
  return findings;
}

function valueAt(node, path) {
  let current = [node];
  for (const key of path.split('.')) {
    current = current
      .flatMap((item) => (Array.isArray(item) ? item : [item]))
      .filter((item) => item && typeof item === 'object')
      .map((item) => item[key])
      .filter((value) => value !== undefined && value !== null && value !== '');
    if (current.length === 0) return [];
  }
  return current.flatMap((item) => (Array.isArray(item) ? item : [item]));
}

/** Paths a JSON-LD node lacks under a spec from rules/rich-results.json. Exported for tests. */
export function missingProperties(node, spec, specsByType) {
  const missing = [];
  for (const path of spec.required ?? []) {
    if (valueAt(node, path).length === 0) missing.push(path);
  }
  for (const group of spec.anyOf ?? []) {
    if (!group.some((path) => valueAt(node, path).length > 0)) missing.push(group.join(' | '));
  }
  for (const [path, minimum] of Object.entries(spec.minItems ?? {})) {
    const count = valueAt(node, path).length;
    if (count > 0 && count < minimum) missing.push(`${path} (needs at least ${minimum} items)`);
  }
  for (const [path, nested] of Object.entries(spec.each ?? {})) {
    const nestedSpec = nested.ref ? specsByType.get(nested.ref) : nested;
    for (const item of valueAt(node, path)) {
      if (!item || typeof item !== 'object') continue;
      for (const lacking of missingProperties(item, nestedSpec, specsByType)) missing.push(`${path}.${lacking}`);
    }
  }
  return [...new Set(missing)];
}

/**
 * Rules that check JSON-LD nodes against the properties Google requires for each rich result.
 * One finding per schema type: the markup comes from a shared template, so the type is the cause.
 */
export function schemaRules({ pages, richResults, weigh }) {
  const specsByType = new Map(richResults.types.flatMap((spec) => spec.types.map((type) => [type, spec])));
  const incomplete = new Map();
  const retired = new Map();
  const note = (map, type, url, extra) => {
    if (!map.has(type)) map.set(type, { ...extra, missing: new Set(), urls: new Set() });
    map.get(type).urls.add(url);
    return map.get(type);
  };

  for (const page of pages) {
    for (const block of page.html?.jsonld ?? []) {
      for (const node of block.nodes ?? []) {
        for (const type of [].concat(node['@type'] ?? [])) {
          if (richResults.withoutRichResult[type]) {
            note(retired, type, page.url, { note: richResults.withoutRichResult[type] });
          }
          const spec = specsByType.get(type);
          const missing = spec ? missingProperties(node, spec, specsByType) : [];
          if (missing.length > 0) {
            const entry = note(incomplete, type, page.url, { feature: spec.feature });
            for (const property of missing) entry.missing.add(property);
          }
        }
      }
    }
  }

  const toFinding = (rule, type, { urls, missing, ...details }) => {
    const affected = [...urls];
    const evidence = { type, ...details, pagesAffected: affected.length };
    if (missing.size > 0) evidence.missing = [...missing];
    const finding = siteFinding(rule, evidence, {
      id: `${rule}|${type}`,
      count: affected.length,
      urls: affected.slice(0, 10),
    });
    const impact = weigh?.(affected);
    if (impact) finding.impact = impact;
    return finding;
  };
  return [
    ...[...incomplete].map(([type, entry]) => toFinding('schema.missing-required', type, entry)),
    ...[...retired].map(([type, entry]) => toFinding('schema.no-rich-result', type, entry)),
  ];
}
