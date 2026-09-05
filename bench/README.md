# Coding Agent bench

The repeatable version of 2026-08-27's hand-testing: a fixed, versioned task
suite, a runner that drives the box's own HTTP API, a deterministic scorer per
task, cheap regression guards, and a comparer. Three axes, kept separate:
**reliability** (does the run finish), **quality** (does it meet the brief),
**footprint** (how many tokens and how long).

It spends real tokens and real wall-clock. It is **never** part of `test:*` —
run it by hand or from a cron.

## Quick start (on the box)

```sh
node bench/runner.mjs --dry-run            # what would run
node bench/runner.mjs --nightly            # S+M nightly set
node bench/runner.mjs --tasks s-01-single-edit
node bench/compare.mjs                     # tables over bench/results/
node bench/guards.mjs                      # free static+record guards
node bench/guards.mjs --live --slow        # + timeout-wall probes
```

Auth: on the box nothing is needed — the runner mints the owner cookie from
`data/.session-secret` (enable/settings are owner-only by design) and reads the
MCP bearer from `data/.mcp-token`. Off-box set `CLAWBOX_URL` plus either
`CLAWBOX_COOKIE` or `CLAWBOX_PASSWORD` (used for ONE login attempt — five
failures lock the whole box out for five minutes).

## The loop (`loop.mjs`)

The runner drives one suite in a folder of its own. The **loop** is the
version the harness is tuned by: it runs the suite's demo tasks as coding
PROJECTS — `bench-<task>-<stamp>` directly under the owner's project folder,
so every run shows up in the Coding Agent app like any other project —
samples each run every 5 s while it works, and writes one report per cycle
with the four figures the owner asked to optimise by, and the change against
the cycle before:

- **token spend** (`tokensUsed`, thinking share, per model from the transcript),
- **parallelisation** (`peakActive` helpers at once, helper-seconds, the share
  of the clock with a helper out, and `agentSecondsPerWallSecond` — 1.0 is the
  main loop alone, 2.0 is one helper beside it the whole run),
- **time to finish** (wall clock to settle, plus the commit lag),
- **cost per task** — priced from `bench/pricing.json` (USD per million tokens
  by model; the numbers shipped are PLACEHOLDERS to set to the plan this box is
  on) over the per-model usage, with a model the table lacks flagged as
  unpriced rather than counted as free.

```sh
node bench/loop.mjs --dry-run                          # what would run
node bench/loop.mjs --tasks s-01-single-edit            # one task, one cycle
node bench/loop.mjs --nightly --cycles 3 --pause 60     # three cycles, a minute apart
node bench/loop.mjs --nightly --baseline nightly-c1-2026-09-05   # deltas against a cycle
```

Each cycle appends `results/<suite>/loop-<label>.jsonl` (one line per run, the
figures) and writes `results/<suite>/report-<label>.md` (the table, the deltas,
and a "look at" list of plain rules: a run that did not complete, a low score,
refused actions, a long run with no helper, a burst of helpers that sat idle,
a thinking share over 30%). Every run's directory also gets `samples.json`,
the raw 5-second samples. `--workroot` moves the runs elsewhere, and says so:
the app lists only what is under the project folder meanwhile. The pure parts
(`lib/cost.mjs`, `lib/metrics.mjs`) are unit-tested in `src/tests/unit/bench-metrics.test.ts`.

## Layout

```text
bench/
  runner.mjs        drives the API, captures everything, scores
  loop.mjs          the tuning loop: tasks as projects, samples, cost, deltas
  pricing.json      USD per million tokens by model — set to your plan
  compare.mjs       tables + baseline diff
  guards.mjs        regression pins (static / record / --live / --slow)
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
  fresh baseline. (The day-0 numbers in `results/1/` were captured while the
  suite itself was still being reviewed — m-03's seed and several scorers
  tightened afterwards, pre-release — so the first nightly run is the
  baseline that counts.)
- **A failing run is a finding, not a retry.** The runner captures before it
  moves on; a runner timeout stops the run only after capture.
- Triage every failure into exactly one bucket: infra / agent / harness /
  flake (re-run 5×, record the rate, don't "fix" until it reproduces).

## Corrections to the 2026-08-27 design doc (verified against source)

- **Money is not tracked by the product** — it records no cost, by decision
  (2026-08-29). The bench's LOOP prices its own runs from `pricing.json`
  (2026-09-05, at the owner's request); the runner still prices nothing.
  Tokens and wall-clock remain the footprint record. The orchestrator-vs-sub-agent split comes from per-model
  usage sums over the session transcript (the typed helpers — explorer,
  tester, reviewer — run on `deepseek-v4-flash`; the main loop on the tier
  model; a workflow `agent()` without an agentType would run on the tier
  model too, which the ultracode brief forbids). Since 2026-09-03 the CLI
  streams one assistant line per content block, each with the message's
  whole usage — sum per `message.id`, not per line, or every turn counts
  double (the run record does this; `lib/transcript.mjs` does too).
- **ClawBox writes no per-run sub-agent transcripts** (`agent-*.jsonl` /
  `.meta.json` are claude-ds internals). Capture sweeps
  `~/.claude-ds/projects/<dir-slug>/` defensively for artifacts newer than the
  run's start.
- **Effort / maxTurns / tokenLimit are enable-time config**, snapshotted per
  run — there is no per-run effort field. The matrix runner flips them via
  `POST /setup-api/coding-agent/enable` (owner-only) between runs.
- `commit` is populated **after** the record settles (fire-and-forget git
  work) — a poll can legitimately see `completed` with `commit: null`. The
  runner waits bounded and records `commitLagMs`; the guard fails only when a
  completed run with touched files still has no commit at rest.

## Known-defect pins (all red until fixed, on purpose)

| pin | where |
|---|---|
| permissionDenials stays 0 on a real refusal | s-02 scorer, `record-denials-on-refusal` guard |
| MCP `coding_agent_run` refuses a bare task while the enable docstring promises the default folder | `mcp-default-directory-consistency` guard |
| stop takes `{id}`, run takes `resumeRunId` | `stop-route-param-shape` guard |
| ~125s / ~300s upstream timeout walls | `guards.mjs --slow` probes |
