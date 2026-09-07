// Taint-then-approve, as an OpenClaw plugin.
//
// WHAT IT IS FOR. CodeRabbit deep-scan finding #9 (TASK-735): the path from web
// content to a shell inside ONE turn was not closed. PR #740 scrubbed the MCP
// token out of that server's environment and reworded `allow_dangerous` as a
// typo override, and left the gate itself deferred — "the taint-then-approve
// design only works at the harness seam". This is that seam.
//
// HARNESS FIRST, AND WHAT OPENCLAW ACTUALLY OWNS. All three moving parts are
// the core's, measured on the pinned 2026.8.1 build rather than assumed:
//
//   1. THE TAINT SIGNAL. `before_tool_call` and `after_tool_call`, the core's
//      own tool hooks. TASK-768 is why it is BOTH and not only the second one:
//      the after hook is the only one that carries a tool's RESULT
//      (`PluginHookAfterToolCallEvent` has `result` and `error`), but the model
//      emits the web read and the shell in ONE assistant message and the core
//      dispatches them together, so every before hook in a batch fires before
//      any sibling's after hook. Learning only from the result meant the shell
//      was asked about while the mark was still empty. THE RULE IS NOW THAT A
//      WEB READ WHICH HAS STARTED TAINTS THE RUN, which is what the before hook
//      can see. Neither hook ever blocks the read itself.
//
//   2. THE TAINT STORE. `api.runContext` is the core's own per-RUN plugin
//      scratch state, namespaced per plugin and documented as "Cleared on run
//      end/error", and it is the right mechanism — it is written and read here.
//      What was OBSERVED on the box, under PR #775's after-hook-only design, is
//      that it did not keep this plugin's mark: the write was refused and every
//      card named no source. WHICH refusal fired was not determined — see
//      `marksByRun` below for the candidates and for why the gate keeps the
//      mark itself as well, and why that mark is reclaimed at run end rather
//      than by a TTL that could outlive the turn or expire inside it.
//
//   3. THE GATE. `before_tool_call` may answer `requireApproval`
//      (`docs/plugins/plugin-permission-requests.md`, "Request approval before
//      a tool call"). The core then calls `plugin.approval.request` carrying
//      the turn's `sessionKey`/`agentId`, writes a durable row whose
//      `audience_session_keys` is that session's lineage, and publishes
//      `session.approval` to every client subscribed with
//      `includeApprovals: true` — which is precisely what PR #749's card in the
//      ClawBox chat already subscribes to and answers with `approval.resolve`.
//      Telegram's native `/approve <id> allow-once|deny` answers the same row.
//      NOTHING NEW IS RENDERED OR STORED HERE.
//
// THE ORDERING THIS RELIES ON, measured in the pinned core rather than assumed.
// `executeToolCalls` (`agent-core`) sends a batch down `executeToolCallsParallel`
// by default, and that has TWO phases: a sequential, awaited prepare loop over
// the tool calls IN ASSISTANT-MESSAGE ORDER, and only then a launch phase that
// starts the implementations concurrently. Every tool carries
// `wrapToolWithBeforeToolCallHook`, whose hook runs in the prepare phase and
// then PARKS the call until the launcher releases it. So in one batch every
// `before_tool_call` runs, in order, before ANY implementation starts — and
// therefore before any sibling's `after_tool_call`, which the core fires
// per-completion and UNAWAITED. Marking the run when a web read is prepared is
// what puts the mark in front of the sibling shell.
//
// AND THE LIMIT THAT LEAVES, on the record rather than left to be found: the
// order is the model's. If the model emits the shell BEFORE the web read in the
// same message, the shell's hook runs first and the mark is not there yet. A
// plugin cannot close that from here, and this is the harness gap worth naming:
// a tool hook is handed only `runId` and `toolCallId` — there is no
// `assistantMessageId`, no sibling list, no batch id anywhere on
// `PluginHookBeforeToolCallEvent` or `PluginHookToolContext` — and the core's
// one batch-level admission hook, `beforeToolBatch`, is host-private (a WeakMap
// keyed by the Agent, reserved for tool-loop detection) with no `api.*` surface.
// AND THE PRICE OF MARKING EARLY, also on the record: a read that is PREPARED
// need not happen. The core runs every before hook and then checks steering, so
// an interrupted, aborted or refused batch can be marked and then skipped
// without fetching a byte — and every shell call for the rest of that run then
// raises a card naming a source that never returned. It fails closed, so it is
// an annoyance and not a hole, and it is why the card says the turn STARTED
// reading rather than that it read. Narrowing it would mean waiting for the
// result, which is the defect this whole change exists to fix.
//
// The one native lever that WOULD serialise a batch is
// `ToolDefinition.executionMode: "sequential"`, which promotes the whole batch
// to the sequential path — but only when the model calls that particular tool,
// so it cannot cover the core's own `exec`, and turning it on for the ClawBox
// MCP tools would serialise every batch on the box to close half a hole.
//
// ORDERING, so this cannot be a false success. The core runs `before_tool_call`
// "after the model selects a tool and before OpenClaw executes it", and an
// unresolved approval always denies ("Unresolved approvals always deny";
// timeout, cancellation and "no approval route" all block). The tool does not
// run first and ask afterwards.
//
// WHAT HAPPENS ON A TURN NOBODY IS WATCHING, stated because it is a behaviour
// change and not an accident. The core will not raise a plugin approval on a
// non-user turn at all: `resolveUnavailablePluginApprovalSurfaceReason` answers
// "<trigger> runs have no approval-capable initiating surface" for every
// trigger but `user`, and the call is then BLOCKED with
// `deniedReason: "plugin-approval-unavailable"`. So on a cron or heartbeat turn
// a shell call after a web read does not ask — it is refused, and the agent is
// told why. That is the safe direction for an unattended turn that just read a
// stranger's text, and it is deliberate; a scheduled "fetch a page then run a
// script" automation stops working and its owner has to move the fetch and the
// shell into different turns. The plugin cannot soften this from here: the tool
// hook context carries no trigger, and guessing one from `requester` would
// gate the ClawBox chat itself on any harness that cannot prove a requester.
//
// WHY IT IS NOT PART OF clawbox-path-guard. That plugin encodes the owner's
// 2026-09-04 ruling — a hard, SILENT deny on two paths, "narrower, but silent
// when it bites" — and `src/tests/unit/protected-paths.test.ts` pins that it
// never emits `requireApproval`. Two different rulings do not belong in one
// handler. The `-10` priority is a courtesy, not the mechanism: the core checks
// `block` before `requireApproval` and a block is sticky and terminal, so the
// guard's silent deny wins whatever the order — the priority only saves this
// handler from being asked about a command that is already refused.
//
// ONE MORE LIMIT, only where code mode is switched on: a `code_mode_exec` call
// (`toolKind` on the hook event) can call other tools from inside itself, so the
// web read and the shell happen within ONE tool call and no `after_tool_call`
// runs between them. Nothing on a shipped box enables `tools.codeMode`, and the
// gate cannot see inside such a call from here.
//
// WHAT IS NOT TAINT. Content that arrives as the turn's PROMPT rather than as a
// tool result — an inbound email routed to the chat, a stranger's message on a
// channel — is outside this gate. `email_read` being in the web-content list
// invites the opposite reading, so: this hook sees tool RESULTS. The inbound
// seam is `message_received`, a different decision.
//
// THE OTHER EDITION. Hermes is not covered and cannot be from here. The shell
// is what is OpenClaw-only (`bash`, and the coordinate browser tools —
// `mcp/check-tools.ts` `OPENCLAW_ONLY`); several of the tainting tools
// (`browser_open`, `browser_navigate`, `browser_screenshot`,
// `browser_view_local`, `email_list`, `email_read`) do run on Hermes, so the
// gap is that Hermes has no seam of this shape to gate them with: its own tool
// gate is `approvals.deny`, fnmatch globs that block unconditionally with no
// "ask" outcome. And ClawBox itself would defeat a naive port —
// `src/lib/hermes-dashboard-turn.ts` answers Hermes' own approval frames with
// `once` by design. Recorded as a gap in the PR rather than papered over with a
// second approval surface.

import { isDangerousTool, isWebContentTool, taintApprovalRequest } from "./web-taint.mjs";

/** The plugin id, which must match `openclaw.plugin.json` and the config key. */
const PLUGIN_ID = "clawbox-web-taint";

/** The `api.runContext` namespace the mark is written under. */
export const TAINT_NAMESPACE = "clawbox.web-taint";

/**
 * How long a taint with NO RUN TO KEY ON keeps every shell asking.
 *
 * This is the fail-closed path and nothing else, and it now has exactly ONE
 * trigger: a web tool call that arrived carrying no run id, so there was
 * nothing to scope the taint to. An eviction deliberately does NOT arm it —
 * see `rememberTaint`, where arming from the bound is the failure that made an
 * earlier draft of this gate ask about every shell on the box for ever. A clean
 * turn never arms it, so ordinary work, cron included, is untouched.
 */
const UNSCOPED_TAINT_WINDOW_MS = 5 * 60_000;

/** How many distinct source tools the mark names, so the card stays bounded. */
const MAX_SOURCES = 4;

/**
 * A BACKSTOP bound on the mark map, not the mechanism that keeps it small.
 *
 * What keeps it small is the harness: the gate subscribes to the core's
 * `lifecycle` agent-event stream and drops a run's mark when the core says that
 * run ended — the same event, in the same dispatcher, at which the core clears
 * its OWN per-run plugin context. So the map holds live runs that read the web,
 * which on a box is a handful.
 *
 * This bound only matters on a core that offers no such subscription, where
 * marks would otherwise accumulate for the process lifetime. Eviction is
 * least-recently-marked, age-gated and SILENT: it arms nothing — see
 * `rememberTaint` for why arming the process-wide window from the bound would
 * be far worse than the taint it protects.
 */
const MAX_TRACKED_RUNS = 1024;

/**
 * How old a mark must be before the backstop above may evict it.
 *
 * NOT A TTL: nothing expires, and a mark this old still gates its run for as
 * long as that run lives. It is the floor that makes eviction SAFE — losing a
 * live run's mark is an ungated shell, and the least-recently-marked entry is
 * exactly the shape a long agent run has when it read a page early and reaches
 * a shell much later. A day is far past any turn, so anything older belongs to
 * a run that ended; if nothing is that old the map is simply allowed to grow,
 * because bounded memory is worth less than a gate that holds.
 */
const EVICTABLE_AFTER_MS = 24 * 60 * 60_000;

/** Lower than the path guard's default 0, so its silent deny is answered first. */
const GATE_PRIORITY = -10;

/**
 * The core's per-run plugin scratch state, as this file uses it. Named so the
 * unit test's stand-in and the boot self-test's are checked against the same
 * three methods the pinned core exposes on `api.runContext`.
 *
 * `setRunContext` is typed `=> boolean` by the core, but this gate takes its
 * answer as `unknown` and never reads it: that boolean reports whether the CORE
 * accepted the write, and no decision here depends on it — the gate keeps its
 * own mark. Reading it is what produced TASK-768's second defect.
 *
 * @typedef {object} WebTaintRunStore
 * @property {(patch: { runId: string, namespace: string, value?: unknown }) => unknown} setRunContext
 * @property {(params: { runId: string, namespace: string }) => unknown} getRunContext
 * @property {(params: { runId: string, namespace?: string }) => void} [clearRunContext]
 */

/**
 * The gate, over one run store.
 *
 * Both handlers are total by construction — every field is type-checked before
 * it is read and every store call is wrapped — because a tool hook that throws
 * is a guard whose behaviour becomes the dispatcher's business rather than
 * ours.
 *
 * @param {{ runContext?: WebTaintRunStore, now?: () => number }} [options]
 */
export function createWebTaintGate({ runContext, now = Date.now } = {}) {
  /**
   * THE MARK, held here: `runId` → `{ sources, at }`.
   *
   * WHY THIS EXISTS BESIDE THE HARNESS'S OWN STORE, which is the thing a
   * ClawBox plugin is supposed to use rather than reinvent. `api.runContext` IS
   * the right mechanism and it is still written and read below.
   *
   * WHAT WAS OBSERVED, and only that: under PR #775's design — where the mark
   * was written from `after_tool_call` — every approval the device lane raised
   * on the box carried the "could not be kept" wording and named no source, so
   * the write was refused and the gate had nowhere else to put what it had
   * learned. WHICH refusal fired was NOT determined. The likeliest candidate is
   * the core's own `if (!allowClosedRun && isPluginRunClosed(runId)) return
   * false`, reachable precisely because the core fires `after_tool_call`
   * UNAWAITED so it can land after the run's terminal lifecycle event — a race
   * this file's before-hook write may well win. The loader also gates the store
   * behind a side-effect predicate, but that predicate is true for a normally
   * loaded, enabled plugin, so it is not the explanation.
   *
   * SO WHY KEEP A MARK HERE AT ALL, if the store may now accept the write.
   * Because the two stores answer different questions. When the loader's
   * predicate DOES shut, it shuts `setRunContext` and `getRunContext` together
   * (`… ? setPluginRunContext({…}) : false` / `… : void 0`), so a refused write
   * is not a mark that can be recovered by reading harder — the gate would be
   * silently blind, which for a security gate is the one outcome worth paying a
   * map for. The mark is therefore kept here and MIRRORED into `api.runContext`,
   * the harness reclaims it at run end through the subscription in `register`,
   * and no decision depends on whether the core took the copy. If a later
   * measurement shows the store accepts reliably, this map becomes a redundant
   * cache to delete rather than a design to unwind.
   *
   * It cannot leak across turns: a run id belongs to exactly one run, so a mark
   * is only ever read back by the turn that wrote it.
   */
  const marksByRun = new Map();

  /**
   * A taint with NO RUN TO KEY ON — the only case where there is nothing to
   * scope to, so the window has to be process-wide. It is armed by a web tool
   * call that carried no run id, and by an eviction, and by nothing else, so a
   * box that never reads the web never sees it.
   */
  let unscopedTaintUntilMs = 0;

  /**
   * Records `toolName` against `runId`, newest sources kept, oldest RUN evicted.
   *
   * THERE IS DELIBERATELY NO TIME LIMIT ON A MARK. A TTL would be a second way
   * for the gate to fail: a turn that outlived it would have its own mark
   * expire underneath it and the shell would go unasked mid-turn — probe-once,
   * arrived at from the other side. A mark is dropped when its RUN ENDS
   * instead, on the core's own signal (`forgetRun` below).
   *
   * THE EVICTION IS SILENT AND AGE-GATED, and that is the careful part. Two
   * earlier drafts of this file got it wrong in opposite directions.
   *
   * The first armed the process-wide window on every eviction, reasoning that a
   * lost mark is a taint the gate can no longer prove. That only holds if
   * reaching the bound means something is wrong — and without run-end
   * reclamation it does not: marks would accumulate for the process lifetime,
   * so a box that browses reaches 1024 in the ordinary course of weeks, and
   * from then on EVERY web read would evict one and re-arm a process-wide gate
   * that never drains. The gate would degrade, silently and permanently, into
   * asking about every shell in every session and every cron — the "a gate that
   * fires on ordinary work is worse than no gate" failure this plugin forbids.
   *
   * The second evicted the least-recently-marked run silently, which is
   * fail-OPEN: that entry is exactly the shape of a long agent run which read a
   * page early and reaches a shell much later, and dropping its mark is an
   * ungated shell with no card and no trace. So eviction now refuses to touch
   * anything younger than `EVICTABLE_AFTER_MS`, and the map is allowed to grow
   * rather than drop a mark that might still be live.
   */
  const rememberTaint = (runId, toolName) => {
    const sources = marksByRun.get(runId)?.sources ?? [];
    const next = sources.includes(toolName) ? sources : [...sources, toolName].slice(-MAX_SOURCES);
    // Delete before set so insertion order stays recency order and the eviction
    // below considers the run that has been quiet longest first.
    marksByRun.delete(runId);
    marksByRun.set(runId, { sources: next, at: now() });
    while (marksByRun.size > MAX_TRACKED_RUNS) {
      const oldest = marksByRun.entries().next().value;
      if (!oldest) break;
      const [key, mark] = oldest;
      // Insertion order is recency order, so once the oldest is too young to
      // evict, every other entry is too.
      if (now() - mark.at < EVICTABLE_AFTER_MS) break;
      // BOTH copies. Dropping only this gate's would leave the mirror behind,
      // and the mirror is read back beside the mark — so the run would still be
      // gated by a taint the gate believes it has released, and the eviction
      // would free a map entry while changing nothing else.
      dropRun(key);
    }
  };

  /**
   * Releases a run's taint from BOTH stores.
   *
   * Both, or the mirror outlives the mark it mirrors: `onBeforeToolCall` reads
   * the two together, so a run whose local mark was released but whose mirror
   * was not is still gated by a taint this gate believes it has let go. That
   * was a real defect in a draft of this file, where eviction dropped only the
   * map entry.
   */
  const dropRun = (runId) => {
    marksByRun.delete(runId);
    try {
      runContext?.clearRunContext?.({ runId, namespace: TAINT_NAMESPACE });
    } catch {
      // A store that refuses to forget is the harness's business, not the
      // gate's: the mark this gate reads is already gone.
    }
  };

  /**
   * Drops a run's taint because the run has ENDED.
   *
   * THIS IS THE HARNESS DOING THE RECLAIMING, which is the point: the core
   * dispatches plugin agent-event subscriptions and, on a terminal `lifecycle`
   * event, marks the run closed and clears its own per-run plugin context in
   * the same place (`dispatchPluginAgentEventSubscriptions`). Hooking the same
   * event keeps this gate's copy in step with the core's instead of inventing a
   * lifetime of our own.
   */
  const forgetRun = (runId) => {
    if (typeof runId !== "string" || !runId) return;
    dropRun(runId);
  };

  /**
   * The core's `AgentEventPayload`, filtered to the run's end.
   *
   * `isTerminalAgentRunEvent` in the core is `stream === "lifecycle" && (phase
   * === "end" || phase === "error")`, and this matches it exactly so the mark
   * goes at the same moment the core drops its own.
   *
   * @param {{ stream?: unknown, runId?: unknown, data?: { phase?: unknown } }} event
   */
  function onAgentEvent(event) {
    if (event?.stream !== "lifecycle") return;
    const phase = event?.data?.phase;
    if (phase !== "end" && phase !== "error") return;
    forgetRun(event.runId);
  }

  const localSources = (runId) => marksByRun.get(runId)?.sources ?? [];

  const runIdOf = (event, ctx) => {
    const runId = event?.runId ?? ctx?.runId;
    return typeof runId === "string" && runId ? runId : null;
  };

  /**
   * The sources the HARNESS holds for this run. Throws only if the core's own
   * accessor throws; a store that is merely shut answers `undefined`, which is
   * indistinguishable from a clean run and is exactly why the mirror above
   * exists.
   */
  const coreSources = (runId) => {
    // A store that does not offer a reader is not a store that FAILED to
    // answer: it has no copy to give, which is what an empty list means. Calling
    // through would throw, and the caller reads a throw as "this turn cannot be
    // shown to be clean" — so a core with a partial `api.runContext` would put a
    // sourceless card in front of every shell on the box, permanently and
    // silently.
    if (typeof runContext.getRunContext !== "function") return [];
    const value = runContext.getRunContext({ runId, namespace: TAINT_NAMESPACE });
    const sources = value && typeof value === "object" ? value.sources : undefined;
    return Array.isArray(sources) ? sources.filter((name) => typeof name === "string") : [];
  };

  /**
   * Records a web tool call against its run, in this gate's map and — best
   * effort — in the harness's own store.
   *
   * IT IS CALLED FROM BOTH HOOKS. `after_tool_call` is where the turn learns
   * what the page SAID, but `before_tool_call` is where it learns a read has
   * STARTED, and that is the one that matters: the model emits the read and the
   * shell in ONE assistant message, the core dispatches them together, and
   * every `before_tool_call` in a batch fires before any sibling's
   * `after_tool_call` (measured on the box: `exec:start` preceded
   * `web_fetch:result` by 17-40 ms in every run). A gate that only learned from
   * the result read an empty mark and let the shell through.
   *
   */
  const rememberWebRead = (event, ctx) => {
    const runId = runIdOf(event, ctx);
    if (!runId) {
      // Nothing to key on, so the window is the only place left to put it.
      unscopedTaintUntilMs = now() + UNSCOPED_TAINT_WINDOW_MS;
      return;
    }
    // The gate's own mark first, because it is the one every decision below
    // reads. `rememberTaint` de-duplicates and keeps the NEWEST sources, so the
    // card names what just tainted the turn rather than what tainted it first.
    rememberTaint(runId, event.toolName);
    if (!runContext) return;
    try {
      // The harness's copy, best effort — so the core clears it at run end and
      // a core whose store does answer stays in step with this gate.
      //
      // THE RETURN VALUE IS DELIBERATELY NOT READ. It is a genuine `boolean`,
      // but it reports whether the CORE took the write, and nothing this gate
      // decides depends on that any more: the mark above is already kept. The
      // previous version read it as "did the taint survive" and, because the
      // pinned core refuses the write, armed the fail-closed wording on every
      // single web read on the box while naming no source at all.
      runContext.setRunContext({ runId, namespace: TAINT_NAMESPACE, value: { sources: localSources(runId) } });
    } catch {
      // A store that throws costs the harness's copy and nothing else.
    }
  };

  /**
   * The core's `PluginHookAfterToolCallEvent`, and the tool ctx beside it.
   *
   * @param {{ toolName?: unknown, params?: unknown, result?: unknown, error?: unknown, runId?: string, toolCallId?: string, durationMs?: number }} event
   * @param {{ runId?: string, sessionKey?: string, agentId?: string }} [ctx]
   */
  function onAfterToolCall(event, ctx) {
    if (!isWebContentTool(event?.toolName)) return;
    // EVERY call of a web tool taints, a failed one included. An earlier draft
    // skipped `event.error` calls, which read well and was dead code: the
    // embedded runner sets `result` on failures too (`result: sanitizedResult,
    // error: …`), and ClawBox's own MCP errors come back as a defined
    // `{content, isError: true}` result, so the branch could not fire on any
    // path that reaches this box. It is gone rather than left as a comforting
    // no-op — and the honest reading is the safe one anyway: a refused fetch
    // still puts a status line and often a body into the turn.
    //
    // The mark is normally already there from this call's own
    // `before_tool_call`; recording it again is how a core that runs only the
    // after hook, or a web tool reached by some path with no before hook, still
    // taints. `rememberTaint` de-duplicates, so the card names it once.
    rememberWebRead(event, ctx);
  }

  /**
   * The core's `PluginHookBeforeToolCallEvent`, and the tool ctx beside it.
   *
   * @param {{ toolName?: unknown, params?: unknown, runId?: string, toolCallId?: string, derivedPaths?: readonly string[] }} event
   * @param {{ runId?: string, sessionKey?: string, agentId?: string }} [ctx]
   * @returns {{ requireApproval: ReturnType<typeof taintApprovalRequest> } | undefined}
   */
  function onBeforeToolCall(event, ctx) {
    // A WEB READ THAT HAS STARTED TAINTS THE RUN. This is the half TASK-768
    // added: when the model batches the read and the shell into one assistant
    // message the core dispatches them together, so the shell's before hook
    // runs before the read's after hook. Marking here is what puts the mark in
    // place before the sibling shell is asked about.
    //
    // The read itself is never gated — that would put a card in front of every
    // fetch on the box, which is the "fires on ordinary work" failure this
    // plugin's own ruling forbids.
    if (isWebContentTool(event?.toolName)) {
      rememberWebRead(event, ctx);
      return undefined;
    }
    if (!isDangerousTool(event?.toolName)) return undefined;

    const runId = runIdOf(event, ctx);
    // The window covers only the taints with no run to key on; the mark covers
    // the rest, and it is this gate's own, so a shut core store cannot hide it.
    let cannotProveClean = now() < unscopedTaintUntilMs;
    let sources = runId ? localSources(runId) : [];
    if (runId && runContext) {
      try {
        sources = [...new Set([...sources, ...coreSources(runId)])].slice(-MAX_SOURCES);
      } catch {
        // A store that THROWS is not a store that is merely shut: it can say
        // neither that this turn read something nor that it did not, so the
        // turn cannot be shown to be clean.
        cannotProveClean = true;
      }
    }
    if (!cannotProveClean && sources.length === 0) return undefined;

    return {
      requireApproval: taintApprovalRequest({
        pluginId: PLUGIN_ID,
        toolName: event.toolName,
        sources,
        params: event.params,
      }),
    };
  }

  return { onAfterToolCall, onBeforeToolCall, onAgentEvent };
}

/**
 * Says, once, that the run-end reclamation is not in place.
 *
 * The gate still works without it — marks fall back to the bounded map — but
 * the map then grows with the gateway, so this is the difference between a
 * known degradation and a silent one.
 */
function warnNoReclamation(why) {
  // The gateway log is the only channel a hook plugin is given, and a silent
  // loss of reclamation is exactly the failure this line exists to prevent.
  console.warn(
    `[${PLUGIN_ID}] run-end reclamation is not active (${why}); ` +
      "taint marks will be released by the size backstop instead",
  );
}

const clawboxWebTaintPlugin = {
  id: PLUGIN_ID,
  name: "ClawBox web-taint approval gate",
  description:
    "Asks the owner before a shell command runs in a turn that read a web page, a search result or an email.",
  register(api) {
    const gate = createWebTaintGate({ runContext: api?.runContext });
    api.on("after_tool_call", gate.onAfterToolCall);
    api.on("before_tool_call", gate.onBeforeToolCall, { priority: GATE_PRIORITY });
    // THE HARNESS RECLAIMS THE MARK. `registerAgentEventSubscription` is the
    // core's sanitised event feed — no `allowConversationAccess` to pay for,
    // unlike the typed `agent_end` hook, which is why it is this one — and on a
    // terminal `lifecycle` event the core clears its own per-run plugin context
    // in the very same dispatcher. Wrapped and optional because a core without
    // the surface must still get the gate: it falls back to the bounded map.
    //
    // IT SAYS SO WHEN IT CANNOT, rather than degrading quietly. The core's api
    // builder substitutes silent no-ops for handlers it did not wire, so a dead
    // feed returns `undefined` exactly like a live one; without this line the
    // only symptom of losing reclamation would be a map that grows for weeks.
    const subscribe = api?.agent?.events?.registerAgentEventSubscription;
    if (typeof subscribe !== "function") {
      warnNoReclamation("this core exposes no api.agent.events.registerAgentEventSubscription");
    } else {
      try {
        subscribe({
          id: `${PLUGIN_ID}-run-end`,
          description: "Drops this run's web-taint mark when the run ends.",
          streams: ["lifecycle"],
          handle: gate.onAgentEvent,
        });
      } catch (error) {
        // A registration the core refused costs the reclamation, not the gate.
        warnNoReclamation(`the core refused the subscription: ${String(error)}`);
      }
    }
  },
};

// The loader follows only the `default` and `module` export keys, and its one
// hard requirement is that `register` is a function — a named export would be
// ignored, so this default is the plugin's entire contract with the core.
export default clawboxWebTaintPlugin;
