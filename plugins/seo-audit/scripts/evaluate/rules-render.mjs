import { normalizeUrl } from '../lib/util.mjs';
import { RULES, SEVERITIES } from './catalog.mjs';
import { pageFindings, siteFinding } from './finding.mjs';
import { hasNoindex } from './rules-pages.mjs';

// Requests a page cannot work without, whoever serves them.
const DEPENDENCY_TYPES = new Set(['document', 'script', 'stylesheet', 'xhr', 'fetch']);
const NOISE_TYPES = new Set(['ping', 'other', 'media']);
const AXE_IMPACT = { critical: 'high', serious: 'medium', moderate: 'low', minor: 'info' };

const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim();

/** Rules from loading the sampled pages in a browser, compared with their raw HTML. */
export function renderRules({ site, pages, browser, config, isKey, weigh }) {
  if (!browser?.ran) return [];
  const findings = [];
  const add = (rule, matches, options) =>
    findings.push(...pageFindings(rule, matches, { isKey, weigh, ...options }));

  const rawByUrl = new Map(pages.map((page) => [page.url, page]));
  const baseHost = site.host.replace(/^www\./, '');
  const sameSite = (url) => {
    try {
      const { hostname } = new URL(url);
      return hostname === baseHost || hostname.endsWith(`.${baseHost}`);
    } catch {
      return false;
    }
  };

  const failed = browser.pages.filter((page) => page.error || (page.status !== null && page.status >= 400));
  add(
    'render.load-failed',
    failed.map((page) => ({ url: page.url, evidence: { error: page.error, status: page.status } })),
    { keySeverity: 'critical' },
  );

  const loaded = browser.pages.filter((page) => page.rendered && !failed.includes(page));
  add(
    'render.blank-page',
    loaded
      .filter((page) => page.rendered.wordCount < config.thresholds.renderedWordsMin)
      .map((page) => ({
        url: page.url,
        evidence: { words: page.rendered.wordCount, errors: page.pageErrors.slice(0, 2) },
      })),
    { keySeverity: 'critical' },
  );
  add(
    'render.selector-missing',
    loaded
      .filter((page) => page.selectorFound === false)
      .map((page) => ({ url: page.url, evidence: { selector: config.browser.expectSelector } })),
  );
  add(
    'render.js-error',
    loaded
      .filter((page) => page.pageErrors.length > 0)
      .map((page) => ({
        url: page.url,
        evidence: { errors: page.pageErrors.slice(0, 3), count: page.pageErrors.length },
      })),
  );
  // One finding per failing request, not per page: a broken endpoint is one cause however many
  // pages call it.
  const failingRequests = new Map();
  for (const page of loaded) {
    for (const request of page.failedRequests) {
      const relevant = sameSite(request.url) ? !NOISE_TYPES.has(request.type) : DEPENDENCY_TYPES.has(request.type);
      if (!relevant) continue;
      const target = request.url.split('?')[0];
      const key = `${target} ${request.reason}`;
      if (!failingRequests.has(key)) {
        failingRequests.set(key, { request: target, reason: request.reason, type: request.type, pages: new Set() });
      }
      failingRequests.get(key).pages.add(page.url);
    }
  }
  for (const { pages: affected, ...request } of failingRequests.values()) {
    const urls = [...affected];
    const finding = siteFinding(
      'render.request-failed',
      { ...request, pagesAffected: urls.length, pagesChecked: loaded.length },
      { id: `render.request-failed|${request.request}`, count: urls.length, urls: urls.slice(0, 10) },
    );
    const impact = weigh?.(urls);
    if (impact) finding.impact = impact;
    findings.push(finding);
  }
  add('render.never-idle', loaded.filter((page) => !page.settled).map((page) => ({ url: page.url })));

  // What the HTML says against what the DOM says once scripts have run.
  const changed = [];
  const added = [];
  const contentNeedsJs = [];
  const linksNeedJs = [];
  for (const page of loaded) {
    const record = rawByUrl.get(page.url);
    if (!record?.html) continue;
    const html = record.html;
    const dom = page.rendered;
    const canonicals = (hrefs) =>
      [...new Set(hrefs.map((href) => normalizeUrl(href ?? '', page.url)).filter(Boolean))].sort();

    const changes = [];
    const additions = [];
    const [htmlTitle, domTitle] = [clean(html.title), clean(dom.title)];
    if (htmlTitle && domTitle && htmlTitle !== domTitle) {
      changes.push({ field: 'title', html: htmlTitle, rendered: domTitle });
    } else if (!htmlTitle && domTitle) {
      additions.push('title');
    }
    const [htmlCanonical, domCanonical] = [canonicals(html.canonical), canonicals(dom.canonical)];
    if (htmlCanonical.length > 0 && htmlCanonical.join() !== domCanonical.join()) {
      changes.push({ field: 'canonical', html: htmlCanonical, rendered: domCanonical });
    } else if (htmlCanonical.length === 0 && domCanonical.length > 0) {
      additions.push('canonical');
    }
    const htmlNoindex = hasNoindex(html.robotsMeta.map((meta) => meta.content));
    const domNoindex = hasNoindex(dom.robotsMeta);
    if (htmlNoindex !== domNoindex) {
      changes.push({
        field: 'robots',
        html: htmlNoindex ? 'noindex' : 'index',
        rendered: domNoindex ? 'noindex' : 'index',
      });
    }
    if (!html.description && dom.description) additions.push('description');

    if (changes.length > 0) changed.push({ url: page.url, evidence: { changes } });
    if (additions.length > 0) added.push({ url: page.url, evidence: { onlyAfterJs: additions } });

    // Raw word counts include hidden text and rendered ones do not, so this errs toward silence.
    if (html.wordCount < dom.wordCount * 0.5 && dom.wordCount - html.wordCount >= 150) {
      contentNeedsJs.push({
        url: page.url,
        evidence: { htmlWords: html.wordCount, renderedWords: dom.wordCount },
      });
    }
    const htmlLinks = record.internalLinkCount + record.externalLinkCount;
    if (dom.linkCount >= 10 && htmlLinks < dom.linkCount * 0.5) {
      linksNeedJs.push({ url: page.url, evidence: { htmlLinks, renderedLinks: dom.linkCount } });
    }
  }
  add('render.head-changed-by-js', changed);
  add('render.head-added-by-js', added);
  add('render.content-needs-js', contentNeedsJs, { keySeverity: 'high' });
  add('render.links-need-js', linksNeedJs);

  return findings;
}

/** One finding per axe-core rule, across every sampled page it fails on. */
export function a11yRules({ browser }) {
  if (!browser?.ran) return [];
  const checked = browser.pages.filter((page) => page.axe);
  const byRule = new Map();
  for (const page of checked) {
    for (const violation of page.axe) {
      if (!byRule.has(violation.id)) {
        byRule.set(violation.id, { ...violation, severity: null, urls: [], elements: 0, samples: [] });
      }
      const entry = byRule.get(violation.id);
      const severity = AXE_IMPACT[violation.impact] ?? RULES['a11y.violation'].severity;
      if (!entry.severity || SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(entry.severity)) {
        entry.severity = severity;
      }
      entry.urls.push(page.url);
      entry.elements += violation.nodes;
      if (entry.samples.length < 3 && violation.samples[0]) {
        entry.samples.push({ url: page.url, ...violation.samples[0] });
      }
    }
  }
  return [...byRule.values()].map((entry) =>
    siteFinding(
      'a11y.violation',
      {
        axeRule: entry.id,
        helpUrl: entry.helpUrl,
        pagesAffected: entry.urls.length,
        pagesChecked: checked.length,
        elements: entry.elements,
        samples: entry.samples,
      },
      {
        id: `a11y.violation|${entry.id}`,
        severity: entry.severity,
        summary: entry.help,
        count: entry.urls.length,
        urls: entry.urls.slice(0, 10),
      },
    ),
  );
}
