#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectPages } from './collect/pages.mjs';
import { collectSite } from './collect/site.mjs';
import { SEVERITIES } from './evaluate/catalog.mjs';
import { evaluate } from './evaluate/index.mjs';
import { loadConfig } from './lib/config.mjs';
import { createClient } from './lib/http.mjs';
import { parseRobots } from './lib/robots.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What this version measures, and what it does not. Reports must show both.
const COVERAGE = {
  checked: [
    'reachability (HTTP, TLS, redirects, robots.txt, sitemaps)',
    'indexability from raw HTML (canonical, robots, hreflang, duplicates)',
    'on-page elements and internal links',
    'structured data syntax (JSON-LD parses)',
    'LLM access (robots.txt policy, crawler user-agent probes, raw HTML text, llms.txt)',
  ],
  notChecked: [
    'rendering in a browser (JavaScript errors, raw vs rendered HTML)',
    'performance (Core Web Vitals, Lighthouse)',
    'accessibility',
    'Search Console data (index status, clicks, impressions)',
    'structured data required fields',
    'comparison with the previous run',
  ],
};

const writeJson = (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

async function run({ config: configFile, out }) {
  const config = await loadConfig(configFile);
  const { bots } = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'rules/ai-crawlers.json'), 'utf8'));
  const client = createClient(config.crawl);

  console.error(`Collecting ${config.origin} ...`);
  const site = await collectSite(config, client, bots);
  const usableRobots = site.robots.status === 200 && !site.robots.looksLikeHtml;
  const robots = parseRobots(usableRobots ? site.robots.text : '');
  const sitemapUrls = site.sitemaps.urls.map((entry) => entry.loc);
  console.error(`Site checks done; ${sitemapUrls.length} URLs in sitemaps. Crawling ...`);
  const { pages, skipped } = await collectPages(config, client, { robots, sitemapUrls });

  const { findings, suppressed } = evaluate({ site, pages, skipped, config, bots });
  const counts = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]),
  );
  const result = {
    site: config.origin,
    collectedAt: site.collectedAt,
    coverage: {
      ...COVERAGE,
      urlsFetched: pages.length,
      htmlPages: pages.filter((page) => page.html).length,
      sitemapUrls: sitemapUrls.length,
      sitemapFiles: site.sitemaps.files.length,
      sitemapTruncated: site.sitemaps.truncated,
      skippedByRobots: skipped.byRobots.length,
      skippedByFilters: skipped.byFilters,
      skippedByLimit: skipped.byLimit,
    },
    counts,
    findings,
    suppressed,
  };

  const stamp = site.collectedAt.replace(/[:.]/g, '-');
  const runDir = path.resolve(out ?? config.output, 'runs', stamp);
  await mkdir(path.join(runDir, 'raw'), { recursive: true });
  await writeJson(path.join(runDir, 'raw', 'site.json'), site);
  await writeJson(path.join(runDir, 'raw', 'pages.json'), { skipped, pages });
  await writeJson(path.join(runDir, 'findings.json'), result);

  console.log(`\n${config.origin}: ${pages.length} URLs fetched, ${result.coverage.htmlPages} HTML pages`);
  console.log(SEVERITIES.map((severity) => `${severity}: ${counts[severity]}`).join('  '));
  for (const finding of findings) {
    const where = finding.pattern ? `${finding.pattern} x${finding.count}` : 'site';
    console.log(`  [${finding.severity}] ${finding.rule}  (${where})  ${finding.summary}`);
  }
  if (suppressed.length > 0) console.log(`  ${suppressed.length} finding(s) ignored by config`);
  console.log(`\nNot checked in this version: ${COVERAGE.notChecked.join('; ')}`);
  console.log(`\nOutput: ${runDir}`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: 'seo-audit.config.json' },
    out: { type: 'string' },
  },
});
const command = positionals[0] ?? 'run';

if (command !== 'run') {
  console.error(`Unknown command "${command}". Usage: cli.mjs run [--config <file>] [--out <dir>]`);
  process.exit(2);
}
run(values).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
