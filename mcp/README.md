# ClawBox MCP server

The AI agent's interface to the appliance. Runs over stdio; talks to the
device's own `/setup-api/*` over loopback plus the local filesystem.

```
bun run mcp/clawbox-mcp.ts        # the server (this is what the harness spawns)
bun run mcp/check-tools.ts        # tool-surface check + per-edition registration matrix
bun run typecheck:mcp             # tsc over mcp/** (the root tsconfig excludes it)
bash mcp/test-tools.sh            # on-device smoke test, incl. the file-guard cases
```

## How the harness finds this server

Writing the tools is only half of it — the agent gets them only if its harness
has this server in its own config. Each harness has its own file, and each is
reconciled idempotently, so a restart, a redeploy or an in-app update all
converge on the same entry.

| Harness | Config | Written by |
|---|---|---|
| OpenClaw | `~/.openclaw/openclaw.json` → `mcp.servers.clawbox` | `scripts/gateway-pre-start.sh` (an `ExecStartPre` of `clawbox-gateway.service`) |
| Hermes | `~/.hermes/config.yaml` → `mcp_servers.clawbox` | `scripts/register-mcp.sh` |

`scripts/register-mcp.sh` runs from two places, both idempotent:
`production-server.js` on every web-server boot — `clawbox-setup.service` is the
one unit active on every edition, and both a deploy and an update end by
restarting it — and `scripts/setup-hermes-edition.sh`, so a fresh flash is
provisioned before the web server first starts. It no-ops on an OpenClaw device,
where `gateway-pre-start.sh` owns the registration; the premium `dual` SKU runs
both.

Both writers honour the owner's switch: with `clawbox_mcp_enabled: false` in
`data/config.json` (Settings → Harness → Device tools, written by
`/setup-api/harness/mcp`, which also unregisters and restarts each harness at
once) each REMOVES its entry instead of writing it, so a reboot cannot put the
tools back. Absent means on.

Two properties of the Hermes entry are load-bearing:

- **`command` is `bun`, with the script in `args`.** Hermes refuses an entry
  whose command is a shell interpreter carrying an inline script, and it checks
  that both when the entry is saved and again when the server is spawned.
- **It carries no bearer token.** `mcp/lib/api.ts` reads `data/.mcp-token`
  itself, so rotating the token is not a config-sync problem and `config.yaml` —
  which several `/setup-api/hermes/*` routes rewrite — holds no second copy.

To check a device: `hermes mcp list` (or `openclaw mcp status`) should name
`clawbox`; `hermes mcp test clawbox` connects and lists its tools.

### The server hangs up when it is idle

A harness spawns one of these processes per **session key** and holds it for its
own lifetime, so nothing reaped them: measured on a v4.0.0 box, three turns on
three keys left three `bun run mcp/clawbox-mcp.ts` processes alive — still all
there after 90 s of silence — and a ten-prompt run left nine of them resident at
63–70 MB each, cleared only by restarting the gateway. So the server ends
itself. Ten minutes after the last **inbound JSON-RPC message** — a request, or
a bare notification; anything the harness sends puts the clock back — and only
if no request is in flight, it writes one line to stderr —
`[clawbox-mcp] idle for 600s with no request in flight; exiting so the harness
reconnects on the next call` — closes its transport and exits 0. Both harnesses
treat that as an ordinary disconnect and reconnect on the next call (OpenClaw's
gateway logs `[bundle-mcp] server "clawbox" closed;
next request reconnects`); the reconnect costs 0.31–0.35 s to connect plus
0.02 s to re-list the tools, paid once by whoever comes back after a long pause.
The rule is edition-neutral — the same process, the same reconnect on Hermes —
and it is not a timeout on your work: **a request still in flight defers the
exit for as long as it runs**, so a `bash` command that sleeps for an hour is
never cut off, and the clock only restarts once its result has gone back. A
**background job defers it too** — `bash` with `run_in_background` answers at
once but leaves a detached shell whose handle and output live in this process,
so the period simply starts again, as often as it takes, until `job_status`
would call that job finished. (`bash` exists only where
`CLAWBOX_MCP_CODING_TOOLS=1` registered the coding family; on a device in its
shipped state there is no job to defer for, and the period always runs out.) And
so does a **cancelled call whose handler has not stopped**: the host is sent no
answer and the server lets go of the request id, but the abort the SDK raises is
never handed to the handler, so the write or the fetch it is in the middle of
keeps the process here until it settles. Set
`CLAWBOX_MCP_IDLE_EXIT_MS` to another number of milliseconds to move it, or to
`0` to switch it off and keep every server for the life of the harness.

## The one thing to know: the tool set depends on the edition

A ClawBox ships as an **OpenClaw** device or a **Hermes** device. They have
different agents, different capability stores, and different backing routes.
The edition is resolved **once at startup** from `readEdition()`
(`src/lib/edition-source.ts` → the root-owned `/etc/clawbox/edition.env`).
`main()` makes **one** `GET /setup-api/harness/active` — for the unlocked `dual`
edition, the only case where the device knows something the lock does not — and
hands that answer to both questions it settles: `resolveAppHarness()` returns it
as the APP harness, and `resolveEdition(appHarness)` is synchronous and cannot
ask again. Two probes could disagree, and did.

If the lock file **exists but cannot be read** the two questions part company,
because their answers are shaped differently:

* the **tool set** registers the *smaller* Hermes set and logs it. `readEdition()`
  defaults to `openclaw`, which is conservative for the app (the non-premium SKU)
  and the opposite here — `openclaw` is the only edition carrying `app_search`,
  `backup_now` and the guarded read-only trio (`list_directory`, `glob`, `grep`).
  The two sets are nested, so a doubt has a safe side.
* the **app harness** answers `null` and both harness-only sets are hidden, with
  the reason said out loud (`UNKNOWN_HARNESS_NOTE`). The app sets are *not*
  nested, so there is no safe side to fail onto. The device is not asked in this
  state: `/setup-api/harness/active` resolves through `readEdition()` too, so it
  can only echo the default this process already failed to read.

An **absent** lock file is a different case (dev boxes, CI) and keeps the
documented `CLAWBOX_EDITION` fallback.

A tool that cannot work on the running edition **is not registered**. It is not
registered-and-erroring: Hermes runs a per-server circuit breaker, so one
chronically-failing tool takes *every* ClawBox tool offline for the agent.

| | OpenClaw | Hermes |
|---|---|---|
| Capability store | `app_search`, `app_install` | `skill_search`, `skill_info`, `skill_install`, `skill_list`, `skill_uninstall` |
| Plugin reload (`hermes_plugins_reload`) | **no** — no plugin system | yes |
| AI configuration | in Settings (gateway-owned) | `ai_list_models`, `ai_set_provider`, `ai_set_model` |
| Guarded read-only trio (`list_directory`, `glob`, `grep`) | yes | **no** — Hermes ships its own file tools |
| Coding family (`bash`, `job_status`, `job_stop`, `read_file`, `write_file`, `edit_file`, `notebook_edit`, `web_fetch`, `web_search`) | **no** by default — `CLAWBOX_MCP_CODING_TOOLS=1` registers it | **no** by default — the same variable registers it. Hermes ships its own, and a second unguarded shell doubles the attack surface for no gain |
| Coding agent (`coding_agent_run/status/stop`, `coding_secret_list`) | when the owner switched it on | when the owner switched it on |
| Coding team (`coding_team_run/status/stop`) | when the owner switched it on | when the owner switched it on |
| Steering and following runs (`coding_run_message`, `coding_run_list`, `coding_agent_resume`, `coding_project_status`) | when the owner switched the coding agent on | same |
| Device state reads (`memory_shard_status`, `local_ai_status`, `clawbox_ai_usage`, `anthropic_accounts`) | yes | yes |
| Coordinate browser control (`browser_click/type/keypress/scroll`) | yes | **no** — Hermes ships a richer browser toolset |
| Media inside a run (`generate_image`, `generate_audio`) | when the owner's switch is on | when the owner's switch is on |
| Everything else | yes | yes |

## Tools

### Orientation — call these first

At the start of a session: `clawbox_context` once — the field guide, which also
says how to hand work to the coding agent and then steer and check it — and
`device_status` before any answer about the device itself. Then, by question:

- **"Build / fix / change this"** with the coding agent on: `coding_project_status`
  first (which projects exist, how to name each to `coding_agent_run`, whether
  one is already busy), then `coding_agent_run`.
- **"What are my runs doing?"**: `coding_run_list`, then `coding_agent_status`
  with one `run_id` for its summary. Change a run's mind with
  `coding_run_message`; carry on a paused one with `coding_agent_resume`.
- **Memory, on-box engines, allowance**: `memory_shard_status`,
  `local_ai_status`, `clawbox_ai_usage` — each answers "off", "not installed" or
  "not linked" as an answer, so call them rather than guess.
- **"Why is my run waiting?" / before retrying an Anthropic run**:
  `anthropic_accounts` — how many of the owner's Anthropic accounts can answer,
  which one is in use, and when a limited one is back.

| Tool | What it does |
|---|---|
| `device_status` | Edition, agent, the device's **default** AI provider/model/thinking (`ai.device_default` — a chat may run a per-session override, and `ai.current_chat` says the tool cannot see it), configured context/output limits, free disk, update waiting. One call, independent timeouts, dead legs report `"unknown"`. |
| `clawbox_health` | Is the device API reachable and is our token accepted. Separates auth from connectivity. |
| `clawbox_context` | The device field guide, the webapp storage/styling rules, and whose screen the browser tools drive (`BROWSER_GUIDE` — the desktop's window while the owner's real-browser setting is on, an invisible one when it is off). The guide is one file, `Clawbox.md`, filtered before it is served: `<!-- edition:… -->` blocks follow the ACTIVE HARNESS (tool sets) and `<!-- ships:… -->` blocks follow the INSTALL (what the device has), so a `dual` box is told about both harnesses and a Hermes agent is never handed the OpenClaw toolbelt. |

### Hermes plugins (Hermes only)
`hermes_plugins_reload`

A PLUGIN is not a skill, and the difference is the whole reason this tool
exists. A skill is re-read per turn; a plugin is scanned **once, when the agent's
process starts** — `discover_plugins(force=True)` at start, and
`_ensure_plugins_discovered()` returning early ever after, with nothing reachable
over the dashboard socket passing its `force` flag. Hermes knows: every
`plugins install` ends with *"Restart the gateway for the plugin to take
effect."*

On this SKU the process serving chat is `clawbox-hermes-dashboard.service`, so
that instruction means "restart the dashboard" — and the assistant cannot,
because `sudo systemctl restart` is refused (agent shells run with
`no_new_privs`). Measured on the owner's box: a plugin installed at 12:59 into a
dashboard up since 10:52 was proven working in a fresh `hermes chat -q`, listed
as `enabled` by `hermes plugins list`, and invisible to every chat the owner
opened, new sessions included.

This tool is the supported way to ask, and **it is not a privilege**. It posts to
`/setup-api/hermes/plugins/reload`, whose restart is `bounceHermesDashboard()`:
`hermes dashboard --stop`, upstream's own SIGTERM path over a process the clawbox
user already owns, with the unit's `Restart=always` bringing it back and the
route waiting for a new main PID and for :9119 to answer before it reports
`ready`. **No sudoers grant is added or needed**, and one must not be: `systemctl
restart` also STARTS a stopped unit, which would let an OpenClaw box resurrect
the dashboard its foreign-edition teardown had just stopped and disabled
(`install-sudoers-migration.test.ts`, `install-foreign-edition-teardown.test.ts`).

The device does this by itself as well — a watcher in the web server bounces the
dashboard when `~/.hermes` really declares a different plugin set — so the tool
is for the deliberate case: call it once, right after `hermes plugins
install/enable/disable/remove`. The two share one baseline (`process-store.ts`),
so a reload asked for here does not earn a second bounce from the watcher eight
seconds later.

What the answer's `loaded` and `stale` are worth: `loaded` is HERMES' OWN
registry, read with `plugins.list` over the dashboard socket — `null` means the
process could not be asked and never "it loaded nothing", while `[]` means it
answered and has none of them on. `stale` says the box declares a plugin as
enabled that the running registry does not have; it is derived from that
registry rather than from a file's mtime, so an unrelated Settings save cannot
make it true.

Two answers that must not be collapsed. `restarted` without `serving_again` means
systemd owns the restart and it is on its way; that is not a failure and calling
again would stop a dashboard in the middle of coming back. And `loaded` is
`"could not be established on this device"` rather than an empty list whenever
the running agent could not be asked what it registered — a plugin whose only
registrations are tools logs them below the level that read can see, so an empty
list would have the assistant tell an owner their plugin is missing from a device
that is serving it.

**The owner's open chat window closes with the restart.** That is the feature, not
a fault: the box shows them a notice saying to open a new chat, and the tool's
answer repeats it so the assistant says the same thing.

### Hermes skills (Hermes only)
`skill_search` · `skill_info` · `skill_install` · `skill_list` · `skill_uninstall`

The **id vs name** split is the trap: `skill_install` takes the full store id
(`official/pdf`), `skill_uninstall` takes the short lock id (`pdf`) — the first
word of a `skill_list` line, which is NOT always the name the skill's own
SKILL.md gives it (a ClawHub `martin-weather` shows as `weather`).
`skill_install` returns the lock id so the model never has to guess it, and
`skill_list` prints it first and notes the display name when that differs.

A display name works too, and so does the store identifier the skill was
installed from — as long as it is a valid skill name (no slash, no space, which
rules out the documented ClawHub shape `QR Code Decode`).

The **rule** for "which skill does this string name?" is one exported function,
`matchRemovableSkill` (`src/lib/hermes-skills.ts`): the lock id first, then the
identifier and the display name searched together. It is applied twice — by the
**/uninstall route** over the hub lock and the disk walk (`resolveUninstallKey`,
which is what actually decides), and by `skill_uninstall` over the `/installed`
rows it has just read, so it can say *why* a skill cannot be removed and can
send the lock id the route would land on anyway. Two rules for that one question
is what let the tool refuse a `weather` the route resolved; one function is what
stops it.

An exact lock id settles the question — it is a lock-file key, unique by
construction — and the success message says when another card shows that name
too. Anything else is a tie the moment two rows answer to it, *including across
the two keys* (one skill's identifier being another's card name), and a tie is
refused: both lock ids are named and the user is asked which they meant. This
tool deletes things, and picking one is not the tool's decision to make.

The route's 200 carries the lock key it acted on and the string it was asked
for, and **that** key is what every message the tool prints is about — not the
one the pre-condition read a moment earlier. The two are usually the same and
need not be: the route resolves the argument again at its own moment, so a lock
that moved in between (a parallel install, the owner removing it from Settings)
leaves the tool judging its post-condition against a skill nobody touched.

That post-condition is a second read of `/installed`, and it is what makes a
removal a fact rather than the route's word: the CLI prints its refusal and
exits 0, so the 200 proves nothing on its own. When the read-back FAILS the tool
says so — "the device reported it removed, but its installed list could not be
read back" — instead of the flat "Removed the skill" it used to print over a
removal nothing had checked.

The second trap is **which** installed skills can be removed. A device has three
origins — `builtin` (shipped with it), `hub` (installed from the store) and
`local` (a skill directory that is neither: written by the agent, hand-copied,
or left behind by a failed install rollback). `hermes skills uninstall` works
off the hub lock, so only `hub` is removable, and that is the single rule
`skill_list`'s "from the store" mark, `skill_uninstall`'s pre-condition and the
Skills page's Remove button all use. A `local` skill gets its own refusal: it is
on the device, it is not built in, and only deleting its folder there removes it.

`skill_install` also carries a `confirm` flag, and it is the one argument the
model must never set on its own judgement (TASK-452). When the device's scanner
flags a skill the install route answers 409 with what the skill can do; the tool
turns that into a CONFLICT whose `next` is "tell the user what it can do and ask
them", and `confirm: true` is only correct on a second call after the user has
said yes. A bundled-name collision and an incomplete download are separate
CONFLICTs with their own instructions — the first is never retryable, the second
is retryable once the device is back online.

### AI configuration (Hermes only)
`ai_list_models` · `ai_set_provider` · `ai_set_model`

There is deliberately **no** ClawBox AI plan switch: it changes what the
customer is billed, and "switch to pro for better results" is a one-line
prompt-injection payload with a financial outcome. The plan is reported by
`device_status`; changing it is one click in Settings → AI.

There is also no thinking/reasoning setter yet — see "Work owned by others".

Everything here reads and writes the **device default** (`~/.hermes/config.yaml`),
and says so: `ai_list_models` reports it as `device_default`, never `in_use`,
and `ai_set_provider` / `ai_set_model` answer "device default is now …". The chat
a tool call arrives from may be running a per-session override chosen in its
header, and this server cannot see it — it is one stdio child shared by every
Hermes session, started with a filtered environment (`mcp/lib/profile.ts`) and
called with no session id. Where the ClawBox chat knows the model that served
a reply it prints it under that reply; the payloads point there in
`current_chat`, so the agent never answers "which model are you" from a tool.
On OpenClaw the header writes the box default and repoints every session, so
there `device_status` says the default is what the chat runs.

### Pictures

`image_generate` (both editions, **only where the box CANNOT draw**)

The inverse of every other gate here: this one is registered when the probe says
NO. On a box that can draw, the harness already has its own `image_generate` and
a second one beside it would contradict it; on a box that cannot, there is no
image tool at all — and an agent asked for a picture with no tool to draw it does
not stop. Measured on a customer's device: it reached for the shell, hand-wrote
an SVG, installed `cairosvg`, rasterised it, and then wrote itself a SKILL to do
it again — producing files the chat cannot serve and telling the customer nothing
about why. So the absence gets a voice: one tool, empty schema, whose whole job
is to name the reason (ClawBox AI is not connected) and the fix (Settings → AI
Providers) and to forbid improvising around it.

The probe is `canGenerateImages` off `/setup-api/chat/capabilities`, resolved
once at startup and never re-asked — so unlike the mailbox gate, which the server
now follows while it runs, the startup staleness still applies here, in both
directions: after linking, the refusal must go, and the harness's
own image tool must actually appear. Linking asks for both
(`src/lib/hermes-image-refresh.ts`): `reload.env`, because the backend's
credential lives in `~/.hermes/.env` and only reaches a running agent that way;
then `reload.mcp`, which drops the refusal. Where the backend was installed into
an agent that had already scanned its plugins — nothing reachable over the socket
re-scans them — the dashboard is bounced instead, and only when its unit promises
to come back.

### Device
`system_stats` · `system_info` · `system_power` (needs `confirm: true` + a
`reason`) · `disk_usage` · `disk_cleanup` · `update_check` (reports only, never
installs) · `logs_tail` · `screen_capture` · `wifi_scan` · `wifi_status` ·
`vnc_status` · `preferences_get` · `preferences_set` · `backup_status` ·
`backup_list`* · `backup_now`* · `telegram_status`  &nbsp;&nbsp;*(\* OpenClaw
only)*

`disk_usage`, `disk_cleanup`, `logs_tail` and `screen_capture` are
**capability-probed at startup** — no `du`, no readable journal, or no screen
grabber, and the tool is simply not offered.

ClawKeep archives the OpenClaw agent through the `openclaw` CLI, so on Hermes
the feature reports `supportedOnEdition:false` and Settings offers nothing to
pair: `backup_list` and `backup_now` are not registered there, and
`backup_status` answers "not available on this edition" rather than a status
object the agent reads as "not paired yet".

`backup_status` returns the shared `protection` verdict plus a `notes` array —
the caveats that apply to *this* box (a `lastHeartbeatStatus` that is not the
outcome by itself, a protected verdict with no schedule behind it). They are on
the result rather than in the tool description because they are conditional,
and because description text is paid for in the `tools/list` payload on every
turn. The key is always present on a status result, and the array is often
empty: a box no caveat applies to gets `notes: []`, never a missing field. An
unpaired box gets `protection: null` and a note saying so, the same way the
shelf shield publishes no verdict for one — and the edition that cannot run
ClawKeep (above) answers in prose, with no `protection` and no `notes` at all.

`screen_capture` resolves the display from `CLAWBOX_VNC_DISPLAY`, then
`~/.cache/clawbox/vnc-display.env`, then `:0` — the harness spawns this server
with no `DISPLAY`, and the desktop is the VNC Xvfb, not `:0`.

### Desktop, apps and building
`ui_open_app` · `ui_list_apps` · `ui_notify` · `app_search`* · `app_install`* ·
`app_uninstall` · `webapp_create` · `webapp_update` · `code_project_init` ·
`code_project_list` · `code_project_build` · `code_project_delete` (needs
`confirm: true`)  &nbsp;&nbsp;*(\* OpenClaw only)*

An app `webapp_create` or `code_project_build` puts on the desktop without an
icon gets one drawn by ClawBox AI's image model when the box is linked — after
the tool has answered, never overwriting an icon that exists, one picture per
app and one at a time (a rebuild while it is being drawn does not pay twice),
dropped if the app is uninstalled meanwhile, and silently skipped on an
unlinked box (`src/lib/webapp-icon.ts`).

`code_project_init` and `code_project_list` report the project directory as an
ABSOLUTE path. The agent edits those files with its harness's own file tools,
and that process has a different working directory than the web tier — a
relative path read nothing and wrote into a parallel tree the build never
looks at.


### Email
`email_send` (both editions) · `email_list` · `email_read` (both editions, only
when the mailbox mode allows reading)

The owner picks ONE of three mailbox modes in Settings → Email, and it decides
which of these tools exist:

| mode | what the agent may do | read tools registered |
| --- | --- | --- |
| **Send only** | send mail; never opens the mailbox | no |
| **Read on demand** | send, plus list/read WHEN ASKED — nothing polls | yes |
| **Answer senders** | Hermes' native adapter polls and replies to an allowlist | yes |

`email_list`/`email_read` are **not registered at all** unless a mail account is
connected AND the mode allows reading (`mcp/lib/context.ts` probes it at
startup). Same rule as edition gating and for the same reason: a tool that could
only ever answer 409 is a tool that trips Hermes' circuit breaker and takes every
ClawBox tool offline. The route enforces the gate independently, because the two
live on opposite sides of a process boundary and the owner can change the mode
under a running server.

This is the ONE gate here that is not startup-only, because it is the one the
owner changes with the agent already running. A startup-only answer left a
long-lived server holding the tool list it built at boot: measured on an OpenClaw
box (2026-09-10), seven minutes after the mode moved to "Read on demand" the MCP
child serving the chat still advertised `email_send` alone, while a fresh spawn
of the same server advertised all three. So the server re-asks
`/setup-api/email/status` every `EMAIL_READABILITY_POLL_MS` (30 s) and, on a
CHANGE of the answer, registers or withdraws the pair on the live connection
(`watchEmailReadability`, `mcp/tools/email.ts`). The MCP SDK turns each of those
into a `notifications/tools/list_changed`, which is what the harness acts on —
OpenClaw's bundle MCP runtime invalidates the tool catalogue it cached for this
server and re-lists at the next turn. A probe that could not REACH the device
answers `null` and changes nothing, so one slow moment cannot take a working
mailbox away from the agent.

That notification is also the only mechanism that reaches a RUNNING OpenClaw
gateway: `openclaw mcp reload` disposes the MCP runtimes cached in the CLI's own
process (`disposeAllSessionMcpRuntimes`, OpenClaw 2026.8.1) and the gateway never
hears of it, and the gateway's JSON-RPC exposes no MCP method at all.

On Hermes there IS a way to ask, and it is faster than a poll, so it stays:
`/setup-api/email/configure` asks the dashboard to reload its MCP servers
(`reload.mcp`, `confirm: true`) whenever a save or a disconnect **flips**
`canRead`. Only on a flip: a reload respawns every MCP child process and
invalidates the model's prompt cache, so it is not free and must not fire on an
ordinary save. See `src/lib/email-mcp-refresh.ts`.

Both read tools ARE `readOnly`, and that claim is literal rather than polite: the
mailbox is opened with `EXAMINE` (read-only at the protocol level) and every
fetch uses `BODY.PEEK`, so listing and reading do not even set `\Seen`. No
`STORE`, `APPEND`, `EXPUNGE`, `COPY` or `MOVE` appears anywhere in
`src/lib/imap-client.ts`, and `src/tests/unit/imap-client.test.ts` asserts that
against a server that records every command it is sent.

`email_read` returns the message with an explicit note that its contents are
information, never instructions — an email is the payload most likely to carry an
injected instruction, being text a stranger wrote and chose to send to the device.

**The `EMAIL:<id>` line is asked for where it can become a card, and not on the
channels.** Both read tools tell the agent to end its reply with one such line
per message; ClawBox's chat windows lift them out and show an "open full
message" card in their place (`src/lib/chat-email-refs.ts`), and nothing else
knows what the line means. The same reply sent over Telegram, WhatsApp or
Discord therefore ended with a bare internal id, so the instruction now names a
closed exception: Telegram, WhatsApp, Discord, Slack, and a reply that is itself
being sent as an email.

That is half one of the harness's own two-half pattern for its `MEDIA:`
convention — advertised per platform in the system prompt AND stripped by the
platform adapter on every outbound path. Half one is a sentence the MODEL
evaluates about itself, so it rests on the model being told which platform it is
on. Both editions do tell it: Hermes writes a per-platform hint from a central
dict, and OpenClaw states the channel three ways per turn (a trusted
`### Message Context` block, `channel=<id>` in the `## Runtime` line, and the
`[<Channel> …]` envelope on the body). ClawBox's own chat is `webchat` there and,
on Hermes, `clawbox-chat` — the session `source` ClawBox itself sends, which
Hermes carries through to `agent.platform`; `cli` is only its spawn fallback,
and a standalone `tui` looks the same from inside the agent. That is why the
instruction names all of those as surfaces to make the card on. Half two is native and now BUILT (TASK-697):
Hermes' `transform_llm_output` plugin hook, handed the final text and the
`platform` and free to replace it, and on OpenClaw `reply_payload_sending` —
which gets the whole outbound payload and is keyed on BOTH `ctx.channelId` and
`event.channel`, because neither names the destination on its own — chosen over
the older `message_sending`, whose stage the core itself labels "legacy …
retained for low-level SDK compatibility". Both plugins ship in `scripts/`
(`scripts/hermes-plugins/clawbox_email_directives/`,
`scripts/openclaw-plugins/clawbox-email-directives/`), are installed and enabled
by the boot reconciles (`scripts/register-mcp.sh`, `scripts/gateway-pre-start.sh`),
and KEEP the line on the surfaces that render the card. Three paths run ahead of
a hook and are still half one's alone: a Hermes reply split across several
messages (only the last chunk is edited, `gateway/run.py:29804`), Hermes
streaming TTS (sentences are spoken before the transform, `:20744-20747`), and
OpenClaw channel preview streaming (suppressed while a hook exists, but only for
Discord). The spoken reply is covered at its own entry point,
`scripts/openclaw/clawbox-tts.sh`, because on OpenClaw the core synthesises audio
before any outbound hook runs — a cloud voice there is out of reach of both
halves.

**The same two plugins now carry an INBOUND hook, and it is what lets the owner
approve a queued email from his own Telegram conversation.** The harness is the
single consumer of the main bot's `getUpdates` long poll, so ClawBox cannot read
that stream — but both harnesses hand a plugin the message before the model sees
it, and both take a claim: OpenClaw's `before_dispatch` (`{ handled: true, text }`,
which answers on the originating route with no model call; it is NOT in the core's
`conversationHookNameSet`, so no conversation-access grant is needed) and Hermes'
`pre_gateway_dispatch` (`{"action": "skip"}`; it fires BEFORE the harness's own
auth, so ClawBox does its own). Each plugin matches one strict shape locally — a
verb and a short code, nothing else — and posts to `/setup-api/email/chat-reply`;
every gate is on the ClawBox side, and `src/lib/email-approval-reply.ts` says why
there is still no approve verb on the tool surface. `email_send` tells the agent
that the owner has a code and deliberately does NOT tell it what the code is.

Every claim in the paragraph above about the harness's own internals —
`transform_llm_output`, `PLATFORM_HINTS`, `reply_payload_sending`,
`message_sending`'s "legacy" label, `before_dispatch`, `pre_gateway_dispatch`,
the hook context fields and the `### Message Context` field list — was read off
the running core, not from this repository. Nothing here can check them: there is no vendored core and no
`node_modules/@openclaw`, and `config/openclaw-target.txt` holds a version
string and nothing else. Treat them as a note of where to look, not as verified
fact, and re-read them against the core before building on them — TASK-697 did
exactly that against OpenClaw 2026.8.1 and Hermes 0.20.5 on the two boxes, and
the PR that built the plugins carries the `file:line` citations.

**`webchat` is not exclusive to a card-making surface.** The gateway's own
Control UI chat at `/chat` — a ClawBox-served, default-pinned app on the
OpenClaw edition — is `webchat` too, and it renders the line as text. Its
Hermes-edition twin is the **Hermes dashboard**, the pinned `hermes` app
(`src/lib/desktop-apps.ts`) served through ClawBox's own auth proxy
(`scripts/hermes-dashboard-proxy.js`); it has never heard of the directive
either, so TASK-700 is one task per edition, not one for OpenClaw alone. Both
ClawBox chats connect as `openclaw-control-ui` in `webchat` mode, impersonating
it deliberately, and against the pinned core nothing the gateway passes tells
the three apart: the model's `### Message Context` block carries only `schema`,
`account_id`, `channel`, `provider`, `surface`, `chat_type` and
`response_format`, and an outbound hook is handed `channelId`, `accountId`,
`conversationId` and `sessionKey` on the delivery path — the declared type adds
message, reply and trace fields, none of them client-shaped. ClawBox's connect
frame does send `version: "clawbox-chat"`, but the gateway puts it only where
the model and a hook cannot read it: the live connection record, the presence
row and its own logs.

The **spoken** reply divides the same way. On Hermes ClawBox synthesises the
clip itself, so the route strips the directive before speaking it
(`src/app/setup-api/hermes/chat/route.ts`) — the rule the same function already
applied to `MEDIA:`, "a box reading a file path aloud would be absurd". On
OpenClaw the gateway picks the engine, and how far ClawBox can reach depends on
which one it picks: a cloud provider gets text ClawBox never touches, while the
on-device Kokoro voice is spoken by running ClawBox's own
`scripts/openclaw/clawbox-tts.sh`, which `install.sh` (`step_openclaw_tts`)
wires as the `tts-local-cli` provider command with `{{Text}}` in argv — so on
that engine ClawBox IS handed the reply, directive included. It is still the
wrong layer to strip at: it covers one of the two voices and would put chat
semantics in a speech script. The id is read aloud on both engines today; that
half belongs to TASK-697 with the channels, where `clawbox-tts.sh` is recorded
as the one OpenClaw-side chokepoint that exists so far.

So the instruction leans towards the card — the card is the feature, the stray
line is one line — and the two dashboards keep showing the line, as they did
before the instruction said anything at all. Fixing that is TASK-700, and it
needs the HTML ClawBox already serves — and, on OpenClaw, already injects into
(`src/lib/gateway-proxy.ts`; the Hermes proxy streams bodies unmodified today,
so that half is new code). Not this sentence, and not TASK-697's outbound hook,
which sees `webchat` for every one of them.

The only outbound-mail capability the agent has, and on the OpenClaw edition the
only email capability at all — OpenClaw has no email channel, and inventing one
in its config would fail the gateway's strict schema and silence the channels
that do work. Hermes' native adapter can reply to mail that arrives; it cannot
start a thread.

Deliberately NOT read-only: a sent email cannot be recalled, so the tool carries
no `readOnlyHint`. On a real ClawBox that annotation buys no approval prompt —
ClawBox registers this server with `trust: full` (`scripts/register-mcp.sh`),
because a headless one-shot turn has nobody to answer a prompt. **`email_send`
runs unsupervised**, and its arguments may come from text the agent only read.

**"Ask me before sending" is the consent**, and it is a separate setting from the
mode (default ON for new accounts; accounts configured before it existed migrate
with it OFF, so nobody's device changes behaviour on upgrade). With it on,
`/setup-api/email/send` never reaches the SMTP client: the message becomes a
draft in `data/email-pending.json`, the desktop shows a notification, and the
tool answers `sent: false, queued_for_owner_approval: true` — which the agent
must not report as a delivered message.

**Queueing is idempotent.** A message identical in recipients, subject and body
to one still waiting, inside five minutes, folds into the draft already on disk:
the same `pendingId` comes back with `already_waiting: true`, no second draft is
written and no second notification fires. It exists because a timed-out
`email_send` retry produced two identical drafts from one request. For the same
reason **a timeout on this tool is not a retry**: every other timed-out call in
`mcp/lib/api.ts` answers "retry once", and this one answers "do not retry and do
not claim it was sent" — with the gate off there is no queue to fold into and a
second attempt is a second real email.

A draft that leaves the queue leaves a receipt in `data/email-outcomes.json`
(sent / rejected / failed / unconfirmed / duplicate, 24 h), which is what lets
every surface say whether a message is still waiting instead of guessing from
its own frozen copy.

Approving happens at `/setup-api/email/pending`, which is the one route in this
subtree that **refuses the MCP bearer**. Middleware admits callers to
`/setup-api/*` on either a session cookie or that bearer, and the agent holds the
bearer — so a route that trusted middleware here would let a prompt-injected
agent queue a draft and approve it on its next tool call. It re-checks for a real
browser session (`src/lib/owner-session.ts`) and 403s everything else.

The remaining containment is server-side, in `/setup-api/email/send`: CR/LF
rejected in every header value, at most 10 recipients, and a per-hour send budget
(5) that bounds a runaway — a blast-radius limit, not consent. The owner's own "Send test
email" button is a different route with its own budget, so the agent cannot lock
the person at the keyboard out. The credentials never enter the MCP process, an
unconfigured device answers `CONFLICT` with "do not retry, tell the user to open
Settings → Email". An exhausted budget answers `CONFLICT` too — the generic 429
mapping is `ENDPOINT_DOWN` ("retry once"), which is the loop the budget exists
to stop. The budget counts REQUESTS, not deliveries: under the approval gate
nothing has been sent when it refuses, and a folded retry still spends a slot.

### Browser
`browser_open` · `browser_navigate` · `browser_screenshot` · `browser_close`
(both editions) · `browser_click` · `browser_type` · `browser_fill` · `browser_keypress` ·
`browser_scroll` (OpenClaw only) · `browser_view_local` (only inside a
coding-agent run — see below) · `describe_image` (both editions)

`describe_image` is not a browser tool but lives in the same family so a
coding-agent run gets it: a written description of a local image file
(.png/.jpg/.jpeg/.webp), through the box's vision model — how an image-blind
run looks at a frame it saved without driving the browser at it. The fence is
the ROUTE's (`/setup-api/vision/describe`), not this tool's: a credential
store answers like a missing file for every caller, and the MCP bearer may
only look inside the active run's working and evidence folders while a run
is live (the home folder otherwise) — the tool's own check merely turns a
mistyped path into a clear message first. One call per tool call: the
backend retries a transient flap of the vision proxy once inside its own
60 s budget (`src/lib/vision-describe.ts`), and this tool waits longer than
that budget rather than re-firing. It answers a clean error when ClawBox AI
is not linked.

`browser_type` reports a character count, never the text — it is the tool that
types passwords.

**Which Chromium answers is the OWNER's choice, not the agent's.** The route
drives the desktop's own window — the one on the screen the owner is looking
at — while the Coding Agent's real-browser setting is on
(`coding_agent_real_browser` in the config store, ABSENT MEANS ON, written by
`POST /setup-api/coding-agent/enable { realBrowser }` from the settings panel
and from the Enable/Skip step of the app's first-run wizard), and an invisible
Chromium of its own when the setting is off or that window cannot be used
(another program holding CDP port 18800, a launch that failed). A screenshot
from the two is identical, so every reply carries
`browser: "desktop" | "headless"` and the tools relay it in the header line:
ONCE per session, and again when a fresh session lands on the other browser — a
property of the browser behind the session is not worth repeating on every
click, which is the spend `briefResult` exists to avoid. Inside a run the line
asks the run to say which one it verified on; outside one it stops the
assistant sending the owner to look at a window that was never opened. A server
that predates the field sends nothing and nothing is claimed.

There is deliberately **no tool for the switch**: putting a browser on the
owner's screen is a consent, and a tool that could turn it back on would make
the owner's "no" temporary — the same reason `browser_auto_open` has none.

**Inside a coding-agent run** (the runner spawns this server with
`CLAWBOX_MCP_PROFILE=browser`, which registers ONLY the browser family): the
run's model cannot see images, so every screenshot is archived into the run's
evidence folder (`data/coding-agent-artifacts/<runId>/`,
`CLAWBOX_RUN_ARTIFACTS_DIR`) and replaced in the reply by the backend's written
description of it (the browser route's `describe` action, produced by the
box's vision model — `src/lib/vision-describe.ts`). `browser_view_local` opens
an HTML file from the run's working folder (`CLAWBOX_RUN_DIR`): the ONLY
`file://` the browser route accepts, and only while that run is the active
one, realpath-checked on both sides.

### Media, inside a coding-agent run only
`generate_image` · `generate_audio`

Registered in the browser family (so a run gets them and the assistant's own
server does not) and ONLY when three things hold: this server was spawned for a
run, the owner's matching switch is on, and the runner said so in
`CLAWBOX_RUN_MEDIA` (`images`, `audio`, or both — absent means neither is
registered). A tool that existed and always answered "switched off" would be a
refusal a small model argues with, and on Hermes a candidate for the per-server
circuit breaker.

`generate_image` draws a picture with the box's ClawBox AI plan and writes a PNG
into the run's project; `generate_audio` speaks a line in the box's own voice
and writes a WAV. Both are backed by owner-fenced routes
(`/setup-api/coding-agent/media/image` and `…/audio`) which decide where the
file may land — the active run's working folder and evidence folder, typed-path
and realpath-checked exactly as `/setup-api/vision/describe` decides what may be
read. The tool's own path check is a courtesy for a typo; the bearer this
process holds is the same one a prompt-injected run holds.

Both spend something of the owner's, so both are capped on the RUN RECORD (20
pictures, 40 clips) rather than per process — a transient retry and the
automatic review pass resume the same record and must not buy the allowance
twice — and every successful reply states how many are left, which is what stops
a looping model before the cap has to. A 429 (`CONFLICT`) is a spent daily
allowance or a busy voice: an answer, not a fault, and the mapping says "carry
on without" rather than "retry".

A run does NOT draw its own icon: the box draws the project's desktop icon and
its `favicon.png` / `favicon.ico` itself, shortly after the run starts
(`src/lib/project-icon.ts`), never overwriting a file that is there. The brief
tells the run to link them and ship them.

### Coding family — two groups, one lever

**Always, on OpenClaw:** `list_directory` · `glob` · `grep`

The guarded read-only trio. They stay registered because of the one thing they
do that no harness's own search does: they filter **descendants**, so a
credential store under a folder being listed, matched or searched never reaches
the agent (see *Safety rules*, and the `grep -r ~/.hermes` incident that is why
they exist). Hermes gets them only under the variable below.

**Only with `CLAWBOX_MCP_CODING_TOOLS=1`, on either edition:** `bash` ·
`job_status` · `job_stop` · `read_file` · `write_file` · `edit_file` ·
`notebook_edit` · `web_fetch` · `web_search`

Registration is the only lever here — no tool was deleted, renamed or reshaped,
and setting the variable brings back exactly what a box used to ship. What
changed is the default, measured on a real box (v4.0.0, OpenClaw edition): the
family was ≈ 12.5 KB of a 43.9 KB `tools/list`, 28% of the payload and ≈ 3k
input tokens spent at every session start, and over six shell, file and web
prompts the model reached for the OpenClaw harness's own `exec` / `read` /
`edit` / `web_fetch` six times out of six. Both harnesses already ship a shell
and file tools; this family was a second, differently-guarded way to do the same
work. `bun mcp/check-tools.ts` prints the payload with and without it.

To switch it back on, set the variable in **this server's own `env` block** —
Settings → MCP, or the Harness page — and restart the harness. Nothing in
`scripts/gateway-pre-start.sh` reads it: the MCP process does, at registration
time, so it must be in the environment the harness spawns *this* server with.

One thing to know before relying on that: both boot-time registrars rewrite the
`clawbox` entry whenever it differs from the one they compute
(`scripts/gateway-pre-start.sh` on OpenClaw, `scripts/register-mcp.sh` on
Hermes), so a key hand-added to that entry is dropped at the next boot and has
to be set again. Neither script sets this variable — deliberately: the shipped
default is the family off, and a debugging override that survived a reboot
unnoticed is how a device ends up in a posture nobody chose.

### Coding agent (both editions, only while the owner's switch is on)

`coding_agent_run` · `coding_agent_status` · `coding_agent_stop` ·
`coding_run_message` · `coding_run_list` · `coding_agent_resume` ·
`coding_project_status` · `coding_secret_list`

| Tool | What it does |
|---|---|
| `coding_agent_run` | Hand a whole task to a background Claude Code run in one folder. Answers a run id at once. |
| `coding_agent_status` | One run in full — its summary, deliverable, pull request, deployment, plan — or, with no `run_id`, the recent ids. `wait_seconds` blocks up to two minutes. |
| `coding_run_message` | STEER a run that is still going: queue plain text for it (≤ 4,000 chars, ≤ 20 waiting). Says whether the run has it now or gets it at its next step. |
| `coding_run_list` | Every run at a glance (≤ 30): status, who started it, project, branch and whether that work is home, attempts and the deliverable verdict, why a paused one is paused, `detached`, unread messages, `left_running`. Filter by `status` / `project`. |
| `coding_agent_resume` | The Resume button, for a `paused` or `gave_up` run the AGENT started — optionally telling it something first (`message`). |
| `coding_agent_stop` | Stop a running run (detached ones included); close a paused one for good; with `end_leftovers`, end what a finished run left running. |
| `coding_project_status` | The project matrix: kind, how to name it to `coding_agent_run`, last commit, desktop/server app, latest run, runs working / waiting / not merged / left running. Name one for its runs and pipeline default. |
| `coding_secret_list` | Names — never values — of the owner's stored secrets and whether runs get them. |

A different thing from the coding family above. Instead of editing files
itself, the agent hands a WHOLE task to a second harness — `claude-ds`, Claude
Code running on the box's own ClawBox AI plan (`scripts/claude-ds`) — which
works in the background inside one folder and reports back with a summary.

`coding_agent_run` takes an optional `input_files`: a comma-separated list of
ABSOLUTE paths of files the run is to be GIVEN — the pictures or clips the
agent generated for the task, a file the user sent it. This exists because the
agent writes its generated media inside its own state directory, which is a
credential store denied to every run, wholesale and unopenably: a deny rule
outranks any allow rule in Claude Code, so a path merely MENTIONED in the task
is a file the run can never open (reported from a live run: "denied by
permission settings for all routes — Bash cp and Read both refused", after
which the run drew the four pictures again). Named here, the device copies each
one into `data/coding-agent-inputs/<runId>/`, a folder every run may read, and
tells the run their names. It copies only out of the media trees it writes and
out of that inputs tree — a path anywhere else is refused, per file, with a
stable code, and the answer says which asset did not arrive. A file the OWNER
wants a run to have goes in `data/coding-agent-inputs/shared/`, which every run
may read with no permission rule at all.

`coding_agent_run` takes an optional `provider` (`clawbox-ai` | `anthropic`)
and, for `anthropic` only, a `model`. Omitted, they mean the owner's stored
default (Settings → Coding Agent), which this process does not know — so an
omitted provider is NOT sent, and only a value the caller actually named
travels. The pair is checked here before the request goes out, by the same
resolver the route validates with (`src/lib/coding-provider.ts`): naming a
model for `clawbox-ai` is refused, because the box's plan chooses its own and
a run that silently answered on a different model is the failure the selector
exists to prevent. `anthropic` works only where the owner has connected their
own Anthropic access; `coding_agent_status` and the Coding Agent app say
whether they have, and a run against an unconnected account is 409 /
do-not-retry, never something to try again.
`coding_secret_list` answers the NAMES of the owner's stored secrets
(`src/lib/project-secrets.ts`), their scope (`box` or a project id), whether
each is handed to runs and whether this box can still decrypt it. There is no
tool, route or parameter anywhere that answers a VALUE: the owner types one in
the Coding Agent's settings and only a run's own environment ever holds it, and
everything a run then says is scrubbed of it before it reaches the run record
(`src/lib/secret-redact.ts`). There is deliberately no tool for the master
switch either, for the reason `browser_auto_open` has none: handing an
unattended shell the owner's credentials is a consent, and a tool that could
turn it back on would make their "no" temporary.


The run lives in the web server (`src/lib/coding-agent.ts`,
`/setup-api/coding-agent/*`), not in this process: OpenClaw reaps the MCP
after ten idle minutes and a run routinely outlives that. Run ids therefore
stay valid across sessions, unlike `job-N` ids, and a run the web server lost
to a restart is settled as failed at the next boot rather than reported as
running forever.

**Registered only when `GET /setup-api/coding-agent/status` answers
`enabled` and a usable account at startup** (`mcp/lib/context.ts`): the owner's
switch in the Coding Agent desktop app is on AND Claude Code, the wrapper and
the credential of AT LEAST ONE provider (the ClawBox AI token, or the owner's
own Anthropic access) are present — `readiness.anyProviderReady`, falling back
to `ready` on a device that predates the selector. Deliberately not the
DEFAULT provider's verdict, which is what `ready` alone answers: an owner whose
default account has no credential while the other one works can still run, so
withholding the tools from that box would be wrong. Whether the provider a
single run NAMES is connected is settled by the run route, which answers 409
`not_ready`. Same gate as `email_list`, for the same
circuit-breaker reason — but not the same timing: this one is asked at startup
and never again, so a switch flipped under a running server reaches the agent
when that server is next spawned. The run route enforces the switch again — 409, which
the tool maps to CONFLICT / do-not-retry — because the owner can flip it under
a live server. `POST /setup-api/coding-agent/enable` is the second route in
the API that **refuses the MCP bearer** (`src/lib/owner-session.ts`): the
agent must not be able to grant itself a delegated shell.

What a run may do is bounded to what the agent already has through its own
shell tool, not less and not more:

- edits inside the working folder are auto-approved (`--permission-mode
  acceptEdits`); anything else Claude Code would have asked for is silently
  denied in `-p` mode and COUNTED on the final report, so a task that quietly
  could not finish reports as such. The brief adds the matching rule of
  conduct: a denied Read/Write/Edit is a decision, not a puzzle for Bash to
  solve (bench run run-g6vwqr9y edited a denied path with `sed -i` and
  reported success — that move is now named and forbidden);
- the tool set is files, search, Bash and sub-agents (`--tools`, `--agents`) —
  no web tools. Bash is full access (`Bash(*)`): the owner's switch IS the
  consent for a delegated shell, and the brief holds it to one command per
  call. Three sub-agents ship (explorer / tester / reviewer), all on the
  flash model, plus a `workflow-subagent` of the same name as Claude Code's
  built-in default workflow agent, which shadows it: an `agent()` call that
  names no agentType then runs on flash with read-and-run tools instead of
  as a full writer on the tier model (measured: the first ultracode bench
  run typed none of its four agents). The writing stays with the main loop
  on the tier model. Under
  ultracode (the default effort) the run also gets Claude Code's `Workflow`
  tool, listed AND pre-approved (`--allowedTools Workflow` — listed alone a
  headless run is refused with "Review dynamic workflow before running"),
  plus a brief paragraph on what to fan out; a fixed effort level is no
  opt-in to orchestration and never gets it. The brief keeps a workflow to
  read-only helpers by agentType (explorer / tester / reviewer): the writing
  stays with the main loop, whose edits are what the record, the review
  pass and the commit see. A workflow counts as one helper of type
  `workflow` on the run record, billed live from its task_progress totals
  so the owner's token ceiling holds during a fan-out; the Agent tool's
  helpers are background tasks too on the installed CLI (2.1.259), kept
  "active" until their task_notification rather than their launch receipt,
  and a refused launch is taken back out of the counts;
- the credential folders `file-guard` protects, and every entry of this
  checkout's `data/` except the public subtrees (so `config.json` — the token
  the run is using — but never the run's own `data/code-projects/<id>`), are
  denied to Claude Code's own Read/Edit/Write. A guard rail, not a sandbox —
  the same caveat as `bash`;
- the run holds **no Linux capabilities**. `clawbox-setup.service` gives the web
  server `CAP_NET_BIND_SERVICE`, `CAP_NET_ADMIN` and `CAP_NET_RAW` ambiently for
  WiFi management and port 80, and ambient capabilities are inherited across
  `execve` — so a run used to start with all three while the agent's own shell
  tool, spawned by the gateway, had none. The wrapper is now spawned through
  `setpriv --ambient-caps=-all --inh-caps=-all --no-new-privs`, and a box
  without `setpriv` reports not-ready rather than running with them;
- the folder must be a code project or a directory inside the home that is
  neither protected nor the ClawBox checkout itself. Honestly said, that
  boundary binds the file tools and the run's starting point — full Bash can
  write wherever the device user can, which is the documented cost of the
  owner's switch; the brief's denial rule and the recorded denial count are
  the conduct side of the same line. With no folder named at all, the owner's
  stored default project folder is used — the same fallback the run route
  documents;
- one run at a time, thirty idle minutes before the device gives up on it,
  400 turns by default (10–2000), an optional token ceiling the device itself
  enforces, an explicit environment (no session secret, no service tokens),
  `--setting-sources user` so the OS checkout's own CLAUDE.md never steers a
  project that sits under it;
- **`completed` means the DELIVERABLE exists** wherever a run HAS one, rather
  than meaning the harness said it was done (`src/lib/coding-deliverable.ts`).
  Where it has none the old rule stands unchanged, which is most runs: no
  `deliverable_files` and the owner's auto-PR switch off is ordinary harness
  completion. `deliverable_files` on `coding_agent_run` is a comma-separated
  list of relative paths that must exist and be non-empty; with auto-PR ON a
  pull request for the run's branch is IMPLIED and needs no argument — but only
  where one was possible, so the implication steps aside when the box recorded
  that its own pull-request flow could not run (no repository to branch, or
  `pr.phase === "failed"`), since nudging the harness for a pull request the
  DEVICE cannot open would spend every attempt on the one thing the harness
  cannot fix. When the check fails
  the device resumes the run IN ITS OWN SESSION with a nudge naming what is
  missing, up to `coding_agent_completion_attempts` (default 3, the run's own
  first turn counted as one), and then settles it as `gave_up` — a status of
  its own, because the session is intact and Resume is what helps, where
  `failed` means the harness could not finish at all. `coding_agent_status`
  reports the bar, the verdict and the attempts, and says plainly not to start
  a fresh run for a `gave_up` one. There is deliberately no `command`
  deliverable on this tool surface: that kind has the box RUN something, which
  is execution the agent does not otherwise hold on the Hermes edition, so it
  is the owner's to set in the Coding Agent app.

**Following and moving runs** (`coding_run_list`, `coding_agent_resume`,
`coding_project_status`, and what `coding_agent_stop` does beyond a live run).
All four read the SAME record the runs route answers (`GET
/setup-api/coding-agent/runs`, up to its `MAX_LIMIT` of 30) and the projects
route answers (`GET …/projects`), so a row cannot disagree with the run's own
status. What each row field means:

- `branch` / `copy` — the run's own git worktree (`RunWorktree`): `in use`,
  `kept, not merged home yet`, `kept, could not be merged home: <device's
  reason>`, `merged into <base>`, `files removed; the work is kept on branch …`,
  or `removed with its branch — the run left nothing on it`. Bringing a branch
  home (`POST …/merge`) is the OWNER's button and refuses this bearer.
- `attempts` — goes at the deliverable, the run's own first turn counted, out of
  `coding_agent_completion_attempts`; `deliverable.met` is the device's verdict
  and `missing` its reason — never a `command` deliverable's output, for the
  reason `coding_agent_status` withholds it.
- `paused_because` — `paused on purpose`, or which allowance is used up and when
  it comes back (`pauseReason`).
- `detached` — a RUNNING run in its own systemd scope (`run.unit`): it keeps
  working through a restart of the web server and is reattached after one. A
  message to a reattached run is queued for its next step, because the pipe it
  would have been written to died with the old server.
- `left_running` — the run has settled but a process it started is still up
  (`run.leftover`): usually a server it left listening, which may be what the
  box serves one of its apps from.
- `can_resume` — `paused` or `gave_up`, and started by the agent.

`coding_agent_resume` posts `…/resume`, which re-enters the SAME session in the
same folder (re-creating the run's copy from its branch if the copy was
removed) through the same gates a start passes. It refuses before calling the
route when the run is the OWNER's (the route's `runLifecycleRoute` answers this
bearer 403 for those, whatever their state), when it is not `paused`/`gave_up`
(a `failed` run that hit a ceiling is sent to `coding_agent_run
resume_run_id`), and when the allowance that paused it has a known reset time
still in the future — resuming then only buys the same refusal. With `message`
the text is queued first (`…/message`), so the run reads it as it goes back in;
a resume refused after that says the message is already queued, so a retry does
not send it twice. `can_resume` is left off a run whose allowance is still spent.
Every other refusal is the route's own sentence (the slot is taken, the folder
is gone, the account it ran on is no longer connected), carried through as
CONFLICT / do-not-retry. `coding_agent_stop` on a `paused` run closes it
(`…/stop` settles it `stopped`; it can no longer be resumed); on a finished run
with `left_running` it says so and ends the process only with
`end_leftovers: true` (`…/kill`). Pausing is not offered: it is the owner's
gesture, and stopping already covers ending a run.

### Coding team (both editions, the same switch)

`coding_team_run` · `coding_team_status` · `coding_team_stop`

The multi-agent shape of the coding agent (`src/lib/coding-team.ts`): one
GOAL, a **planner** (a read-only run on the tier model whose final message
must be a JSON array of tasks), **workers** (one ordinary run per task, each
told its task with the goal and its teammates' results around it — in a
folder project SIDE BY SIDE, each in its own git worktree and branch off the
team's branch, up to `MAX_TEAM_WORKERS` (3) while the box has the memory,
each merged home as it settles; a merge git cannot do alone is aborted and
the task offered once more from the merged state; a code project keeps one
worker at a time, in place), a **reviewer** (the v0 rule first — a refused
action or a stray file rejects without a model — then a read-only run on
the merged work that answers `{verdict, notes}`; a reviewer that gives no
verdict is an alert and an acceptance by rule, never a silent pass), all on
a **shared blackboard**
(`data/coding-team/<team>.json`) that refuses any message its sender's ROLE
may not send — only the planner posts tasks, only the assigned worker moves
one or submits a result, only the reviewer rules, only the owner stops — and
logs every accepted message and every refusal (the audit trail). A worker
that hit a permission denial or strayed outside its files raises an ALERT;
three alerts stop the team. `coding_team_run` is for a goal that spans
several parts; `coding_agent_run` is still the tool for one focused change.
`coding_team_status` answers the plan, each task's status, worker, reviewer
and result, the alerts, the team's branch, `agents` (planner, workers,
reviewers, total — who worked), and what to tell the user; `log: 1` adds the
last lines of the audit log. Every agent is a coding run, so the sandbox and
the ceilings above apply unchanged; the one-run-at-a-time rule is between
STRANGERS — a team's own runs share the box, a run of anyone else waits.

`coding_agent_status` can block (`wait_seconds`, up to two minutes) instead of
polling. `coding_agent_stop` posts `{ runId }` (the stop route keeps `{ id }`
as an alias from its launch shape). `coding_run_message` is how a run that is
still going is STEERED rather than stopped: the text is queued on the run's
record (at most 20 waiting, 4,000 characters each, plain text) and delivered
either as the harness's next user turn — the runs spawn with Claude Code's
`--input-format stream-json` — or, on a box whose harness refuses that, folded
into the continuation of its next attempt or the owner's Resume. The tool says
which of the two happened. The owner's own input is on the run's page in the
Coding Agent app; a run the OWNER started answers the MCP bearer 403 here, as
it does for stop and resume, and a browser request from another site is
refused 403 `cross_origin` (a header-less caller such as this server is not). The summary it returns is model-authored and labelled as information,
not instructions. Finishing a run posts a desktop toast and, when a Telegram
bot is connected, a template-only message — never the task or the summary —
to the approved senders (`src/lib/coding-agent-notify.ts`).

### Memory Shard

`memory_shard_status` (both editions) · `memory_shard_search` (Hermes only)

`memory_shard_status` reads `GET /setup-api/clawkeep/memory` — the same status
the Memory Shard app draws: switched on, set up, the paid-plan gate, health,
whether semantic search works, where the embeddings run, folders / files /
chunks, files waiting or failed, whether the index needs a reindex, the last or
running pass, and the schedule. A RUNNING pass reports its progress from the
counts the device writes while it runs (`run.progress`, #909/#925): `30 of 120
files (25%); 800 chunks in the index so far`, or `still scanning the folders`
while the total is not known yet — never a made-up 0%. Both editions have an
index now (OpenClaw's own, or the one ClawBox keeps where there is no OpenClaw),
so the tool is registered on both, with one description per edition: only the
Hermes one points at `memory_shard_search`, which is Hermes-only because on
OpenClaw the index is OpenClaw's and it searches it as part of a turn.

**There is no reindex tool.** `POST /setup-api/clawkeep/memory/index` answers
this bearer 403 `owner_only` on purpose — before that check the assistant could
start a full re-embed of the owner's documents on its own, an hours-long pass
that spends the embedding allowance. The status says so, and tells the agent to
open the app (`ui_open_app("memory-shard")`) for the owner to press Reindex, and
then to report progress from this tool — not to poll it in a loop. The switch,
the folders, the provider and the schedule are owner-only for the same reason.

### Local AI (both editions)

`local_ai_status`

The engines that run ON the box — Kokoro (speaks replies), Whisper (transcribes),
the embedding model behind Memory Shard, the llama.cpp model — from `GET
/setup-api/local-models`, the per-model inventory the Settings → Local AI tab
draws (installed, running / idle / on-demand / not-installed /
not-on-this-edition, disk and memory, the device's own one-line detail, which is
never a path or a command). Alongside it, which voice and which transcription
engine the box uses now (`GET /setup-api/tts` `choice`/`activeEngine`, `GET
/setup-api/stt` `primary`/`chain`). `engine: "whisper"` adds the downloaded
sizes and free disk (`GET /setup-api/whisper`), `engine: "embeddings"` the
embedding service's unit state (`GET /setup-api/embed/status`). Each leg past
the inventory is independent, so one that does not answer costs only its line.
The inventory leaves the embeddings row out until the device has read the
memory index once; the answer then says `not_read_yet` rather than implying
there is no embedding model.

**There is no install tool.** Since 2026-09-15 an install or update puts no
engine or model on a box but llama.cpp and Gemma 4, so Settings → Local AI's
Install is the only way Kokoro, Whisper or the embedding model arrives — and
`POST /setup-api/tts/install`, `POST /setup-api/whisper` and `POST
/setup-api/embed/install` all answer this bearer 403 `owner_only`: they run a
root install step and download gigabytes onto the owner's disk. The answer names
what is not installed and where the owner's button is.

### ClawBox AI usage (both editions)

`clawbox_ai_usage`

`GET /setup-api/ai-models/usage`, the route behind the usage card in Settings →
Providers: the plan, the weekly allowance and the 5-hour burst limit (percent
used, whether it is used up, when it frees up, in UTC), the weekly meters
(pictures, spoken replies, transcribed audio, memory indexing — "not part of
this plan" where the limit is 0), prepaid credits, and the box's time zone. The
route always answers 200 with `available`, and the tool turns every "no" into a
plain answer rather than an error: `not_connected` (link it in Settings →
Providers), `refused` ("ClawBox AI does not share usage details with this box
yet" — the card's own words; the owner sees them on clawbox.com), `unreachable`,
`invalid`. It is the read the coding tools' `paused_because` and a refused chat
point at. There is no tool that changes the plan or buys credits: both are
billed, for the reason there is no plan switch (see "AI configuration").

### Anthropic accounts (both editions)

`anthropic_accounts`

`GET /setup-api/anthropic/accounts` (TASK-902), the route behind Settings → AI
providers → Anthropic accounts: every Anthropic account the owner connected for
coding runs — Claude Pro/Max sign-ins, API keys, this box's own `claude`
sign-in — in the order the box uses them, each with its label, kind, whether it
can answer now or is at its usage limit and when it is back, and which one a run
starting now would use; then `can_answer` ("1 of 2"), `all_limited` and
`next_reset`. When every account is limited it adds `advice` — wait until the
reset; runs that were cut off resume by themselves then — because that is the
moment a queue must stop spending attempts: `coding_agent_run` answers the
same situation with a CONFLICT naming the reset time. Never a credential and
never an email. Read-only: accounts are added, ordered and re-authenticated by
the owner in Settings, and the route's writes refuse this bearer 403
`owner_only`.

### What the agent deliberately cannot do

The audit behind TASK-899 found these route families with no tool, and each
stays that way because its route refuses this bearer (owner session, usually
same-origin too) for a stated reason — a tool would only ever be refused, which
is also what Hermes' circuit breaker counts against every ClawBox tool:

| Owner's only | Route(s) | Why |
|---|---|---|
| Coding agent switch and settings, secrets, permissions, Anthropic/GitHub sign-in, reset | `coding-agent/enable`, `secrets`, `permissions`, `anthropic`, `github-login`, `reset` | consent to a delegated shell and to the owner's credentials |
| Pipeline default | `POST/PUT …/pipeline` | a switch a tool could flip would make the owner's answer temporary |
| Bringing a run's branch home, the file tree's writes, project import/delete | `coding-agent/merge`, `PUT …/tree`, `projects/*` | the owner's repository and folders |
| Pause, discard a draft, remove a run's copy | `…/pause`, `DELETE …/draft`, `…/worktree` | agent-callable for the agent's own runs but left out: owner gestures `coding_agent_stop` already covers |
| Reindex, Memory Shard switch/folders/provider/schedule/reset | `clawkeep/memory/*` writes | an hours-long re-embed of the owner's documents |
| Installing or removing Kokoro, Whisper, embeddings, models | `tts/install`, `whisper`, `embed/install`, `ollama/*`, `llamacpp/models` | root install steps, gigabytes of downloads |
| MCP switch, background jobs | `harness/mcp`, `background-jobs` | consent |

### Examples and refusal shapes

Every refusal is the `{ error, code, message, next }` envelope; `next` is what
the agent does instead. Success bodies are shortened here.

```jsonc
// coding_run_list {"status": "paused"}
{ "runs": [ { "run_id": "run-k3x9q2ab", "status": "paused", "started_by": "agent",
    "project": "site", "branch": "clawbox/run-k3x9q2ab", "copy": "kept, not merged home yet",
    "attempts": "1 of 3", "deliverable": { "kind": "files", "files": ["index.html"], "met": false,
    "missing": "index.html was not created" }, "paused_because": "paused on purpose", "can_resume": true } ],
  "notes": "detached: … can_resume: … left_running: … copy: …" }

// coding_agent_resume {"run_id": "run-k3x9q2ab", "message": "index.html goes in the root"}
"Resumed run run-k3x9q2ab in its own session on branch clawbox/run-k3x9q2ab. It was given your message as it went back in. …"
// … on the owner's run, or while its allowance is still spent:
{ "error": true, "code": "CONFLICT", "message": "That run was started by the owner, so only they can resume it.",
  "next": "Do not retry. Tell the user Resume is on the run's page in the Coding Agent app." }
{ "error": true, "code": "CONFLICT", "message": "Run run-k3x9q2ab is paused because the weekly ClawBox AI chat allowance is used up; it comes back at 2026-09-21 00:00 UTC. …",
  "next": "Do not retry now. Tell the user when it comes back; resume it after that if they still want it." }

// coding_agent_stop {"run_id": "run-k3x9q2ab"} on a finished run that left a server up
"Run run-k3x9q2ab already finished (completed), but something it started is still running … call coding_agent_stop again with end_leftovers set to true."

// coding_project_status {}
{ "project_folder": "/home/clawbox/projects", "projects": [ { "project": "site", "kind": "folder",
    "run_it_with": { "directory": "site" }, "last_commit": "2026-09-17 10:30 UTC — Add a dark mode toggle",
    "on_desktop": true, "app": "server app on port 4230, opened at /apps/site/", "latest_run": "run-k3x9q2ab (completed)",
    "runs_working": 0, "runs_waiting": 1, "branches_not_merged": 1, "left_running": 0 } ] }


// memory_shard_status {} during a reindex
{ "switched_on": true, "health": "healthy", "files_indexed": 120, "chunks": 3400,
  "indexing": { "now": "running", "mode": "full", "progress": "30 of 120 files (25%); 800 chunks in the index so far" },
  "guidance": "An indexing pass is running. Tell the user how far it has got; do not check again in a loop …" }

// local_ai_status {}
{ "engines": [ { "id": "kokoro", "name": "Kokoro", "does": "speaks replies aloud", "installed": false, "state": "not-installed" }, … ],
  "voice": { "chosen": "auto", "speaking_with": "the ClawBox cloud voice" },
  "guidance": "Not installed here: Kokoro. The owner installs an engine with Install in Settings → Local AI …" }

// anthropic_accounts {} while account #1 is at its session limit
{ "can_answer": "1 of 2", "all_limited": false, "next_reset": "2026-09-18T19:50:00.000Z",
  "accounts": [ { "priority": 1, "label": "Work Max", "kind": "Claude account", "status": "at its usage limit", "back_at": "2026-09-18T19:50:00.000Z" },
                { "priority": 2, "label": "Personal Max", "kind": "Claude account", "status": "can answer", "in_use": true } ] }

// clawbox_ai_usage {}
{ "plan": "Pro", "weekly_allowance": "40% used, 40 of 100 tokens, frees up at 2026-09-21 00:00 UTC",
  "five_hour_limit": "USED UP, 100% used, 10 of 10 tokens, frees up at 2026-09-18 15:00 UTC", "credits": "12.50 EUR left" }
"ClawBox AI does not share usage details with this box yet. Tell the user they can see them in their account on clawbox.com."
```

## Safety rules every tool follows

1. **One secret denylist**: `isProtectedFilePath` from `src/lib/file-guard.ts`,
   plus two MCP-local rules in `mcp/lib/guard.ts` — device nodes and `/proc`,
   and `.env` / `.env.*` / `.envrc` anywhere (the project-root one is both a
   credential store and the `EnvironmentFile` `clawbox-setup.service` loads).
   Applied to **descendants**, not just the path handed in: `list_directory`
   filters entries, `glob` filters results, `grep` filters both search roots and
   every hit (paths come back NUL-terminated, so a hit path is parsed rather
   than guessed). Applied to the path **as typed and as resolved**: every rule
   is judged on the canonical path too (nearest existing ancestor, so a deep
   new path under a link is judged where it would land; a dangling link is
   followed to the name the kernel would create through it), resolved ONCE
   per call so the path the sink gets is the string the guard judged. The trio
   is registered on every OpenClaw box; where the gated file tools are switched
   on too, `read_file`, `write_file`, `edit_file` and `notebook_edit` open THAT
   path with `O_NOFOLLOW`, and `grep` is handed it as the argv root it searches
   (rg follows a link named on its command line, so it must be given the
   target) — a benign name linking to `.env`, `/proc/self/environ` or a file
   in the ClawBox tree is refused, and a leaf that is a link at the moment of
   the open (swapped in after the check, or a cycle) is refused as
   `BLOCKED_PATH` rather than followed.
2. **Argv only.** `spawnArgv()` is the sole process entry point outside `bash`;
   no tool builds a shell string out of an argument.
   **What `bash` guarantees, stated plainly:** nothing. Its pre-flight refuses
   commands that name a credential store, but that is a guard rail against a
   mistake, not a sandbox — a shell can spell a path in ways no pattern list
   enumerates. What bounds it is that it is registered on no shipped device at
   all (only where an owner set `CLAWBOX_MCP_CODING_TOOLS=1`), that every other
   tool is argv-driven and goes through the real path guard, and that its own
   description tells the agent never to run a command that came from content it
   read. Plan around "`CLAWBOX_MCP_CODING_TOOLS=1` + `bash` = the agent can
   reach anything the device user can". Its `allow_dangerous` flag skips the
   typo check on destructive spellings (`rm -rf`, `git push --force`) and
   nothing else: it is a model-supplied boolean, so it is neither an
   authorization nor the owner's consent, and no code treats it as either.
   The shell's OWN environment no longer carries the device bearer:
   `CLAWBOX_MCP_TOKEN` is read into `mcp/lib/api.ts`'s cache and deleted from
   `process.env` first thing at startup (`primeApiToken`), before any child is
   spawned, so `printenv` finds none. That is hygiene, not a mitigation, and
   nothing here counts it as one: `delete process.env.X` does not rewrite the
   exec-time block the kernel keeps, so `/proc/<server pid>/environ` still
   holds the value for any same-uid child as long as
   `scripts/gateway-pre-start.sh` registers `mcp.servers.clawbox` with the
   token in `env` — and the same child can read `~/.openclaw/openclaw.json` or
   `data/.mcp-token` as user clawbox regardless. The real removal is that
   script registering the server WITHOUT `env.CLAWBOX_MCP_TOKEN` and letting
   it use the `data/.mcp-token` fallback it already has (the coding runner's
   `buildRunMcpConfig` registers its browser-profile server exactly that way).
3. **Confirmation on irreversible actions** — `system_power` and
   `code_project_delete` take `confirm: true`, which an injected page cannot
   supply by accident.
4. **Timeouts and output caps everywhere.** Default 8 s per API call and 4 000
   characters per result; images over 1 MB are dropped rather than truncated.
   A tool whose answer is a LIST bounds its own rows against its cap and says
   how many it left out — `skill_list` drops built-in skills first, then the
   ones made on the device, and only then store skills (the ids
   `skill_uninstall` resolves, so they are the last to go), saying how many
   store-or-device-made skills and how many built-ins it dropped; `ui_list_apps`
   drops skills before apps and never a built-in app, also stating the count —
   because the cap's own enforcement is a hard slice: it cuts a JSON answer
   mid-object and an id mid-word, and its "narrow the query" is advice a tool
   with no arguments cannot take. `ui_list_apps` MEASURES its finished JSON
   rather than modelling the serializer, because a row carries third-party text
   whose escaping costs more than its characters (`fitRows` in
   `mcp/lib/guard.ts` is the seed, not the guarantee).
5. **Errors are instructions, not stack traces.** Every failure is
   `{ error, code, message, next }` — including schema rejections, which the SDK
   would otherwise render as a raw zod issue array (`reg.finalize()` owns
   `tools/call` for exactly this reason) — with `code` from a fixed set
   (`AUTH_FAILED`, `BAD_ARGUMENT`, `BLOCKED_PATH`, `NOT_FOUND`,
   `NOT_SUPPORTED_HERE`, `ENDPOINT_DOWN`, `TIMEOUT`, `CONFLICT`, `TOO_LARGE`,
   `DANGEROUS_COMMAND`, `INTERNAL`). No `details`, no stack, no absolute path —
   every string passes through `scrubPaths()` + `redact()`.

## Layout

```
mcp/clawbox-mcp.ts     entry: resolve app harness (one probe) → resolve edition → probe capabilities → register → connect
mcp/check-tools.ts     surface check; run after any change here
mcp/clawbox-cli.ts     shell-callable wrapper (clawbox webapp/app/notify/system/code/edition)
mcp/lib/edition.ts     edition resolution (imports readEdition, never re-implements it)
mcp/lib/register.ts    the tool() wrapper: gating, annotations, caps, error envelope
mcp/lib/errors.ts      error vocabulary, per-route rules, scrubbing
mcp/lib/api.ts         /setup-api client: token, timeout, redirect:"manual"
mcp/lib/guard.ts       path guard + argv spawn
mcp/lib/schema.ts      zod parameter builders (bounded ints, closed enums)
mcp/lib/context.ts     startup-resolved device facts and capability probes
mcp/lib/jobs.ts        background shell jobs for `bash` (registered only under CLAWBOX_MCP_CODING_TOOLS=1)
mcp/lib/web.ts         SSRF-guarded fetch and HTML→text
mcp/tools/*.ts         one module per tool family
mcp/tools/coding-agent.ts
                       delegation to the claude-ds harness; runs live in the web server
```

**Import rule for `mcp/**`:** a `src/lib` module may be imported only if its
*entire transitive* import graph is relative paths + node builtins. Verified
safe: `edition-source`, `file-guard` (→ `config-store`), `hermes-skills`,
`hermes-reasoning`, `hermes-providers`, `local-model-profile`,
`desktop-app-editions`. Anything using the `@/` alias is
forbidden — bun resolves it inconsistently for files outside the root tsconfig,
and it drags server-only Next.js code into this stdio process.
`mcp/tsconfig.json` encodes exactly this list.

## Environment

| Variable | Meaning |
|---|---|
| `CLAWBOX_API_BASE` | Device API origin. Default `http://127.0.0.1:80`. |
| `CLAWBOX_MCP_TOKEN` | Bearer for `/setup-api/*`. Falls back to `<root>/data/.mcp-token`, so a provisioning entry need carry no secret. Read once at startup and deleted from the process environment, so a `bash` child's own `printenv` finds none (hygiene only — the server's `/proc/<pid>/environ` keeps the exec-time value; see "What `bash` guarantees"); the `clawbox` CLI a shell invokes reads the file. |
| `CLAWBOX_MCP_PROFILE` | `full` (default), `core` or `browser` pins the tool set (`browser` = the browser family only — what a delegated coding-agent run gets); `auto` makes it FOLLOW THE MODEL — a device whose active provider is the on-device one and whose model is small (≤8B, or a ≤16k context) registers `core`, everything else `full`. `auto` is opt-in because this process sees only the persisted provider, not the chat header's per-turn override. See `mcp/lib/profile.ts` and `docs/hermes-reasoning-levels.md`. |
| `CLAWBOX_SMALL_MODEL_PROFILE` | `off` disables the `auto` selection above (the explicit pins still work). |
| `CLAWBOX_MCP_CODING_TOOLS` | `1` registers the coding family — `bash`, `job_status`, `job_stop`, `read_file`, `write_file`, `edit_file`, `notebook_edit`, `web_fetch`, `web_search` — on **every** edition. Unset (the shipped state) they are registered on none, because both harnesses already ship a shell and file tools and the duplicates cost ≈ 12.5 KB of `tools/list` for prompts that chose the built-ins six times out of six. `list_directory`, `glob` and `grep` are *not* behind it on OpenClaw — see "Coding family". Read at registration time by this process, so it belongs in the server's own `env` block (Settings → MCP, or the Harness page), followed by a harness restart; `scripts/gateway-pre-start.sh` does not set it. |
| `CLAWBOX_MCP_IDLE_EXIT_MS` | Milliseconds with **no inbound JSON-RPC traffic and no request in flight** after which the server closes its transport and exits 0, so the harness reconnects on the next call. Default `600000` (10 min); `0` disables it. A value that is not a non-negative number falls back to the default rather than to `0`, and anything past `2147483647` (24.8 days, the longest delay a timer can hold — both runtimes turn a larger one into 1 ms) is clamped to it, so a bigger number never means a shorter wait. See "The server hangs up when it is idle". |

## Work owned by others

- **`POST /setup-api/hermes/models` should accept `{ reasoning }`.** Until it
  does there is no `ai_set_thinking` tool: the only alternative is a fourth
  uncoordinated writer of `~/.hermes/config.yaml`, which would silently drop
  `mcp_servers` or the provider key.
- **`GET /setup-api/gateway/health` answers HTTP 200 with
  `{"available": false}`** when the gateway is gone. `clawbox_health` reads the
  field, not the status code; any other consumer treating 200 as "up" is wrong.
- **Doc drift.** Both `CLAUDE.md` files still list `run_command`, `file_list`,
  `file_read`, `file_write`, `file_mkdir`, `code_file_*` and `code_search`.
  None of those exist. This README is the accurate map.
