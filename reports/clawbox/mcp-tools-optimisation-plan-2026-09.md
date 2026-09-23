# ClawBox MCP tools — incremental optimisation plan (TASK-1070)

Input: `mcp-tools-benchmark-2026-09.md` (TASK-1069). Rule from Yanko: incremental steps, no breaking change. Every step below keeps every tool name, parameter and result shape; anything that leaves the default set stays reachable; `bun mcp/check-tools.ts` keeps passing; the Hermes edition is untouched unless the step names it.

Ranked by measured saving divided by risk.

## 1. Stop the per-session process pile-up — HIGH

**Measured:** one `bun clawbox-mcp.ts` per session key, 63–70 MB each, never reaped (4 alive after 90 s idle, 9 during a 10-prompt run). Only a gateway restart clears them.

**Step:** the server exits itself after an idle period with no in-flight request (proposal: 10 min, env `CLAWBOX_MCP_IDLE_EXIT_MS`, `0` disables). The gateway already logs `server "clawbox" closed; next request reconnects` and reconnects, so a later turn pays one 0.35 s cold start instead of holding 66 MB for the life of the session. The mailbox watch (`armMailboxWatch`) already stops on transport close, so the same hook is the place.

**Breaks nothing:** tool set unchanged; a turn never sees the exit because the timer only fires with nothing in flight. Verify on a box: 3 turns on new keys → 3 processes → after the idle period 0 → next turn works and spawns 1.

**Also:** report the non-reaping to OpenClaw core with the repro (bundle-mcp keeps one child per session with no idle policy).

## 2. Demote the coding family on the OpenClaw edition — HIGH

**Measured:** the coding family (`bash`, `job_status`, `job_stop`, `read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `grep`, `notebook_edit`, `web_fetch`, `web_search`) is ≈ 12.5 KB of the 43.9 KB payload (28%), ≈ 3k tokens per session start. In six of six shell/file/web prompts the model chose OpenClaw's built-in `exec`/`read`/`edit`/`web_fetch` instead. On this edition the family is paid for and not used.

**Step:** register the family on the OpenClaw edition only when `CLAWBOX_MCP_CODING_TOOLS=1` (the env the file already honours for Hermes debugging) or when the harness is not OpenClaw. Keep the guarded read-only trio (`glob`, `grep`, `list_directory`) registered, because they are the only file tools with descendant filtering and `grep -r ~/.hermes` is the incident they exist for. Document the env in `mcp/README.md` and in the `clawbox_context` field guide.

**Breaks nothing:** names and shapes unchanged; the env restores the full set; `check-tools.ts` matrix updated and quoted. A box on the Hermes edition is not affected (it never had the family). Risk to weigh: a customer with a prompt that names `bash` explicitly — the model falls back to `exec`, which the benchmark shows it already prefers.

**Expected saving:** ≈ 9 KB / ≈ 2.2k tokens per session start after keeping the trio.

## 3. Fix the `.openclaw` guard — HIGH (in flight, TASK-1072, PR #965)

Not a token saving; a correctness fix the benchmark reproduced (`BLOCKED_PATH` on the agent's own workspace). Ships independently.

## 4. Trim the twelve largest descriptions — MEDIUM

**Measured:** top schemas are `bash` 1,726 B, `grep` 1,570 B, `code_project_init` 1,125 B, `webapp_create` 1,120 B, `notebook_edit` 1,076 B, `web_fetch` 1,051 B, `edit_file` 1,038 B, `local_ai_status` 1,013 B, `system_power` 1,011 B, `anthropic_accounts` 929 B, `read_file` 914 B, `browser_scroll` 907 B. The browser family alone is 5.9 KB.

**Step:** move the second and third sentences of those descriptions (examples, caveats already repeated in the field guide) into `clawbox_context`, which is read once per session, and keep the one sentence that tells the model when to call the tool. Keep the injection guard sentence on `bash` and `web_fetch`. Parameter descriptions over 120 chars get the same treatment. The contract's description-length check becomes a ceiling of 400 chars.

**Breaks nothing:** descriptions are not part of any contract a client depends on; the contract checker enforces the banned-phrase list either way.

**Expected saving:** 6–8 KB / ≈ 1.5–2k tokens per session start, on top of step 2.

## 5. Tool Search for the long tail — MEDIUM, after 2 and 4

**Measured:** even with 2 and 4 done, ≈ 28 KB of schema remains for tools a chat session rarely calls (`backup_*`, `preferences_*`, `wifi_*`, `vnc_status`, `telegram_status`, `code_project_*`, `webapp_*`, `app_*`).

**Step:** register the `clawbox` server with OpenClaw's Tool Search (`tools.toolSearch`, docs/tools/tool-search.md) so only a bounded set of schemas ships per turn and the rest are discoverable. Needs a measurement on a box first because Tool Search changes how the model reaches a tool (search → describe → call) and the benchmark must show device questions still resolve in one step. Not for the Hermes edition (different harness).

**Breaks nothing:** config-side only, revertable by one key.

## 6. Cache the startup probes — LOW

**Measured:** cold start is 0.31–0.35 s connect + 0.02 s list. Two loopback probes at start. Not worth a change on its own; only if step 1 makes cold starts frequent. Skip unless the idle-exit benchmark shows a user-visible pause.

## 7. Slow tools — LOW

`browser_open` 1.4 s p50 (window focus), `disk_usage` 0.29 s / 1.5 s max (`du`), `device_status` 0.17 s / 1.7 s max, `glob` 0.18 s / 0.7 s. All within what a chat turn tolerates. `device_status` and `clawbox_health` could share one probe; `disk_usage` could cap `du` depth. Defer.

## Not doing

- Lowering `DEFAULT_MAX_CHARS`: no output in the benchmark hit a cap; nothing to gain.
- Removing `device_status` / `system_stats` / browser tools: the model uses them and they are the product.
- Any change to the Hermes edition: the benchmark never ran there.

## Follow-up tasks (one per accepted step)

1. Idle self-exit for the MCP server (step 1) + upstream report.
2. Coding family behind `CLAWBOX_MCP_CODING_TOOLS` on the OpenClaw edition, keep glob/grep/list_directory (step 2).
3. Description trim for the twelve largest tools (step 4).
4. Tool Search trial on one bench box, measured (step 5).

Order: 1 and 2 in parallel (independent files), then 3, then 4 measured before it is decided.
