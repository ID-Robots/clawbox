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

Two properties of the Hermes entry are load-bearing:

- **`command` is `bun`, with the script in `args`.** Hermes refuses an entry
  whose command is a shell interpreter carrying an inline script, and it checks
  that both when the entry is saved and again when the server is spawned.
- **It carries no bearer token.** `mcp/lib/api.ts` reads `data/.mcp-token`
  itself, so rotating the token is not a config-sync problem and `config.yaml` —
  which several `/setup-api/hermes/*` routes rewrite — holds no second copy.

To check a device: `hermes mcp list` (or `openclaw mcp status`) should name
`clawbox`; `hermes mcp test clawbox` connects and lists its tools.

## The one thing to know: the tool set depends on the edition

A ClawBox ships as an **OpenClaw** device or a **Hermes** device. They have
different agents, different capability stores, and different backing routes.
The edition is resolved **once at startup** from `readEdition()`
(`src/lib/edition-source.ts` → the root-owned `/etc/clawbox/edition.env`);
only the unlocked `dual` edition falls through to one
`GET /setup-api/harness/active`. If the lock file **exists but cannot be read**,
the MCP registers the *smaller* Hermes set and logs it: `readEdition()` defaults
to `openclaw`, which is conservative for the app (the non-premium SKU) and the
opposite here — `openclaw` is the only edition carrying `bash`, `write_file` and
`grep`. An **absent** lock file is a different case (dev boxes, CI) and keeps the
documented `CLAWBOX_EDITION` fallback.

A tool that cannot work on the running edition **is not registered**. It is not
registered-and-erroring: Hermes runs a per-server circuit breaker, so one
chronically-failing tool takes *every* ClawBox tool offline for the agent.

| | OpenClaw | Hermes |
|---|---|---|
| Capability store | `app_search`, `app_install` | `skill_search`, `skill_info`, `skill_install`, `skill_list`, `skill_uninstall` |
| AI configuration | in Settings (gateway-owned) | `ai_list_models`, `ai_set_provider`, `ai_set_model` |
| Coding family (`bash`, file tools, web tools) | yes | **no** — Hermes ships its own, and a second unguarded shell doubles the attack surface for no gain |
| Coding agent (`coding_agent_run/status/stop`) | when the owner switched it on | when the owner switched it on |
| Coordinate browser control (`browser_click/type/keypress/scroll`) | yes | **no** — Hermes ships a richer browser toolset |
| Everything else | yes | yes |

## Tools

### Orientation — call these first
| Tool | What it does |
|---|---|
| `device_status` | Edition, agent, the device's **default** AI provider/model/thinking (`ai.device_default` — a chat may run a per-session override, and `ai.current_chat` says the tool cannot see it), configured context/output limits, free disk, update waiting. One call, independent timeouts, dead legs report `"unknown"`. |
| `clawbox_health` | Is the device API reachable and is our token accepted. Separates auth from connectivity. |
| `clawbox_context` | The device field guide plus the webapp storage/styling rules. |

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

When `/installed` cannot be read the tool sends the raw argument and the route
resolves it; the 200 comes back carrying the lock key it acted on and the string
it was asked for, and every message the tool prints is about **that** skill.

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
once at startup like the rest — so the same staleness the email tools had applies
here, in both directions: after linking, the refusal must go, and the harness's
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
connected AND the mode allows reading (probed once at startup — `mcp/lib/context.ts`).
Same rule as edition gating and for the same reason: a tool that could only ever
answer 409 is a tool that trips Hermes' circuit breaker and takes every ClawBox
tool offline. The route enforces the gate independently, because the two live on
opposite sides of a process boundary and the owner can change the mode under a
running server.

Because the probe is startup-only, a mode or credential change would otherwise
leave a long-lived server with the tool list it built at boot — a mailbox
connected under a running server stayed invisible to the agent until something
respawned the server. So `/setup-api/email/configure` now asks Hermes to reload
its MCP servers (`reload.mcp` on the dashboard socket, `confirm: true`) whenever
a save or a disconnect **flips** `canRead`; the server starts again and re-probes
the gate, and live sessions pick the new list up at their next turn boundary.
Only on a flip: a reload respawns every MCP child process and invalidates the
model's prompt cache, so it is not free and must not fire on an ordinary save.
See `src/lib/email-mcp-refresh.ts`.

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
`[<Channel> …]` envelope on the body). ClawBox's own chat is `webchat` there and
a CLI or TUI on Hermes, which is why the instruction names all of those as
surfaces to make the card on. Half two is native and unbuilt: Hermes'
`transform_llm_output` plugin hook, handed the final text and the platform and
free to replace it, and on OpenClaw `reply_payload_sending` — which gets the
whole outbound payload — beside the older `message_sending`, whose stage the
core itself labels "legacy … retained for low-level SDK compatibility". Either
is handed a context carrying `channelId`, which is enough to tell a channel from
`webchat`.

Every claim in the paragraph above about the harness's own internals —
`transform_llm_output`, `PLATFORM_HINTS`, `reply_payload_sending`,
`message_sending`'s "legacy" label, the hook context fields and the
`### Message Context` field list — was read off the running core, not from this
repository. Nothing here can check them: there is no vendored core and no
`node_modules/@openclaw`, and `config/openclaw-target.txt` holds a version
string and nothing else. Treat them as a note of where to look, not as verified
fact, and re-read them against the core before building on them.

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

### Coding family (OpenClaw only)
`bash` · `job_status` · `job_stop` · `read_file` · `write_file` · `edit_file` ·
`list_directory` · `glob` · `grep` · `notebook_edit` · `web_fetch` · `web_search`

### Coding agent (both editions, only while the owner's switch is on)

`coding_agent_run` · `coding_agent_status` · `coding_agent_stop`

A different thing from the coding family above. Instead of editing files
itself, the agent hands a WHOLE task to a second harness — `claude-ds`, Claude
Code running on the box's own ClawBox AI plan (`scripts/claude-ds`) — which
works in the background inside one folder and reports back with a summary.
The run lives in the web server (`src/lib/coding-agent.ts`,
`/setup-api/coding-agent/*`), not in this process: OpenClaw reaps the MCP
after ten idle minutes and a run routinely outlives that. Run ids therefore
stay valid across sessions, unlike `job-N` ids, and a run the web server lost
to a restart is settled as failed at the next boot rather than reported as
running forever.

**Registered only when `GET /setup-api/coding-agent/status` answers
`enabled && ready` at startup** (`mcp/lib/context.ts`): the owner's switch in
the Coding Agent desktop app is on AND Claude Code, the wrapper and a
ClawBox AI token are all present. Same rule as `email_list`, for the same
circuit-breaker reason. The run route enforces the switch again — 409, which
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
  flash model; the writing stays with the main loop on the tier model;
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
  150 turns by default (10–2000), an optional token ceiling the device itself
  enforces, an explicit environment (no session secret, no service tokens),
  `--setting-sources user` so the OS checkout's own CLAUDE.md never steers a
  project that sits under it.

`coding_agent_status` can block (`wait_seconds`, up to two minutes) instead of
polling. `coding_agent_stop` posts `{ runId }` (the stop route keeps `{ id }`
as an alias from its launch shape). The summary it returns is model-authored and labelled as information,
not instructions. Finishing a run posts a desktop toast and, when a Telegram
bot is connected, a template-only message — never the task or the summary —
to the approved senders (`src/lib/coding-agent-notify.ts`).

## Safety rules every tool follows

1. **One secret denylist**: `isProtectedFilePath` from `src/lib/file-guard.ts`,
   plus two MCP-local rules in `mcp/lib/guard.ts` — device nodes and `/proc`,
   and `.env` / `.env.*` / `.envrc` anywhere (the project-root one is both a
   credential store and the `EnvironmentFile` `clawbox-setup.service` loads).
   Applied to **descendants**, not just the path handed in: `list_directory`
   filters entries, `glob` filters results, `grep` filters both search roots and
   every hit (paths come back NUL-terminated, so a hit path is parsed rather
   than guessed).
2. **Argv only.** `spawnArgv()` is the sole process entry point outside `bash`;
   no tool builds a shell string out of an argument.
   **What `bash` guarantees, stated plainly:** nothing. Its pre-flight refuses
   commands that name a credential store, but that is a guard rail against a
   mistake, not a sandbox — a shell can spell a path in ways no pattern list
   enumerates. What bounds it is that it is registered on OpenClaw only, that
   every other tool is argv-driven and goes through the real path guard, and
   that its own description tells the agent never to run a command that came
   from content it read. Plan around "OpenClaw + `bash` = the agent can reach
   anything the device user can".
3. **Confirmation on irreversible actions** — `system_power` and
   `code_project_delete` take `confirm: true`, which an injected page cannot
   supply by accident.
4. **Timeouts and output caps everywhere.** Default 8 s per API call and 4 000
   characters per result; images over 1 MB are dropped rather than truncated.
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
mcp/clawbox-mcp.ts     entry: resolve edition → probe capabilities → register → connect
mcp/check-tools.ts     surface check; run after any change here
mcp/clawbox-cli.ts     shell-callable wrapper (clawbox webapp/app/notify/system/code/edition)
mcp/lib/edition.ts     edition resolution (imports readEdition, never re-implements it)
mcp/lib/register.ts    the tool() wrapper: gating, annotations, caps, error envelope
mcp/lib/errors.ts      error vocabulary, per-route rules, scrubbing
mcp/lib/api.ts         /setup-api client: token, timeout, redirect:"manual"
mcp/lib/guard.ts       path guard + argv spawn
mcp/lib/schema.ts      zod parameter builders (bounded ints, closed enums)
mcp/lib/context.ts     startup-resolved device facts and capability probes
mcp/lib/jobs.ts        background shell jobs for `bash`
mcp/lib/web.ts         SSRF-guarded fetch and HTML→text
mcp/tools/*.ts         one module per tool family
mcp/tools/coding-agent.ts
                       delegation to the claude-ds harness; runs live in the web server
```

**Import rule for `mcp/**`:** a `src/lib` module may be imported only if its
*entire transitive* import graph is relative paths + node builtins. Verified
safe: `edition-source`, `file-guard` (→ `config-store`), `hermes-skills`,
`hermes-reasoning`, `hermes-providers`. Anything using the `@/` alias is
forbidden — bun resolves it inconsistently for files outside the root tsconfig,
and it drags server-only Next.js code into this stdio process.
`mcp/tsconfig.json` encodes exactly this list.

## Environment

| Variable | Meaning |
|---|---|
| `CLAWBOX_API_BASE` | Device API origin. Default `http://127.0.0.1:80`. |
| `CLAWBOX_MCP_TOKEN` | Bearer for `/setup-api/*`. Falls back to `<root>/data/.mcp-token`, so a provisioning entry need carry no secret. |
| `CLAWBOX_MCP_PROFILE` | `full` (default), `core` or `browser` pins the tool set (`browser` = the browser family only — what a delegated coding-agent run gets); `auto` makes it FOLLOW THE MODEL — a device whose active provider is the on-device one and whose model is small (≤8B, or a ≤16k context) registers `core`, everything else `full`. `auto` is opt-in because this process sees only the persisted provider, not the chat header's per-turn override. See `mcp/lib/profile.ts` and `docs/hermes-reasoning-levels.md`. |
| `CLAWBOX_SMALL_MODEL_PROFILE` | `off` disables the `auto` selection above (the explicit pins still work). |
| `CLAWBOX_MCP_CODING_TOOLS` | `1` forces the coding family onto Hermes. Debugging only. |

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
