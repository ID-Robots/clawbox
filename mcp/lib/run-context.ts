// What the coding-agent runner tells this server about the run it belongs to.
//
// When src/lib/coding-agent.ts spawns the clawbox MCP server for a delegated
// run (CLAWBOX_MCP_PROFILE=browser) it names the run's working folder, its
// evidence folder, which media the owner's switches allow, and — for a run of
// a coding team — the run, its team, its role and its task. Several families
// read that — the browser tools, the media tools, the team's message tool — so
// it lives here rather than in any of them.
//
// No "@/" imports: this process is stdio and alias-free (mcp/lib/guard.ts).

export interface RunContext {
  workingDir: string;
  artifactsDir: string;
}

/**
 * All-or-nothing: the runner sets BOTH variables. Anything less is no run
 * context, so a stray variable can never produce a chimera — an inline image
 * the run's model cannot read, or a local-view tool outside any run.
 */
export function runContext(): RunContext | null {
  const workingDir = process.env.CLAWBOX_RUN_DIR?.trim();
  const artifactsDir = process.env.CLAWBOX_RUN_ARTIFACTS_DIR?.trim();
  return workingDir && artifactsDir ? { workingDir, artifactsDir } : null;
}

export interface TeamRunContext {
  runId: string;
  teamId: string;
  role: "planner" | "worker" | "reviewer";
  /** The board task this run works on; null for the planner, whose run has none. */
  taskId: string | null;
}

const RUN_ID = /^run-[a-z0-9]{8}$/;
const TEAM_ID = /^team-[a-z0-9]{8}$/;
const TASK_ID = /^t[1-9][0-9]{0,2}$/;
const ROLES = new Set(["planner", "worker", "reviewer"]);

/**
 * The coding TEAM this run belongs to, from the four variables the runner sets
 * only for a team's runs (buildRunMcpConfig): CLAWBOX_RUN_ID, CLAWBOX_TEAM_ID,
 * CLAWBOX_TEAM_ROLE and CLAWBOX_TEAM_TASK (`none` for the planner).
 *
 * All-or-nothing, like the pair above, and on top of it: every one must also be
 * the SHAPE the runner writes, and the whole thing counts only inside a run. One
 * missing or malformed variable is no team at all — so `team_message` is simply
 * not registered, never registered and refusing (see runMedia on why) — and a
 * stray variable in some other process's environment cannot make that process a
 * team member. The web server checks the claim against the board regardless.
 */
export function teamRunContext(): TeamRunContext | null {
  if (!runContext()) return null;
  const runId = process.env.CLAWBOX_RUN_ID?.trim() ?? "";
  const teamId = process.env.CLAWBOX_TEAM_ID?.trim() ?? "";
  const role = process.env.CLAWBOX_TEAM_ROLE?.trim() ?? "";
  const task = process.env.CLAWBOX_TEAM_TASK?.trim() ?? "";
  if (!RUN_ID.test(runId) || !TEAM_ID.test(teamId) || !ROLES.has(role)) return null;
  if (task !== "none" && !TASK_ID.test(task)) return null;
  return { runId, teamId, role: role as TeamRunContext["role"], taskId: task === "none" ? null : task };
}

export interface RunMediaAllowed {
  images: boolean;
  audio: boolean;
}

/**
 * Which media tools this run may have, from CLAWBOX_RUN_MEDIA ("images,audio").
 *
 * The variable is ABSENT when neither is allowed, and every unknown word is
 * ignored: a tool is registered only where the runner said so in as many words,
 * because a tool that exists and always answers "switched off" is a refusal the
 * model will spend steps arguing with — and, on Hermes, a candidate for the
 * per-server circuit breaker.
 */
export function runMedia(): RunMediaAllowed {
  const allowed = new Set((process.env.CLAWBOX_RUN_MEDIA ?? "").split(",").map((part) => part.trim()));
  return { images: allowed.has("images"), audio: allowed.has("audio") };
}
