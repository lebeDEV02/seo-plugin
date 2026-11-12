import tls from 'node:tls';
import { parseRobots } from '../lib/robots.mjs';
import { loadSitemaps } from '../lib/sitemap.mjs';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const slim = ({ url, finalUrl, status, hops, headers, ttfbMs, bytes, error }) => ({
  url,
  finalUrl,
  status,
  hops,
  headers,
  ttfbMs,
  bytes,
  error,
});

function certificate(host) {
  return new Promise((resolve) => {
    const fail = (error) => resolve({ validTo: null, authorized: false, issuer: null, error });
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve({
        validTo: cert.valid_to ? new Date(cert.valid_to).toISOString() : null,
        authorized: socket.authorized,
        issuer: cert.issuer?.O ?? null,
        error: null,
      });
    });
    socket.on('error', (error) => fail(error.code ?? error.message));
    socket.on('timeout', () => {
      socket.destroy();
      fail('timeout');
    });
  });
}

async function collectLlmsTxt(origin, client) {
  const response = await client.get(`${origin}/llms.txt`);
  const text = response.body ?? '';
  const info = {
    status: response.status,
    error: response.error,
    contentType: response.headers['content-type'] ?? null,
    bytes: response.bytes,
    looksLikeHtml: /<!doctype html|<html[\s>]/i.test(text.slice(0, 1000)),
    firstLine: text.split(/\r?\n/).find((line) => line.trim() !== '')?.slice(0, 200) ?? null,
    links: [],
  };
  if (response.status !== 200 || info.looksLikeHtml) return info;

  const urls = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]);
  for (const url of [...new Set(urls)].slice(0, 40)) {
    const check = await client.get(url, { readBody: false });
    info.links.push({ url, status: check.status, redirected: check.hops.length > 0, error: check.error });
  }
  return info;
}

/** Ask for the key pages as each AI crawler would, next to a normal browser request. */
async function probeBots(config, client, bots) {
  const probes = [];
  for (const path of config.keyPages.slice(0, 3)) {
    const url = new URL(path, config.origin).href;
    const baseline = await client.get(url, { userAgent: BROWSER_UA });
    const probe = { url, baseline: { status: baseline.status, bytes: baseline.bytes }, bots: [] };
    for (const bot of bots.filter((entry) => entry.probeUserAgent)) {
      const response = await client.get(url, { userAgent: bot.probeUserAgent });
      probe.bots.push({
        token: bot.token,
        class: bot.class,
        status: response.status,
        error: response.error,
        bytes: response.bytes,
        cfMitigated: response.headers['cf-mitigated'] ?? null,
      });
    }
    probes.push(probe);
  }
  return probes;
}

/** Everything that is checked once per site rather than once per page. */
export async function collectSite(config, client, bots) {
  const { origin } = config;
  const host = new URL(origin).hostname;
  const otherHost = host.startsWith('www.') ? host.slice(4) : `www.${host}`;

  const home = slim(await client.get(`${origin}/`, { readBody: false }));
  const variants = [];
  for (const url of [`http://${host}/`, `https://${otherHost}/`, `http://${otherHost}/`]) {
    variants.push(slim(await client.get(url, { readBody: false })));
  }

  const robotsResponse = await client.get(`${origin}/robots.txt`);
  const robotsText = robotsResponse.status === 200 ? (robotsResponse.body ?? '') : '';
  const robots = {
    status: robotsResponse.status,
    error: robotsResponse.error,
    looksLikeHtml: /<!doctype html|<html[\s>]/i.test(robotsText.slice(0, 1000)),
    text: robotsText.slice(0, 200_000),
  };
  const parsedRobots = parseRobots(robots.looksLikeHtml ? '' : robots.text);

  const declared = parsedRobots.sitemaps;
  const sitemaps = await loadSitemaps(declared.length > 0 ? declared : [`${origin}/sitemap.xml`], client);

  const missing = await client.get(`${origin}/seo-audit-missing-${Date.now().toString(36)}`, {
    readBody: false,
  });

  return {
    origin,
    host,
    collectedAt: new Date().toISOString(),
    home,
    variants,
    tls: origin.startsWith('https:') ? await certificate(host) : null,
    robots,
    sitemaps: { declaredInRobots: declared.length > 0, ...sitemaps },
    missingPageProbe: { url: missing.url, status: missing.status, finalUrl: missing.finalUrl },
    llmsTxt: await collectLlmsTxt(origin, client),
    botProbes: await probeBots(config, client, bots),
  };
}
