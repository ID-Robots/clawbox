import { NextResponse } from "next/server";
import { refreshCodingAgentToolsIfChanged } from "@/lib/coding-agent-mcp-refresh";
import { hasPersonSession } from "@/lib/owner-session";
import { logSafe } from "@/lib/log-safe";
import { bodyWouldEnable } from "@/lib/paid-plan-gate";
import { readPlanGate, refusePaidPlan } from "@/lib/paid-plan-gate-server";
import {
  clearHarnessFault,
  CodingAgentError,
  getCodingAgentStatus,
  HISTORY_RETENTION_MODES,
  httpStatusForCodingError,
  MAX_DIRECTORY_CHARS,
  hostMaxParallelRuns,
  MIN_MAX_PARALLEL_RUNS,
  setCodingAgentEnabled,
  setCodingGitAuthor,
  getConnectedProviders,
  setCodingProvider,
  setConnectedProviders,
  checkRoleModelsPatch,
  setDefaultDirectory,
  setEffort,
  setAutoMerge,
  setAutoPr,
  setMaxParallelRuns,
  setPrBodyIncludesTask,
  setGenerateMedia,
  setHistoryRetention,
  setRealBrowser,
  setReviewPass,
  setRoleModels,
  setSetupComplete,
  setTeamDynamic,
} from "@/lib/coding-agent";
import { PR_BODY_TASK_MODES } from "@/lib/coding-pr-body";

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
 * (`{ maxTurns }` is an unknown body since SCA3, 400, like `{ tokenLimit }`
 * since SCA A2: the step ceiling is a safety net, DEFAULT_MAX_TURNS, not a
 * setting.)
 * POST { generateMedia: boolean } → may a run draw pictures with ClawBox AI
 * (and the box draw the project's desktop icon and favicon while it works)
 * and have this box speak clips into its project. ONE switch over the two
 * keys since SCA C3 (`setGenerateMedia`); ON by default — see the keys in
 * @/lib/coding-agent for why it is not a consent.
 * POST { realBrowser: boolean } → does a run verify its work in the Chromium
 * on the owner's screen, or in a headless one nobody sees? ON when absent, for
 * the same reason as the media switch.
 * POST { teamDynamic: boolean } → may a coding team's lead add or retire tasks
 * while the team runs (one short read-only run after each worker settles).
 * OFF when absent; a team reads it when it starts.
 * POST { providers: ["clawbox-ai" | "anthropic", …] } → the providers the
 * owner CONNECTED to the coding agent (the whole list each time; never empty:
 * the last one cannot be disconnected). The default provider follows the list
 * when it was dropped from it, and a team role pinned to a provider that left
 * the list goes back to its default — `setConnectedProviders`. In a body that
 * carries both, `providers` is applied FIRST and a `provider` outside the
 * resulting list is refused (400) before anything is written, never silently
 * overwritten.
 * POST { roleModels: { planner?|worker?|reviewer?: { provider?, model?,
 * effort? } } } → what a coding team's roles run on (src/lib/coding-role-models.ts).
 * `provider` is "clawbox-ai" or "anthropic"; `model` is "standard", "economy"
 * or one model that provider offers (`roleModelOptions` — a model needs a
 * provider, named in the same edit or already stored for the role); `effort`
 * is one of the levels above; "auto" or null puts a half back to the role's
 * default. Only the halves named change. The whole edit is refused, before
 * anything in the body is saved, on an unknown role or field or a provider and
 * model that do not go together. Storing a provider does not require it to be
 * connected; a team run of that role does.
 * POST { autoPr: boolean } → branch, open a pull request into the repo's
 * default branch, wait for GitHub Actions, and merge when at least one real
 * check has passed. See @/lib/coding-pr for the guardrails.
 * POST { prBodyIncludesTask: "summary"|"full-redacted"|"none" } → how much of
 * the run's task that pull request carries: a one-line summary and the first
 * ~600 characters (the default), the whole task, or none of it. Whichever, it
 * is redacted before it is published (@/lib/publish-redaction); a value this
 * box does not offer is refused before anything is saved.
 * POST { autoMerge: boolean } → may the box squash-merge a pull request its
 * own review loop cleared? Off by default, and never into `main`. See
 * @/lib/coding-review-state for the decision.
 * POST { maxParallelRuns: number } → how many coding runs may be going at
 * once. Each run works in a git worktree of its own, so the limit is a
 * question about the box's memory rather than about the filesystem; the range
 * is refused rather than clamped.
 * (The review rounds are no longer a setting since SCA C3: a run gets
 * DEFAULT_REVIEW_ROUNDS. The attempts at a deliverable and the token ceiling
 * went altogether in SCA A2 — the box checks the bar once and the owner's
 * Resume is the only second go — and the extended history's N went with its
 * mode in SCA2 C1. A body naming any of them is answered 400.)
 * POST { historyRetention: "standard"|"everything" } → what the box keeps of
 * finished runs (see @/lib/coding-run-history); a value this box does not
 * offer is refused before anything is saved. Choosing "everything" also tells
 * Claude Code to keep its transcripts (merged into its settings files, never
 * overwriting them); choosing standard hands that back.
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
  if (!(await hasPersonSession(request))) return forbidden();

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
    reviewPass?: unknown;
    autoPr?: unknown;
    prBodyIncludesTask?: unknown;
    autoMerge?: unknown;
    maxParallelRuns?: unknown;
    generateMedia?: unknown;
    realBrowser?: unknown;
    teamDynamic?: unknown;
    setupComplete?: unknown;
    clearHarnessFault?: unknown;
    provider?: unknown;
    providers?: unknown;
    gitAuthorName?: unknown;
    gitAuthorEmail?: unknown;
    historyRetention?: unknown;
    roleModels?: unknown;
  };
  const hasEnabled = typeof fields.enabled === "boolean";
  const hasReviewPass = typeof fields.reviewPass === "boolean";
  const hasSetupComplete = typeof fields.setupComplete === "boolean";
  const hasAutoPr = typeof fields.autoPr === "boolean";
  const hasAutoMerge = typeof fields.autoMerge === "boolean";
  const hasMaxParallelRuns = typeof fields.maxParallelRuns === "number";
  const hasGenMedia = typeof fields.generateMedia === "boolean";
  const hasRealBrowser = typeof fields.realBrowser === "boolean";
  const hasTeamDynamic = typeof fields.teamDynamic === "boolean";
  // Only `true`. `false` is not the other half of a switch here — it would
  // mean "record a fault", and nothing outside the runner may do that.
  const clearsFault = fields.clearHarnessFault === true;
  const hasEffort = typeof fields.effort === "string";
  const hasProvider = typeof fields.provider === "string";
  const hasProviders = Array.isArray(fields.providers);
  // `null` is meaningful here — it CLEARS the default — so presence is what
  // decides whether this request is about the folder, not truthiness.
  const hasDirectory = "defaultDirectory" in fields
    && (typeof fields.defaultDirectory === "string" || fields.defaultDirectory === null);
  // Both halves of the commit identity are optional and independently
  // clearable, so — like the folder — presence decides,
  // not truthiness: `null` and `""` are the request that CLEARS one.
  const hasGitAuthorName = "gitAuthorName" in fields
    && (typeof fields.gitAuthorName === "string" || fields.gitAuthorName === null);
  const hasGitAuthorEmail = "gitAuthorEmail" in fields
    && (typeof fields.gitAuthorEmail === "string" || fields.gitAuthorEmail === null);
  // Presence decides, like the counted settings: a wrong TYPE is still a
  // request about the history, and is refused below rather than ignored.
  const hasHistoryRetention = "historyRetention" in fields;
  // Presence decides here too, for the same reason as the history setting.
  const hasPrBodyIncludesTask = "prBodyIncludesTask" in fields;
  // A team's per-role model and effort (src/lib/coding-role-models.ts):
  // presence decides, and a wrong shape is refused below, whole.
  const hasRoleModels = "roleModels" in fields;
  if (!hasEnabled && !hasDirectory && !hasEffort && !hasProvider && !hasProviders && !hasReviewPass && !hasSetupComplete && !hasAutoPr && !hasPrBodyIncludesTask && !hasAutoMerge && !hasMaxParallelRuns && !hasGenMedia && !hasRealBrowser && !hasTeamDynamic && !hasGitAuthorName && !hasGitAuthorEmail && !hasHistoryRetention && !hasRoleModels && !clearsFault) {
    return NextResponse.json(
      {
        error:
          "Invalid body. Expected { enabled: boolean }, { defaultDirectory: string | null }, "
          + "{ effort: string }, { provider: string }, "
          + "{ reviewPass: boolean }, "
          + "{ generateMedia: boolean }, "
          + "{ realBrowser: boolean }, { teamDynamic: boolean }, "
          + "{ autoMerge: boolean }, "
          + "{ maxParallelRuns: number }, "
          + "{ historyRetention: string }, "
          + "{ gitAuthorName: string | null }, { gitAuthorEmail: string | null }, "
          + "{ prBodyIncludesTask: string }, "
          + "{ roleModels: { planner?|worker?|reviewer?: { provider?, model?, effort? } } }, "
          + "{ setupComplete: boolean }, { autoPr: boolean } or { clearHarnessFault: true }.",
      },
      { status: 400 },
    );
  }
  // The paid-plan gate, checked before any setter runs and ONLY for a body
  // that would switch the feature on or finish its wizard (`bodyWouldEnable`).
  // Owner's decision, 2026-09-14: the coding agent is a Pro-or-Max feature.
  //
  // Deliberately not "refuse every write". A box that was already switched on
  // and whose subscription later lapsed is not auto-disabled — that is the
  // owner's own consent and their own runs — so its settings, including the
  // switch that turns it OFF, stay writable. What a Free or unconnected
  // account cannot do is turn it on or mark setup complete, which is what
  // stops a new box from getting through the wizard.
  if (bodyWouldEnable(fields)) {
    const gate = await readPlanGate();
    if (!gate.satisfied) return refusePaidPlan("coding_agent", gate);
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
      || (fields.maxParallelRuns as number) > hostMaxParallelRuns())) {
    return NextResponse.json(
      { error: `The number of runs at once must be a whole number between ${MIN_MAX_PARALLEL_RUNS} and ${hostMaxParallelRuns()}.`, kind: "invalid" },
      { status: 400 },
    );
  }
  // The history setting, checked before any setter runs for the same reason.
  if (hasHistoryRetention && !(HISTORY_RETENTION_MODES as readonly unknown[]).includes(fields.historyRetention)) {
    return NextResponse.json(
      { error: `The run history setting must be one of: ${HISTORY_RETENTION_MODES.join(", ")}.`, kind: "invalid" },
      { status: 400 },
    );
  }
  if (hasPrBodyIncludesTask && !(PR_BODY_TASK_MODES as readonly unknown[]).includes(fields.prBodyIncludesTask)) {
    return NextResponse.json(
      { error: `What a pull request includes of the task must be one of: ${PR_BODY_TASK_MODES.join(", ")}.`, kind: "invalid" },
      { status: 400 },
    );
  }

  try {
    // The per-role choices, checked whole before any setter runs, like the
    // rest — and inside the try because the check reads what is stored: a
    // model named alone runs on the role's stored provider.
    if (hasProvider && hasProviders) {
      const list = fields.providers as unknown[];
      if (!list.includes(fields.provider)) {
        return NextResponse.json({ error: `The default provider must be one of the connected ones: ${list.map(String).join(", ")}.`, kind: "invalid" }, { status: 400 });
      }
    }
    if (hasProvider && !hasProviders && !(await getConnectedProviders()).includes(fields.provider as never)) {
      return NextResponse.json({ error: "The default provider must be a connected one. Connect it first.", kind: "invalid" }, { status: 400 });
    }
    const roleModelsRefusal = hasRoleModels ? await checkRoleModelsPatch(fields.roleModels) : null;
    if (roleModelsRefusal) {
      return NextResponse.json({ error: roleModelsRefusal, kind: "invalid" }, { status: 400 });
    }
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
    const before = hasEnabled || clearsFault || hasProvider || hasProviders
      ? await getCodingAgentStatus()
      : null;
    if (hasDirectory) {
      const saved = await setDefaultDirectory(fields.defaultDirectory as string | null);
      console.error(`[coding-agent] default folder ${saved ? "set" : "cleared"} by the owner`);
    }
    if (hasGitAuthorName || hasGitAuthorEmail) {
      // ONE call for both halves. Two setters in a row stored the name and
      // then answered 400 for a bad address in the same body, leaving half an
      // identity behind — and half an identity is the state that reads as
      // configured and is not. The setter validates everything it was given
      // before it writes any of it.
      const saved = await setCodingGitAuthor({
        ...(hasGitAuthorName ? { name: fields.gitAuthorName as string | null } : {}),
        ...(hasGitAuthorEmail ? { email: fields.gitAuthorEmail as string | null } : {}),
      });
      // Never the values themselves — they are the owner's own name and
      // e-mail, and this line goes to the box's journal. Only whether each
      // supplied half ended up set.
      if (hasGitAuthorName) console.error(`[coding-agent] commit author name ${saved.name ? "set" : "cleared"} by the owner`);
      if (hasGitAuthorEmail) console.error(`[coding-agent] commit author e-mail ${saved.email ? "set" : "cleared"} by the owner`);
    }
    if (hasEffort) {
      const saved = await setEffort(fields.effort as string);
      console.error(`[coding-agent] effort set to ${saved} by the owner`);
    }
    if (hasRoleModels) {
      const saved = await setRoleModels(fields.roleModels);
      console.error(`[coding-agent] team role models set by the owner: ${JSON.stringify(saved)}`);
    }
    // The list first, the default second: the default must be on the list.
    if (hasProviders) {
      const saved = await setConnectedProviders(fields.providers);
      console.error(`[coding-agent] connected providers set to ${saved.providers.join(", ")} by the owner${saved.resetRoles.length ? ` (back on their default: ${saved.resetRoles.join(", ")})` : ""}`);
    }
    if (hasProvider) {
      const saved = await setCodingProvider(fields.provider as string);
      console.error(`[coding-agent] runs will be paid for by ${saved}, by the owner's choice`);
    }
    if (hasReviewPass) {
      const saved = await setReviewPass(fields.reviewPass);
      console.error(`[coding-agent] review pass switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasAutoPr) {
      const saved = await setAutoPr(fields.autoPr);
      console.error(`[coding-agent] auto pull requests switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasPrBodyIncludesTask) {
      const saved = await setPrBodyIncludesTask(fields.prBodyIncludesTask);
      // A value from the setter's own fixed list by now.
      console.error(`[coding-agent] pull requests will carry the task as ${logSafe(saved)}, by the owner's choice`);
    }
    if (hasAutoMerge) {
      const saved = await setAutoMerge(fields.autoMerge);
      console.error(`[coding-agent] merging a cleared pull request switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasMaxParallelRuns) {
      await setMaxParallelRuns(fields.maxParallelRuns);
      // The number is deliberately NOT in the line. It is a whole number
      // between 1 and 4 by the time it is saved — the setter throws `invalid`
      // for anything else — but CodeQL could not see that, and at the time
      // this was written it did not read `logSafe` as a sanitiser either, so
      // `js/log-injection` stood over any shape that carried the request's
      // value into the log. (TASK-1014 gave `logSafe` one literal pass per
      // line break, which the scanner CAN read, so the line above this block
      // now sanitises rather than omits; this one is left as it is because the
      // saved number adds nothing the re-read status does not already carry.)
      // The answer this route returns is the re-read status, which says the
      // saved number, and `data/config.json` holds it; the log line is here to
      // record that the owner changed it, which it still does.
      console.error("[coding-agent] the number of coding runs at once was changed by the owner");
    }
    if (hasHistoryRetention) {
      const { policy, transcripts } = await setHistoryRetention(fields.historyRetention);
      // Both are values from the setter's own fixed lists by now.
      console.error(`[coding-agent] run history set to ${logSafe(policy.mode)} by the owner`);
      for (const t of transcripts) {
        if (t.state !== "already") console.error(`[coding-agent] Claude Code transcript period ${t.state}: ${logSafe(t.file)}`);
      }
    }
    if (hasGenMedia) {
      const saved = await setGenerateMedia(fields.generateMedia);
      console.error(`[coding-agent] generated pictures and audio switched ${saved ? "on" : "off"} by the owner`);
    }
    if (hasRealBrowser) {
      const saved = await setRealBrowser(fields.realBrowser);
      console.error(`[coding-agent] runs will verify their work in the ${saved ? "desktop" : "headless"} browser, by the owner's choice`);
    }
    if (hasTeamDynamic) {
      const saved = await setTeamDynamic(fields.teamDynamic);
      console.error(`[coding-agent] the coding team's lead switched ${saved ? "on" : "off"} by the owner`);
    }
    if (clearsFault) {
      await clearHarnessFault();
      console.error("[coding-agent] recorded harness fault cleared by the owner");
    }
    if (hasSetupComplete) {
      const saved = await setSetupComplete(fields.setupComplete);
      console.error(`[coding-agent] setup wizard marked ${saved ? "finished" : "unfinished"} by the owner`);
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
    if (before) {
      await refreshCodingAgentToolsIfChanged({ ready: before.ready }, { ready: status.ready });
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
