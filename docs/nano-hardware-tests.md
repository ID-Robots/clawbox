# Nano hardware tests

The on-device test suite: a handful of checks that only mean something on a real
Jetson, run automatically on **one** freshly reflashed board from the nano lab
for every pull request, after which the board is recycled — handed to the lab
host's reflash queue for a clean golden restore — whether the tests passed,
failed or were cancelled (see [How recycling works](#how-recycling-works)).

Everything that does not need the hardware already runs in the container CI
(`Tests`, `E2E`, `E2E Install`, `Build identity`). This suite is only the rest.

## When it runs

**Every pull request of ours into `beta` or `main`, drafts included,
automatically** — no label needed. It is part of the PR's suite like `Tests`
or `E2E`: the check is **On-device tests (nano-lab)**. The workflow
(`.github/workflows/nano-hardware-tests.yml`) runs when a PR is opened or
reopened and again on every push to it, as long as:

| Condition | Why |
|---|---|
| The PR's branch lives in **this** repository | A fork's code never runs on the lab host (see [Safety](#safety)). |
| The PR does **not** carry the label `skip-nano` | The only opt-out. |
| The PR changes something besides documentation | See [Docs-only pull requests](#docs-only-pull-requests). |

Since 2 Oct 2026 **On-device tests (nano-lab)** is a **required** check on
`beta`, and a skipped run (a docs-only PR, `skip-nano`) counts as passing.

A **draft** runs like any other PR: the coding agent opens most of our PRs as
drafts, and the board run is part of the checks it waits for. Marking a draft
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
them — `nano-ci reserve` exits 3. The job asks again every minute for up to
**20 minutes**, logging each try. If a board frees up it carries on, and its
summary says how long it waited. If none does, it fails with
`No free nano-lab board` (as an annotation and in the job summary) — re-run the
job when `nano-ci status` shows a clean board. It never held a board, so
there is nothing to recycle. How many clean boards the lab returns an hour:
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
| `reserve "<purpose>"` | leases one FREE board with the **clean** marker (freshly reflashed, see [How recycling works](#how-recycling-works)) and prints `SERIAL IP LAB` (exit 3: none free — the job asks again every minute for 20 minutes) |
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
   verdict. `false` skips the board job, with the reason in this job's summary.
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
   every minute for up to 20 minutes while no board is free; then the job fails
   with *No free nano-lab board* (see [No free board](#no-free-board)). The
   board's address is masked in the log as soon as the reservation is read.
4. **Rebuild** the board from the PR's branch, `nano-ci rebuild <serial>
   <branch>` (≤ 20 min), **wait** for `nano-ci health` (≤ 10 min), and
   **verify** that the board's `git rev-parse HEAD` is the head commit. A board
   on a newer commit of the branch is
   [superseded](#superseded-by-a-newer-push) — the job passes without testing,
   the newer push has its own run. A board on any other commit fails the job
   before a single test runs.
5. **Run the suite** (≤ 40 min, less any time spent waiting for a board, never
   less than 20; not on a superseded run): `scripts/nano-tests/run.sh <serial>`.
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
deadline. A failed test does not stop the next one.

| Test | Deadline | Checks | Skips when |
|---|---|---|---|
| `10-build-identity` | 5 min | `/setup-api/system/build-identity?force=1` names the head commit for both the checkout and the build, `dirty` false for both, `drift.buildVsCheckout` `match`, the stamped build is the deployed `BUILD_ID`; `clawbox-setup.service` started **after** that build was deployed (so it serves it); `scripts/verify-build-identity.sh` passes on the board | — |
| `20-services` | 5 min | `clawbox-gateway` and `clawbox-setup` active, `clawbox-vnc` too when the board enables it; `nano-ci health`; `/setup-api/gateway/health` 200 with `available: true`; the dashboard serves `/login`; `~/.npm-global/bin/openclaw --version` works as `clawbox` | — |
| `30-chat-turn` | 11 min | `openclaw agent --agent main -m "Reply with exactly this text and nothing else: NANO-CI-OK <serial>" --json` answers `NANO-CI-OK <serial>` within 240 s through the `main` agent's configured provider (ClawBox AI on every lab board); retried once after 60 s | — |
| `40-coding-agent-run` | 10 min | `POST /setup-api/coding-agent/run` in a fresh `~/Projects/nano-ci-<run id>` (or inside the owner's project folder if one is set) asks for `hello.txt` with one given line; `runs?id=` is long-polled until the run settles; it must be `completed` and the file must hold exactly that line | — |
| `60-media-tools` | 10 min | a coding run asked to use `generate_image` leaves a PNG of at least 4 KB and 64×64 px (`generate_audio` and a clip of at least 8 KB when only audio is on), and the run's `mediaGenerated` counter shows the tool was used | the coding agent's `generateImages` and `generateAudio` are both off |
| `70-reboot-survival` | 13 min | restarts the gateway the way the box does (`sudo -n systemctl restart clawbox-gateway.service`, or `systemctl --user` for a legacy user unit); within 120 s it is back as a new process and `/setup-api/gateway/health` reports it available; then the `30-chat-turn` turn passes again | — |

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
- **A reboot.** `sudo -n reboot` is not granted to `clawbox`, so
  `70-reboot-survival` restarts the gateway instead, through the sudoers grant
  `restartGateway()` uses.
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
   default is 600. Keep the suite inside the job's 40-minute cap.
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
