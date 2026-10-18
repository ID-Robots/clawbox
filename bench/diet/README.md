# Token-diet suite (`bench/diet`)

A repeatable measurement of what the Coding Agent spends to deliver a
**finished, working app** — and the loop that tunes its defaults by it.
Objective order: (1) the result works (tests green, builds, runs), (2) fewest
tokens, (3) wall time. A cheaper run that ships a broken app is a regression,
never a win.

It spends real tokens and real wall-clock. It is **never** part of `test:*`.

## The suite

Eight specs under `specs/<id>/`: `spec.json` (the prompt, setup, acceptance,
probe, rubric), `seed/` (the starting project; tabulate is cloned from its
public repository instead) and `hidden/` (acceptance tests the run never sees,
copied over the finished project before acceptance runs).

| id | tier | stack | what it exercises |
|---|---|---|---|
| todo-cli | control | Node CLI | the smallest real change: a flag, tests |
| node-api | short | Express | two endpoints with validation, supertest |
| static-site | short | HTML/CSS | a new page, nav on every page, responsive fix |
| py-cli | short | Python argparse | a subcommand, unittest |
| react-widget | short | Vite + React + Vitest | a stateful, accessible component; build must pass |
| bugfix-lib | short | Node library | three planted bugs from symptoms; regression tests; tests untouched |
| inventory-api | long | Express | six features from a spec, failing suite to green, modules, no new deps |
| tabulate-refactor | long | Python (python-tabulate 0.9.0) | split a 2,700-line module into a package, behaviour and API unchanged |

Acceptance is AUTOMATED and strict: each step is a shell command that must
exit 0 on a clean checkout of what the run left behind (its branch, merged or
not), with the hidden tests copied in; `probe` starts the app on a free port
and asks it one question. Quality beyond pass/fail is scored by `judge.mjs`: a
separate model run (Opus by default, on the workstation, never on the box under
test) scores correctness, completeness, code quality and hygiene 0–10 from the
task, the diff, the acceptance results and the run's report — blind to the
settings, two samples averaged.

## Running it

On the box (owner cookie minted locally, as `../lib/box.mjs` does — the
settings switch is owner-only):

```sh
node bench/diet/run-suite.mjs --label base --concurrency 2 \
  --settings '{"effort":"ultracode","reviewPass":true,"completionAttempts":2,"maxTurns":400}'
node bench/diet/run-suite.mjs --label xhigh --concurrency 2 --settings '{"effort":"xhigh",...}'
```

`--provider clawbox-ai|anthropic` picks the account per run; `--specs a,b`
narrows the suite; every lever the run depends on should be named in
`--settings` so nothing carries over from the previous configuration.

On a workstation, over the copied results:

```sh
node bench/diet/judge.mjs bench/diet/results/base          # Opus rubric, writes judge into each JSON
node bench/diet/compare.mjs bench/diet/results/base bench/diet/results/xhigh
```

Each spec run writes `results/<label>/<spec>.json`: the settings, the run's
status, acceptance steps with output tails, the probe, the diff, the run's
report, tool-call counts (and repeated reads), and **tokens per phase** from
the transcripts — main loop, sub-agents, review pass, extra completion
attempts — plus per model and the largest context the main loop carried.

### Counting tokens

The transcript is the source of truth: every API message counted once (by
message id, with the largest usage its lines carry), across the main session
and every sub-agent / workflow sidechain. The box's own run records are kept
beside it (`boxTokens`) but cannot simply be added up: a review pass resumes
the run's session, and the CLI reports a resumed session's whole history.

## The loop's rule

`compare.mjs` prints the before/after table and the verdict. A lever is
**kept** only when no spec that passed before fails now, the pass count does
not fall, the mean judge score drops by less than 0.5, and total tokens fall.
Levers are applied one at a time, each on top of the last kept configuration.
A spec whose files changed between two runs (`specHash`) is not comparable and
blocks the verdict.
