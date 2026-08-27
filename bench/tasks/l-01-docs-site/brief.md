Build the documentation site for **crabctl**, a (fictional) fleet-management
CLI, in this folder. Static files only — no build step, no frameworks, and no
network access from the pages.

## Structure — exactly these files

```
index.html
getting-started.html
changelog.html
commands/init.html
commands/run.html
commands/stop.html
commands/status.html
commands/logs.html
commands/config.html
commands/backup.html
commands/restore.html
commands/update.html
css/docs.css
js/commands.js
js/nav.js
```

## The shared data layer — the important part

`js/commands.js` is the **single source of truth** for command metadata: for
each command its name, synopsis, one-paragraph description, and flags. Every
command page renders its header (name + synopsis) and its flag table from
`js/commands.js` via `js/nav.js` or page scripts — the synopsis strings and
flag names must not be duplicated into the HTML files. Every page (including
index, getting-started and changelog) shows a sidebar listing all nine
commands, generated from `js/commands.js`, with the current page highlighted.

## Command metadata (verbatim — put this in js/commands.js, nowhere else)

| Command | Synopsis | Flags |
|---|---|---|
| init | `crabctl init [--fleet <name>] [--force]` | `--fleet <name>` target fleet; `--force` overwrite existing config |
| run | `crabctl run <task> [--detach] [--timeout <s>]` | `--detach` run in background; `--timeout <s>` kill after s seconds |
| stop | `crabctl stop <task-id> [--all]` | `--all` stop every running task |
| status | `crabctl status [--json] [--watch]` | `--json` machine-readable output; `--watch` refresh every 2s |
| logs | `crabctl logs <task-id> [--follow] [--tail <n>]` | `--follow` stream new lines; `--tail <n>` last n lines |
| config | `crabctl config <get\|set> <key> [value]` | `--global` apply to every fleet; `--local` this fleet only |
| backup | `crabctl backup [--output <path>] [--exclude <glob>]` | `--output <path>` archive destination; `--exclude <glob>` skip matches |
| restore | `crabctl restore <archive> [--dry-run]` | `--dry-run` list what would change without writing |
| update | `crabctl update [--channel <stable\|beta>] [--check]` | `--channel` release channel; `--check` report without installing |

## Other requirements

1. `index.html`: what crabctl is, a quick-install section, and links to
   getting-started and every command page.
2. `getting-started.html`: a worked first-session walkthrough using at least
   four of the commands.
3. `changelog.html`: three releases (2.4.0, 2.3.1, 2.3.0) with dated entries.
4. Internal links only, all resolving; every page has `<meta name="viewport">`;
   real copy, no lorem ipsum, no TODOs.
