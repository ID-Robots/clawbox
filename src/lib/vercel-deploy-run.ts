/**
 * One deployment, from the production slot to the records it leaves behind.
 *
 * WHAT WAS HERE BEFORE. All of this lived inside the deploy route's POST, which
 * was right while the route was the only caller. It is not any more: the
 * delivery pipeline (./coding-pipeline) deploys a preview and then production
 * without anybody pressing anything, and a second copy of "reserve the slot,
 * deploy, write the two records, give the slot back if nothing happened" is
 * exactly the shape of a rule that gets fixed in one place and stays wrong in
 * the other — the release-by-index bug and the guarded record write were both
 * found in review on this code once already.
 *
 * WHAT THIS MODULE IS NOT. It is NOT the gate. Who may deploy, whether the
 * owner confirmed, whether the agent has the owner's standing permission for
 * THIS project — all of that stays with the caller, in one readable place each
 * (the route's POST, and the pipeline's production stage). A module that could
 * be called into production from anywhere is one where the gate has to be
 * looked for. What it owns is the part that must not vary: the RATE LIMIT, and
 * the rule that nothing after a real deployment may turn it into a failure the
 * caller would retry.
 */
import { recordManualDeployment } from "@/lib/coding-agent";
import { deployProject, type DeployOutcome } from "@/lib/vercel-deploy";
import {
  newProjectDeploy,
  readProjectDeploy,
  recordProjectDeploy,
  releaseProductionSlot,
  reserveProductionSlot,
  type ProjectDeployEntry,
} from "@/lib/vercel-deploy-store";
import type { DeployActor, DeployTarget, ProjectDeploy } from "@/lib/vercel-state";

export interface RunDeploymentInput {
  scope: string;
  directory: string;
  target: DeployTarget;
  /** The ref to build — a run deploys its OWN branch, not the project's current one. */
  gitRef: string | null;
  /** The run this belongs to, when it belongs to one. */
  runId: string | null;
  by: DeployActor;
  /** Extra build metadata. Never a credential, never a path. */
  meta?: Record<string, string>;
}

export type RunDeploymentOutcome =
  | { ok: true; deploy: ProjectDeploy; entry: ProjectDeployEntry; made: Extract<DeployOutcome, { ok: true }> }
  /** The rate limit. `nextAt` is when the oldest slot comes back, when it is known. */
  | { ok: false; code: "rate_limited"; detail: string; nextAt: number | null }
  | { ok: false; code: string; detail: string; nextAt?: never };

/** How many production deployments one project takes per window — re-exported for the callers' sentences. */
export { MAX_PRODUCTION_DEPLOYS } from "@/lib/vercel-deploy-store";

/**
 * Make the deployment and record it.
 *
 * The ordering is the contract, and every step of it was learned in review:
 *
 *  1. RESERVE the production slot in one queued step — checked and taken
 *     together, because two calls that arrive together read the same count and
 *     a loop is exactly when calls arrive together.
 *  2. Deploy. A refusal gives the slot BACK: the counter bounds deployments,
 *     not attempts, and a wrong token must not lock the owner out of their own
 *     domain for an hour after three instant failures.
 *  3. Record on the PROJECT, then on the RUN — both guarded. Past step 2 the
 *     deployment is real and building on somebody's account; a throw here would
 *     have the caller retry and deploy it a second time, which for production
 *     means rebuilding a live domain because a disk write on the Jetson
 *     hiccupped. The production slot is NOT released on this path, for the
 *     same reason: the deployment happened, and only the bookkeeping failed.
 */
export async function runDeployment(input: RunDeploymentInput): Promise<RunDeploymentOutcome> {
  let reserved: number | null = null;
  if (input.target === "production") {
    const slot = await reserveProductionSlot(input.scope);
    if (!slot.ok) {
      return {
        ok: false,
        code: "rate_limited",
        detail: "This project has had as many production deployments in the last hour as this ClawBox makes. Wait, or deploy it from Vercel.",
        nextAt: slot.nextAt,
      };
    }
    reserved = slot.at;
  }

  const made = await deployProject({
    scope: input.scope,
    directory: input.directory,
    target: input.target,
    gitRef: input.gitRef,
    meta: {
      clawbox: "1",
      clawboxProject: input.scope,
      ...(input.runId ? { clawboxRun: input.runId } : {}),
      ...input.meta,
    },
  });
  if (!made.ok) {
    if (reserved !== null) await releaseProductionSlot(input.scope, reserved);
    return { ok: false, code: made.code, detail: made.detail };
  }

  const deploy: ProjectDeploy = newProjectDeploy({
    target: input.target,
    projectId: made.projectId,
    teamId: made.teamId,
    deploymentId: made.deployment.id,
    readyState: made.deployment.readyState,
    url: made.deployment.url,
    inspectorUrl: made.deployment.inspectorUrl,
    source: made.source,
    gitRef: made.gitRef,
    fileCount: made.fileCount,
    by: input.by,
    runId: input.runId,
  });

  let entry: ProjectDeployEntry;
  try {
    entry = await recordProjectDeploy(input.scope, deploy);
  } catch (err) {
    console.error(`[vercel-deploy] ${input.scope} deployment not recorded:`, err instanceof Error ? err.message : err);
    // `productionAt` is preserved: a reservation that is no longer counted is a
    // cap the next call can walk straight past.
    entry = { latest: deploy, productionAt: (await readProjectDeploy(input.scope).catch(() => null))?.productionAt ?? [] };
  }

  if (input.runId) {
    try {
      recordManualDeployment(input.runId, {
        deployment: made.deployment,
        projectId: made.projectId,
        teamId: made.teamId,
        target: input.target,
        branch: made.gitRef,
      });
    } catch (err) {
      console.error(`[vercel-deploy] ${input.runId} not recorded on the run:`, err instanceof Error ? err.message : err);
    }
  }

  return { ok: true, deploy, entry, made };
}
