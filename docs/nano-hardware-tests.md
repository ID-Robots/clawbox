# Nano hardware tests

The on-device test suite: a handful of checks that only mean something on a real
Jetson, run on **one** freshly reflashed board from the nano lab for the events
in [When it runs](#when-it-runs), after which the board is recycled — handed to the lab
host's reflash queue for a clean golden restore — whether the tests passed,
failed or were cancelled (see [How recycling works](#how-recycling-works)).

Everything that does not need the hardware already runs in the container CI
(`Tests`, `E2E`, `E2E Install`, `Build identity`). This suite is only the rest.

## When it runs

In **batches** since 20 Oct 2026: a pull request into `beta` no longer takes a
board of its own. The check is **On-device tests (nano-lab)**, the workflow
`.github/workflows/nano-hardware-tests.yml`, and a board runs on

| Event | Tests |
|---|---|
| a pull request into `main` (the `beta` → `main` promotion), drafts included, when it is opened or reopened and on every push to it | the ones its changes reach, plus the core smoke set ([Which tests a run picks](#which-tests-a-run-picks)) |
| a pull request into `beta` labelled `nano-full` or `nano-long` | all of them (`nano-long`: the long tier too) |
| a dispatch ([Dispatching a branch](#dispatching-a-branch)) | all of them (`long` ticked: the long tier too) |
| every second night, 01:00 UTC, on `beta`'s head: `.github/workflows/nano-hardware-tests-schedule.yml` dispatches it | all of them — **only once that file is on `main`**, see [The night run](#the-night-run) |

Pushes to `beta` or `main` no longer start it. A pull request that does take
a board runs as long as:

| Condition | Why |
|---|---|
| The PR's branch lives in **this** repository | A fork's code never runs on the lab host (see [Safety](#safety)). |
| The PR does **not** carry the label `skip-nano` | The only opt-out. |
| The PR changes something besides documentation | See [Docs-only pull requests](#docs-only-pull-requests). |

Since 2 Oct 2026 **On-device tests (nano-lab)** is a **required** check on
`beta`, and a skipped run (a PR into `beta` without `nano-full`/`nano-long`, a
docs-only PR, `skip-nano`) counts as passing.

### The night run

GitHub starts a `schedule:` trigger only from the workflow files on the
repository's **default branch**, `main` — never from `beta`'s. Until a
promotion carries `.github/workflows/nano-hardware-tests-schedule.yml` to
`main`, GitHub does not know that workflow at all: no night run happens, and
`beta`'s head reaches a board only through a dispatch or a labelled pull
request. Whether it is live:

```bash
gh workflow list --all | grep 'every 2nd night'   # nothing: the night run is not live yet
```

Until it is, dispatch `beta` by hand after the merges that matter (add
`-f long=true` for the long tier):

```bash
gh workflow run nano-hardware-tests.yml --ref beta -f ref=beta
```

### Drafts and labels

A **draft** runs like any other PR that takes a board: the coding agent opens
most of our PRs as drafts, and the board run is part of the checks it waits for. Marking a draft
ready for review starts no second run — its head commit has already been
tested, and the check stays on that commit. Labels start nothing either: the
review bots' and auto-triage labels never cost a board.

```bash
gh pr edit <PR number> --add-label skip-nano     # this PR: no more board runs
```

`skip-nano` counts from the next event: adding it does not stop a run already
going (that always finishes, its recycle included), and removing it does not start
one — the next push or reopen is judged with the labels the PR has then. On a
`skip-nano` PR the check shows as skipped.

The `nano-test` label of the first version (opt-in) is gone; it does nothing
any more.

`skip-nano` is not created by the workflow. A maintainer creates it once:

```bash
gh label create skip-nano --color BFD4F2 \
  --description "Do not run the nano-lab hardware tests on this PR"
```

### Docs-only pull requests

A pull request that changes nothing but documentation gets no board. The
workflow's first job, **Needs a board?** (`plan`, on `ubuntu-latest`, seconds),
lists the files the PR changes at the commit under test and hands them to
`scripts/nano-tests/needs-board.sh`. A file is documentation when it matches

- `docs/**`, `docs-site/**` or `**/*.md` (at any depth, the root included),
- **except** anything under `config/`: `config/clawbox-bootstrap.md` and
  `config/clawbox-workspace-guide.md` are markdown, but `gateway-pre-start.sh`
  seeds them into the agent's workspace on the box.

When every file is documentation the board job is **skipped**, and `plan`'s job
summary and the PR comment say why. Both sides of a rename count (code moved
into `docs/` still gets a board), matching is case-sensitive like GitHub's own
path filters, and every doubt gets a board: no file listed, more than GitHub's
300-file compare can show, or a failed API call. This is a job, not a
`paths-ignore` on the trigger, because `paths-ignore` would hide the check
entirely instead of reporting it as skipped.

To put a docs-only PR on a board anyway, dispatch its branch (below) —
`plan`'s summary prints the exact command.

### Which tests a run picks

A pull request runs only the tests its changes reach, plus a core smoke set;
everything else runs on a dispatch (the night run is one). `plan` hands the PR's changed files to
`scripts/nano-tests/select-tests.sh`, which reads the map from the tests'
own headers:

| Header (first 20 lines of a test) | Means |
|---|---|
| `# covers: GLOB GLOB …` | the source areas the test exercises, as shell `case` patterns over repository paths (`*` crosses `/`); as many lines as it needs |
| `# select: always` | part of the **core smoke set** every run includes: `10-build-identity`, `20-services`, `30-chat-turn` |

A changed file picks every test whose `covers` match it; a changed test file
picks that test. Files that never reach a board pick nothing: documentation,
`src/tests/`, `e2e/`, `e2e-install/`, the CI files other than this workflow,
the test and lint configs. The board then runs the core set and the picked
tests; every other test is reported as a skip, *not affected by this change*,
in the TAP output, the job summary and `summary.json` (`selection`).

**Every doubt runs every test** — the full suite is the safe answer:

- a changed file that no test's map covers (`install.sh`, `package.json`,
  `bun.lock` and most of `src/lib/` are deliberately unmapped);
- the runner itself: `scripts/nano-tests/*.sh`, this workflow, and
  `scripts/public-hygiene.mjs`, which redacts the board's logs;
- a list of changed files that is incomplete or empty;
- a dispatch (the night run included) and a pull request labelled
  **`nano-full`** (or `nano-long`). `plan` reads the PR's labels when it runs,
  so add the label and re-run the workflow (or push) to get the full suite.

`plan`'s job summary and the board job's summary both say which tests ran and
why. The map is in the tests on purpose: a test that starts exercising a new
area adds a `# covers:` line in the same change, and the self-test fails a
pattern that matches no file.

### Dispatching a branch

**On a branch of this repository** — dispatch it:

```bash
gh workflow run nano-hardware-tests.yml --ref beta -f ref=<branch>
```

`--ref` names where the workflow file is read from: without it `gh` uses the
default branch, `main`, which has no copy of this workflow yet.

The board is always rebuilt from a **branch**: `nano-ci rebuild` hands its ref
to the board's `scripts/force-update.sh`, which checks out `origin/<branch>`
and has no way to check out a bare commit or a tag. So the dispatch input is:

| `ref=` | What runs |
|---|---|
| a branch (`beta`, `refs/heads/beta`) | that branch at its head now |
| a tag (`v2.2.2`, `refs/tags/v2.2.2`) | only if a branch's head is exactly the tag's commit — then that branch; otherwise refused with the `git push` that makes one |
| a commit SHA (7–40 hex digits) | only if a branch's head is exactly that commit — then that branch; otherwise refused |
| `refs/pull/*`, `pull/*`, `refs/remotes/*`, anything else | refused |

The job resolves the input with `git ls-remote` against this repository, and
the branch must pass the same character check as `force-update.sh`
(`^[A-Za-z0-9._/-]+$`, no leading `-`) before it reaches `nano-ci`. Since only
a branch of this repository is ever used, a fork's commit — GitHub serves
those by SHA from this repository too — cannot be dispatched onto a board.
A dispatch needs write access.

**Re-running** a finished or failed job is the Actions page's *Re-run jobs*, or
`gh run rerun <run id>`. It reserves a board afresh. A re-run judges the event
it re-runs, labels included, as they were then — and rebuilds the board from
the PR's branch as it is now, so re-running an older commit's run after newer
pushes ends as [superseded](#superseded-by-a-newer-push).

## Parallel runs

Each pull request has its own concurrency group,
`nano-lab-pr-<PR number>` (a dispatch: `nano-lab-pr-<ref it was dispatched
from>`), with `cancel-in-progress: false`:

- **Within one PR, one board job at a time, and a running one is never
  cancelled** — its recycle (or the release fallback) must run. A push queues
  behind the PR's own running job. GitHub keeps only ONE pending job per group,
  so when a third push arrives the second one is cancelled before it starts: it
  never had a board, nothing needs recycling, and it was an older commit of the
  same PR. That cancelled job does not touch the PR comment. A job cancelled
  after it started — by a person while it waited for a free board, or by its
  timeout — does: the section then says *cancelled* for that commit.
- **Different PRs run side by side.** Two limits bound how many: the number of
  runner instances with the `nano-lab` label on the lab host (each runs one job
  at a time; on 2 Oct 2026 the lab host runs four — `lab-runner-1` …
  `lab-runner-4` — so **at most four PRs' board jobs run at once**), and the
  number of clean boards that `nano-ci reserve` finds FREE (see
  [Throughput and waiting](#throughput-and-waiting)). A fifth waits on GitHub
  for a free runner instance, before its 90 minutes start.

### Superseded by a newer push

The board is rebuilt from the PR's **branch**, so it gets whatever the branch
points at when the rebuild fetches it. When someone pushed to the PR after the
run was queued, that is a newer commit than the one under test. The verify
step then sees the board on another commit, and asks `git ls-remote` where the
branch is now:

- the board **moved** during the rebuild (it is not on the commit it had
  before — or, if that commit could not be read, it is exactly the branch's
  head now) **and** the branch is no longer at the commit under test → the run
  is **superseded**: a `Superseded by a newer push` warning, the suite is not
  run, the job **passes**, and the job summary and PR comment say
  *superseded, not tested*. It is not a hardware failure and does not fail the
  PR: the newer push has its own run, queued behind this one in the PR's
  concurrency group, and that run reports on the commit that is now the PR's
  head. The board is recycled as always.
- anything else → `Wrong commit on the board`, which fails the job: the
  rebuild left the board where it was, its commit could not be read, or it is
  on some commit although the branch never moved.

### No free board

When no clean board is free — the boards are leased by other PRs' jobs, by
people (`nano-lease list`) or by the reflash service that is still restoring
them — `nano-ci reserve` exits 3. The lab host keeps a small **CI pool** of
boards that only CI uses and that `reserve` hands out first, so this is rare.
The job asks again with a growing pause (1 minute, ×1.5 each time, at most 5)
for up to **30 minutes**, logging each try. If a board frees up it carries on,
and its summary says how long it waited. If none does, the job ends
**skipped, not failed**: a warning `Skipped: no free nano-lab board`, the
board steps are skipped, and the PR comment says *skipped — no free lab
board*. No board is lab capacity, not a verdict on the commit; re-run the job
to test it. It never held a board, so there is nothing to recycle. How many clean boards the lab returns an hour:
[Throughput and waiting](#throughput-and-waiting).

The wait comes out of the suite's 40 minutes, never out of the room the
`always()` steps keep at the end: the suite's cap is 40 minutes less every
started minute spent waiting, and never less than 20.

## What runs where

| Where | What |
|---|---|
| GitHub (`ubuntu-latest`), every PR | `shellcheck` over `scripts/nano-tests/` and its self-test (`scripts/nano-tests/selftest.sh`, also run by `npm test` through `src/tests/unit/nano-tests-runner.test.ts`) — the runner, with fixture tests and a stub `nano-ci`, no board. `npm test` also covers the docs-only classifier (`src/tests/unit/nano-tests-needs-board.test.ts`). |
| GitHub (`ubuntu-latest`), this workflow | **Needs a board?** (`plan`): the gate, the changed files and the docs-only verdict. **PR comment**: the results section of the PR's CI Summary comment. Neither touches the lab. |
| The nano-lab runner (`self-hosted, nano-lab`) | The board job of `.github/workflows/nano-hardware-tests.yml` and `scripts/nano-tests/run.sh` |
| One reserved board | Only what `nano-ci ssh` runs there, as the `clawbox` user |

The runner host reaches a board **only** through its `nano-ci` helper. This
repository holds no board address, key or password:

| `nano-ci …` | Does |
|---|---|
| `reserve "<purpose>"` | leases one FREE board with the **clean** marker (freshly reflashed, see [How recycling works](#how-recycling-works)) and prints `SERIAL IP LAB` (CI pool boards first; exit 3: none free — the job asks again with backoff for 30 minutes, then ends skipped) |
| `rebuild <serial> <branch>` | force-updates the board's checkout to `origin/<branch>` (`scripts/force-update.sh`) and rebuilds it (5–10 min); fails when force-update does. A **branch** only: there is no `origin/<sha>` or `origin/<tag>`, so a SHA or a tag fails |
| `health <serial>` | exit 0 when `clawbox-gateway` and `clawbox-setup` are active and the dashboard answers |
| `ssh <serial> <cmd…>` / `scp <serial> <src> <dst>` | runs a command on / copies a file to the board as `clawbox` |
| `recycle <serial>` | hands the board to the reflash queue (seconds; never waits for the reflash). The board is no longer yours once it returns 0 — the job's step 7 |
| `cleanup <serial>` | **legacy, by hand only** — the workflow no longer calls it: rebuilds the board back to `beta` and wipes test projects; reflashes it from the golden image if it is still unhealthy (~40 min) |
| `release <serial>` | releases the lease — in the job only the **fallback** when `recycle` failed (step 8) |

A reserved board shows as leased in `nano-lease list` like any board a person
has locked.

## The job

Three jobs. **Needs a board?** (`plan`) decides, the board job does the work,
and **PR comment** reports it.

0. **Needs a board?** (`ubuntu-latest`): the gate above, then the docs-only
   verdict and the test selection ([Which tests a run picks](#which-tests-a-run-picks)).
   `false` skips the board job, with the reason in this job's summary.
1. **Resolve the branch under test**: a PR's head branch and head commit; a
   dispatch's input resolved to a branch (see
   [Dispatching a branch](#dispatching-a-branch)). The branch must pass
   `force-update.sh`'s character check. Then **check out** the commit under
   test — the PR's head commit, not the merge commit — with plain `git` into an
   emptied workspace (see [What is published](#what-is-published)).
2. **Resolve the commit** and check the runner host has `nano-ci`, `jq`,
   `timeout`, `base64` and `node`, and that the commit carries
   `scripts/public-hygiene.mjs` — the redactor the rest of the job prints
   through. A branch from before it was added is refused: rebase it on `beta`.
3. **Reserve** a board: `nano-ci reserve "clawbox PR #<n> <sha>"`, asked again
   with a growing pause for up to 30 minutes while no board is free; then the
   job ends skipped (see [No free board](#no-free-board)). The
   board's address is masked in the log as soon as the reservation is read.
4. **Rebuild** the board from the PR's branch, `nano-ci rebuild <serial>
   <branch>` (≤ 45 min) — the commit under test is written to the board first,
   and the rebuild checks the board reached exactly that commit, retrying once
   with the memory freed when the build failed — **wait** for `nano-ci health` (≤ 10 min), and
   **verify** that the board's `git rev-parse HEAD` is the head commit. A board
   on a newer commit of the branch is
   [superseded](#superseded-by-a-newer-push) — the job passes without testing,
   the newer push has its own run. A board on any other commit fails the job
   before a single test runs.
5. **Run the suite** (≤ 40 min, less any time spent waiting for a board, never
   less than 20; not on a superseded run): `scripts/nano-tests/run.sh <serial>`
   with `NANO_TESTS_SELECT` from `plan`.
6. **Redact** `results/` and upload it as the artifact
   `nano-results-<run id>-<attempt>`, and write the redacted **job summary**:
   board serial and lab, the commit, one row per test with its result,
   duration and reason, what each step did, whether the job was cancelled, and
   how long it waited for a board.
7. **Recycle** (`if: always()`): `nano-ci recycle <serial>` hands the board to
   the reflash queue within seconds; from then on it is not the job's. A
   recycle that fails fails the job.
8. **Release — fallback only** (`if: always()` and the recycle did not
   succeed): `nano-ci release <serial>`. Skipped after a successful recycle.
9. **PR comment** (`ubuntu-latest`): the *Nano hardware tests* section of the
   PR's one **CI Summary** comment — the comment `Tests`, `E2E` and
   `E2E Install` already edit in place — is rewritten with the verdict, the
   commit, the board and what became of it (*recycled for a clean reflash*,
   *recycle FAILED, released* or *recycle FAILED and release FAILED: board
   needs a look*), and the job summary. One comment per PR,
   never one per push. A skipped docs-only run says so there too. Only a board
   job cancelled before it ever started — the pending job a newer push
   replaced in the PR's concurrency group, or one a person cancelled while it
   still waited for a runner instance — leaves the section alone: it never ran
   a step, so its `reserve` output is empty. A cancelled job that started
   reports *cancelled*, with or without a board.

The board job on the lab host holds only a read token (`contents: read`, never
handed to its `git` checkout). The comment is written by the separate job on
GitHub's runners, the only one with `pull-requests: write`; it takes nothing
from the PR's tree but the redactor the comment passes through.

## What is published

This repository is public, and so is everything the workflow writes: the job
log, the job summary, the PR comment and the results artifact. None of it may
name the lab — no board address, no private address of any kind, no host or
user name of the lab, no home folder (TASK-1366). So:

- The board is named by its **serial and lab** only — in the log, the summary,
  `summary.json` and the comment.
- The reserve step masks the board's address (`::add-mask::`) the moment it
  reads the reservation and never prints it; GitHub then shows `***` wherever
  it would appear in the job's log.
- Everything `nano-ci` prints (rebuild, health, recycle, release, and what ssh
  says when a commit cannot be read) passes through
  `scripts/public-hygiene.mjs redact`, which turns the board's address into
  `<board-ip>` and any other private address, home folder, internal name or
  credential into a placeholder. `run.sh` passes every test's output through it
  before the log is written, so the suite's output and its logs are redacted
  at the source.
- The job summary, the PR comment and every file in `results/` go through the
  same redactor before they are written or uploaded. A summary the redactor
  cannot process is withheld, results it cannot process are not uploaded, and
  a comment it cannot process is not posted.
- The results folder is relative to the workspace, and the board job checks
  out with plain `git` rather than `actions/checkout`, which logs the
  workspace's absolute path — that path names the runner host's home folder.

What the workflow cannot change: GitHub prints the runner's name and machine
name at the top of every job's log, before any step runs. Those are set on the
lab host (the runner registration and the host name), and must be neutral
there.

Every pull request's added lines are checked for the same things by the
`public-hygiene` check (`.github/workflows/public-hygiene.yml`, on GitHub's
runners).

## How recycling works

Every board a run gets was **restored from the golden image and provisioned to
the current `beta` head** since the last time anyone used it.

Step 7 runs whenever a board was reserved — after a pass, a failed test, a
failed rebuild, a wrong commit, a timeout or a cancel (`always()` covers a
cancel too, and the summary then says the job was cancelled). `nano-ci recycle
<serial>` hands the board from the CI lease to the **reflash service** on the
lab host (outside this repository) and returns 0 within seconds: the job never
waits for the reflash, and the board is no longer the job's. The service then

1. restores the board from the golden image (~20 min);
2. provisions it to the current `beta` head — claimed, ClawBox AI and the
   coding agent on — and verifies it: the build identity is the `beta` head,
   `clawbox-gateway` and `clawbox-setup` are active, and a real chat turn
   answers (~15 min);
3. releases it FREE with a **clean** marker.

`nano-ci reserve` hands out only boards with that marker, so every run gets a
freshly reflashed board, never one another run or a person has touched since.
A board whose reflash fails is **quarantined** by the service and never handed
out. The service reflashes one board per lab at a time, `nano-lab1` and
`nano-lab2` in parallel.

A recycle that fails fails the job with `Board recycle failed`, says so in the
summary and the PR comment, and only then does step 8, the **fallback**,
release the board: it is still leased to `ci` and must not stay so. After a
recycle that succeeded the release is skipped — the board belongs to the
reflash service, and the broker would refuse to release it for `ci`. A board
the fallback released carries no clean marker, so `nano-ci reserve` does not
hand it to a run again until it has been reflashed.

The budget: the job has 90 minutes; the steps before the recycle are capped at
20 (waiting for a board) + 20 + 10 + 40, but the suite's cap shrinks by the
wait, so they never take more than about 70. The recycle takes seconds — the
reflash runs on the lab host after the job, not inside it — so the job no
longer keeps room for a ~40-minute cleanup, and the rest of the 90 is headroom
for the upload, the summary, the recycle and the fallback release. A normal run
spends about 25 minutes. Each test also has its own deadline (below), so one
stuck test cannot eat the suite's.

### Throughput and waiting

A reflash takes about 35–40 minutes per board, one per lab at a time, so the
lab returns **about 2–4 clean boards per hour across both labs**. When fewer
than 2 clean boards are free, a PR waits for one with the existing 20-minute
board wait (one `nano-ci reserve` try a minute, see
[No free board](#no-free-board)) and then fails with `No free nano-lab board` —
re-run the job when `nano-ci status` shows a clean board. Boards whose reflash
fails are quarantined and never handed out.

### Cancelled, or the runner died

Nothing in the workflow cancels a running board job: the per-PR concurrency
group does not cancel in progress (see [Parallel runs](#parallel-runs)). A
person can still cancel a run; the recycle (and, if it fails, the release)
then runs as above. If the job is stopped outright before the recycle step
finishes, neither step runs and the board stays leased to `ci` — nobody else
gets a board that was not reflashed. Find it in `nano-lease list` and recycle
it by hand on the lab host: `nano-ci recycle <serial>`.

If the runner host itself dies mid-job, nothing on GitHub can recycle the
board: `nano-lease list` shows it still leased to `ci`, and it is recycled by
hand the same way, `nano-ci recycle <serial>`. Its lease would expire after 24
hours, but only a reflashed board is ever handed to a run again, so recycle it
rather than wait.

## The tests

Each is `scripts/nano-tests/tests/NN-name.sh`, run in order, each with its own
deadline. A failed test does not stop the next one. Neighbours that share a
`# parallel: GROUP` header run **side by side**, each under its own deadline,
and their results still come out in NN order with their own durations: only
tests that read the box do — no restart, no reboot, no memory pressure, no
`sudo` (the self-test refuses a parallel test that uses one). Today that is
`10-`, `20-` and `25-` (`probes`), `30-` and `40-` (`agent`, after the probes
have waited out the gateway's settling) and `77-` and `78-` (`after-boot`).
`NANO_PARALLEL=0` runs every test on its own.

| Test | Deadline | Checks | Skips when |
|---|---|---|---|
| `10-build-identity` | 5 min | `/setup-api/system/build-identity?force=1` names the head commit for both the checkout and the build, `dirty` false for both, `drift.buildVsCheckout` `match`, the stamped build is the deployed `BUILD_ID`; `clawbox-setup.service` started **after** that build was deployed (so it serves it); `scripts/verify-build-identity.sh` passes on the board | — |
| `20-services` | 5 min | `clawbox-gateway` and `clawbox-setup` active, `clawbox-vnc` too when the board enables it; `nano-ci health`; `/setup-api/gateway/health` 200 with `available: true`; the dashboard serves `/login`; `~/.npm-global/bin/openclaw --version` works as `clawbox` | — |
| `25-gateway-channels` | 5 min | the gateway's own `/startupz` answers 200 and `/readyz` reports its event loop not degraded on two probes in a row (a gateway that just started says `degraded: cpu` for its first seconds: that is waited out for up to 180 s, not reported); `/readyz` lists nothing in `failing`; `openclaw channels status --json` has no status issue and every enabled channel account is running with no last error | — (no channel configured: only the gateway half runs) |
| `30-chat-turn` | 11 min | `openclaw agent --agent main -m "Reply with exactly this text and nothing else: NANO-CI-OK <serial>" --json` answers `NANO-CI-OK <serial>` within 240 s through the `main` agent's configured provider (ClawBox AI on every lab board); retried once after 60 s | — |
| `40-coding-agent-run` | 10 min | `POST /setup-api/coding-agent/run` in a fresh `~/Projects/nano-ci-<run id>` (or inside the owner's project folder if one is set) asks for `hello.txt` with one given line; `runs?id=` is long-polled until the run settles; it must be `completed` and the file must hold exactly that line | — |
| `41-coding-agent-mcp-servers` | 15 min | a stand-in board MCP server is registered with the board's own harness (`openclaw mcp set`, a fixture token in its env); the owner's checklist (`GET /setup-api/coding-agent/mcp-servers`, an owner cookie minted on the board) lists it usable and unticked and never the token, the MCP bearer may not tick it, the owner ticks it and "ClawBox read-only tools" for a fresh code project; a run there must call the board's tool (which answers after 30 s, so the run stays live) and `device_status` — while it runs the Coding Agent app itself (`/app/coding` in a headless Chromium of the box's own, with an owner session, the run opened by the app's open-run event) shows its live card with both servers in the timeline, its record names both servers and the harness argv keeps `--strict-mcp-config` with a 0600 `--mcp-config` file under `data/coding-agent-streams/` and no token; it completes with the board's answer on disk, the token is in no run record, history or evidence file, and the config file is gone. Undone on the way out | OpenClaw is not installed |
| `42-coding-agent-openai` | 10 min | OpenAI as a coding provider on the board's pinned Codex CLI (`config/codex-target.txt`, `~/.local/bin/codex`): its `exec` and `exec resume` take `--json`, `--skip-git-repo-check`, `-c` and `-m`, `login` takes `--device-auth` and `logout` answers (help read with a throwaway `CODEX_HOME`, never `~/.codex`); the status lists OpenAI with its models and finds the CLI; the MCP bearer gets 403 from `GET /setup-api/coding-agent/openai` and the owner (a cookie minted on the board) its state, with nothing key-shaped in it; Settings → Coding Agent in a headless Chromium of the box's own shows the OpenAI provider row (Connect, or Connected) and the OpenAI card's status, key field and "Sign in with ChatGPT"; pressing that shows OpenAI's own device page and a one-time code (never printed) and Cancel ends it; with an OpenAI credential on the board, one small run on `openai` must complete with exactly the line asked for | the run step, when the board holds no OpenAI credential for coding runs |
| `45-codex-auth-mirror-lock` | 10 min | the codex credential mirror is not held up by the live gateway's writes. A fixture login (a `state-db` shared store holding `openai:chatgpt`, reached through `OPENCLAW_STATE_DIR`, and an app-server `codex-home` that has rotated) in a throwaway folder whose agent `openclaw-agent.sqlite` is a symlink to the live main agent's; real chat turns (two rounds of two) keep the gateway writing that database while `scripts/codex-auth-mirror.js` runs over and over as `clawbox-codex-auth-sync.service` runs it. Every pass must exit 0 in under 2 s, reach the write-back and find no profile to record the rotation in, adopt nothing and leave the live `auth_profile_store` row unchanged; every other pass runs under a `node --require` statement recorder, and on the live store those may only open read-only and read its `auth_profile_store` row first, never `BEGIN IMMEDIATE` or a write; at least one pass must run while the gateway holds the write lock (a non-waiting probe every 10 ms), and a `BEGIN IMMEDIATE` queued beside the passes shows what beta's write-back waited | the main agent holds a ChatGPT sign-in of its own (never written by a fixture), or any other profile under `openai:chatgpt` (it shadows the fixture login); no SQLite agent store; the gateway never held the lock during a pass (that leg only) |
| `50-memory-pressure` | 7 min | swap is on with at least 1 GB; a throwaway hog (oom_score_adj 1000, random bytes so zram cannot compress it away) takes memory down to ~350 MB available and holds 45 s; the gateway's `/healthz` and the dashboard's `/login` must answer at least 3 in 4 probes meanwhile; afterwards `clawbox-gateway` and `clawbox-setup` are the same processes (no OOM kill, no restart) and the gateway settles again | — |
| `55-multi-user` | 10 min | the owner adds a user through `POST /setup-api/users` (the real `user_add` root step) and the account is a `clawbox-users` member in no admin group, with `signIn.available` true; a wrong password is refused 401 and the user's own password signs them in through `/login-api`; with their cookie the routes that used to answer `owner_only` (preferences, kv, coding-agent runs, Files, store, VNC, ClawKeep, Prime Radiant, Users, Wi-Fi, AI status) answer them and the desktop page serves, while the owner's password route and the gateway console page answer 403 and `ws-config` hands them no token; their chat socket gets a hello naming `agent:main:clawbox-user-<name>` and no device token, the owner's `chat.history` is refused `FORBIDDEN`, a real turn on their key is answered and no frame of another session arrives; the owner removes them, the Linux account is gone and their password no longer signs in. Both cookies are minted on the board from `data/.session-secret` and never leave it | — |
| `60-media-tools` | 10 min | a coding run asked to use `generate_image` leaves a PNG of at least 4 KB and 64×64 px (`generate_audio` and a clip of at least 8 KB when only audio is on), and the run's `mediaGenerated` counter shows the tool was used | the coding agent's `generateImages` and `generateAudio` are both off |
| `65-prime-radiant-mcp` | 5 min | the box's own MCP server, started over stdio from the checkout as a harness starts it, lists all 31 `prime_radiant_*` tools; `prime_radiant_status` answers; with a page in the wiki, `prime_radiant_page` reads the first one `prime_radiant_pages` lists and `prime_radiant_search` answers for its title (hits, or Memory Shard's off / indexing state). Read-only | the wiki has no page yet (search and page half only) |
| `66-prime-radiant-core` | 15 min | the Prime Radiant core block as the MODEL receives it from the pinned gateway: a capture model on a loopback port (OpenAI-compatible, it answers and keeps each request), added for the test as providers `nanoci-core` and `llamacpp-nanoci-core` with `openclaw config set` and removed after it, takes main-agent turns (`openclaw agent --agent main --model …`). Off by default; with 8 linked pages made by the owner (6 eligible, a confidential and a secret-ref one that every other page links to) and `context` on with n=3, a NEW session sends ONE block, exactly the one on disk, the 3 most-linked pages by the box graph, within maxChars, neither hidden page in it, and its next turn still one block and none in the history; the own chat of a ClawBox user (`agent:main:clawbox-user-…`) and a turn on an on-device model get none; n=50 lists min(50, eligible); a page set to confidential leaves at once; a real nightly pass merges into main, the block is rebuilt from the merged main and the next new session gets it with no gateway restart (same MainPID and start time, no new startup in the gateway log); off again, none. Pages, setting and providers are put back; a missing block prints the core view of the plugin (`plugins inspect --runtime`, its entry, the gateway log) | the night merged nothing or was held (the night half only) |
| `75-full-reboot` | 15 min | ONE pass, so the board reboots once: first the gateway is restarted the way the box does it (`sudo -n systemctl restart clawbox-gateway.service`, or `systemctl --user` for a legacy user unit); within 120 s it is back as a new process and `/setup-api/gateway/health` reports it available, and the `30-chat-turn` turn passes again. Then a REAL reboot (`sudo -n systemctl reboot`, the power menu's grant): the board comes back with a new boot id within 6 min, a `/tmp` file is gone and a home file kept; `clawbox-gateway`/`clawbox-setup` come back enabled and active by themselves, no `clawbox*` unit failed; **boot-time readiness**: the gateway's early `degraded: cpu` is waited out, and it must be started and settled within 5 min; same commit, `/login` 200, and a chat turn answers. Reboot-to-answer, -to-settled and -to-chat times are noted. A failed restart is reported and the reboot still runs (this was `70-reboot-survival` and `75-full-reboot`) | — |
| `76-gnome-initial-setup` | 15 min | GNOME's first-run assistant does not run for `clawbox` after boot. When `~/.config/gnome-initial-setup-done` is missing or newer than the boot (`nano-ci rebuild` runs no install.sh step), `step_gnome_initial_setup_done` is run from the board's checkout as `clawbox` — it must write `yes` and end the running assistant — and the board reboots as in `75`. After a boot that started with the marker, once the session is 90 s up: the marker is `clawbox`'s and holds `yes`, and `pgrep` finds no `gnome-initial-setup` for `clawbox` | no GNOME session for `clawbox` (desktop off) |
| `77-vnc-clean-boot` | 3 min | in the boot `75` made: `clawbox-vnc` is active, and the current boot's journal (`journalctl -b`, systemd's own lines for the unit) shows it started exactly once with no `clawbox-vnc.service: Main process exited` line, so the first-boot VNC unit did not restart a desktop that was already up. Whether that unit ran this boot is noted. A journal that shows no start of the unit at all (the `clawbox` user cannot read it) is a failure, not a pass | `clawbox-vnc` undefined, or disabled (headless) |
| `78-one-browser` | 4 min | in the boot `75` made: exactly one browser process serves a DevTools port, on the profile the Browser app reports, and none runs on a gateway-managed profile; the gateway's browser config is attach-only on that port and the default profile; Close in the Browser app answers `409 shared_browser` and the browser keeps its pid | Chromium not installed, or the isolated assistant browser is configured |
| `79-browser-clean-start` | 7 min | the shared browser starts clean (`scripts/lib/browser-clean-start.sh`). Twice — after a clean stop of its unit (as a reboot does) and after a SIGKILL (its profile must then record a crashed exit) — with three tabs of its own open and its profile then set to restore the last session, it is started again with the Browser app's Open and must have exactly one tab, none of the three, a new pid and `--hide-crash-restore-bubble` on its command line. Started twice more while it runs — Open (`alreadyRunning`) and `scripts/launch-browser.sh` (exit 0) — it keeps its pid and its one tab | Chromium not installed, or the isolated assistant browser is configured |
| `85-update-rollback` | 70 min, **long tier** | the board is put on the current release (head of `main`, via `nano-ci rebuild`), then updated to `NANO_BRANCH` through the box's own updater (`/setup-api/update/run`) while every `next build` it starts is SIGKILLed, as an OOM kill would; the update must end `failed` with a reason, and the box must still serve `/login`, settle its gateway, serve a build that names its checked-out commit (no drift) and answer a chat turn | `NANO_BRANCH` unset |
| `90-upgrade-from-release` | 70 min, **long tier** | from the current release (kept when `85` left the board there, rebuilt otherwise), an owner's update to `NANO_BRANCH` through `/setup-api/update/run` must end `completed` on exactly `NANO_SHA`, with no drift, a settled gateway, no failed `clawbox*` unit, a project file, the setup/password flags, the main agent's model and its session store unchanged, and a chat turn that answers | `NANO_BRANCH` or `NANO_SHA` unset |

Notes on what the brief asked for and what the box actually offers:

- **`/health`.** The dashboard has no public `/health`: a bare `/health` is
  session-gated and proxied to the gateway, and the MCP bearer opens
  `/setup-api/*` only (`src/middleware.ts`). The suite asks
  `/setup-api/gateway/health` and `nano-ci health` instead.
- **ClawBox AI only.** The suite tests the happy path: a box on the ClawBox
  AI plan, which is how every lab board is set up. The chat turn goes through
  whatever provider the `main` agent is configured with; the suite does not
  assert which one. On-device models (Gemma on llama.cpp, the wizard's ollama
  presets) are not tested for now.
- **A reboot.** `75-full-reboot` restarts the gateway the way the box does,
  then reboots the whole board through `sudo -n systemctl reboot`, the grant
  the power menu uses — one reboot per run.
- **Readiness settles.** Every readiness wait in the suite
  (`wait_gateway_settled` in `lib.sh`) treats an early `degraded` event loop
  as a gateway still warming up and waits for two settled probes in a row; only
  a gateway still degraded when its budget runs out is a failure.
- **The long tier.** A test whose header says `# tier: long` rebuilds the
  board and runs the box's own updater, so it takes up to ~70 min. It runs only
  with `NANO_TESTS_LONG=1`: on a pull request labelled `nano-long` (add the
  label, then push or re-run the job — labelling alone starts no run) or a
  dispatch with `long` ticked; the job's limit is then 280 min. Otherwise it
  is reported as a skip.
- **The ClawBox edition.** The suite assumes the OpenClaw edition every lab
  board runs; on a Hermes-only board the gateway tests fail rather than skip.

### Secrets

Tests that call `/setup-api` authenticate with the board's MCP bearer
(`data/.mcp-token`). It is read **on the board** inside the same
`nano-ci ssh` command that uses it, handed to `curl` on stdin — never on a
command line, never printed, never copied to the runner. On top of that,
`run.sh` redacts bearer tokens, the session cookie and any
`token`/`password`/`secret`/`api key`/`cookie` value from every log before it is
written, and then passes it through `scripts/public-hygiene.mjs` (see
[What is published](#what-is-published)). Each coding run is a fresh folder with a run-id name; the folder is
removed at the end, and the board is reflashed from the golden image after the
run anyway.

## Results

`results/` holds one `<test>.log` per test (everything the test printed,
redacted) and `summary.json`:

```json
{
  "serial": "…", "lab": "…", "sha": "…", "run_id": "gh123-1",
  "started_at": "2026-09-30T10:00:00Z", "finished_at": "2026-09-30T10:14:12Z",
  "planned": 7, "total": 7, "passed": 5, "failed": 1, "skipped": 1,
  "interrupted": false, "ok": false,
  "tests": [
    { "name": "10-build-identity", "status": "pass", "reason": "",
      "duration_s": 12, "timeout_s": 300, "exit_code": 0, "log": "10-build-identity.log" }
  ]
}
```

`status` is `pass`, `fail` or `skip`; `reason` is the first `not ok` line, the
skip reason, `timed out after Ns`, `exited N: …` or `interrupted`. `run.sh`
exits 0 when nothing failed (skips are fine), 1 when something did, 130 when it
was cancelled (and still writes `summary.json` for what ran).

## Running it by hand

On the lab host, with a board you reserved yourself:

```bash
read -r SERIAL IP LAB <<<"$(nano-ci reserve "TASK-NNN: nano tests by hand")"
nano-ci rebuild "$SERIAL" <branch>                  # a branch, never a SHA or tag
NANO_SHA=<the commit the board runs> scripts/nano-tests/run.sh "$SERIAL"
scripts/nano-tests/run.sh --only 30-chat "$SERIAL"  # one test
NANO_TESTS_SELECT="10-build-identity 50-memory-pressure" scripts/nano-tests/run.sh "$SERIAL"  # these, the rest skipped
git diff --name-only origin/beta... | scripts/nano-tests/select-tests.sh  # what a PR would run
nano-ci recycle "$SERIAL"                           # to the reflash queue; no longer yours
```

Always recycle, also when the tests fail; only when `nano-ci recycle` itself
fails, release the board with `nano-ci release "$SERIAL"`. `NANO_SHA` defaults
to the commit your checkout is on — `10-build-identity` compares the board
with it.

## Adding a test

1. Create `scripts/nano-tests/tests/NN-what-it-checks.sh`. `NN` sets the order;
   the name is lower-case with dashes. Anything not named `NN-*.sh` never runs.
2. Start it like the others:

   ```bash
   #!/usr/bin/env bash
   # timeout: 300
   #
   # What this checks, and why it needs the real board.
   # shellcheck source=scripts/nano-tests/lib.sh
   source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
   ```

   `# timeout: NNN` (seconds, within the first 20 lines) is the deadline; the
   default is 600. Keep the suite inside the job's 40-minute cap. In the same
   first 20 lines: `# covers: GLOB …` for the source areas it exercises (a
   PR touching them runs it — see
   [Which tests a run picks](#which-tests-a-run-picks); without one it runs on
   pull requests only when its own file or an unmapped file changes),
   `# select: always` only for the core smoke set, and
   `# parallel: GROUP` only when it reads the box and nothing else.
3. Report with `lib.sh`: `ok "…"`, `not_ok "…"`, `skip "…"` (prints
   `ok # SKIP …`), `note "…"` for the log, and end with `finish`. The verdict is
   what the test prints — any `not ok` fails it, only `# SKIP` oks skip it, and
   a test that prints no result at all fails. Board output goes through `note`,
   never straight to stdout.
4. Talk to the board only through `lib.sh`: `board '<bash script>' ARG…` runs a
   script there as `clawbox` (arguments arrive as `$1…`, nothing to quote),
   `board_api METHOD PATH [JSON]` calls `/setup-api` with the bearer and sets
   `API_STATUS`/`API_BODY`, `api_json '<jq filter>'` reads the answer,
   `wait_gateway_health`, `chat_turn`, and the coding-run helpers
   (`fresh_project_dir`, `start_coding_run`, `wait_coding_run`,
   `expect_completed`, `remove_project_dir`).
5. Keep it self-contained: no state shared with another test except
   `results/`, and nothing left on the board for the tests after it — the
   board is reflashed only once the whole run is over.
6. Check it: `shellcheck -x scripts/nano-tests/*.sh scripts/nano-tests/tests/*.sh`
   and `bash scripts/nano-tests/selftest.sh` (both run in CI), then on a
   reserved board with `--only`.

## Safety

**External contributors never trigger the lab Nanos.** Two layers enforce it,
and a team rule backs them:

1. **On the lab host (the real fence).** Every `nano-lab` runner instance on
   the lab host (`lab-runner-1` … `lab-runner-4`) has a job-started hook
   (`ACTIONS_RUNNER_HOOK_JOB_STARTED`) that refuses every job that is not a
   same-repo pull request, a push or a dispatch of `ID-Robots/clawbox`. It
   runs before any step of the job, outside anything a PR can change. That
   matters because a `pull_request` run takes its workflow file **from the
   PR**: a fork could rewrite every `if:` in it.
2. **In the workflow (the second layer).** The `plan` job's `if:` and the board
   job's own both admit a `pull_request` only when its head repository **is**
   this repository, and the board job checks it again before it uses the PR's
   branch. A dispatch is only ever resolved to a branch of this repository
   (see [Dispatching a branch](#dispatching-a-branch)), so neither a
   `refs/pull/*` ref nor a fork commit's SHA reaches a board.

On top of both, the repository requires a maintainer's approval before any
workflow runs for an outside contributor. **Team rule: never "Approve and run"
a fork PR's workflows.** Approving runs the fork's own copy of the workflow,
which can aim any job at the lab runners: the hook refuses those, and the rule
means the hook never has to. If a contributor's change needs the lab, review
it, push it to a branch of this repository and open the PR from there.

The rest:

- `permissions: contents: read`, and the checkout on the lab host uses no
  token at all. Only the **PR comment** job, on GitHub's runners, may write
  (`pull-requests: write`); of the PR's tree it runs only the redactor,
  `scripts/public-hygiene.mjs`.
- Every value from the event reaches a shell through `env:`, never spliced into
  a script; the board serial and the branch are validated before `nano-ci`
  sees them.
- No credential for the lab or a board is in this repository. The lab host's
  `nano-ci` owns them.
