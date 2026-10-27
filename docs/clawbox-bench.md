# The ClawBox bench

`scripts/bench/clawbox-bench.mjs` scores a LIVE box: one number (0–100) per
area and one overall, so an update can be measured before and after and the
difference read as "better", "same" or "worse". It runs on the box itself,
through the Chrome that shows the desktop (the kiosk's loopback DevTools
port), so every request is the owner's own session and the chat turns go
through the real gateway socket — nothing is mocked and no credential is
handled by the bench.

```bash
bun run bench                                    # every area, report under data/bench/
bun run bench -- --quick                         # shorter windows, no coding run (~2 min)
bun run bench -- --scenarios chat,desktop --runs 3   # a few areas, median of 3
node scripts/bench/clawbox-bench.mjs compare data/bench/before.json data/bench/after.json
node scripts/bench/clawbox-bench.mjs list
```

Options: `--auth cdp|token` (default `cdp`: the signed-in desktop page on
`--cdp-port`, default 18801 or `CLAWBOX_KIOSK_CDP_PORT`; `token`: the MCP
bearer in `data/.mcp-token`, the on-device suite's credential, which cannot
run the page scenarios), `--base-url`, `--url-match <text>` (which page is the
desktop), `--out <file>`, `--runs <n>`, `--label <text>`, `--verbose` (every
metric), `--quick`.

## What it touches

It reads; it opens one page of its own at `/` and closes it (visible on the
screen for a few seconds); it sends two chat turns in a gateway session of its
own (`agent:<id>:clawbox-bench-<stamp>`, deleted afterwards — never the
owner's main chat); it creates and deletes one Prime Radiant page, one folder
with one file under the Files root, one ephemeral terminal shell, and — unless
`--quick` — one tiny coding run in a fresh `clawbox-bench-<stamp>` folder
under the project directory. Settings, the vault's other pages, other runs
and the owner's sessions are never changed. Leave the desktop alone while it
runs: the idle window measures what the page does on its own.

## Areas and weights

| area | weight | what it measures |
|---|---|---|
| `api` | 10 | the routes the desktop polls and apps open with: fast p50, worst fast route, heavy routes warm and cold, bytes per poll round, errors |
| `desktop` | 15 | navigate → shelf on screen (warm and cold), load event, TTFB, bytes transferred, JavaScript parsed, requests until settled, main-thread time |
| `idle` | 10 | requests and bytes per minute the idle desktop sends, main-thread busy %, layouts and style recalcs per second, JS heap |
| `chat` | 25 | gateway connect, chat.send ack, first streamed token, plain and tool turn send → final, both replies correct, fresh-session history size and time, session delete, the gateway's own "preparation" stage from its journal |
| `prime-radiant` | 10 | status, page list, page read, history, search, a page created → read back → found by search (and how long until it is) → deleted, lint |
| `memory-shard` | 8 | embedder status, index status, provider, sources, schedule; the vault search as the one query that embeds on every edition; the local embedder's wake and warm time when it is installed and chosen; ClawBox's own search on the edition that owns it |
| `files` | 7 | list, mkdir, 200 KB upload and read back (bytes compared), search, delete |
| `terminal` | 5 | connect → prompt, echo round trip, exit seen |
| `coding-agent` | 15 | one tiny run: first progress, wall time, turns, tokens, the file it was asked for exists, the web server's bytes written and CPU during the run (`--quick` skips it) |
| `resources` | 8 | over the whole bench: web server and gateway CPU share and RSS, bytes written per minute, memory still available |

An area that cannot run (feature off, edition without it, no desktop page in
`token` mode) is **skipped**, scored `null` and left out of the overall mean
with its reason in the report — a box without the embedder is not punished
for it, and two boxes compare on what they both have.

## Scoring

Each metric states two anchors: `good` (scores 100) and `bad` (scores 0);
between them the score is linear, past them clamped, in whichever direction
the metric reads (`dir: "lower"` or `"higher"`). An area is the mean of its
metrics' scores (a few carry `weight: 2`, correctness ones especially); the
overall is the weighted mean of the areas that scored. The anchors are
deliberately coarse — "fine on a Jetson" and "clearly broken" — so a score
moves only when something a person would notice moved, and the raw numbers
stay in the report (`metrics.<name>.value`, `details`) for reading a change
back to its cause. `src/tests/unit/bench-score.test.ts` pins the arithmetic.

**Compare** reads two reports: per area and overall, a delta past the
threshold is `better`/`worse`, inside it `same`. The threshold is 3 points,
or the larger run-to-run spread the reports recorded (`--runs 3` stores the
spread as `noise`), and the metrics that moved ≥10 % are listed under the
table. On a busy laptop the threshold is honest; on a quiet Jetson 3 points
is about one run's noise.

## Reading a result

- `chat` is the owner's experience: `first_word_ms` is what they wait for;
  `gateway_prep_ms` (from `journalctl -u clawbox-gateway`) says how much of
  it is the gateway's own work before the model is asked; the correctness
  metrics guard against a faster box that answers wrongly.
- `desktop.script_mb` and `shelf_ms` move together: less JavaScript parsed
  is the lever for a faster shelf.
- `idle.requests_per_min` is the polling floor; on a Jetson every poll is
  middleware + a config read on slower cores.
- `coding-agent.web_write_mb_min` is the runs-file write amplification.
- `resources` compares like with like only when the same areas ran.

The bench is not a test: a failing area reports an error and the rest keep
going. The on-device pass/fail suite is `docs/nano-hardware-tests.md`; the
desktop's frame-level profile is `scripts/perf/desktop-perf.mjs`.
