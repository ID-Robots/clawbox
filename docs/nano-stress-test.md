# Stress test on a Jetson (nano-lab)

A repeatable load run for one ClawBox on a nano-lab board (TASK-2500). It is
not part of the per-PR suite in [nano-hardware-tests.md](nano-hardware-tests.md):
a full run takes 10–30 minutes and, with the defaults, sends 85 real chat
turns (45 in the ramp, 32 in the long session, 8 in the tool session). Run it
by hand before a release, after a change to the gateway, Hermes or memory
limits, or when a box is reported slow, and keep the summaries to compare.

It covers both agent runtimes. The board's own runtime decides which one a run
measures: a lab board of the OpenClaw edition, one of the Hermes edition, or
one board swapped between the two (`POST /setup-api/harness/swap` on a Max-plan
board) with one run on each side.

## What it does

`scripts/nano-stress/board-stress.mjs` runs ON the board, as the box user, and
talks to the box the way its desktop chat does:

- OpenClaw: the gateway's WebSocket on loopback (`chat.send`, then the `chat`
  and `agent` events of that session), with the token `/setup-api/gateway/ws-config`
  hands the owner.
- Hermes: `POST /setup-api/hermes/chat`, streamed, threading the `sessionId`
  the previous turn answered with.

Each run uses sessions of its own (`clawbox-stress-<run>-…` on OpenClaw,
`stress-<run>-…` on Hermes) and deletes them at the end, also when it is
stopped: on OpenClaw `chat.abort` then `sessions.delete` through the gateway,
on Hermes the owner's Stop, the chat route's transcript file and
`hermes sessions delete` for every Hermes session its turns opened. The record
says how many it deleted, and the summary lists any it could not.

| step | what it sends |
|---|---|
| `idle` | nothing for 30 s: the baseline |
| `ramp-1`, `ramp-2`, `ramp-4`, `ramp-8` | N chats at once, each 3 turns in a row ("reply with exactly STRESS-…") |
| `long` | one session of 32 turns: a code word to remember, then turns that each add ~360 characters of context, with a recall question every 8th turn and at the end |
| `tool` | one session of 8 turns that each need a tool: shell commands, writing, reading and appending a file in the run's own `/tmp` folder, `sha256sum`, `stat`, `grep -rl` |

Every reply is checked against what the board itself knows (the marker sent,
the file's real hash, `wc -l`, `boot_id`, the files the agent was asked to
write), as a whole token and with any echo of the prompt taken out first, so a
turn that answered but answered wrong counts as a failed turn, not a fast one.
A turn with no answer within the turn timeout is stopped (`chat.abort` on
OpenClaw, the route's Stop on Hermes) and counts as an error with no latency.

Every 2 s the run samples: MemAvailable, swap used, CPU busy % and load, the
hottest thermal zone, the memory of the runtime's unit (`clawbox-gateway` on
OpenClaw, `clawbox-hermes-dashboard` on Hermes) and of the web server
(`clawbox-setup`, where Hermes turns run). A unit's memory is its cgroup's
`memory.current`, the headline, and the summed resident set of every process
in it, an upper bound since shared pages count once per process. At a
step's start, and again after it has waited up to 120 s for the runtime to
answer healthy and the settle pause, it reads each unit's `MainPID` and
`NRestarts` and the kernel's `oom_kill` counter, so a crash at the tail of the
load is that step's. On OpenClaw it also counts the gateway's own
`slow chat send` journal lines for the step.

## Running it

On the lab host, with a board leased for the job and on the build to measure:

```bash
nano-lease reserve <serial> "TASK-NNN: stress run"
nano-board rebuild <serial> <branch> <40-hex sha>
nano-board sha <serial>
NANO_CI=nano-board scripts/nano-stress/run.sh --results out/ <serial>
nano-lease release <serial>        # always, also when the run fails
```

`run.sh` copies the board script to a fresh `/tmp/clawbox-stress-<stamp>`
folder on the board, starts it detached (a dropped ssh does not end it), prints
its progress every 30 s, brings back the raw record and the board-side log, and
removes the folder. Interrupted, it stops the board side first, which deletes
its sessions before it exits.

Options after `--` go to the board script unchanged:

```bash
NANO_CI=nano-board scripts/nano-stress/run.sh <serial> -- \
  --ramp 1,2,4,8 --ramp-turns 3 --long-turns 32 --tool-turns 8 \
  --steps idle,ramp,long,tool --turn-timeout 240 --settle 20
```

`--budget-min N` (default 150) caps the whole run; `--strict` exits 3 when the
summary lists any finding. `run.sh` exits 0 when the run finished and was
summarised, and 1 when it did not finish (out of budget, died, never started)
or its record could not be read; a partial record is still summarised.

Never edit `run.sh` while a run of it is going: bash reads a script as it runs
it.

## What comes back

In the results folder, per runtime:

- `raw-<runtime>.json`: every turn (step, latency, first token, tool calls,
  pass/fail and why) and every sample. No reply text is kept for a turn that
  passed; a failed one keeps the first 120 characters of the model's reply,
  so treat the raw files as private.
- `stress-<runtime>.json`: the per-step numbers ([report.mjs](../scripts/nano-stress/report.mjs)):
  latency p50/p95/max over every turn that got an answer, errors by kind,
  MemAvailable start/min/end, swap used, hottest zone, CPU, runtime and web
  RSS, restarts, OOM kills, and the findings.
- `stress-<runtime>.md`: the short summary, one table row per step.
- `board-<runtime>.log`: the board script's own progress lines.

Several raw files can be summarised side by side:
`node scripts/nano-stress/report.mjs --md both.md raw-openclaw.json raw-hermes.json`.

A finding is a failed turn, an OOM kill, a unit restart or new main process, a
runtime not healthy after a step, MemAvailable under 400 MB, a missed recall,
a gateway socket opened again mid-step, or a test session left undeleted.
The numbers depend on the model the box is set to: compare runs on the same
provider and model (the summary names the model the turns reported).

Before pasting a summary into a public place, check it: it names the board
model, the build and the model the turns reported, never a board's address,
name or serial.
