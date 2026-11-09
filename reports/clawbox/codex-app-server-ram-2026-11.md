# Idle `codex app-server` processes and gateway RAM (TASK-2247, 2026-11)

A customer report on 4.3.0 (Pro, four agents, Jetson Orin Nano 8 GB): after a
while the box used 5.6 GB RAM + 1.4 GB swap and agent memory indexing failed
with `HTTP 502: Not enough free memory to wake the memory embedder (1167 MB
available, 2300 MB needed)`. Their breakdown: `openclaw-gateway` 3.45 GB RSS
after ~15 h, four `codex app-server` children of the gateway (~170 MB each,
~685 MB) idle for 10+ h, `clawbox-web` 192 MB, Chromium + GNOME ~400 MB, and
per-agent SQLite stores of 322-474 MB with many free pages.

## 1. Who starts the app-servers, and why they are never stopped

**ClawBox does not start them.** With a ChatGPT sign-in, ClawBox arms the
OpenClaw Codex runtime for the `openai/<model>` reference
(`agents.defaults.models["openai/…"].agentRuntime.id = "codex"`, see
`src/lib/chatgpt-subscription.ts` and the arm/disarm rule in
`scripts/gateway-pre-start.sh`), and `gateway-pre-start.sh` installs
`@openclaw/codex@<pinned core>`, which is 2026.10.9 today. Every turn then goes through that
plugin, which starts the app-server as a direct child of the gateway:

```
openclaw-gateway
 └─ node …/@openclaw/codex/node_modules/@openai/codex/bin/codex.js -c cli_auth_credentials_store="ephemeral" app-server --listen stdio://
     └─ …/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex -c … app-server --listen stdio://
```

There is one per agent. The plugin's pool key includes the agent directory,
and each app-server runs with `CODEX_HOME=~/.openclaw/agents/<id>/agent/codex-home`.
The node launcher is ~47 MB and the native binary 90-210 MB, so 130-260 MB per agent.

**The leak is upstream, in `@openclaw/codex` 2026.10.9** (`@openai/codex`
0.160.0 underneath):

- `extensions/codex/src/app-server/shared-client.ts`,
  `acquireSharedCodexAppServerClient`, keeps one shared client per key and
  clears `entry.closeWhenIdle` on every acquire.
- `extensions/codex/src/app-server/shared-client-lifecycle.ts`,
  `releaseSharedClientEntry` → `closeRetiredSharedClientEntryIfIdle`, closes a
  client whose last lease is released only when `closeWhenIdle` is set. Only
  the retire paths set it: a changed start selection, an older desktop
  generation, a timed-out turn, or an auth-refresh failure. A healthy client
  whose turn simply ended is never retired.
- `extensions/codex/src/app-server/client-runtime.ts`,
  `CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS` (30 min), only unsubscribes
  idle **threads** from the app-server. The process stays.
- The only thing that closes every client is `clearSharedCodexAppServerClientAndWait`,
  on gateway stop. `codex-app-server-process-reaper` (in
  `transport-process-registration.ts`) reaps only the orphans of a gateway
  that died.

**No setting controls it.** `plugins.entries.codex.config.appServer` has
`mode`, `transport`, `homeScope`, `command`, `args`, `requestTimeoutMs`,
`approvalPolicy`, `sandbox`, `serviceTier`, `networkProxy` and others, but no
idle or lifetime knob, in 2026.10.9 or any later release.

**Fixed upstream in `@openclaw/codex` 2026.10.10.**
`shared-client-lifecycle.ts` gains `CODEX_APP_SERVER_CLIENT_IDLE_GRACE_MS` (30 s) and
`scheduleSharedClientIdleRetirement`. Once a shared client has no lease, no
pending acquire and no owned thread, it is retired after the grace, and the
30-minute thread eviction re-arms it. So an app-server goes away about 30 min
after the agent's last turn. 2026.11.1 has the same code, and 2026.11.5-beta.1
raises the grace to 5 min. Still no setting. No upstream issue is needed;
**moving the pin to ≥ 2026.10.10 is the real fix**, and the ClawBox mitigation
below can go once it has moved.

Repro (any box on core/plugin 2026.10.9): sign in with ChatGPT, give two or more
agents an `openai/*` model (the Codex runtime is armed), send each agent one
message, and wait. `ps --ppid $(systemctl show clawbox-gateway -p MainPID --value) -o pid,rss,etime,args`
keeps one `codex.js … app-server` per agent, each with its native child, until
the gateway restarts.

## 2. The ClawBox mitigation (this change)

`src/lib/codex-app-server-reaper.ts`, swept by the web server every 5 min
(`src/instrumentation.ts`). It does from outside what 2026.10.10 does inside,
and only stops a process that meets every one of these:

- it is in the gateway unit's own cgroup and is a **direct child of the
  gateway server**, so a `codex app-server` started by the agent from a shell,
  or by a coding run, is never touched;
- it is the plugin's **launcher**: argv[0] is node, running
  `@openai/codex/bin/codex.js` with the `app-server` subcommand. It also runs
  with the plugin's per-agent `CODEX_HOME=…/agents/<id>/agent/codex-home`, so
  a bare `codex app-server` exec'd in place under the gateway is not a
  candidate;
- nothing runs under it but its own native binary. A command, a background
  terminal or an MCP server keeps it;
- the tree has stayed **quiet for 30 min**, under 0.5 % of a core between
  looks. An idle app-server is not completely still: on the lab board each one
  gained 3-4 clock ticks a minute over 35 idle minutes (≈ 0.06 %), so the bar
  sits ~8× above that. CPU alone is not enough, because a turn waiting on the
  model uses none: the gateway is asked at every look while an app-server
  runs, and an agent it reports work for starts its 30 min over, so the
  window counts from the agent's last turn, as upstream's retirement does;
- right before **each** stop, the gateway says **no session has agent work
  running or queued** (`sessions.list` with `activeOnly`, read-only, the call
  `gatewayWsActiveSessions` makes). No answer, or an answer without a session
  list, means nothing is stopped.

The clock is monotonic, because the box has no RTC and timesyncd steps the
clock forward after a cold boot. A web-server restart starts the clock over.
The stop is SIGTERM to the launcher, which forwards it to the binary, then
SIGKILL after 10 s; a tree still there 5 s after that is logged as not
stopped and tried again a window later. The plugin sees its child exit
(`markClosed` → the shared entry's close handler drops it from the pool), and
the agent's next turn starts a fresh app-server and resumes the thread from
its rollout. That is the same path upstream's idle retirement and every gateway
restart take. `CLAWBOX_CODEX_REAP=0` turns it off.

Not done, on purpose: no `node_modules` patch, no change to the plugin's
config, and no `appServer.homeScope: "user"`. That would let agents share
one process, but it changes where Codex keeps auth and threads.

## 3. Board evidence

Lab Jetson Orin Nano 8 GB, OpenClaw 2026.10.9, `@openclaw/codex` 2026.10.9.
**The lab board has no ChatGPT/OpenAI login.** The 2026.10.9 harness takes
the Codex runtime only for a prepared ChatGPT OAuth/token profile (an API-key
route is refused: "Codex cannot reproduce the prepared provider route"), so no
Codex turn completed on the board. What did run is the process lifecycle the
leak is about. The setup was the pinned plugin installed the way the boot
script installs it, the runtime armed on `openai/gpt-5.5`, a placeholder OpenAI
key, and four agents (`main`, `r1`, `r2`, `r3`). The agents' first turns made
the plugin acquire one shared app-server client per agent from its pool (the
`catalog-observation` acquire boundary in the gateway log), and the turns then
fell back to the next model. That left one `codex app-server` per agent, the
shape in the customer report, released and idle.

**Before: beta `80ccfce61`**, no turn after 09:25:48:

| time (UTC) | gateway RSS | app-servers (same pids throughout) | their RSS | MemAvailable |
|---|---|---|---|---|
| 09:26, after the turns | 1,798 MB | 4: main, r1, r2, r3 | 742 MB | 3,438 MB |
| 09:54, 28 min idle | 1,548 MB | 4 | 715 MB | 3,730 MB |
| 10:02, 36.5 min idle (past the plugin's 30-min thread window) | 1,551 MB | 4 | 705 MB | 3,712 MB |

**After: this branch `2035b8edd`** (`nano-board sha` = branch head):

| time (UTC) | what happened | app-servers | MemAvailable |
|---|---|---|---|
| 10:09 | the same four turns | 4, 956 MB RSS | 2,993 MB |
| 10:39:10-12 | `[codex-reaper] stopped the idle codex app-server of agent main (pid 189230, idle 30 min, 219 MB)`, then r1 214 MB, r2 227 MB, r3 226 MB. SIGTERM only, no SIGKILL needed | 0 | |
| 10:41 | gateway still the same process, `active`, `/healthz` 200, `NRestarts=0`, nothing in its log about the exits, no orphan or zombie | 0 | 4,147 MB |
| 10:42 | a new turn on every agent: each one starts a fresh app-server, and the gateway log shows the same lines as beta and nothing new | 4, 907 MB RSS, **615 MB PSS** (90-184 MB per agent) | 3,099 MB |
| 11:13:47 → 11:14:17 | second stop, sampled every 30 s: gateway RSS 1,566 → 1,567 MB | 4 → 0 | **3,422 → 4,052 MB (+630 MB)** |

**Hermes.** The board, a locked OpenClaw box, was switched with Settings' own
harness swap (`POST /setup-api/harness/swap`) to Hermes and back. On Hermes the
OpenClaw gateway unit is not running and no `codex app-server` exists. A
`hermes chat -q` turn answered in 22 s. The web server's sweeps at about 11:19
and 11:24 found no gateway cgroup and logged nothing, no errors either. The swap
back to OpenClaw succeeded, with gateway and dashboard healthy.

Does the problem apply to Hermes? Hermes has a Codex app-server client of its
own (`run_agent.py`, hermes-agent `bf0203a794`). It closes that child when an
agent is closed or evicted from its cache (`release_clients` →
`_close_codex_session`), so it does not have this leak, and the reaper, which
looks only inside the OpenClaw gateway's cgroup, never touches it.

## 4. Gateway RSS and the agent stores (measure only)

Gateway RSS on the lab board (no channel traffic, so it shows load from the
plugin and the agents, not 15 hours of use):

| state | gateway RSS |
|---|---|
| fresh, no Codex plugin, one agent, 3-4 min | 1,155-1,172 MB |
| fresh, Codex plugin + four agents configured, 1.4 min | 1,566 MB |
| right after the four agents' first turns, 3-4 min | 1,798 MB (beta) / 2,009 MB (branch) |
| idle 30-70 min afterwards | 1,541-1,567 MB, peak (`VmHWM`) 2,083 MB |

96 % of it is anonymous memory (`smaps_rollup` at 13 min: Rss 1,586 MB,
Pss_Anon 1,528 MB, Pss_File 12 MB). It fell back after the burst and did not
grow over ~70 idle minutes, so the climb to 3.45 GB in the customer report
needs real traffic to reproduce, and this run did not have that.

**The embedder bar.** The memory embedder wakes only with at least 2,300 MB
available (`DEFAULT_EMBED_WAKE_MIN_AVAILABLE_MB`, `src/lib/local-ai-runtime.ts`).
On the lab board, reaping four idle app-servers raised MemAvailable by 630 MB,
to 4,052 MB, well clear of the bar. On the customer's numbers, 1,167 MB plus
roughly the same ~630 MB comes to ≈ 1.8 GB, **still ~0.5 GB short**. The rest
of the gap is the gateway itself: 3.45 GB there against ~1.6 GB here.

- **SQLite free pages are disk, not RAM.** The agent stores' free pages cost
  space on disk and, at most, reclaimable page cache. They are not part of the
  gateway's RSS and not what blocks the embedder. ClawBox already compacts
  them with the core's own `doctor --session-sqlite compact`
  (`scripts/openclaw-db-maintenance.py`: any store over 30 % free pages, 512 MB
  of free pages, a 256 MB WAL, or `auto_vacuum` still NONE, only when the
  gateway answers `gateway suspend` idle). It runs from Settings → System →
  Agent databases, nightly once the owner switches it on, or with "Run now".
  OpenClaw's routine incremental `auto_vacuum` handles the rest. Nothing to add.
- **No heap flag shipped.** The gateway runs with no `--max-old-space-size`
  (`NODE_OPTIONS` carries only `--dns-result-order`). A cap below what the
  gateway really uses turns slow growth into an out-of-memory crash and a full
  restart of every channel. That is not clearly safe, so it is a
  recommendation to measure, not a change.

## 5. Recommendations

1. Move the OpenClaw pin to ≥ 2026.10.10 (latest 2026.11.1) in the next pin
   bump. That fixes the app-servers at the source; then remove
   `codex-app-server-reaper.ts`.
2. For the customer now: update to the release with this change, after which
   the four app-servers go 30-35 min after each agent's last turn (~630 MB).
   On their numbers that alone does not reach the embedder's 2,300 MB, so also
   restart the gateway once to give back its 15-hour growth
   (`sudo systemctl restart clawbox-gateway`; on the lab board a fresh gateway
   with the plugin is ~1.6 GB against their 3.45 GB).
3. Gateway growth: take `smaps_rollup` and the core's own heap figures at 1 h,
   6 h and 15 h on a box with several active agents before choosing a heap
   cap or a scheduled idle restart.
