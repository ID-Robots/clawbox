# Nano hardware tests

The on-device test suite: a handful of checks that only mean something on a real
Jetson, run automatically on **one** free board from the nano lab for every pull
request, after which the board is cleaned back to `beta` and released — whether
the tests passed, failed or were cancelled.

Everything that does not need the hardware already runs in the container CI
(`Tests`, `E2E`, `E2E Install`, `Build identity`). This suite is only the rest.

## When it runs

**Every pull request into `beta` or `main`, automatically** — no label needed.
The workflow (`.github/workflows/nano-hardware-tests.yml`) runs when a PR is
opened, reopened or marked ready for review, and again on every push to it, as
long as:

| Condition | Why |
|---|---|
| The PR's branch lives in **this** repository | A fork's code never runs on the lab host (see [Safety](#safety)). |
| The PR is **not a draft**, or it carries the label `nano-test` | A draft opts in with `nano-test`. |
| The PR does **not** carry the label `skip-nano` | The opt-out. It wins over `nano-test`. |
| A `labeled` event is for `nano-test` itself | Adding any other label (a review bot's, or `skip-nano`) never starts a run. |
| The PR changes something besides documentation | See [Docs-only pull requests](#docs-only-pull-requests). |

```bash
gh pr edit <PR number> --add-label nano-test     # a draft: run it on a board
gh pr edit <PR number> --add-label skip-nano     # any PR: no more board runs
```

Labels count from the next event: adding `nano-test` starts a run at once
(on a non-draft PR that is simply one more run of the same commit), but adding
`skip-nano` or removing either label does not stop or start anything by
itself — the next push, reopen or ready-for-review is judged with the labels
the PR has then. A run already going always finishes, cleanup included.

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

To put a docs-only commit on a board anyway, dispatch it (below) with the
commit's SHA — `plan`'s summary prints the exact command.

**On any branch, tag or commit** — dispatch it:

```bash
gh workflow run nano-hardware-tests.yml -f ref=<branch, tag or commit sha>
```

`refs/pull/*` is refused, so a fork's PR head is never picked up by name. A
dispatch needs write access and runs whatever commit it is given — GitHub also
serves a fork PR's commits by SHA from this repository — so dispatch only
commits that are on a branch or tag of this repository.

**Re-running** a finished or failed job is the Actions page's *Re-run jobs*, or
`gh run rerun <run id>`. It reserves a board afresh. A re-run judges the event
it re-runs, labels included, as they were then.

## Parallel runs

Each pull request has its own concurrency group,
`nano-lab-pr-<PR number>` (a dispatch: `nano-lab-pr-<ref it was dispatched
from>`), with `cancel-in-progress: false`:

- **Within one PR, one board job at a time, and a running one is never
  cancelled** — its cleanup and release must run. A push queues behind the PR's
  own running job. GitHub keeps only ONE pending job per group, so when a third
  push arrives the second one is cancelled before it starts: it never had a
  board, nothing needs cleaning, and it was an older commit of the same PR.
  That cancelled job does not touch the PR comment.
- **Different PRs run side by side.** Two limits bound how many: the number of
  runner instances with the `nano-lab` label on the lab host (each runs one job
  at a time: `nexus0-nano-lab` today, and ops is adding 3–4 on nexus0 — until
  then PRs take turns), and the number of boards that `nano-ci reserve` finds
  FREE. A job waiting for a runner instance waits on
  GitHub, before its 90 minutes start.

### No free board

When every board is leased — by other PRs' jobs or by people (`nano-lease
list`) — `nano-ci reserve` exits 3. The job asks again every minute for up to
**20 minutes**, logging each try. If a board frees up it carries on, and its
summary says how long it waited. If none does, it fails with
`No free nano-lab board` (as an annotation and in the job summary) — re-run the
job when `nano-lease list` shows a FREE board. It never held a board, so
there is nothing to clean up.

The wait comes out of the suite's 40 minutes, never out of cleanup's room: the
suite's cap is 40 minutes less every started minute spent waiting, and never
less than 20.

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
| `reserve "<purpose>"` | leases one FREE board and prints `SERIAL IP LAB` (exit 3: none free — the job asks again every minute for 20 minutes) |
| `rebuild <serial> <ref>` | force-updates the board's checkout to the ref and rebuilds it (5–10 min) |
| `health <serial>` | exit 0 when `clawbox-gateway` and `clawbox-setup` are active and the dashboard answers |
| `ssh <serial> <cmd…>` / `scp <serial> <src> <dst>` | runs a command on / copies a file to the board as `clawbox` |
| `cleanup <serial>` | rebuilds the board back to `beta` and wipes test projects; reflashes it from the golden image if it is still unhealthy (~40 min) |
| `release <serial>` | releases the lease |

A reserved board shows as leased in `nano-lease list` like any board a person
has locked.

## The job

Three jobs. **Needs a board?** (`plan`) decides, the board job does the work,
and **PR comment** reports it.

0. **Needs a board?** (`ubuntu-latest`): the gate above, then the docs-only
   verdict. `false` skips the board job, with the reason in this job's summary.
1. **Refuse fork refs** (dispatch only), then **check out** the commit under
   test — the PR's head commit, not the merge commit.
2. **Resolve the commit** and check the runner host has `nano-ci`, `jq`,
   `timeout` and `base64`.
3. **Reserve** a board: `nano-ci reserve "clawbox PR #<n> <sha>"`, asked again
   every minute for up to 20 minutes while no board is free; then the job fails
   with *No free nano-lab board* (see [No free board](#no-free-board)).
4. **Rebuild** the board at the head commit (≤ 20 min), **wait** for
   `nano-ci health` (≤ 10 min), and **verify** that the board's
   `git rev-parse HEAD` is the head commit. A board on any other commit fails
   the job before a single test runs.
5. **Run the suite** (≤ 40 min, less any time spent waiting for a board, never
   less than 20): `scripts/nano-tests/run.sh <serial>`.
6. Upload `results/` as the artifact `nano-results-<run id>-<attempt>` and write
   the **job summary**: board serial, IP and lab, the commit, one row per test
   with its result, duration and reason, what each step did, whether the job
   was cancelled, and how long it waited for a board.
7. **Clean up** (`if: always()`): `nano-ci cleanup <serial>`.
8. **Release** (`if: always()`): `nano-ci release <serial>`.
9. **PR comment** (`ubuntu-latest`): the *Nano hardware tests* section of the
   PR's one **CI Summary** comment — the comment `Tests`, `E2E` and
   `E2E Install` already edit in place — is rewritten with the verdict, the
   commit, the board and its cleanup, and the job summary. One comment per PR,
   never one per push. A skipped docs-only run says so there too; a board job
   cancelled before it held a board leaves the section alone.

The board job on the lab host holds only a read token (`contents: read`, not
persisted by the checkout). The comment is written by the separate job on
GitHub's runners, the only one with `pull-requests: write`.

## How cleanup works

Steps 7 and 8 run whenever a board was reserved — after a failed test, a failed
rebuild, a wrong commit, a timeout or a cancel (`always()` covers a cancel too,
and the summary then says the job was cancelled) — and always in that order:
the board is rebuilt to `beta` (or reflashed) **before** anyone else can lease
it. A cleanup that fails fails the job, says so in the summary and the PR
comment, and the board is still released.

The budget is what keeps that promise. The job has 90 minutes; the steps before
cleanup are capped at 20 (waiting for a board) + 20 + 10 + 40, but the suite's
cap shrinks by the wait, so they never take more than about 70 and cleanup
keeps at least 20. A normal run spends about 25 before cleanup — 45 after the
longest wait — so a cleanup that has to reflash (~40 min) still fits. Each test
also has its own deadline (below), so one stuck test cannot eat the suite's.

Nothing in the workflow cancels a running board job: the per-PR concurrency
group does not cancel in progress (see [Parallel runs](#parallel-runs)). A
person can still cancel a run; cleanup and release then run as above. If the
job is stopped outright before cleanup finishes, the release step never runs
and the board stays leased to this job — nobody else gets a board that was not
cleaned. Find it in `nano-lease list`, then clean and release it by hand.

If the runner host itself dies mid-job, nothing on GitHub can clean up: the
lease expires after 24 hours, and `nano-lease list` shows who held the board.

## The tests

Each is `scripts/nano-tests/tests/NN-name.sh`, run in order, each with its own
deadline. A failed test does not stop the next one.

| Test | Deadline | Checks | Skips when |
|---|---|---|---|
| `10-build-identity` | 5 min | `/setup-api/system/build-identity?force=1` names the head commit for both the checkout and the build, `dirty` false for both, `drift.buildVsCheckout` `match`, the stamped build is the deployed `BUILD_ID`; `clawbox-setup.service` started **after** that build was deployed (so it serves it); `scripts/verify-build-identity.sh` passes on the board | — |
| `20-services` | 5 min | `clawbox-gateway` and `clawbox-setup` active, `clawbox-vnc` too when the board enables it; `nano-ci health`; `/setup-api/gateway/health` 200 with `available: true`; the dashboard serves `/login`; `~/.npm-global/bin/openclaw --version` works as `clawbox` | — |
| `30-chat-turn` | 11 min | `openclaw agent --agent main -m "Reply with exactly this text and nothing else: NANO-CI-OK <serial>" --json` answers `NANO-CI-OK <serial>` within 240 s through the box's configured provider; retried once after 60 s | — |
| `40-coding-agent-run` | 10 min | `POST /setup-api/coding-agent/run` in a fresh `~/Projects/nano-ci-<run id>` (or inside the owner's project folder if one is set) asks for `hello.txt` with one given line; `runs?id=` is long-polled until the run settles; it must be `completed` and the file must hold exactly that line | — |
| `50-local-model` | 7 min | `ollama run <model> "Say OK"` answers OK within 180 s, `<model>` being the first of `OLLAMA_PRESET_MODELS` (`src/lib/local-install.ts`) the board has pulled; a stopped `ollama.service` is started and stopped again | ollama is not installed, or none of those models is pulled |
| `60-media-tools` | 10 min | a coding run asked to use `generate_image` leaves a PNG of at least 4 KB and 64×64 px (`generate_audio` and a clip of at least 8 KB when only audio is on), and the run's `mediaGenerated` counter shows the tool was used | the coding agent's `generateImages` and `generateAudio` are both off |
| `70-reboot-survival` | 13 min | restarts the gateway the way the box does (`sudo -n systemctl restart clawbox-gateway.service`, or `systemctl --user` for a legacy user unit); within 120 s it is back as a new process and `/setup-api/gateway/health` reports it available; then the `30-chat-turn` turn passes again | — |

Notes on what the brief asked for and what the box actually offers:

- **`/health`.** The dashboard has no public `/health`: a bare `/health` is
  session-gated and proxied to the gateway, and the MCP bearer opens
  `/setup-api/*` only (`src/middleware.ts`). The suite asks
  `/setup-api/gateway/health` and `nano-ci health` instead.
- **The local model.** ClawBox ships no ollama model — the model it installs is
  Gemma on its own llama.cpp. What it ships *for* ollama is the wizard's preset
  pair, which is what `50-local-model` looks for.
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
written. Each coding run is a fresh folder with a run-id name; the folder is
removed at the end and `nano-ci cleanup` wipes test projects anyway.

## Results

`results/` holds one `<test>.log` per test (everything the test printed,
redacted) and `summary.json`:

```json
{
  "serial": "…", "ip": "…", "lab": "…", "sha": "…", "run_id": "gh123-1",
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
nano-ci rebuild "$SERIAL" <branch or sha>          # only if you need a specific commit
NANO_SHA=<the commit the board runs> scripts/nano-tests/run.sh "$SERIAL"
scripts/nano-tests/run.sh --only 30-chat "$SERIAL"  # one test
nano-ci cleanup "$SERIAL"
nano-ci release "$SERIAL"
```

Always clean up and release, also when it fails. `NANO_SHA` defaults to the
commit your checkout is on — `10-build-identity` compares the board with it.

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
   `results/`, and nothing left on the board that `nano-ci cleanup` would not
   remove.
6. Check it: `shellcheck -x scripts/nano-tests/*.sh scripts/nano-tests/tests/*.sh`
   and `bash scripts/nano-tests/selftest.sh` (both run in CI), then on a
   reserved board with `--only`.

## Safety

- The job runs only for `workflow_dispatch` (write access) and for pull requests
  whose head repository **is** this repository — the same fence as before the
  suite ran on every PR, written into both the `plan` job's `if:` and the board
  job's own. A `pull_request` run takes its workflow file from the PR, so for a
  fork that `if:` is not the fence — the repository setting that makes fork PR
  workflows wait for a maintainer's approval is. Keep it on, and approve no fork
  run of this workflow.
- `permissions: contents: read`, and the checkout does not persist its token on
  the lab host. Only the **PR comment** job, on GitHub's runners, may write
  (`pull-requests: write`); it runs no code from the PR.
- Every value from the event reaches a shell through `env:`, never spliced into
  a script; the board serial is validated before it is used.
- No credential for the lab or a board is in this repository. The lab host's
  `nano-ci` owns them.
