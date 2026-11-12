import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findChrome, sandboxFlags } from './browser.mjs';

// Pinned on purpose: scores are not comparable across Lighthouse versions, so an upgrade is a
// deliberate change that resets the lab baseline.
export const LIGHTHOUSE_VERSION = '13.6.0';

const CRUX = 'https://chromeuxreport.googleapis.com/v1/records';
const FIELD_METRICS = {
  lcpMs: 'largest_contentful_paint',
  inpMs: 'interaction_to_next_paint',
  cls: 'cumulative_layout_shift',
  ttfbMs: 'experimental_time_to_first_byte',
  fcpMs: 'first_contentful_paint',
};

function runProcess(command, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().split('\n').pop() || `exit ${code}` });
    });
  });
}

/** The parts of a Lighthouse result the audit uses. Exported for tests. */
export function summarizeLighthouse(lhr) {
  const { audits } = lhr;
  const value = (id) => audits[id]?.numericValue ?? null;
  const opportunities = lhr.categories.performance.auditRefs
    .filter((ref) => ref.group !== 'metrics' && ref.group !== 'hidden')
    .map((ref) => audits[ref.id])
    .filter((audit) => audit && typeof audit.score === 'number' && audit.score < 0.9)
    .map((audit) => ({
      id: audit.id,
      title: audit.title,
      displayValue: audit.displayValue ?? null,
      // Estimated time saved; layout-shift savings are unitless and below 1, so they drop out.
      savingsMs: Math.round(
        Math.max(0, ...Object.values(audit.metricSavings ?? {}).filter((saved) => typeof saved === 'number' && saved > 1)),
      ),
    }))
    .sort((a, b) => b.savingsMs - a.savingsMs)
    .slice(0, 6);
  return {
    score: lhr.categories.performance.score,
    metrics: {
      fcpMs: value('first-contentful-paint'),
      lcpMs: value('largest-contentful-paint'),
      tbtMs: value('total-blocking-time'),
      cls: value('cumulative-layout-shift'),
      speedIndexMs: value('speed-index'),
    },
    totalBytes: value('total-byte-weight'),
    opportunities,
  };
}

/** The run in the middle by score: one Lighthouse run is too noisy to compare week to week. */
export function medianRun(runs) {
  const sorted = [...runs].sort((a, b) => a.score - b.score);
  return sorted[Math.floor(sorted.length / 2)];
}

async function lighthouseOnce(url, chromePath, dir, index) {
  const output = path.join(dir, `run-${index}.json`);
  const flags = ['--headless=new', ...sandboxFlags()].join(' ');
  const result = await runProcess(
    'npx',
    [
      '-y',
      `lighthouse@${LIGHTHOUSE_VERSION}`,
      url,
      '--output=json',
      `--output-path=${output}`,
      '--quiet',
      '--only-categories=performance',
      `--chrome-flags=${flags}`,
    ],
    { env: { ...process.env, CHROME_PATH: chromePath }, timeoutMs: 150_000 },
  );
  if (!result.ok) return { error: result.error };
  try {
    const lhr = JSON.parse(await readFile(output, 'utf8'));
    if (lhr.runtimeError) return { error: lhr.runtimeError.message ?? lhr.runtimeError.code };
    return summarizeLighthouse(lhr);
  } catch (error) {
    return { error: `unreadable Lighthouse output: ${error.message}` };
  }
}

/** Lab measurements: Lighthouse on each URL, several runs, the median one kept. Never in parallel. */
export async function collectLab(config, urls) {
  const chromePath = findChrome();
  if (!chromePath) {
    return { ran: false, reason: 'Chrome was not found; set CHROME_PATH to its executable', pages: [] };
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'seo-audit-lh-'));
  const pages = [];
  try {
    for (const url of urls) {
      const runs = [];
      let lastError = null;
      for (let index = 0; index < config.performance.runs; index++) {
        const run = await lighthouseOnce(url, chromePath, dir, index);
        if (run.error) lastError = run.error;
        else runs.push(run);
      }
      if (runs.length === 0) {
        pages.push({ url, error: lastError ?? 'no successful run', runs: 0 });
      } else {
        pages.push({
          url,
          error: null,
          runs: runs.length,
          scores: runs.map((run) => run.score).sort((a, b) => a - b),
          ...medianRun(runs),
        });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return {
    ran: true,
    reason: null,
    lighthouseVersion: LIGHTHOUSE_VERSION,
    formFactor: 'mobile',
    runsPerPage: config.performance.runs,
    pages,
  };
}

async function crux(endpoint, key, body) {
  let response;
  try {
    response = await fetch(`${CRUX}:${endpoint}`, {
      method: 'POST',
      // The key goes in a header, not the URL, so it stays out of logs and proxies.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    return { error: error?.cause?.code ?? error?.name ?? 'fetch-failed' };
  }
  // 404 is CrUX's answer for "not enough real-user traffic to report on".
  if (response.status === 404) return { noData: true };
  if (!response.ok) return { error: `HTTP ${response.status}` };
  return response.json();
}

/** p75 per metric from a CrUX record. Exported for tests. */
export function readCruxRecord(payload) {
  const metrics = payload.record?.metrics ?? {};
  const values = {};
  for (const [name, cruxName] of Object.entries(FIELD_METRICS)) {
    const p75 = metrics[cruxName]?.percentiles?.p75;
    values[name] = p75 === undefined ? null : Number(p75);
  }
  return values;
}

/** Field measurements: what real Chrome users experienced over the last 28 days. Needs an API key. */
export async function collectField(config, urls) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    return { ran: false, reason: 'GOOGLE_API_KEY is not set (Chrome UX Report API)', origin: null, pages: [] };
  }
  const query = async (target) => {
    const payload = await crux('queryRecord', key, { ...target, formFactor: 'PHONE' });
    if (payload.error) return { ...target, error: payload.error };
    if (payload.noData) return { ...target, noData: true };
    return {
      ...target,
      period: payload.record?.collectionPeriod ?? null,
      ...readCruxRecord(payload),
    };
  };

  const origin = await query({ origin: config.origin });
  if (origin.error) return { ran: false, reason: `Chrome UX Report API: ${origin.error}`, origin: null, pages: [] };

  const pages = [];
  for (const url of urls) pages.push(await query({ url }));

  // Weekly p75 history for the origin, so a trend is visible without storing anything.
  let history = null;
  const payload = await crux('queryHistoryRecord', key, { origin: config.origin, formFactor: 'PHONE' });
  if (!payload.error && !payload.noData) {
    const metrics = payload.record?.metrics ?? {};
    history = {
      periods: (payload.record?.collectionPeriods ?? []).slice(-8).map((period) => period.lastDate),
      lcpMs: metrics[FIELD_METRICS.lcpMs]?.percentilesTimeseries?.p75s?.slice(-8) ?? null,
      inpMs: metrics[FIELD_METRICS.inpMs]?.percentilesTimeseries?.p75s?.slice(-8) ?? null,
      cls: metrics[FIELD_METRICS.cls]?.percentilesTimeseries?.p75s?.slice(-8) ?? null,
    };
  }
  return { ran: true, reason: null, formFactor: 'phone', origin, pages, history };
}
