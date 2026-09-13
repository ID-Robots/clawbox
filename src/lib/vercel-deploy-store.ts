/**
 * What this box has DEPLOYED for a project, the owner's standing permission
 * for the agent to deploy to production, and the rate limit that bounds it.
 *
 * WHY IT IS A STORE AND NOT A FIELD ON A RUN. A run's push already has a
 * record (`CodingRun.vercel`), watched until it settles. That record cannot
 * answer "what did the Deploy button on this project do", for two reasons: a
 * project can have no runs at all (an imported repository, a folder the owner
 * made by hand), and a deploy pressed today is about the project as it is now
 * rather than about whatever a run did last week. So a deployment this box was
 * ASKED for is filed under the project, and a deployment a run's push caused
 * stays on the run — and when a deploy IS asked for on a run's page, both are
 * written, because the owner looking at that run should see it there too.
 *
 * WHY THE AUTO-PRODUCTION SWITCH LIVES HERE AND IS OFF BY DEFAULT.
 * `coding_vercel_auto_production` is the ONE thing in this feature that lets
 * the assistant put a build in front of a project's users without being asked
 * again. Preview deploys are the agent's to make: a preview URL is a throwaway
 * address nobody has, and the whole point of "build me something and let me
 * look at it" is that the box does both halves. Production is different in
 * kind, so it is refused for the agent until the owner names THAT project and
 * turns it on — per project, never box-wide, because "the agent may ship the
 * toy site by itself" must not also mean "and the shop".
 *
 * It is deliberately not a switch the agent can see the other side of: there is
 * no tool that sets it, only routes behind the owner's cookie AND this box's
 * own origin, for the reason the secret store's master switch has both. A tool
 * that could turn it on would make the owner's answer temporary.
 *
 * WHY THE RATE LIMIT IS PERSISTED AND NOT A MAP IN MEMORY. It bounds what the
 * agent can spend unasked — build minutes on the owner's Vercel account, and
 * churn on a domain their users are on. A counter in the web server's memory is
 * reset by every restart, and a restart is one `systemctl restart` (or one
 * in-app update) away, so a loop that kept failing and retrying would get its
 * whole allowance back each time. It rides in the same config entry as the
 * record, so there is one file to read and one shape to reason about.
 *
 * AND WHY THE SLOT IS RESERVED RATHER THAN COUNTED. Reading the count, making
 * the deployment and writing the count back is not a rate limit: two calls that
 * arrive together read the same number and both pass — and a loop is exactly
 * when calls arrive together, which is the only thing this counter is for. So
 * `reserveProductionSlot` checks and takes in ONE queued step and is the only
 * writer of `productionAt`, and a reservation whose deployment never happened
 * is given back.
 */

import { get as configGet, set as configSet } from "@/lib/config-store";
import { BOX_SCOPE, isValidSecretScope } from "@/lib/project-secrets";
import { readProjectSwitch, setProjectSwitch } from "@/lib/project-switch";
import {
  isDeployTarget,
  isVercelPhase,
  type DeployActor,
  type ProjectDeploy,
  type VercelReadyState,
} from "@/lib/vercel-state";

/** Where the deployments live in `data/config.json`. */
export const VERCEL_DEPLOYS_CONFIG_KEY = "coding_vercel_deploys";

/** Where the per-project "the agent may deploy to production" switch lives. */
export const VERCEL_AUTO_PRODUCTION_CONFIG_KEY = "coding_vercel_auto_production";

/**
 * The most production deploys ONE project takes in the window below.
 *
 * Not a quota anybody asked for — a bound on a loop. A model that reads a
 * failed build as "deploy again" would otherwise spend an evening rebuilding a
 * customer's live site, and the owner's first sign of it would be the Vercel
 * bill. Three is enough for a real afternoon (deploy, find the bug, deploy the
 * fix, deploy the fix to the fix) and far short of a loop.
 */
export const MAX_PRODUCTION_DEPLOYS = 3;

/** The window the count above is measured over. */
export const PRODUCTION_WINDOW_MS = 60 * 60_000;

/**
 * The most projects that keep a deployment record.
 *
 * The same reasoning as `MAX_VERCEL_LINKS`: this is one config value read on
 * every project page, and a map written by a route is still a map that grows.
 * Past the cap the OLDEST record is dropped, which is safe in a way evicting a
 * LINK would not be — a link is configuration the owner set, a record is
 * history the owner can re-read on Vercel.
 */
export const MAX_DEPLOY_RECORDS = 50;

/** One project's deployment history, as little of it as is worth keeping. */
export interface ProjectDeployEntry {
  /**
   * The last deployment this box made for the project.
   *
   * NULL is a real state and not a missing field: a project can hold a
   * production slot it reserved a moment ago and have no deployment yet, and
   * the first draft wrote a placeholder deployment to avoid saying so — which
   * left a project whose first production deploy FAILED showing "waiting for
   * Vercel to start the build" for ever.
   */
  latest: ProjectDeploy | null;
  /** When production deploys happened, newest last — the rate limit's memory. */
  productionAt: number[];
}

export type ProjectDeploys = Record<string, ProjectDeployEntry>;

/**
 * A map with NO PROTOTYPE, for the reason `emptyLinks` in ./vercel-link is:
 * a project scope is `[A-Za-z0-9_-]`, which spells `__proto__`, and assigning
 * that key on an object literal writes the accumulator's prototype instead.
 */
function empty(): ProjectDeploys {
  return Object.create(null) as ProjectDeploys;
}

function isDeploy(value: unknown): value is ProjectDeploy {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isDeployTarget(v.target)
    && isVercelPhase(v.phase)
    && typeof v.projectId === "string"
    && typeof v.startedAt === "number"
    && (v.by === "owner" || v.by === "agent");
}

function isEntry(value: unknown): value is ProjectDeployEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.latest === null || isDeploy(v.latest))
    && Array.isArray(v.productionAt)
    && v.productionAt.every((x) => typeof x === "number");
}

/**
 * Read the map.
 *
 * A value that is not the map it should be reads as EMPTY, and a single
 * malformed entry is dropped rather than the rest with it — the direction
 * ./vercel-link reads its links in, for the same reason: a project whose
 * deployment record cannot be read must show "nothing deployed yet" rather
 * than take the project page down.
 */
export async function readProjectDeploys(): Promise<ProjectDeploys> {
  const raw = await configGet(VERCEL_DEPLOYS_CONFIG_KEY);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty();
  const out = empty();
  for (const [scope, value] of Object.entries(raw as Record<string, unknown>)) {
    if (scope !== BOX_SCOPE && isValidSecretScope(scope) && isEntry(value)) out[scope] = value;
  }
  return out;
}

/** One project's record, or null. */
export async function readProjectDeploy(scope: string | null | undefined): Promise<ProjectDeployEntry | null> {
  if (typeof scope !== "string" || !scope) return null;
  const all = await readProjectDeploys();
  // OWN keys only: see `empty` above.
  return Object.prototype.hasOwnProperty.call(all, scope) ? all[scope] : null;
}

/**
 * Every write to the map, one after another.
 *
 * The `mutateExtraPaths` pattern, and for the same measured reason: a read and
 * a write with an `await` between them is a window another request lands its
 * own write in, and here the two requests are "the owner pressed Deploy" and
 * "the watcher learned the build finished" — overlapping often, by design. A
 * failed write is its caller's to report and never the next caller's to
 * inherit, so the chain carries on either way.
 */
let writes: Promise<unknown> = Promise.resolve();

function queue<T>(fn: () => Promise<T>): Promise<T> {
  const mine = writes.then(fn, fn);
  writes = mine.catch(() => {});
  return mine;
}

/** When this project was last heard from — a deployment, or a slot it took. */
function touchedAt(entry: ProjectDeployEntry): number {
  return Math.max(entry.latest?.startedAt ?? 0, ...entry.productionAt, 0);
}

/** Prune to the cap, oldest record first. */
function pruned(all: ProjectDeploys): ProjectDeploys {
  const keys = Object.keys(all);
  if (keys.length <= MAX_DEPLOY_RECORDS) return all;
  const order = keys.sort((a, b) => touchedAt(all[a]) - touchedAt(all[b]));
  const next = empty();
  for (const key of order.slice(keys.length - MAX_DEPLOY_RECORDS)) next[key] = all[key];
  return next;
}

/**
 * Take a production slot, or say there is none — CHECKED AND WRITTEN in one
 * queued step.
 *
 * Read-then-write with an `await` between them is not a rate limit: a model
 * that fires two production deploys at once reads the same count twice and both
 * pass. The whole point of this counter is to bound what happens when something
 * loops, which is exactly when calls overlap, so the check and the reservation
 * have to be the same operation — the reasoning `assertCanSpawn` in
 * coding-agent.ts is written from.
 *
 * A reservation that never became a deployment is given back
 * (`releaseProductionSlot`): the counter bounds DEPLOYMENTS, not attempts, and a
 * token that is wrong must not lock the owner out of their own domain for an
 * hour after three instant failures.
 */
export function reserveProductionSlot(scope: string, now = Date.now()): Promise<{ ok: true; at: number } | { ok: false; nextAt: number | null }> {
  return queue(async () => {
    const all = await readProjectDeploys();
    const before = Object.prototype.hasOwnProperty.call(all, scope) ? all[scope] : null;
    const allowance = productionAllowance(before, now);
    if (allowance.left <= 0) return { ok: false as const, nextAt: allowance.nextAt };
    const within = (before?.productionAt ?? []).filter((at) => now - at < PRODUCTION_WINDOW_MS);
    const entry: ProjectDeployEntry = {
      // A project whose first act is a production deploy has no deployment yet,
      // and says so. The real one is recorded a moment later.
      latest: before?.latest ?? null,
      // The window is what bounds this list, and the cap is a second bound for
      // a clock that moved backwards: a record from "the future" would survive
      // every prune otherwise.
      productionAt: [...within, now].slice(-MAX_PRODUCTION_DEPLOYS * 4),
    };
    await configSet(VERCEL_DEPLOYS_CONFIG_KEY, pruned({ ...all, [scope]: entry }));
    return { ok: true as const, at: now };
  });
}

/** Give a reserved slot back, for a deployment that never happened. */
export function releaseProductionSlot(scope: string, at: number): Promise<void> {
  return queue(async () => {
    const all = await readProjectDeploys();
    const before = Object.prototype.hasOwnProperty.call(all, scope) ? all[scope] : null;
    if (!before) return;
    // ONE occurrence, not every entry with that value. `Date.now()` has
    // millisecond resolution, so two deploys that start in the same
    // millisecond stamp the same number — and filtering by value would give
    // BOTH slots back when one deployment failed, after which the surviving
    // deployment is uncounted and the project can exceed the cap. That is
    // exactly the overlapping-call case this counter exists for (found in
    // review).
    const index = before.productionAt.indexOf(at);
    if (index === -1) return;
    const productionAt = before.productionAt.filter((_, i) => i !== index);
    const next = { ...all };
    // An entry holding neither a deployment nor a slot is not a record of
    // anything; leaving it would grow one row per project that ever tried.
    if (!before.latest && productionAt.length === 0) delete next[scope];
    else next[scope] = { ...before, productionAt };
    await configSet(VERCEL_DEPLOYS_CONFIG_KEY, next);
  });
}

/**
 * Record a deployment this box has just created. Answers what was stored.
 *
 * It does NOT touch `productionAt`: `reserveProductionSlot` is the only writer
 * of the counter, so the check and the increment cannot come apart.
 */
export function recordProjectDeploy(scope: string, deploy: ProjectDeploy): Promise<ProjectDeployEntry> {
  return queue(async () => {
    const all = await readProjectDeploys();
    const before = Object.prototype.hasOwnProperty.call(all, scope) ? all[scope] : null;
    const entry: ProjectDeployEntry = {
      latest: deploy,
      productionAt: (before?.productionAt ?? []).filter((at) => deploy.startedAt - at < PRODUCTION_WINDOW_MS),
    };
    await configSet(VERCEL_DEPLOYS_CONFIG_KEY, pruned({ ...all, [scope]: entry }));
    return entry;
  });
}

/** What the box has since learned about the deployment it recorded. */
export function updateProjectDeploy(
  scope: string,
  deploymentId: string,
  change: Partial<Pick<ProjectDeploy, "phase" | "readyState" | "url" | "inspectorUrl" | "detail" | "endedAt">>,
): Promise<ProjectDeployEntry | null> {
  return queue(async () => {
    const all = await readProjectDeploys();
    const before = Object.prototype.hasOwnProperty.call(all, scope) ? all[scope] : null;
    // Only the deployment the caller was told about: a poll that comes home
    // after the owner pressed Deploy again must not write the old build's
    // verdict over the new build's record.
    if (!before?.latest || before.latest.deploymentId !== deploymentId) return null;
    const entry: ProjectDeployEntry = { ...before, latest: { ...before.latest, ...change } };
    await configSet(VERCEL_DEPLOYS_CONFIG_KEY, { ...all, [scope]: entry });
    return entry;
  });
}

/**
 * How many production deploys this project has room for right now.
 *
 * Answered as a number rather than a boolean so the refusal can say when the
 * next one is possible, which is the difference between a sentence a caller can
 * act on and one it retries.
 */
export function productionAllowance(entry: ProjectDeployEntry | null, now = Date.now()): {
  left: number;
  /** When the oldest deploy in the window falls out of it, when none is left. */
  nextAt: number | null;
} {
  const within = (entry?.productionAt ?? []).filter((at) => now - at < PRODUCTION_WINDOW_MS).sort((a, b) => a - b);
  const left = Math.max(0, MAX_PRODUCTION_DEPLOYS - within.length);
  return { left, nextAt: left > 0 || !within.length ? null : within[0] + PRODUCTION_WINDOW_MS };
}

// ── the owner's standing permission ─────────────────────────────────────────

/**
 * Read the switch for one project.
 *
 * Anything that is not an explicit `true` for THAT project reads as off. The
 * default is the safe direction and it is the direction an unreadable value
 * must fail in too — the reasoning `clawbox_improvement_program` is written
 * with: every failure of this read has to fail towards the agent not being able
 * to ship to production.
 *
 * The behaviour itself lives in ./project-switch, shared with the delivery
 * pipeline's own per-project switch: two standing permissions that must fail
 * the same way cannot be two implementations of the same paragraph.
 */
export function readAutoProduction(scope: string | null | undefined): Promise<boolean> {
  return readProjectSwitch(VERCEL_AUTO_PRODUCTION_CONFIG_KEY, scope);
}

/** Turn it on or off for one project. Answers what it now is. */
export function setAutoProduction(scope: string, enabled: boolean): Promise<boolean> {
  return setProjectSwitch(VERCEL_AUTO_PRODUCTION_CONFIG_KEY, scope, enabled);
}

/** A fresh record for a deployment that has just been created. */
export function newProjectDeploy(input: {
  target: ProjectDeploy["target"];
  projectId: string;
  teamId: string | null;
  deploymentId: string | null;
  readyState: VercelReadyState;
  url: string | null;
  inspectorUrl: string | null;
  source: ProjectDeploy["source"];
  gitRef: string | null;
  fileCount: number | null;
  by: DeployActor;
  runId: string | null;
  now?: number;
}): ProjectDeploy {
  return {
    target: input.target,
    // A deployment Vercel has just accepted is `building`, never `ready`: its
    // state is whatever the next poll says, and the fold in ./vercel-state
    // treats an unknown one as in flight for exactly this reason.
    phase: input.readyState === "ready" ? "ready" : input.readyState === "error" ? "failed" : "building",
    readyState: input.readyState,
    projectId: input.projectId,
    teamId: input.teamId,
    deploymentId: input.deploymentId,
    url: input.url,
    inspectorUrl: input.inspectorUrl,
    source: input.source,
    gitRef: input.gitRef,
    fileCount: input.fileCount,
    by: input.by,
    runId: input.runId,
    startedAt: input.now ?? Date.now(),
    endedAt: null,
    detail: null,
  };
}
