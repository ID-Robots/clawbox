# Coding Agent bench

The repeatable version of 2026-08-27's hand-testing: a fixed, versioned task
suite, a runner that drives the box's own HTTP API, a deterministic scorer per
task, cheap regression guards, and a comparer. Three axes, kept separate:
**reliability** (does the run finish), **quality** (does it meet the brief),
**economics** (what did it cost).

It costs real money and real wall-clock. It is **never** part of `test:*` —
run it by hand or from a cron that respects `--budget`.

## Quick start (on the box)

```
node bench/runner.mjs --dry-run            # what would run, what it should cost
node bench/runner.mjs --nightly            # S+M nightly set (~$3 expected)
node bench/runner.mjs --tasks s-01-single-edit
node bench/compare.mjs                     # tables over bench/results/
node bench/guards.mjs                      # free static+record guards
node bench/guards.mjs --live --slow        # + stop-cost run and timeout-wall probes
```

Auth: on the box nothing is needed — the runner mints the owner cookie from
`data/.session-secret` (enable/settings are owner-only by design) and reads the
MCP bearer from `data/.mcp-token`. Off-box set `CLAWBOX_URL` plus either
`CLAWBOX_COOKIE` or `CLAWBOX_PASSWORD` (used for ONE login attempt — five
failures lock the whole box out for five minutes).

## Layout

```
bench/
  runner.mjs        drives the API, captures everything, scores
  compare.mjs       tables + cost-per-file / cost-per-point + baseline diff
  guards.mjs        regression pins (static / record / --live / --slow)
  pricing.json      bench-owned per-token rates (all null until filled in)
  lib/              box client, capture, scorer utils, transcript usage sums
  tasks/<id>/       brief.md + task.json + score.mjs [+ seed/]
  results/<suite>/  index.jsonl + one directory per captured run (gitignored)
```

Workdirs go under `~/bench-work/<stamp>-<task>-r<n>/work` — the run route
requires a folder inside the home directory and outside this checkout.

## The tasks (suite v1)

| id | tier | exercises |
|---|---|---|
| s-01-single-edit | S | smallest possible edit; leaves the rest alone |
| s-02-refusal | S | one step lies outside the folder: does it refuse AND report the refusal? |
| m-01-static-site | M | 8-file greenfield site, data-driven pricing |
| m-02-existing-repo | M | read-before-write in an existing codebase; run the tests |
| m-03-failing-tests | M | seeded red tests must go green; tests untouched |
| m-04-ambiguity | M | under-specified brief: pass = states its assumption in the summary |
| l-01-docs-site | L | 12 pages + shared data layer; duplication is the failure mode |
| x-01-recovery | M | MANUAL: cut the network mid-run; scores only the record's honesty |

Every scorer is deterministic (files, `node --test`, greps, link resolution,
anti-patterns, a claims-are-verifiable pass over the summary). No LLM in the
objective path. Each scorer was validated against a hand-built reference
solution (scores 100) and the untouched seed (scores low).

## Rules, carried over from the design doc

- **Never change the benchmark and the product in the same cycle.** Bump
  `suite.json`'s `suiteVersion` when tasks change; a new version starts a
  fresh baseline.
- **A failing run is a finding, not a retry.** The runner captures before it
  moves on; a runner timeout stops the run only after capture.
- Triage every failure into exactly one bucket: infra / agent / harness /
  flake (re-run 5×, record the rate, don't "fix" until it reproduces).

## Corrections to the 2026-08-27 design doc (verified against source)

- **There is no `MODEL_PRICING` and no `tiers.ts`** anywhere in this repo.
  `run.costUsd` is whatever the CLI's `result` event said. The
  orchestrator-vs-sub-agent split comes from per-model usage sums over the
  session transcript (sub-agents all run on `deepseek-v4-flash`; the main loop
  on the tier model) — priced only if you put rates into `bench/pricing.json`.
- **ClawBox writes no per-run sub-agent transcripts** (`agent-*.jsonl` /
  `.meta.json` are claude-ds internals). Capture sweeps
  `~/.claude-ds/projects/<dir-slug>/` defensively for artifacts newer than the
  run's start.
- **Effort / maxTurns / tokenLimit are enable-time config**, snapshotted per
  run — there is no per-run effort field. The matrix runner flips them via
  `POST /setup-api/coding-agent/enable` (owner-only) between runs.
- A **stopped/killed run structurally cannot carry `costUsd`** today: cost
  only arrives on the CLI's final `result` event. The guard and x-01 keep
  that pinned red until the product computes cost from the tokens it already
  counts.
- `commit` is populated **after** the record settles (fire-and-forget git
  work) — a poll can legitimately see `completed` with `commit: null`. The
  runner waits bounded and records `commitLagMs`; the guard fails only when a
  completed run with touched files still has no commit at rest.

## Known-defect pins (all red until fixed, on purpose)

| pin | where |
|---|---|
| stopped run with tokens reports a hard $0.00 (null = honestly unreported is fine; costUsd here is the CLI's estimate over unknown model names, so tokens are the real spend record) | `guards.mjs --live`, x-01 scorer |
| permissionDenials stays 0 on a real refusal | s-02 scorer, `record-denials-on-refusal` guard |
| MCP `coding_agent_run` refuses a bare task while the enable docstring promises the default folder | `mcp-default-directory-consistency` guard |
| stop takes `{id}`, run takes `resumeRunId` | `stop-route-param-shape` guard |
| ~125s / ~300s upstream timeout walls | `guards.mjs --slow` probes |
