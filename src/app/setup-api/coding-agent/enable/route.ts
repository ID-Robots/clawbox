import { NextResponse } from "next/server";
import { refreshCodingAgentToolsIfReadinessChanged } from "@/lib/coding-agent-mcp-refresh";
import { hasOwnerSession } from "@/lib/owner-session";
import {
  clearHarnessFault,
  CodingAgentError,
  getCodingAgentStatus,
  httpStatusForCodingError,
  MAX_DIRECTORY_CHARS,
  MAX_MAX_PARALLEL_RUNS,
  MIN_MAX_PARALLEL_RUNS,
  setCodingAgentEnabled,
  setCodingProvider,
  setDefaultDirectory,
  setEffort,
  setMaxTurns,
  setAutoMerge,
  setAutoPr,
  setCompletionAttempts,
  setMaxParallelRuns,
  setGenerateAudio,
  setGenerateImages,
  setRealBrowser,
  setReviewPass,
  setReviewRounds,
  setSetupComplete,
  setTokenLimit,
} from "@/lib/coding-agent";

export const dynamic = "force-dynamic";

/**
 * The one refusal this route has: no owner browser session, no change.
 *
 * OWNER ONLY — the one thing in this subtree the agent must never be able to
 * do to itself. Middleware admits every /setup-api/* call on the MCP bearer,
 * and the agent holds that bearer; a route that trusted middleware here (or
 * requireSession, which also accepts the bearer) would let a prompt-injected
 * agent switch on its own delegated shell. Same rule and same helper as
 * email/pending: a real browser session or a 403, identical for "no
 * credential" and "valid bearer" alike.
 */
function forbidden() {
  return NextResponse.json(
    { error: "Changing the coding agent switch needs a signed-in browser session.", kind: "owner_only" },
    { status: 403 },
  );
}

/**
 * Change one coding-agent setting, then answer with the whole status.
 *
 * POST { enabled: boolean } → flip the owner's switch.
 * POST { defaultDirectory: string | null } → set (or clear) the folder a run
 * works in when the assistant names neither a project nor a directory. An
 * absolute path; a bare name is answered 400, since it is only ever a
 * shorthand for a folder INSIDE this one.
 * POST { effort: "low"|"medium"|"high"|"xhigh"|"max"|"ultracode" } → how hard a run thinks.
 * POST { provider: "clawbox-ai" | "anthropic" } → which account pays for a run
 * the caller does not name one for: the box's own ClawBox AI plan, or the
 * owner's Anthropic access (src/lib/coding-provider.ts). Storing it does not
 * require that provider to be connected — the owner may pick it before pasting
 * the key — but STARTING a run against it does.
 * POST { maxTurns: number } → how many steps a run gets.
 * POST { tokenLimit: number | null } → token ceiling, or null for none.
 * POST { generateImages: boolean } → may a run draw pictures with ClawBox AI,
 * and may the box draw the project's desktop icon and its favicon while a run
 * works. POST { generateAudio: boolean } → may a run have this box speak a
 * clip into its project. Both default ON; see their config keys in
 * @/lib/coding-agent for why these two are not consents.
 * POST { realBrowser: boolean } → does a run verify its work in the Chromium
 * on the owner's screen, or in a headless one nobody sees? ON when absent, for
 * the same reason as the media switches.
 * POST { autoPr: boolean } → branch, open a pull request into the repo's
 * default branch, wait for GitHub Actions, and merge when at least one real
 * check has passed. See @/lib/coding-pr for the guardrails.
 * POST { reviewRounds: number } → how many follow-up turns the review loop may
 * hand the harness after the pull request is opened (failing check logs,
 * unresolved review comments, "rebase onto <base>"). 0 switches the loop off
 * and leaves the older checks-only watcher in charge; the range is refused
 * rather than clamped, so a caller learns what this box offers.
 * POST { autoMerge: boolean } → may the box squash-merge a pull request its
 * own review loop cleared? Off by default, and never into `main`. See
 * @/lib/coding-review-state for the decision.
 * POST { maxParallelRuns: number } → how many coding runs may be going at
 * once. Each run works in a git worktree of its own, so the limit is a
 * question about the box's memory rather than about the filesystem; the range
 * is refused rather than clamped, like the review rounds.
 * POST { completionAttempts: number } → how many goes a run with a deliverable
 * gets at it, its own first turn counted as one. Only ever spent by a run that
 * HAS a deliverable — one the caller named, or the pull request the auto-PR
 * switch implies — so a box that uses neither is unaffected. The range is
 * refused rather than clamped, like the review rounds.
 * POST { setupComplete: boolean } → mark the setup wizard finished (the app
 * shows the wizard instead of its home page until this is true; the reset
 * route is what puts it back to false).
 * POST { clearHarnessFault: true } → forget a recorded harness fault, so runs
 * are accepted again at once. The fault expires on its own and a completed run
 * drops it, but an owner who has just fixed what the message named (signed in
 * again, changed plan) should not have to wait out a clock to prove it. Only
 * `true` does anything: there is no way to ASSERT a fault from outside, which
 * would be a way to disable the coding agent by POST.
 * The one switch of this feature's that is NOT here: whether a run may be
 * handed the owner's stored secrets (`coding_agent_inject_secrets`). It lives
 * on /setup-api/coding-agent/secrets instead, with the store it governs,
 * because it needs a fence this route does not carry: a same-origin check as
 * well as the owner's cookie. Everything above is the owner's preference about
 * their own agent, where the cookie is the whole question; that one hands
 * credentials to an unattended shell, which is the fence the permission rules
 * and the import routes carry for the same reason. The status still REPORTS it
 * (`injectSecrets`), because reading is not the half that needs the fence.
 * POST { reviewPass: boolean } → the automatic review pass: one extra run in
 * the same session after every completed run that changed project files
 * (the status payload reports it as `reviewPass`; a review run carries
 * `reviewOf: <run id>` in the runs listing).
 * Either way the answer is the same payload as GET
 * /setup-api/coding-agent/status, re-read after the change.
 *
 * Owner-only; see `forbidden` for why middleware is not trusted here.
 *
 * The switch branch does one thing the others do not: it tells the RUNNING
 * agent. The coding_agent_* tools are registered behind a probe the MCP server
 * takes once at boot, so a flip that only reaches the browser leaves the panel
 * claiming "ready" over an agent that still cannot start a run — see
 * `refreshCodingAgentToolsIfReadinessChanged`.
 *
 * @param request the owner's browser request, JSON body as above
 * @returns 200 with the re-read status, 400 on a body this route cannot read,
 *          or 403 without an owner session
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) return forbidden();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  // A JSON body may legally be a string, a number or a boolean, and `in`
  // throws a TypeError on those — which surfaced as a 500 where the caller
  // should have been told 400. Measured: `"a string"`, `42` and `true` all
  // returned 500 before this guard.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const fields = body as {
    enabled?: unknown;
    defaultDirectory?: unknown;
    effort?: unknown;
    maxTurns?: unknown;
    tokenLimit?: unknown;
    reviewPass?: unknown;
    autoPr?: unknown;
    reviewRounds?: unknown;
    autoMerge?: unknown;
    completionAttempts?: unknown;
    maxParallelRuns?: unknown;
    generateImages?: unknown;
    generateAudio?: unknown;
    realBrowser?: unknown;
    setupComplete?: unknown;
    clearHarnessFault?: unknown;
    provider?: unknown;
  };
  const hasEnabled = typeof fields.enabled === "boolean";
  const hasReviewPass = typeof fields.reviewPass === "boolean";
  const hasSetupComplete = typeof fields.setupComplete === "boolean";
  const hasAutoPr = typeof fields.autoPr === "boolean";
  const hasReviewRounds = typeof fields.reviewRounds === "number";
  const hasAutoMerge = typeof fields.autoMerge === "boolean";
  const hasCompletionAttempts = typeof fields.completionAttempts === "number";
  const hasMaxParallelRuns = typeof fields.maxParallelRuns === "number";
  const hasGenImages = typeof fields.generateImages === "boolean";
  const hasGenAudio = typeof fields.generateAudio === "boolean";
  const hasRealBrowser = typeof fields.realBrowser === "boolean";
  // Only `true`. `false` is not the other half of a switch here — it would
  // mean "record a fault", and nothing outside the runner may do that.
  const clearsFault = fields.clearHarnessFault === true;
  const hasEffort = typeof fields.effort === "string";
  const hasProvider = typeof fields.provider === "string";
  const hasTurns = typeof fields.maxTurns === "number";
  // null is meaningful — it CLEARS the ceiling — so presence decides.
  const hasTokens = "tokenLimit" in fields
    && (typeof fields.tokenLimit === "number" || fields.tokenLimit === null);
  // `null` is meaningful here — it CLEARS the default — so presence is what
  // decides whether this request is about the folder, not truthiness.
  const hasDirectory = "defaultDirectory" in fields
    && (typeof fields.defaultDirectory === "string" || fields.defaultDirectory === null);
  if (!hasEnabled && !hasDirectory && !hasEffort && !hasProvider && !hasTurns && !hasTokens && !hasReviewPass && !hasSetupComplete && !hasAutoPr && !hasReviewRounds && !hasAutoMerge && !hasCompletionAttempts && !hasMaxParallelRuns && !hasGenImages && !hasGenAudio && !hasRealBrowser && !clearsFault) {
    return NextResponse.json(
      {
        error:
          "Invalid body. Expected { enabled: boolean }, { defaultDirectory: string | null }, "
          + "{ effort: string }, { provider: string }, { maxTurns: number }, "
          + "{ tokenLimit: number | null }, { reviewPass: boolean }, "
          + "{ generateImages: boolean }, { generateAudio: boolean }, "
          + "{ realBrowser: boolean }, { reviewRounds: number }, "
          + "{ autoMerge: boolean }, { completionAttempts: number }, "
          + "{ maxParallelRuns: number }, "
          + "{ setupComplete: boolean }, { autoPr: boolean } or { clearHarnessFault: true }.",
      },
      { status: 400 },
    );
  }
  if (typeof fields.defaultDirectory === "string" && fields.defaultDirectory.length > MAX_DIRECTORY_CHARS) {
    return NextResponse.json({ error: "The folder path is too long.", kind: "invalid" }, { status: 400 });
  }
  // Checked BEFORE the first setter runs, the way the folder length above is.
  // The setters below apply one at a time, so a value refused halfway through
  // answers 400 over settings that have already been saved — a body carrying
  // both `effort` and a runs-at-once number this box does not offer would move
  // the effort and then report a failure. The setter keeps its own throw: it is
  // the library's door, and the MCP path does not come through here.
  if (hasMaxParallelRuns
    && (!Number.isInteger(fields.maxParallelRuns)
      || (fields.maxParallelRuns as number) < MIN_MAX_PARALLEL_RUNS
      || (fields.maxParallelRuns as number) > MAX_MAX_PARALLEL_RUNS)) {
    return NextResponse.json(
      { error: `The number of runs at once must be a whole number between ${MIN_MAX_PARALLEL_RUNS} and ${MAX_MAX_PARALLEL_RUNS}.`, kind: "invalid" },
      { status: 400 },
    );
  }

  try {
    // The family's availability BEFORE the write, read only on requests that
    // can actually move it. `ready` — not the raw switch — because `ready` is
    // the fact `probeCodingAgent` reads to decide whether the coding_agent_*
    // tools exist at all, and it is the field this route already answers with.
    //
    // It is a SECOND status read on the switch branch, deliberately, rather than
    // deriving the old verdict from the new one: `ready` is `enabled AND the
    // harness is installed AND ClawBox AI is connected`, and only the first of
    // those three is this request's to know. The reads are a handful of stat()s
    // and one readdir, on the one branch that flips a switch — and null here
    // means "this request cannot move the family", which is every other setting
    // the route carries.
    // `clearHarnessFault` belongs here with the switch, and for exactly the
    // same reason: a remembered fault makes `readiness.ready` false, so
    // clearing one can flip the family from unavailable to available while the
    // running MCP child still has none of the three coding_agent_* tools.
    // Without it the owner presses Try again, the panel says ready, and the
    // agent cannot start a run until something unrelated respawns the child.
    // The PROVIDER moves it for the third time over: `ready` is the box's
    // tools plus the DEFAULT provider's credential, so switching to an account
    // nobody has connected takes the family away exactly as switching the
    // agent off does.
    const readyBefore = hasEnabled || clearsFault || hasProvider ? (await getCodingAgentStatus()).ready : null;
    if (hasDirectory) {
      const saved = await setDefaultDirectory(fields.defaultDirectory as string | null);
      console.error(`[coding-agent] default folder ${saved ? "set" : "cleared"} by the owner`);
    }
    if (hasEffort) {
      const saved = await setEffort(fields.effort as string);
      console.error(`[coding-agent] effort set to ${saved} by the owner`);
    }
    if (hasProvider) {
      const saved = await setCodingProvider(fields.provider as string);
      console.error(`[coding-agent] runs will be paid for by ${saved}, by the owner's choice`);
    }
    if (hasTurns) {
      const saved = await setMaxTurns(fields.maxTurns);
      console.error(`[coding-agent] step limit set to ${saved} by the owner`);
    }
    if (hasReviewPass) {
      const saved = await setReviewPass(fields.reviewPass);
      console.error(`[coding-agent] review pass switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasAutoPr) {
      const saved = await setAutoPr(fields.autoPr);
      console.error(`[coding-agent] auto pull requests switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasReviewRounds) {
      const saved = await setReviewRounds(fields.reviewRounds);
      console.error(`[coding-agent] review rounds set to ${saved} by the owner`);
    }
    if (hasAutoMerge) {
      const saved = await setAutoMerge(fields.autoMerge);
      console.error(`[coding-agent] merging a cleared pull request switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasCompletionAttempts) {
      const saved = await setCompletionAttempts(fields.completionAttempts);
      console.error(`[coding-agent] attempts at a run's deliverable set to ${saved} by the owner`);
    }
    if (hasMaxParallelRuns) {
      await setMaxParallelRuns(fields.maxParallelRuns);
      // The number is deliberately NOT in the line. It is a whole number
      // between 1 and 4 by the time it is saved — the setter throws `invalid`
      // for anything else — but CodeQL cannot see that, and it does not
      // recognise `logSafe` as a sanitiser either, so `js/log-injection`
      // stands over any shape that carries the request's value into the log.
      // The answer this route returns is the re-read status, which says the
      // saved number, and `data/config.json` holds it; the log line is here to
      // record that the owner changed it, which it still does.
      console.error("[coding-agent] the number of coding runs at once was changed by the owner");
    }
    if (hasGenImages) {
      const saved = await setGenerateImages(fields.generateImages);
      console.error(`[coding-agent] generated pictures switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasGenAudio) {
      const saved = await setGenerateAudio(fields.generateAudio);
      console.error(`[coding-agent] generated audio switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasRealBrowser) {
      const saved = await setRealBrowser(fields.realBrowser);
      console.error(`[coding-agent] runs will verify their work in the ${saved ? "desktop" : "headless"} browser, by the owner's choice`);
    }
    if (clearsFault) {
      await clearHarnessFault();
      console.error("[coding-agent] recorded harness fault cleared by the owner");
    }
    if (hasSetupComplete) {
      const saved = await setSetupComplete(fields.setupComplete);
      console.error(`[coding-agent] setup wizard marked ${saved ? "finished" : "unfinished"} by the owner`);
    }
    if (hasTokens) {
      const saved = await setTokenLimit(fields.tokenLimit as number | null);
      console.error(`[coding-agent] token limit ${saved === null ? "cleared" : `set to ${saved}`} by the owner`);
    }
    if (hasEnabled) {
      await setCodingAgentEnabled(fields.enabled as boolean);
      console.error(`[coding-agent] switched ${fields.enabled ? "on" : "off"} by the owner`);
    }
    const status = await getCodingAgentStatus();
    // Tell the RUNNING agent, not just the browser. The coding_agent_* tools are
    // registered behind a probe the MCP server takes ONCE while it boots, and
    // that server is a long-lived stdio child — so without this the panel says
    // "ready" while the agent still has no way to start a run. Same shape and
    // same mechanism as #486 (email) and #503 (images); see the helper for the
    // rule about when a reload is worth its cost.
    //
    // AWAITED, and it cannot fail the save: the helper swallows everything and
    // returns void, so the worst case is a logged line and a tool list that
    // catches up at the next restart. A floating promise here would outlive the
    // response with nothing watching it.
    if (readyBefore !== null) {
      await refreshCodingAgentToolsIfReadinessChanged(readyBefore, status.ready);
    }
    return NextResponse.json(status);
  } catch (err) {
    // The folder rules answer in the owner's words ("that folder holds
    // credentials…"); pass them through as a 400 rather than a 500, because
    // the request was understood and refused, not broken. (The setters throw
    // only invalid/not_found, so the shared table answers 400/404 here.)
    if (err instanceof CodingAgentError) {
      return NextResponse.json({ error: err.message, kind: err.kind }, { status: httpStatusForCodingError(err.kind) });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to change the coding agent setting" },
      { status: 500 },
    );
  }
}
