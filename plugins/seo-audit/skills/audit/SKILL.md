---
name: audit
description: Technical SEO audit of a site - reachability, rendering, indexability, on-page, structured data, Core Web Vitals, accessibility and LLM access - with a report of what to fix, where, and what it affects. Use when asked to run an SEO audit, check a site's SEO health, or produce the weekly SEO report. Триггеры - «сделай SEO-аудит», «проверь SEO сайта», «еженедельный SEO-отчёт».
argument-hint: "[url]"
---

# SEO audit

**Status: scaffold.** The collection and evaluation scripts are not implemented yet, so this skill cannot audit anything.

If invoked now:

1. Tell the user the plugin is a scaffold and that no checks ran.
2. Do not run an ad-hoc audit in its place, and do not report any metric values or findings.

## Rule that holds once the scripts exist

Every number and every finding in a report comes from the plugin's scripts (`findings.json`, `metrics.json`, `diff.json`). Claude explains, locates the cause in the code, and prioritises. Claude never estimates a metric, and a source that did not run is listed as missing coverage rather than treated as a pass.
