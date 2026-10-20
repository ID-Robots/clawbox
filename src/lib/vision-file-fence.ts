import fs from "fs/promises";
import { hasPersonSession } from "@/lib/owner-session";
import { filesBrowseRoot } from "@/lib/file-guard";
import { activeRunDirectory, activeRunId, getRun } from "@/lib/coding-agent";
import { artifactsDir } from "@/lib/coding-agent-artifacts";

/**
 * The folders a caller of the vision routes may read from — decided by the
 * ROUTE, not by the MCP tool that calls it. SERVER ONLY.
 *
 * Shared by `vision/describe` (one picture) and `vision/describe-video` (a
 * video's frames), so the two can never disagree about which files the device
 * will look at. The tool's own check is a courtesy for a mistyped path, and a
 * courtesy is not a boundary: the bearer it holds is also the credential a
 * prompt-injected run holds.
 *
 * A person at the desktop (session cookie) may read any file under the tree the
 * Files app browses. The bearer — the agent's, and the run's — gets the fence
 * browser_view_local lives behind: while a run is live, its working folder and
 * its evidence folder, the two places its own files are; with no run live, the
 * same Files tree. Credential stores are refused for everyone by the callers
 * before they read. Roots are resolved through realpath so a symlinked root
 * grants exactly what it points at; one that does not exist grants nothing.
 */
export async function visionAllowedRoots(
  request: Request,
  requestedRunId?: string,
): Promise<{ roots: string[]; refusal: string }> {
  const owner = await hasPersonSession(request);
  const runId = owner ? null : (requestedRunId ?? activeRunId());
  const runDir = owner ? null : (requestedRunId ? getRun(requestedRunId)?.directory : activeRunDirectory());
  const wanted = runId && runDir ? [runDir, artifactsDir(runId)] : [filesBrowseRoot()];
  const roots: string[] = [];
  for (const root of wanted) {
    try {
      roots.push(await fs.realpath(root));
    } catch {
      // a root that does not exist grants nothing
    }
  }
  const refusal = runId && runDir
    ? "That file is outside the active coding run's working and evidence folders."
    : "That file is outside the home folder.";
  return { roots, refusal };
}
