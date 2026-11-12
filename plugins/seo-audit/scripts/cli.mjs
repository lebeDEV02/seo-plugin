#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectBrowser, samplePages } from './collect/browser.mjs';
import { collectPages } from './collect/pages.mjs';
import { collectField, collectLab } from './collect/performance.mjs';
import { collectSearchConsole } from './collect/search-console.mjs';
import { collectSite } from './collect/site.mjs';
import { SEVERITIES } from './evaluate/catalog.mjs';
import { buildSnapshot, compareRuns, loadPreviousSnapshot, saveSnapshot } from './evaluate/history.mjs';
import { evaluate } from './evaluate/index.mjs';
import { loadConfig } from './lib/config.mjs';
import { createClient } from './lib/http.mjs';
import { parseRobots } from './lib/robots.mjs';
import { normalizeUrl } from './lib/util.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What each collector covers. A report must say which of these ran and which did not.
const AREAS = {
  http: 'reachability, indexability, on-page elements, structured data, LLM access',
  browser:
    'rendering in a browser and accessibility (axe-core, WCAG 2.1 A and AA; automated checks find only part of accessibility problems), on a sample of pages',
  lab: 'lab performance (Lighthouse, mobile) on the key pages',
  field: 'real-user Core Web Vitals (Chrome UX Report)',
  search: 'Search Console: clicks, index status of key pages, sitemap errors',
};

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
const log = (message) => console.error(message);

async function run({ config: configFile, out, skip }) {
  const config = await loadConfig(configFile);
  const skipped = new Set((skip ?? '').split(',').map((name) => name.trim()).filter(Boolean));
  const unknown = [...skipped].filter((name) => !(name in AREAS) || name === 'http');
  if (unknown.length > 0) throw new Error(`--skip accepts: browser, lab, field, search (got: ${unknown.join(', ')})`);
  const off = (name, enabled = true) =>
    skipped.has(name) ? 'skipped with --skip' : enabled ? null : 'disabled in the config';

  const { bots } = await readJson(path.join(PLUGIN_ROOT, 'rules/ai-crawlers.json'));
  const richResults = await readJson(path.join(PLUGIN_ROOT, 'rules/rich-results.json'));
  const client = createClient(config.crawl);

  log(`Collecting ${config.origin} ...`);
  const site = await collectSite(config, client, bots);
  const usableRobots = site.robots.status === 200 && !site.robots.looksLikeHtml;
  const robots = parseRobots(usableRobots ? site.robots.text : '');
  const sitemapUrls = site.sitemaps.urls.map((entry) => entry.loc);
  log(`Site checks done; ${sitemapUrls.length} URLs in sitemaps. Crawling ...`);
  const crawl = await collectPages(config, client, { robots, sitemapUrls });
  const { pages } = crawl;

  const keyUrls = config.keyPages.map((pagePath) => normalizeUrl(pagePath, config.origin));
  const notRun = (reason) => ({ ran: false, reason, pages: [] });

  let browser = notRun(off('browser', config.browser.enabled));
  if (!browser.reason) {
    const sample = samplePages(pages, new Set(keyUrls), config.browser);
    log(`Opening ${sample.length} pages in a browser ...`);
    browser = await collectBrowser(config, sample);
  }

  let lab = notRun(off('lab', config.performance.enabled));
  if (!lab.reason) {
    const urls = keyUrls.slice(0, config.performance.maxPages);
    log(`Running Lighthouse: ${urls.length} page(s) x ${config.performance.runs} runs ...`);
    lab = await collectLab(config, urls);
  }

  let field = notRun(off('field', config.performance.enabled));
  if (!field.reason) field = await collectField(config, keyUrls.slice(0, config.performance.maxPages));

  let search = notRun(off('search'));
  if (!search.reason) search = await collectSearchConsole(config, keyUrls, site.collectedAt);

  const collectors = {
    http: { ran: true, reason: null },
    browser: { ran: browser.ran, reason: browser.reason, pages: browser.pages.length },
    lab: { ran: lab.ran, reason: lab.reason, pages: lab.pages.length },
    field: { ran: field.ran, reason: field.reason },
    search: { ran: search.ran, reason: search.reason },
  };

  const performance = { lab, field };
  const evaluated = evaluate({
    site,
    pages,
    skipped: crawl.skipped,
    config,
    bots,
    browser,
    performance,
    search,
    richResults,
  });

  const outDir = path.resolve(out ?? config.output);
  const historyDir = path.join(outDir, 'history');
  const comparison = compareRuns(await loadPreviousSnapshot(historyDir), evaluated.findings, collectors, site.collectedAt);
  const findings = comparison.findings;
  const counts = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]),
  );

  const result = {
    site: config.origin,
    collectedAt: site.collectedAt,
    coverage: {
      collectors,
      checked: Object.keys(AREAS).filter((name) => collectors[name].ran).map((name) => AREAS[name]),
      notChecked: Object.keys(AREAS)
        .filter((name) => !collectors[name].ran)
        .map((name) => `${AREAS[name]} — ${collectors[name].reason}`),
      urlsFetched: pages.length,
      htmlPages: pages.filter((page) => page.html).length,
      sitemapUrls: sitemapUrls.length,
      sitemapFiles: site.sitemaps.files.length,
      sitemapTruncated: site.sitemaps.truncated,
      skippedByRobots: crawl.skipped.byRobots.length,
      skippedByFilters: crawl.skipped.byFilters,
      skippedByLimit: crawl.skipped.byLimit,
    },
    comparison: {
      firstRun: comparison.firstRun,
      previousRun: comparison.previousRun,
      ...comparison.summary,
      fixedFindings: comparison.fixed,
      notRecheckedFindings: comparison.notRechecked,
    },
    counts,
    findings,
    suppressed: evaluated.suppressed,
  };

  const stamp = site.collectedAt.replace(/[:.]/g, '-');
  const runDir = path.join(outDir, 'runs', stamp);
  await mkdir(path.join(runDir, 'raw'), { recursive: true });
  await writeJson(path.join(runDir, 'raw', 'site.json'), site);
  await writeJson(path.join(runDir, 'raw', 'pages.json'), { skipped: crawl.skipped, pages });
  await writeJson(path.join(runDir, 'raw', 'browser.json'), browser);
  await writeJson(path.join(runDir, 'raw', 'performance.json'), performance);
  await writeJson(path.join(runDir, 'raw', 'search.json'), search);
  await writeJson(path.join(runDir, 'findings.json'), result);
  await saveSnapshot(
    historyDir,
    stamp,
    buildSnapshot({
      collectedAt: site.collectedAt,
      collectors,
      comparison,
      metrics: {
        lab: lab.pages
          .filter((page) => !page.error)
          .map(({ url, score, metrics }) => ({ url, score, ...metrics })),
        field: field.ran ? field.origin : null,
        search: search.ran ? search.totals : null,
      },
    }),
  );

  console.log(`\n${config.origin}: ${pages.length} URLs fetched, ${result.coverage.htmlPages} HTML pages`);
  console.log(SEVERITIES.map((severity) => `${severity}: ${counts[severity]}`).join('  '));
  const { summary } = comparison;
  console.log(
    comparison.firstRun
      ? 'First run: there is no earlier run to compare with, so every finding counts as new.'
      : `Against ${comparison.previousRun}: ${summary.new} new, ${summary.regressed} regressed, ${summary.persisting} persisting, ${summary.fixed} fixed, ${summary.notRechecked} not rechecked`,
  );
  for (const finding of findings) {
    const where = finding.pattern ? `${finding.pattern} x${finding.count}` : 'site';
    console.log(`  [${finding.severity}] [${finding.status}] ${finding.rule}  (${where})  ${finding.summary}`);
  }
  if (evaluated.suppressed.length > 0) console.log(`  ${evaluated.suppressed.length} finding(s) ignored by config`);
  if (result.coverage.notChecked.length > 0) {
    console.log(`\nNot checked:\n${result.coverage.notChecked.map((line) => `  - ${line}`).join('\n')}`);
  }
  console.log(`\nOutput: ${runDir}`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: 'seo-audit.config.json' },
    out: { type: 'string' },
    skip: { type: 'string' },
  },
});
const command = positionals[0] ?? 'run';

if (command !== 'run') {
  console.error(
    `Unknown command "${command}". Usage: cli.mjs run [--config <file>] [--out <dir>] [--skip browser,lab,field,search]`,
  );
  process.exit(2);
}
run(values).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
