import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SEVERITIES } from './catalog.mjs';

/** Which collector a rule's findings come from. A finding can only be "fixed" if its collector ran. */
export function sourceOf(rule) {
  const group = rule.split('.')[0];
  if (group === 'render' || group === 'a11y') return 'browser';
  if (rule.startsWith('perf.lab')) return 'lab';
  if (rule.startsWith('perf.field')) return 'field';
  if (group === 'search') return 'search';
  return 'http';
}

/**
 * Compare this run's findings with the previous snapshot.
 *
 * - new: was not there last time
 * - regressed: was there, and is now more severe or covers noticeably more pages
 * - persisting: was there, unchanged
 * - fixed: was there, gone now, and the collector that finds it ran this time
 * - not rechecked: was there, gone now, but its collector did not run, so nothing is known
 */
export function compareRuns(previous, findings, collectors, collectedAt) {
  const before = new Map((previous?.findings ?? []).map((finding) => [finding.id, finding]));
  const rank = (severity) => SEVERITIES.indexOf(severity);

  const annotated = findings.map((finding) => {
    const old = before.get(finding.id);
    let status = 'new';
    if (old) {
      const grew = finding.count >= old.count + Math.max(2, Math.ceil(old.count * 0.2));
      status = rank(finding.severity) < rank(old.severity) || grew ? 'regressed' : 'persisting';
    }
    return {
      ...finding,
      status,
      firstSeen: old?.firstSeen ?? collectedAt,
      previousCount: old?.count ?? null,
    };
  });

  const present = new Set(findings.map((finding) => finding.id));
  const gone = [...before.values()].filter((finding) => !present.has(finding.id));
  const fixed = gone.filter((finding) => collectors[sourceOf(finding.rule)]?.ran);
  const notRechecked = gone.filter((finding) => !collectors[sourceOf(finding.rule)]?.ran);

  const count = (status) => annotated.filter((finding) => finding.status === status).length;
  return {
    firstRun: !previous,
    previousRun: previous?.collectedAt ?? null,
    findings: annotated,
    fixed,
    notRechecked,
    summary: {
      new: count('new'),
      regressed: count('regressed'),
      persisting: count('persisting'),
      fixed: fixed.length,
      notRechecked: notRechecked.length,
    },
  };
}

const slim = ({ id, rule, severity, summary, pattern, count, firstSeen }) => ({
  id,
  rule,
  severity,
  summary,
  pattern,
  count,
  firstSeen,
});

/** What the next run needs in order to compare itself with this one. */
export function buildSnapshot({ collectedAt, collectors, comparison, metrics }) {
  return {
    collectedAt,
    collectors: Object.fromEntries(Object.entries(collectors).map(([name, state]) => [name, { ran: state.ran }])),
    // Findings whose collector did not run are carried over, so they are not reported as new later.
    findings: [...comparison.findings, ...comparison.notRechecked].map(slim),
    metrics,
  };
}

export async function loadPreviousSnapshot(dir) {
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  return JSON.parse(await readFile(path.join(dir, names.at(-1)), 'utf8'));
}

export async function saveSnapshot(dir, stamp, snapshot) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${stamp}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
}
