import { isAllowed } from '../lib/robots.mjs';
import { siteFinding } from './finding.mjs';

const DAY_MS = 86_400_000;

/** Rules that look at the site as a whole: host, TLS, robots.txt, sitemaps, AI crawler access. */
export function siteRules({ site, config, robots, bots }) {
  const findings = [];
  const add = (rule, evidence, overrides) => findings.push(siteFinding(rule, evidence, overrides));
  const https = config.origin.startsWith('https:');
  const onMainHost = (url) => new URL(url).hostname === site.host;

  if (site.home.status !== 200) {
    add('reach.home-unreachable', {
      status: site.home.status,
      error: site.home.error,
      finalUrl: site.home.finalUrl,
    });
  }

  const [httpVariant, ...hostVariants] = site.variants;
  if (https && !(httpVariant.hops.length > 0 && httpVariant.finalUrl.startsWith('https://'))) {
    add('reach.http-not-redirected', {
      url: httpVariant.url,
      status: httpVariant.status,
      finalUrl: httpVariant.finalUrl,
      error: httpVariant.error,
    });
  }
  const strayHosts = hostVariants.filter((variant) => variant.status === 0 || !onMainHost(variant.finalUrl));
  if (strayHosts.length > 0) {
    add('reach.host-variant-not-redirected', {
      variants: strayHosts.map(({ url, status, finalUrl, error }) => ({ url, status, finalUrl, error })),
    });
  }
  const chains = site.variants.filter((variant) => variant.hops.length > 1);
  if (chains.length > 0) {
    add('reach.host-redirect-chain', {
      chains: chains.map(({ url, hops, finalUrl }) => ({ url, hops, finalUrl })),
    });
  }

  if (https && site.home.status === 200 && !site.home.headers['strict-transport-security']) {
    add('reach.hsts-missing', { url: site.home.url });
  }

  if (site.tls) {
    if (site.tls.error || !site.tls.authorized) {
      add('reach.tls-invalid', { error: site.tls.error });
    } else if (site.tls.validTo) {
      const daysLeft = Math.floor((new Date(site.tls.validTo) - new Date(site.collectedAt)) / DAY_MS);
      if (daysLeft < config.thresholds.tlsDaysHigh) {
        add(
          'reach.tls-expiring',
          { validTo: site.tls.validTo, daysLeft },
          daysLeft < config.thresholds.tlsDaysCritical ? { severity: 'critical' } : {},
        );
      }
    }
  }

  if (site.robots.status === 0 || site.robots.status >= 500) {
    add('reach.robots-unavailable', { status: site.robots.status, error: site.robots.error });
  } else if (site.robots.status !== 200) {
    add('reach.robots-missing', { status: site.robots.status });
  } else if (site.robots.looksLikeHtml) {
    add('reach.robots-not-text', { status: site.robots.status });
  }

  const blockedKeyPages = config.keyPages
    .map((path) => ({ path, verdict: isAllowed(robots, 'Googlebot', path) }))
    .filter(({ verdict }) => !verdict.allowed)
    .map(({ path, verdict }) => ({ path, rule: `${verdict.rule.type}: ${verdict.rule.path}` }));
  if (blockedKeyPages.length > 0) {
    add('reach.robots-blocks-key-page', { blocked: blockedKeyPages }, { count: blockedKeyPages.length });
  }

  const { files, declaredInRobots } = site.sitemaps;
  const fetched = files.filter((file) => file.status === 200);
  if (fetched.length === 0) {
    add('reach.sitemap-missing', { tried: files.map(({ url, status, error }) => ({ url, status, error })) });
  } else {
    const broken = fetched.filter((file) => file.type === 'invalid' || file.count === 0);
    if (broken.length > 0) {
      add('reach.sitemap-invalid', { files: broken.map(({ url, type, count }) => ({ url, type, count })) });
    }
    if (!declaredInRobots) add('reach.sitemap-not-in-robots', { found: fetched[0].url });
  }

  if (site.missingPageProbe.status === 200) {
    add('reach.soft-404', {
      requested: site.missingPageProbe.url,
      status: site.missingPageProbe.status,
      finalUrl: site.missingPageProbe.finalUrl,
    });
  }

  // AI crawlers: what robots.txt says against the policy the site owner declared.
  const mismatches = [];
  for (const bot of bots) {
    const policy = config.aiCrawlers[bot.class];
    if (policy === 'any') continue;
    for (const path of config.keyPages) {
      const verdict = isAllowed(robots, bot.token, path);
      if ((policy === 'allow') === verdict.allowed) continue;
      mismatches.push({
        bot: bot.token,
        class: bot.class,
        expected: policy,
        actual: verdict.allowed ? 'allowed' : 'blocked',
        path,
        robotsGroup: verdict.agent,
        rule: verdict.rule ? `${verdict.rule.type}: ${verdict.rule.path}` : null,
      });
    }
  }
  if (mismatches.length > 0) {
    add('llm.robots-policy-mismatch', { mismatches }, { count: mismatches.length });
  }

  // AI crawlers: what the server actually answers. A probe comes from an ordinary IP address, so
  // a firewall that verifies crawler IPs can block the probe while letting the real crawler in.
  const blocked = [];
  for (const probe of site.botProbes) {
    if (probe.baseline.status !== 200) continue;
    for (const bot of probe.bots) {
      const refused = bot.status !== 200 || bot.cfMitigated;
      if (!refused || !isAllowed(robots, bot.token, new URL(probe.url).pathname).allowed) continue;
      blocked.push({
        url: probe.url,
        bot: bot.token,
        status: bot.status,
        error: bot.error,
        cfMitigated: bot.cfMitigated,
      });
    }
  }
  if (blocked.length > 0) {
    add('llm.bot-blocked-by-server', { blocked }, { count: blocked.length, confidence: 'low' });
  }

  const llms = site.llmsTxt;
  if (llms.status !== 200 || llms.looksLikeHtml) {
    add(
      'llm.llms-txt-missing',
      { status: llms.status, servedHtmlInstead: llms.looksLikeHtml },
      config.llmsTxt === 'expected' ? { severity: 'medium' } : {},
    );
  } else {
    if (!/^#\s+\S/.test(llms.firstLine ?? '')) add('llm.llms-txt-invalid', { firstLine: llms.firstLine });
    const dead = llms.links.filter((link) => link.status !== 200 || link.redirected);
    if (dead.length > 0) {
      add('llm.llms-txt-broken-link', { links: dead.slice(0, 10) }, { count: dead.length });
    }
  }

  return findings;
}
