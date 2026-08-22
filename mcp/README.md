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
| Coordinate browser control (`browser_click/type/keypress/scroll`) | yes | **no** — Hermes ships a richer browser toolset |
| Everything else | yes | yes |

## Tools

### Orientation — call these first
| Tool | What it does |
|---|---|
| `device_status` | Edition, agent, AI provider/model, configured context/output limits, thinking level, free disk, update waiting. One call, independent timeouts, dead legs report `"unknown"`. |
| `clawbox_health` | Is the device API reachable and is our token accepted. Separates auth from connectivity. |
| `clawbox_context` | The device field guide plus the webapp storage/styling rules. |

### Hermes skills (Hermes only)
`skill_search` · `skill_info` · `skill_install` · `skill_list` · `skill_uninstall`

The **id vs name** split is the trap: `skill_install` takes the full store id
(`official/pdf`), `skill_uninstall` takes the short lock name (`pdf`).
`skill_install` returns the lock name so the model never has to guess it.

### AI configuration (Hermes only)
`ai_list_models` · `ai_set_provider` · `ai_set_model`

There is deliberately **no** ClawBox AI plan switch: it changes what the
customer is billed, and "switch to pro for better results" is a one-line
prompt-injection payload with a financial outcome. The plan is reported by
`device_status`; changing it is one click in Settings → AI.

There is also no thinking/reasoning setter yet — see "Work owned by others".

### Device
`system_stats` · `system_info` · `system_power` (needs `confirm: true` + a
`reason`) · `disk_usage` · `disk_cleanup` · `update_check` (reports only, never
installs) · `logs_tail` · `screen_capture` · `wifi_scan` · `wifi_status` ·
`vnc_status` · `preferences_get` · `preferences_set` · `backup_status` ·
`backup_list` · `backup_now` · `telegram_status`

`disk_usage`, `disk_cleanup`, `logs_tail` and `screen_capture` are
**capability-probed at startup** — no `du`, no readable journal, or no screen
grabber, and the tool is simply not offered.

### Desktop, apps and building
`ui_open_app` · `ui_list_apps` · `ui_notify` · `app_search`* · `app_install`* ·
`app_uninstall` · `webapp_create` · `webapp_update` · `code_project_init` ·
`code_project_list` · `code_project_build` · `code_project_delete` (needs
`confirm: true`)  &nbsp;&nbsp;*(\* OpenClaw only)*

### Email
`email_send` (both editions)

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

The containment is server-side, in `/setup-api/email/send`: CR/LF rejected in
every header value, at most 10 recipients, and a per-hour send budget (5) that
bounds a runaway — a blast-radius limit, not consent. The owner's own "Send test
email" button is a different route with its own budget, so the agent cannot lock
the person at the keyboard out. The credentials never enter the MCP process, an
unconfigured device answers `CONFLICT` with "do not retry, tell the user to open
Settings → Email". An exhausted budget answers `CONFLICT` too — the generic 429
mapping is `ENDPOINT_DOWN` ("retry once"), which is the loop the budget exists
to stop.

### Browser
`browser_open` · `browser_navigate` · `browser_screenshot` · `browser_close`
(both editions) · `browser_click` · `browser_type` · `browser_keypress` ·
`browser_scroll` (OpenClaw only)

`browser_type` reports a character count, never the text — it is the tool that
types passwords.

### Coding family (OpenClaw only)
`bash` · `job_status` · `job_stop` · `read_file` · `write_file` · `edit_file` ·
`list_directory` · `glob` · `grep` · `notebook_edit` · `web_fetch` · `web_search`

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
| `CLAWBOX_MCP_PROFILE` | `full` (default) or `core` — `core` registers only the handful of tools a 4–8B local model needs, for the on-device model bake-off. |
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
