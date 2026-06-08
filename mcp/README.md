# ClawBox MCP

The agent's interface to OpenClaw OS. `clawbox-mcp.ts` is a [Model Context
Protocol](https://modelcontextprotocol.io) server (stdio transport) that
exposes ~45 tools so the OpenClaw agent can drive the device — shell, files,
web, browser automation, the desktop, system control, code projects, and a
full Claude-Code-style coding suite.

```
agent ──stdio (MCP)──▶ clawbox-mcp.ts ──HTTP(Bearer)──▶ Next.js /setup-api/* ──▶ device
                       clawbox-cli.ts  (same backend, shell-callable)
```

- **`clawbox-mcp.ts`** — the full MCP server. Spawned as a stdio subprocess of
  the OpenClaw gateway.
- **`clawbox-cli.ts`** — a thin shell wrapper over a subset of the same
  `/setup-api/*` calls, for when the agent only has `exec` (no MCP tool
  calling). `clawbox webapp create`, `app open`, `notify`, `system info`,
  `code …`.

## Authentication

`/setup-api/*` is gated by `src/middleware.ts` once setup completes. Service
callers (the MCP/CLI have no session cookie) authenticate with a per-install
**bearer token**:

- **Source of truth:** `data/.mcp-token` (mode 0600), minted on first read by
  `src/lib/mcp-token.ts`. Override via the `CLAWBOX_MCP_TOKEN` env var.
- **Injection:** both the MCP server and the CLI send
  `Authorization: Bearer <token>` on every call. The MCP reads it from its env
  (`scripts/gateway-pre-start.sh` injects it); the CLI reads `CLAWBOX_MCP_TOKEN`
  and falls back to the `data/.mcp-token` file (it's launched separately and
  may not inherit the env).
- **Verification:** `middleware.ts` → `verifyMcpBearer()` (constant-time),
  scoped to `/setup-api/*` only.

> Without the bearer, every call is `307`-redirected to `/login`: POSTs surface
> as `405`, GETs return the login HTML that `JSON.parse` chokes on with
> **"Failed to parse JSON"**. If you see that, your token is missing or wrong —
> run the `clawbox_health` tool.

## Tool catalog (~45)

| Category | Tools |
|----------|-------|
| **Diagnostics** | `clawbox_health` (token + API reachability), `clawbox_context` (field guide) |
| **Shell** | `bash` (dangerous commands blocked by default — see below), `task_status` |
| **Files** | `read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `grep` |
| **Web** | `web_fetch`, `web_search`, `notebook_edit` |
| **Agent / tasks** | `agent`, `task_create`, `task_update`, `task_get`, `task_list`, `task_stop` |
| **System** | `system_stats`, `system_info`, `system_power` |
| **Browser (CDP)** | `browser_open`, `browser_launch`, `browser_navigate`, `browser_click`, `browser_type`, `browser_keypress`, `browser_scroll`, `browser_screenshot`, `browser_close` |
| **App store** | `app_search`, `app_install`, `app_uninstall` |
| **Network** | `wifi_scan`, `wifi_status`, `vnc_status` |
| **Preferences** | `preferences_get`, `preferences_set` |
| **Desktop UI** | `ui_open_app`, `ui_list_apps`, `ui_notify` |
| **Webapps** | `webapp_create`, `webapp_update` |
| **Code projects** | `code_project_init`, `code_project_list`, `code_project_build`, `code_project_delete` |

## Errors are structured

Every tool handler is wrapped so a failure returns a parseable envelope (as the
tool's text content, with `isError: true`) instead of a free-form string:

```json
{ "error": true, "code": "AUTH_FAILED", "message": "...", "details": "..." }
```

`code` is one of: `AUTH_FAILED` (401/403 — bad/missing bearer), `NOT_FOUND`
(404), `ENDPOINT_DOWN` (5xx), `API_ERROR` (other non-2xx), `TIMEOUT`,
`INVALID_RESPONSE` (non-JSON body), `INTERNAL`, or `DANGEROUS_COMMAND` (see
below). Branch on `code` rather than scraping `message`.

## `bash` safety

`bash` hard-**blocks** destructive commands (`rm -rf /`, `dd of=/dev/…`,
`mkfs.*`, redirect-to-raw-device, fork bombs, `kill -9 -1`, stopping critical
services, etc.), returning `{ error: true, code: "DANGEROUS_COMMAND" }`. To run
one anyway, pass `allowDangerous: true` (you accept responsibility; the override
is logged). Git-safety patterns (`--no-verify`, `git add -A`, …) only **warn**.

## Testing

```bash
# 1. Health first — proves the token works end-to-end
CLAWBOX_MCP_TOKEN=$(cat data/.mcp-token) bun run mcp/clawbox-mcp.ts
#    then send an MCP tools/call for clawbox_health → { "healthy": true, ... }

# 2. Full smoke test of every tool over JSON-RPC stdio
bash mcp/test-tools.sh

# 3. CLI sanity (uses the data/.mcp-token fallback)
bun run mcp/clawbox-cli.ts system info     # → JSON, not "Failed to parse JSON"
```

The MCP runs under **bun** (types stripped at runtime) and `mcp/` is excluded
from the Next `tsconfig`, so it is not part of the app's typecheck — keep the
runtime smoke tests green.

## Common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Failed to parse JSON` / `API 405` on every call | missing/invalid bearer (`307 → /login`) | run `clawbox_health`; ensure `CLAWBOX_MCP_TOKEN` or `data/.mcp-token` is set |
| `{ code: "AUTH_FAILED" }` | token rejected by middleware | re-check the token matches `data/.mcp-token` |
| `{ code: "DANGEROUS_COMMAND" }` | `bash` blocked a destructive command | pass `allowDangerous: true` if intentional |
| A created webapp doesn't appear on the desktop | the desktop reconciles `data/webapps/` on load | reload the desktop; the app grid re-syncs from the server |
