/**
 * The Vercel integration's pure half: its types, what a deployment's state
 * means, and when the box stops waiting for one.
 *
 * Split from ./vercel for the reason ./coding-pr-state is split from
 * ./coding-pr: the run card and the project card both render a deployment, and
 * a client component that imported the module which holds the API client would
 * pull the token-reading store — and with it `fs` and `crypto` — into the
 * browser bundle. Nothing in this file does I/O, reads a credential or names a
 * host; it is safe on either side.
 */

/**
 * A deployment's state, as Vercel spells it, folded to the five outcomes that
 * mean different things to an owner.
 *
 * Vercel's own enum has more members than this and has grown over time
 * (`INITIALIZING`, `DEPLOYING` and `BUILDING` are all "it is working on it"),
 * so the fold is deliberately lossy and deliberately total: an unknown state is
 * `"building"` — still in flight — and never a silent success. Reading a state
 * this box has not heard of as "ready" would put a preview URL on the card for
 * a build that never finished, which is the one mistake available here.
 */
export type VercelReadyState = "queued" | "building" | "ready" | "error" | "canceled";

/** States that mean Vercel is still working. */
const IN_FLIGHT = new Set(["INITIALIZING", "BUILDING", "DEPLOYING", "UPLOADING", "ANALYZING"]);
/** States that mean it has not started yet. */
const QUEUED = new Set(["QUEUED", "PENDING"]);
/** The definite endings. */
const FAILED = new Set(["ERROR", "FAILED"]);
const CANCELED = new Set(["CANCELED", "CANCELLED", "DELETED"]);

/**
 * Fold Vercel's state string. Exported for its test, which is where the
 * unknown-state case is pinned.
 */
export function foldReadyState(raw: unknown): VercelReadyState {
  const state = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (state === "READY") return "ready";
  if (FAILED.has(state)) return "error";
  if (CANCELED.has(state)) return "canceled";
  if (QUEUED.has(state)) return "queued";
  if (IN_FLIGHT.has(state)) return "building";
  // Including the empty string: a deployment Vercel answered for without a
  // state is one this box has not finished watching.
  return "building";
}

/**
 * Where the box has got to with the deployment for one run's push.
 *
 *  - `looking`   the branch is pushed and no deployment for it has appeared yet
 *  - `building`  one exists and Vercel is working on it
 *  - `ready`     it built; `url` is the preview
 *  - `failed`    Vercel reported an error; the build log tail went to the agent
 *  - `canceled`  somebody or something stopped it
 *  - `abandoned` the box stopped watching; `detail` says why
 *
 * `abandoned` is its own ending rather than a flavour of `failed` for the
 * reason `gave_up` is its own run status: "Vercel said the build broke" and
 * "this box could not find out" need different things said and offer different
 * next steps, and folded together the second reads as a broken deploy.
 */
export type VercelPhase = "looking" | "building" | "ready" | "failed" | "canceled" | "abandoned";

export const VERCEL_PHASES: readonly VercelPhase[] = [
  "looking", "building", "ready", "failed", "canceled", "abandoned",
];

export function isVercelPhase(value: unknown): value is VercelPhase {
  return typeof value === "string" && (VERCEL_PHASES as readonly string[]).includes(value);
}

/** A promotion to production: who asked for it and when. Never automatic. */
export interface VercelPromotion {
  deploymentId: string;
  /** Which deployment URL was promoted, so the record says what went live. */
  url: string | null;
  at: number;
  /**
   * Who. Only ever `"owner"` today — the route that writes it refuses the MCP
   * bearer — and a field rather than a boolean because "who put this in front
   * of customers" is the question a record of a production change exists to
   * answer, and a second answer (a scheduled promotion, a second signed-in
   * person) must not have to change the shape to be recordable.
   */
  by: "owner";
}

/** What a run's push became on Vercel. Lives on the run record. */
export interface VercelState {
  phase: VercelPhase;
  /** The Vercel project this was deployed to — from the owner's link. */
  projectId: string;
  /** The team the project is under, or null for a personal account. */
  teamId: string | null;
  /** Vercel's id for the deployment, once one has been found. */
  deploymentId: string | null;
  readyState: VercelReadyState;
  /** The preview address, with a scheme. Null until there is a deployment. */
  url: string | null;
  /** Vercel's own page for the build — where a person reads the whole log. */
  inspectorUrl: string | null;
  /** `production` or `preview`, as Vercel reports it. */
  target: string | null;
  /** The git branch and commit the watch is matching on. */
  branch: string | null;
  sha: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Why it failed or was abandoned, in words meant for the owner. */
  detail: string | null;
  /** The follow-up run the failed build's log was handed to, if any. */
  fixRunId: string | null;
  /**
   * Whether the failed build has already been handed back to the agent.
   *
   * ON THE RECORD and not in the watcher's closure, for the reason
   * `PrState.reviewOk` is: the watcher is rebuilt from this file after a
   * restart, and a flag that lived only in memory came back false — so a box
   * that rebooted between the failure and the fix would spend a second run
   * saying the same thing to the same session.
   */
  feedbackSent: boolean;
  /** The production promotion, once the owner has asked for one. */
  promotion: VercelPromotion | null;
}

/** How often Vercel is asked again. */
export const VERCEL_POLL_INTERVAL_MS = 15_000;

/**
 * How long a pushed branch may go without ANY deployment appearing.
 *
 * Vercel's git integration creates the deployment when GitHub tells it the
 * branch moved, which is seconds on a good day and minutes when the webhook is
 * slow or the project's ignore rules skipped this commit. Reading "no
 * deployment" as "nothing will ever deploy" too early would abandon a watch
 * that was about to succeed; reading it as "keep waiting" for ever would leave
 * the card pending on a project whose deploys are switched off. Three minutes
 * is the line, and what follows it is `abandoned` with the reason said.
 */
export const VERCEL_NO_DEPLOYMENT_GRACE_MS = 180_000;

/** The ceiling on one push's whole watch. A build longer than this is the
 *  owner's to follow on Vercel, and the card says so. */
export const VERCEL_MAX_WAIT_MS = 30 * 60_000;

/** True while this deployment is still something the box is watching. */
export function isVercelPending(v: VercelState | null | undefined): boolean {
  return v != null && (v.phase === "looking" || v.phase === "building");
}

/** One deployment, as this box reads Vercel's answer. */
export interface VercelDeployment {
  id: string;
  readyState: VercelReadyState;
  /** Vercel's `url` is a bare host; this is the address with a scheme. */
  url: string | null;
  inspectorUrl: string | null;
  target: string | null;
  branch: string | null;
  sha: string | null;
  createdAt: number | null;
  /** Vercel's own sentence about why it failed, when it gave one. */
  errorMessage: string | null;
}

/** A bare host with a scheme put back on it, or null. */
export function deploymentUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = raw.trim();
  if (!host) return null;
  if (/^https?:\/\//i.test(host)) {
    // Already absolute: accepted only when it parses and is http(s), because
    // this string is put in an `href` the owner clicks.
    try {
      const parsed = new URL(host);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
    } catch {
      return null;
    }
  }
  // A host and nothing else — no slash, no scheme, no credentials. Vercel
  // answers `my-app-abc123.vercel.app`; anything with a path or an `@` in it is
  // not that shape and is refused rather than concatenated into a link.
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return null;
  return `https://${host}`;
}

/**
 * Read one deployment out of Vercel's JSON.
 *
 * Defensive about the field names on purpose: the list endpoint (`/v6`) calls
 * the id `uid` and the detail endpoint (`/v13`) calls it `id`, and `readyState`
 * is `state` on some answers. Written to the union of both rather than to one
 * version, because the alternative is a parser that silently returns nothing
 * the day Vercel serves the other shape.
 */
export function parseDeployment(raw: unknown): VercelDeployment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const id = typeof v.uid === "string" && v.uid ? v.uid : typeof v.id === "string" && v.id ? v.id : null;
  if (!id) return null;
  const meta = typeof v.meta === "object" && v.meta !== null ? (v.meta as Record<string, unknown>) : {};
  const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
  return {
    id,
    readyState: foldReadyState(v.readyState ?? v.state),
    url: deploymentUrl(v.url),
    inspectorUrl: deploymentUrl(v.inspectorUrl),
    target: str(v.target),
    branch: str(meta.githubCommitRef) ?? str(meta.gitlabCommitRef) ?? str(meta.bitbucketCommitRef) ?? str(meta.branch),
    sha: str(meta.githubCommitSha) ?? str(meta.gitlabCommitSha) ?? str(meta.bitbucketCommitSha) ?? str(meta.commit),
    createdAt: typeof v.created === "number" ? v.created : typeof v.createdAt === "number" ? v.createdAt : null,
    errorMessage: str(v.errorMessage) ?? str(v.errorCode),
  };
}

/**
 * Which of a project's deployments belongs to this push.
 *
 * The COMMIT first and the branch only as a fallback, and the order matters: a
 * branch can have several deployments (a retry, a second push while the watch
 * was running), and matching on the branch alone picks whichever Vercel listed
 * first. The sha names exactly one.
 *
 * Case-insensitive on the sha because git prints it lowercase and Vercel has
 * been seen to echo what the webhook sent; prefix-matched in both directions
 * because a short sha is a legitimate spelling of a long one.
 */
export function matchDeployment(
  deployments: readonly VercelDeployment[],
  want: { sha: string | null; branch: string | null },
): VercelDeployment | null {
  const sha = want.sha?.trim().toLowerCase() ?? "";
  if (sha) {
    const bySha = deployments.find((d) => {
      const got = d.sha?.trim().toLowerCase() ?? "";
      return got !== "" && (got === sha || got.startsWith(sha) || sha.startsWith(got));
    });
    if (bySha) return bySha;
  }
  const branch = want.branch?.trim() ?? "";
  if (branch) {
    // Newest first: the list endpoint is asked in that order, and a second push
    // to the same branch should be the one the card follows.
    const byBranch = deployments.find((d) => d.branch === branch);
    if (byBranch) return byBranch;
  }
  return null;
}

/**
 * What the watcher does with what it just read.
 *
 * Pure, and every input is either on the record or was just measured, so a
 * watcher rebuilt after a restart decides exactly as the first one did — the
 * property `decideMerge` is written for, for the same reason.
 */
export type VercelVerdict =
  | { action: "wait" }
  | { action: "settle"; phase: Exclude<VercelPhase, "looking" | "building">; detail: string | null };

export function decideDeployment(input: {
  deployment: VercelDeployment | null;
  waitedMs: number;
}): VercelVerdict {
  const { deployment, waitedMs } = input;
  if (!deployment) {
    if (waitedMs < VERCEL_NO_DEPLOYMENT_GRACE_MS) return { action: "wait" };
    return {
      action: "settle",
      phase: "abandoned",
      detail: "No Vercel deployment appeared for this branch. Check that the project is connected to this repository and that deployments for this branch are not ignored.",
    };
  }
  switch (deployment.readyState) {
    case "ready":
      return { action: "settle", phase: "ready", detail: null };
    case "error":
      return {
        action: "settle",
        phase: "failed",
        detail: deployment.errorMessage ?? "The Vercel build failed.",
      };
    case "canceled":
      return { action: "settle", phase: "canceled", detail: "The Vercel deployment was cancelled." };
    default:
      // The ceiling comes AFTER the endings and before the wait, the ordering
      // `decideMerge` arrived at the hard way: a build that never completes
      // answers "building" on every poll, and tested the other way round it
      // was waited on for ever.
      if (waitedMs >= VERCEL_MAX_WAIT_MS) {
        return {
          action: "settle",
          phase: "abandoned",
          detail: "Gave up waiting for the Vercel build. It may still be going — follow it on Vercel.",
        };
      }
      return { action: "wait" };
  }
}

// ── the owner's link ────────────────────────────────────────────────────────

/**
 * A Vercel project attached to one coding-agent project.
 *
 * The token is NOT here and never will be: what is stored is the NAME of an
 * entry in the owner's secret store (src/lib/project-secrets.ts), which the
 * server resolves at the moment it makes a call. So the link is ordinary
 * configuration — it can be read by the card, logged and backed up — while the
 * credential stays in the one place on this box that encrypts it.
 */
export interface VercelLink {
  /** The Vercel project's id (`prj_…`) or its name. */
  projectId: string;
  /** The team it is under, or null for a personal account. */
  teamId: string | null;
  /** The name of the secret-store entry holding the API token. */
  tokenSecretName: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a Vercel identifier may be.
 *
 * Every one of these reaches a URL PATH or a query parameter, so it is bounded
 * hard at the door rather than escaped at the sink: Vercel's ids are
 * `prj_<base62>` and `team_<base62>`, and a project name is lowercase
 * alphanumerics and hyphens. Nothing outside this alphabet is a Vercel
 * identifier, and a string that contains a slash or a dot-dot is the one that
 * would turn `/v9/projects/<id>` into a request to somewhere else.
 */
export const VERCEL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isVercelId(value: unknown): value is string {
  return typeof value === "string" && VERCEL_ID_RE.test(value);
}

/** A refusal the owner is shown, with a stable code beside the sentence. */
export type VercelLinkRefusal =
  | "invalid_project"
  | "invalid_team"
  | "invalid_secret_name"
  | "invalid_scope"
  | "not_linked"
  | "token_missing"
  | "token_unreadable"
  | "link_unreadable"
  | "link_unwritable";

export class VercelLinkError extends Error {
  constructor(readonly code: VercelLinkRefusal, message: string) {
    super(message);
    this.name = "VercelLinkError";
  }
}

// ── what the agent is handed when a build fails ─────────────────────────────

/**
 * The follow-up task for a run whose Vercel build broke.
 *
 * The sibling of `buildReviewFeedback` in coding-review-state.ts, and pure for
 * the same reason: what the box says to the harness is a decision, and a
 * decision belongs where a test can read it without a network or a process.
 *
 * WHAT IT DELIBERATELY DOES AND DOES NOT SAY. It quotes the log TAIL and names
 * the deployment, because that is the evidence. It does NOT tell the run to
 * deploy, promote, or talk to Vercel itself: the box owns that half, the run
 * owns the code, and a run given a deploy verb would be a run that could put
 * its own work in front of a project's users. And it says "do not start over",
 * because this arrives in the run's OWN session, which still holds everything
 * it did the first time.
 */
export function buildDeployFeedback(input: {
  projectId: string;
  branch: string | null;
  url: string | null;
  inspectorUrl: string | null;
  detail: string | null;
  log: string;
}): string {
  const lines = [
    "The Vercel build of the work you just pushed FAILED.",
    "",
    `Vercel project: ${input.projectId}`,
    ...(input.branch ? [`Branch: ${input.branch}`] : []),
    ...(input.detail ? [`What Vercel said: ${input.detail}`] : []),
    ...(input.inspectorUrl ? [`Build page: ${input.inspectorUrl}`] : []),
    "",
    "The end of the build log:",
    "",
    "```",
    input.log.trim() || "(Vercel returned no build log for this deployment.)",
    "```",
    "",
    "Fix the cause in this folder, then commit and push to the same branch — that is what makes Vercel build again.",
    "This is your own session: do not start the task over, and do not redo work that already landed.",
    "Do not try to deploy, promote or call Vercel yourself; this ClawBox watches the build and will tell its owner how it went.",
    "If the failure is not something you can fix from this folder (a missing environment variable on Vercel, a paid feature, a wrong project setting), do not guess: say exactly what is missing and finish.",
  ];
  return lines.join("\n");
}
