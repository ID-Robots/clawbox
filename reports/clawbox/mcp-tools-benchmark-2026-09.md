# ClawBox MCP tools benchmark — 2026-09-22 (TASK-1069)

Measured on real Jetson Orin Nano ClawBoxes from the flash rig, OpenClaw edition, ClawBox v4.0.0 (main 7f511dd1), OpenClaw core 2026.9.3. Raw data and the scripts are under `bench/mcp-2026-09/` next to this file.

| Box | Serial | Model | Result |
|---|---|---|---|
| 192.168.50.183 | 1791626087021 | ClawBox AI cloud (deepseek-v4-pro, served as flash) | full run |
| 192.168.50.145 | 1791626120943 | llamacpp/gemma4-e2b-it-q4_0 (local) | **blocked**: every turn fails before the model runs (see §6) |

Method: `openclaw agent --agent main --session-key <fresh> -m <prompt> --json` through the box's own gateway, ten prompts, once with the ClawBox MCP registered and once switched off through the product switch (`clawbox_mcp_enabled=false` + gateway restart, which `gateway-pre-start.sh` honours). Direct MCP measurements use a stdio client (`mcp-direct.ts`) spawning the server exactly as `openclaw.json` registers it.

## 1. Per-turn token overhead (cloud box)

| | MCP on | MCP off | delta |
|---|---|---|---|
| "hi", fresh session, input tokens | 34,792 | 24,416 | **+10,376 (+42%)** |
| tool-using turn, input tokens | 35,087–36,844 | 24,684–25,464 | ≈ +10,500 |
| pre-prompt estimate reported by the gateway | 10,275 | 10,174 | the estimate ignores tool schemas entirely |

Every fresh session pays ~10.4k tokens for the ClawBox tool schemas (59 tools, 43.9 KB of `tools/list` on this posture; 72 tools / 56.6 KB when email, coding agent and images are on). Follow-up turns in the same session reported 180–260 input tokens (provider prompt cache), so the cost lands on session starts and cache misses, not on every message.

## 2. Which tool the model actually picks (cloud box, MCP on)

| Prompt | Tool chosen |
|---|---|
| CPU temperature and memory | `clawbox__system_stats` (MCP) |
| List files in home | `ls` via built-in exec |
| Create a file and show it | built-in `exec` |
| Find .md files | built-in `exec` |
| `uname -a` | built-in `exec` |
| Append a line to workspace USER.md and read back | built-in `read` + `edit` |
| Fetch example.com title | built-in `web_fetch` |

The model chose an MCP tool only for the device question. In six of six shell/file/web tasks it used OpenClaw's own tools even though `bash`, `read_file`, `edit_file`, `glob`, `grep` and `web_fetch` were offered. On this edition the MCP coding family is paid for on every session start and not used.

## 3. Direct MCP server measurements (cloud box)

- Cold start: connect 307–347 ms, `tools/list` 20–28 ms (5 runs). `openclaw mcp doctor clawbox --probe` end to end: 4.0–4.1 s (includes the CLI's own boot).
- Process RSS: 67 MB after `tools/list`, 85 MB after the 26-call script.
- Per-tool latency (p50 / max over 3 reps): most tools under 20 ms. Slow ones: `browser_open` 1,377 / 3,008 ms; `disk_usage` 288 / 1,528 ms; `glob` 183 / 712 ms; `device_status` 174 / 1,675 ms; `clawbox_health` 124 / 659 ms; `browser_screenshot` 130 ms; `bash sleep 3` 3,007 ms as expected.
- No tool errored except the expected `BLOCKED_PATH` cases in §5. `write_file` / `edit_file` / `read_file` / `grep` / `web_fetch` all correct.
- Biggest schemas: `bash` 1,726 B, `grep` 1,570 B, `code_project_init` 1,125 B, `webapp_create` 1,120 B, `notebook_edit` 1,076 B, `web_fetch` 1,051 B, `edit_file` 1,038 B. By family: browser 5.9 KB, code_project 3.1 KB, system 2.1 KB. The coding family (bash, job_*, read/write/edit_file, list_directory, glob, grep, notebook_edit, web_fetch, web_search) is ≈ 12.5 KB, 28% of the payload.

## 4. MCP server processes are never reaped

The gateway spawns one `bun run mcp/clawbox-mcp.ts` per **session key** and keeps it. Observed on the cloud box:

- 3 turns on the same session key: 1 process. 3 turns on new keys: 2, 3, 4 processes.
- After 90 s idle: still 4. During the 10-prompt run: 9 processes alive, 63–70 MB RSS each (≈ 600 MB).
- They go away only on a gateway restart (`[bundle-mcp] server "clawbox" closed; next request reconnects`).

A single web-chat session is bounded to one process, but every Telegram chat, cron job, subagent or coding-agent run is its own session. On an 8 GB Jetson that already holds a 3.3 GB llama-server this is the most likely way the MCP hurts a box. The spawner is OpenClaw core (`bundle-mcp`), so the ClawBox-side mitigation is the server exiting itself after an idle period (the gateway reconnects on the next request), plus an upstream report.

## 5. The `.openclaw` guard (TASK-1072), reproduced on the box

Direct calls: `list_directory ~/.openclaw/workspace`, `read_file ~/.openclaw/workspace/USER.md` and `bash "cat ~/.openclaw/workspace/USER.md"` all return `BLOCKED_PATH`. With the model in the loop the request still succeeded (§2, row 6) only because the model chose OpenClaw's built-in `read`/`edit`, which are not guarded. A turn that picks the MCP tool is told not to retry.

## 6. Local model: blocked by two defects, no numbers

Both rebuilt boards (.145, .183 before the cloud switch; .57 untouched) fail every local-model turn:

1. **Token drift.** `data/.local-ai-token` is regenerated at first boot (09:59:34) but `openclaw.json` `models.providers.llamacpp.apiKey` still holds the token the image was built with, so the proxy answers 401 to every chat completion. Re-saving the provider (`POST /setup-api/ai-models/configure {provider:"llamacpp", model:"llamacpp/gemma4-e2b-it-q4_0"}`) rewrites the key correctly.
2. **After the re-save** the core fails with `Unable to rematerialize llamacpp/gemma4-e2b-it-q4_0 for its resolved auth profile.` on both the gateway path and `openclaw agent exec`, with or without the `auth.profiles` block. The proxy itself works (`/v1/chat/completions` with the token returns 200) and `openclaw models status` shows the profile and `models.json` key in agreement. Filed separately.

## 7. What this says about the tools

- Keep: every device tool, the browser family, the guarded read-only file tools. They are the product and they are fast.
- Costly and unused on the OpenClaw edition: the coding family (§2, §3). ≈ 3k tokens per session start for tools the model does not pick.
- Actively harmful today: the per-session process pile-up (§4) and the `.openclaw` deny (§5).
- Not an MCP problem but blocking: the local-model auth (§6).
