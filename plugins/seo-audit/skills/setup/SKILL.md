---
name: setup
description: Connect the current project to the seo-audit plugin - create seo-audit.config.json, check which collectors can run here, and record the first baseline. Use when asked to set up or enable SEO audits for a project. Триггеры - «подключи SEO-аудит к проекту», «настрой seo-audit».
argument-hint: "[url]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *)
---

# Set up SEO audit for a project

The result of setup is a config file in the project, a clear list of which checks can run here, and a first run to compare later runs with.

## 1. Config

If `seo-audit.config.json` already exists in the project root, show what it contains and ask what to change. Do not overwrite it.

Otherwise you need two things from the user:

- **The site address.** Take it from the argument, or ask.
- **The key pages**: the handful of pages that matter most, such as the home page and the main sections. They get Lighthouse runs, AI crawler probes and higher severity, so more than five makes every run slow. If the user has no list, propose one from the site's navigation and ask them to confirm it.

Write `seo-audit.config.json` with `site` and `keyPages` only; every other option has a default. Add `"$schema"` from `${CLAUDE_PLUGIN_ROOT}/templates/seo-audit.config.json` so editors validate the file. Mention the options a first-time user is most likely to want: `expect.noindex` for pages that are noindex on purpose, `aiCrawlers` for the intended AI crawler policy, `browser.expectSelector`.

## 2. Output folder

Runs are written to `.seo-audit/`. Tell the user what is in it and let them decide what to commit:

- `.seo-audit/runs/` is bulky and reproducible; it belongs in `.gitignore`.
- `.seo-audit/history/` is small and is what later runs compare with. Committing it keeps the comparison when the audit moves to another machine or to CI.

Add the `.gitignore` line only if the user agrees.

## 3. Collectors

Check what can run here and report it as a short table:

| Collector | Check |
|---|---|
| `browser`, `lab` | Chrome is installed, or `CHROME_PATH` points at it |
| `field` | `GOOGLE_API_KEY` is set |
| `search` | `GSC_SERVICE_ACCOUNT_KEY` is set and `searchConsole.property` is in the config |

Check that a variable is set without printing its value. For anything missing, say what it unlocks and how to get it:

- **`GOOGLE_API_KEY`**: an API key in a Google Cloud project with the Chrome UX Report API enabled.
- **`GSC_SERVICE_ACCOUNT_KEY`**: a service account key (the JSON, or a path to the file), with the service account's email added as a user of the Search Console property. `searchConsole.property` is the property's name as Search Console shows it: `sc-domain:example.com` or `https://example.com/`.

Never ask for a key in the chat and never write one into a file. The user sets environment variables themselves.

## 4. Baseline

Run the audit once, in the background:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs run --config seo-audit.config.json
```

Report the result as a baseline, following the `audit` skill's reporting rules: this is the state the site is in today, and from the next run on the report will say what is new, what got worse and what was fixed.

## Not implemented yet

A scheduled workflow and report delivery. For now, schedule the audit yourself.
