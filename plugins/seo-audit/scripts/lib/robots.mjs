import { escapeRegExp } from './util.mjs';

/** Parse robots.txt into user-agent groups and sitemap URLs (RFC 9309 grouping). */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let previousWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      // Consecutive user-agent lines share one group; a user-agent after rules starts a new one.
      if (!current || !previousWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (current) current.rules.push({ type: key, path: value });
      previousWasAgent = false;
    } else if (key === 'sitemap') {
      sitemaps.push(value);
    } else {
      previousWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

/** Rules that apply to a crawler token: its own group if there is one, otherwise `*`. */
export function rulesFor(robots, token) {
  const wanted = token.toLowerCase();
  const named = robots.groups.flatMap((group) => group.agents).filter((agent) => agent !== '*');
  const agent =
    named.find((name) => name === wanted) ??
    named
      .filter((name) => wanted.startsWith(name))
      .sort((a, b) => b.length - a.length)[0] ??
    '*';
  const rules = robots.groups
    .filter((group) => group.agents.includes(agent))
    .flatMap((group) => group.rules);
  return { agent, rules };
}

function pathMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/**
 * Whether `token` may fetch `path` (path plus query string).
 * The longest matching rule wins; on a tie `allow` wins. No matching rule means allowed.
 */
export function isAllowed(robots, token, path) {
  const { agent, rules } = rulesFor(robots, token);
  let best = null;
  for (const rule of rules) {
    if (rule.path === '' || !pathMatches(rule.path, path)) continue;
    const longer = !best || rule.path.length > best.path.length;
    const tieAllow = best && rule.path.length === best.path.length && rule.type === 'allow';
    if (longer || tieAllow) best = rule;
  }
  return { allowed: !best || best.type === 'allow', agent, rule: best };
}
