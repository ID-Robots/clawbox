# MCP server

The ClawBox MCP server: the tool set per edition, registration with each harness and the CLI wrapper. Read it together with `mcp/README.md` (the authoritative tool list) when you touch `mcp/`.

## MCP Server (`mcp/`)

The AI agent interface to the OS. See `mcp/README.md` for the authoritative tool
list, the safety rules and the layout — that file is kept in step with the code;
this section is only a map.

**The tool set depends on the device edition**, resolved once at startup from the
root-owned `/etc/clawbox/edition.env` (`src/lib/edition-source.ts`). A tool that
cannot work on the running edition is not registered at all, because Hermes runs
a per-server circuit breaker that would take every ClawBox tool offline once one
of them kept failing.

- **`clawbox-mcp.ts`** — server entry: resolve edition → probe capabilities →
  register → connect. Tool families live in `mcp/tools/` (`orientation`,
  `skills`, `ai`, `system`, `desktop`, `browser`, `media`, `email`, `coding`,
  `coding-agent`, `memory`, `prime-radiant`, `local-ai`) and the shared
  machinery in `mcp/lib/` (`edition`, `guard`, `api`, `errors`, `schema`,
  `register`, `context`, `run-context`, `jobs`, `web`).
  - **Both editions**: `device_status`, `clawbox_health`, `clawbox_context`,
    `system_stats`, `system_info`, `system_power`, `disk_usage`, `disk_cleanup`,
    `update_check`, `logs_tail`, `screen_capture`, `backup_status`,
    `telegram_status`, `email_send`, `wifi_scan`, `wifi_status`, `vnc_status`,
    `preferences_get`, `preferences_set`, `ui_open_app` (with `run_id` /
    `team_id` / `project_id` for the `coding` app, a `target` on the ring's
    `open_app`), `ui_open_card` (`new_app`: the chat's Create card, an
    `open_card` ring action `page.tsx` opens the chat for), `ui_list_apps`,
    `ui_notify`, `app_uninstall`, `webapp_create`, `webapp_update`,
    `code_project_init/list/build/delete`, `browser_open/navigate/screenshot/close`,
    `describe_image`, `memory_shard_status`, `local_ai_status`, `clawbox_ai_usage`
    (read-only; installs and the plan stay the owner's), the `memory_shard_*`
    management tools (incremental passes on its own; a full re-embed, a
    provider move or a reset only with `confirm: true` after the owner's yes),
    `coding_agent_run/status/stop` (`coding_agent_run` and `coding_team_run`
    are the ONLY tools whose result carries MCP `structuredContent` —
    `{ kind, id, projectId, directory, title, status, queuePosition? }`, `ToolResult.structuredContent`
    in `mcp/lib/register.ts`; their prose tells the assistant the chat shows
    the card and not to poll), `coding_run_message`, `coding_run_list`,
    `coding_agent_resume`, `coding_project_status`, `coding_project_import`
    (the app's Import panel as a tool since 2026-10-30: a GitHub repository
    or a folder on the box into the project folder; `POST
    coding-agent/projects/import` admits the MCP bearer for it),
    `coding_settings_get`, `coding_settings_set` (the coding TEAM's
    settings since 2026-10-30 — effort, each role's provider/model/effort,
    review pass, auto PR and merge, PR body, dynamic team, runs at once,
    history, media, commit identity — through `GET/POST
    coding-agent/settings`, which admits the bearer for exactly that set and
    refuses the owner's consent surfaces by name; `coding-settings-patch.ts`
    in coding-agent.md),
    `coding_secret_list`
    (registered only while the owner's switch is on
    and the `claude-ds` harness is ready — probed at startup, and unlike
    `email_list` never re-probed after it),
  - **Prime Radiant** (both editions, full profile only): the `prime_radiant_*`
    family (`mcp/tools/prime-radiant.ts`, 31 tools) — every action of the app plus
    page create/edit/delete/merge and claim add/edit/delete/verify — calls the app's own
    `/setup-api/prime-radiant/*` routes; `writerGuard` admits the MCP bearer as
    the assistant, whose commits are authored `ClawBox assistant` so History shows
    them and Undo reverses them; the bearer may undo only its own commits, and
    init, the document drop and reindex/rejudge/migrate stay owner-only.
  - **The browser family** (`mcp/tools/browser.ts`) relays the route's
    `browser` field: the header line names the device's own window on the
    screen or the invisible one, said ONCE per session and again when a fresh
    session lands on the other browser (a property of the session is not worth
    repeating on every click), with nothing claimed by a server that predates
    the field. Inside a run it asks the run to say which one it verified on;
    outside one it stops the assistant sending the owner to look at a window
    that was never opened. There is deliberately no tool for the switch —
    putting a browser on the owner's screen is a consent, and a tool that could
    turn it back on would make the owner's "no" temporary, the same reason
    `browser_auto_open` has none. `clawbox_context` carries the standing half
    of that (`BROWSER_GUIDE` in `mcp/tools/orientation.ts`), since a browser
    reply can only name the browser that answered one call.
  - **Inside a coding-agent run only**: `generate_image`, `generate_audio` —
    registered when this server was spawned for a run AND the runner named the
    media in `CLAWBOX_RUN_MEDIA` (`mcp/lib/run-context.ts`, which also reads the
    run's working and evidence folders for the browser family). A tool that
    existed and always answered "switched off" is a refusal a small model argues
    with, and on Hermes a candidate for the circuit breaker, so an unwanted one
    is not registered at all. Both are backed by the owner-fenced media routes;
    their 429 means a spent daily allowance or a busy voice, which the error
    mapping words as "carry on without" rather than "retry", and a run never
    draws its own icon — the box draws the project's icon and favicons for it.
  - **Hermes only**: `skill_search`, `skill_list`, `skill_info`, `skill_install`,
    `skill_uninstall`, `ai_list_models`, `ai_set_provider`, `ai_set_model`
  - **OpenClaw only**: `app_search`, `app_install`, `backup_list`, `backup_now`,
    `browser_click/type/keypress/scroll`, and the coding family — `bash`,
    `job_status`, `job_stop`, `read_file`, `write_file`, `edit_file`,
    `list_directory`, `glob`, `grep`, `notebook_edit`, `web_fetch`, `web_search`
- **`clawbox-cli.ts`** — shell-callable CLI wrapper (`clawbox webapp create/update`, `clawbox app open/list`, `clawbox notify`, `clawbox system stats/info`, `clawbox edition`, `clawbox code init/build/files/read/write/edit/search/delete`)
- **Registration** — the harness spawns this server only if its own config lists
  it. OpenClaw: `scripts/gateway-pre-start.sh` writes `mcp.servers.clawbox` into
  `~/.openclaw/openclaw.json`. Hermes: `scripts/register-mcp.sh` writes
  `mcp_servers.clawbox` into `~/.hermes/config.yaml`, and is run by
  `production-server.js` at every web-server boot and by
  `scripts/setup-hermes-edition.sh` at install time.
