/**
 * "ClawBox read-only tools" — the one slice of the box's own MCP tool set an
 * owner can hand a coding-agent run, project by project
 * (src/lib/project-mcp-servers.ts).
 *
 * Two processes read this list, which is why it is a module of its own with no
 * imports at all: the run's clawbox MCP server (mcp/lib/register.ts), whose
 * `run-read` profile registers the browser family as the `browser` profile does
 * plus every tool that declares `readOnly: true`; and the runner
 * (src/lib/coding-agent.ts), which approves exactly these names in the run's
 * `--allowedTools`. The MCP server is stdio and alias-free, so no "@/" here.
 *
 * The list is the readOnly set itself, not a choice from it: every tool any
 * edition registers with `readOnly: true` and outside the browser family (which
 * a run already has, under its own rule — MCP_BROWSER_TOOLS), with the coding
 * family's env gate off as it is in every run, over every capability posture
 * (a gate can point either way). An EQUALITY, pinned by
 * src/tests/unit/mcp-run-read-profile.test.ts against the real registrars, so a
 * tool that gains or loses the declaration fails there rather than drifting
 * silently between what the server registers and what the run may call.
 *
 * Nothing that writes is ever in it: `readOnly` and `destructive` cannot both
 * be declared (mcp/lib/register.ts contractViolations), and a write tool
 * declares neither.
 *
 * NOT how a read-only run — a coding team's planner, reviewer or lead —
 * reads its project, and never handed to one (buildRunArgs and prepareRunMcp
 * in coding-agent.ts give such a run no project servers and its own server
 * no `run-read` profile). This set reads the DEVICE — mail, logs, the
 * screen, the box's status, secrets' names — which a plan has no business
 * with, and its file tools are fenced by the server's own guards, not by the
 * run's file deny rules (a Claude Code rule is per tool). A planner reads with Claude Code's Read, Grep
 * and Glob and with read-only git (READ_ONLY_GIT_RULES), under those rules.
 */

/** The CLAWBOX_MCP_PROFILE a run's server gets when its project ticked the read-only tools. */
export const RUN_READ_PROFILE = "run-read";

export const CLAWBOX_READ_ONLY_TOOLS = [
  "ai_list_models",
  "anthropic_accounts",
  "app_search",
  "backup_list",
  "backup_status",
  "clawbox_ai_usage",
  "clawbox_context",
  "clawbox_health",
  "code_project_list",
  "coding_agent_status",
  "coding_project_status",
  "coding_run_list",
  "coding_secret_list",
  // The coding team's settings, read (2026-10-30; coding_settings_set writes).
  "coding_settings_get",
  "coding_team_status",
  "device_status",
  "disk_usage",
  "email_list",
  "email_read",
  "glob",
  "grep",
  // Registered only where the box CANNOT draw (mcp/tools/ai.ts): it says why.
  "image_generate",
  "list_directory",
  "local_ai_status",
  "logs_tail",
  "memory_shard_provider_get",
  "memory_shard_schedule_get",
  "memory_shard_search",
  "memory_shard_sources_list",
  "memory_shard_status",
  "preferences_get",
  "prime_radiant_costs",
  "prime_radiant_daily_questions",
  "prime_radiant_diff",
  "prime_radiant_golden_list",
  "prime_radiant_history",
  "prime_radiant_ingest_preview",
  "prime_radiant_ingest_status",
  "prime_radiant_lint",
  "prime_radiant_map",
  "prime_radiant_page",
  "prime_radiant_pages",
  "prime_radiant_review_list",
  "prime_radiant_search",
  "prime_radiant_settings",
  "prime_radiant_status",
  "screen_capture",
  "skill_info",
  "skill_list",
  "skill_search",
  "system_info",
  "system_stats",
  "telegram_status",
  "ui_list_apps",
  "update_check",
  "vnc_status",
  "wifi_scan",
  "wifi_status",
] as const;
