import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const DAY_MS = 86_400_000;
// Search Console data settles a few days late; newer days are incomplete.
const LAG_DAYS = 3;

const base64url = (input) => Buffer.from(input).toString('base64url');
const isoDate = (date) => date.toISOString().slice(0, 10);

/** Two consecutive 7-day windows ending `LAG_DAYS` before `now`. Exported for tests. */
export function comparisonPeriods(now) {
  const end = new Date(new Date(now).getTime() - LAG_DAYS * DAY_MS);
  const day = (offset) => isoDate(new Date(end.getTime() - offset * DAY_MS));
  return {
    current: { startDate: day(6), endDate: day(0) },
    previous: { startDate: day(13), endDate: day(7) },
  };
}

/** Join per-page rows of two periods into one list. Exported for tests. */
export function mergePeriods(currentRows, previousRows) {
  const pages = new Map();
  const entry = (url) => {
    if (!pages.has(url)) {
      pages.set(url, { url, clicks: 0, impressions: 0, position: null, previousClicks: 0, previousImpressions: 0 });
    }
    return pages.get(url);
  };
  for (const row of currentRows) {
    Object.assign(entry(row.keys[0]), { clicks: row.clicks, impressions: row.impressions, position: row.position });
  }
  for (const row of previousRows) {
    Object.assign(entry(row.keys[0]), { previousClicks: row.clicks, previousImpressions: row.impressions });
  }
  return [...pages.values()].sort((a, b) => b.impressions - a.impressions);
}

async function loadServiceAccount() {
  const value = process.env.GSC_SERVICE_ACCOUNT_KEY;
  if (!value) return null;
  // Either the JSON itself (handy for CI secrets) or a path to the key file.
  return JSON.parse(value.trim().startsWith('{') ? value : await readFile(value, 'utf8'));
}

async function accessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: account.token_uri, iat: now, exp: now + 3600 })),
  ].join('.');
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url');
  const response = await fetch(account.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`token request failed: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

/**
 * Search Console: clicks and impressions for two weeks, index status of the key pages, and the
 * state of submitted sitemaps. Read-only. Needs a service account that was added to the property.
 */
export async function collectSearchConsole(config, keyUrls, now) {
  const property = config.searchConsole.property;
  if (!property) return { ran: false, reason: 'searchConsole.property is not set in the config' };

  let account;
  try {
    account = await loadServiceAccount();
  } catch (error) {
    return { ran: false, reason: `GSC_SERVICE_ACCOUNT_KEY could not be read: ${error.message}` };
  }
  if (!account) return { ran: false, reason: 'GSC_SERVICE_ACCOUNT_KEY is not set' };

  let token;
  try {
    token = await accessToken(account);
  } catch (error) {
    return { ran: false, reason: `Search Console: ${error.message}` };
  }

  const call = async (url, body) => {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
    return response.json();
  };
  const site = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}`;
  const periods = comparisonPeriods(now);

  try {
    const analytics = (period) =>
      call(`${site}/searchAnalytics/query`, { ...period, dimensions: ['page'], rowLimit: 5000 });
    const [current, previous] = [await analytics(periods.current), await analytics(periods.previous)];
    const pages = mergePeriods(current.rows ?? [], previous.rows ?? []);
    const sum = (key) => pages.reduce((total, page) => total + page[key], 0);

    const inspections = [];
    for (const url of keyUrls.slice(0, 20)) {
      const { inspectionResult } = await call('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
        inspectionUrl: url,
        siteUrl: property,
      });
      const index = inspectionResult?.indexStatusResult ?? {};
      inspections.push({
        url,
        verdict: index.verdict ?? null,
        coverageState: index.coverageState ?? null,
        indexingState: index.indexingState ?? null,
        robotsTxtState: index.robotsTxtState ?? null,
        pageFetchState: index.pageFetchState ?? null,
        googleCanonical: index.googleCanonical ?? null,
        userCanonical: index.userCanonical ?? null,
        lastCrawlTime: index.lastCrawlTime ?? null,
      });
    }

    const sitemaps = ((await call(`${site}/sitemaps`)).sitemap ?? []).map((sitemap) => ({
      path: sitemap.path,
      errors: Number(sitemap.errors ?? 0),
      warnings: Number(sitemap.warnings ?? 0),
      isPending: Boolean(sitemap.isPending),
      lastDownloaded: sitemap.lastDownloaded ?? null,
    }));

    return {
      ran: true,
      reason: null,
      property,
      periods,
      totals: {
        clicks: sum('clicks'),
        impressions: sum('impressions'),
        previousClicks: sum('previousClicks'),
        previousImpressions: sum('previousImpressions'),
      },
      pages,
      inspections,
      sitemaps,
    };
  } catch (error) {
    return { ran: false, reason: `Search Console: ${error.message}` };
  }
}
