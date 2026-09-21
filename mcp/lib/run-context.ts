// What the coding-agent runner tells this server about the run it belongs to.
//
// When src/lib/coding-agent.ts spawns the clawbox MCP server for a delegated
// run (CLAWBOX_MCP_PROFILE=browser) it names the run's working folder, its
// evidence folder, and which media the owner's switches allow. Two families
// read that — the browser tools and the media tools — so it lives here rather
// than in either of them.
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
