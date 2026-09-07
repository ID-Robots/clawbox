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
//      But it does not work for this plugin on the pinned core, which is a
//      finding rather than a licence: the loader shuts `setRunContext` and
//      `getRunContext` behind ONE side-effect predicate, so the write answers
//      `false` and the read answers `undefined` together, and on the box every
//      card it produced named no source at all. So the gate also keeps the mark
//      itself, keyed by run id — see `marksByRun` below for why that cannot
//      become a TTL that outlives the turn (probe-once) or expires inside it.
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
 * This is the fail-closed path and nothing else: it is armed only when a web
 * tool call arrived that carried no run id at all, or when the mark for a run
 * had to be evicted to keep the map bounded. A clean turn never arms it, so
 * ordinary work, cron included, is untouched.
 */
const UNSCOPED_TAINT_WINDOW_MS = 5 * 60_000;

/** How many distinct source tools the mark names, so the card stays bounded. */
const MAX_SOURCES = 4;

/**
 * How many runs may hold a mark at once. A memory bound, not a policy: a
 * gateway runs for weeks, and a run id is unique per turn, so nothing here can
 * leak into another turn however long it is kept. Evicting the oldest loses a
 * taint, so an eviction arms the process-wide window — it is generous enough
 * that a real box cannot reach it.
 */
const MAX_TRACKED_RUNS = 1024;

/**
 * How long a run's mark is kept before the sweep may reclaim it.
 *
 * It is NOT a gating window — the mark is keyed by run id, and a run id belongs
 * to exactly one turn — so this only decides when the memory goes back. It is
 * far longer than any turn so that a long agent run cannot have its own mark
 * expire underneath it, which would reopen the gate mid-turn.
 */
const RUN_MARK_TTL_MS = 60 * 60_000;

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
   * THE MARK, held here: `runId` → `{ sources, expiresAt }`.
   *
   * WHY THIS EXISTS BESIDE THE HARNESS'S OWN STORE, which is the thing a
   * ClawBox plugin is supposed to use rather than reinvent. `api.runContext` IS
   * the right mechanism and it is still written and read below. But on the
   * pinned 2026.8.1 core it does not keep this plugin's mark: every approval
   * the device lane raised on the box carried the "could not be kept" wording
   * and named no source, because the write was refused and the gate had nowhere
   * else to put what it had learned.
   *
   * The refusal is ordinary rather than exotic, and the core has several ways
   * to produce it (`loader`'s side-effect predicate, a retired registry, and —
   * measured — a run already in `closedRunIds`, which `after_tool_call` can
   * reach because the core fires that hook UNAWAITED and it can land after the
   * run's terminal lifecycle event). What matters here is that the same loader
   * predicate shuts `setRunContext` and `getRunContext` together:
   *
   *     setRunContext: (patch) => …predicate… ? setPluginRunContext({…}) : false,
   *     getRunContext: (get)   => …same predicate… : void 0,
   *
   * so a refused write is not a mark that can be recovered by reading harder.
   * The gate therefore keeps the mark itself and MIRRORS it into
   * `api.runContext`: the card can name what tainted the turn on the core we
   * actually ship, the harness still clears its own copy at run end, and the
   * day that store answers for a hook plugin this map is a redundant cache
   * rather than a design to unwind.
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

  const sweep = () => {
    for (const [key, mark] of marksByRun) if (mark.expiresAt <= now()) marksByRun.delete(key);
  };

  /** Records `toolName` against `runId`, newest kept, oldest evicted. */
  const rememberTaint = (runId, toolName) => {
    sweep();
    const sources = marksByRun.get(runId)?.sources ?? [];
    const next = sources.includes(toolName) ? sources : [...sources, toolName].slice(-MAX_SOURCES);
    // Delete before set so insertion order stays recency order and the eviction
    // below drops the run that has been quiet longest.
    marksByRun.delete(runId);
    marksByRun.set(runId, { sources: next, expiresAt: now() + RUN_MARK_TTL_MS });
    while (marksByRun.size > MAX_TRACKED_RUNS) {
      const oldest = marksByRun.keys().next().value;
      if (oldest === undefined) break;
      marksByRun.delete(oldest);
      // An evicted mark is a taint this gate can no longer prove, so it falls
      // back to the window rather than forgetting it.
      unscopedTaintUntilMs = now() + UNSCOPED_TAINT_WINDOW_MS;
    }
  };

  const localSources = (runId) => {
    const mark = marksByRun.get(runId);
    if (!mark) return [];
    if (mark.expiresAt > now()) return mark.sources;
    marksByRun.delete(runId);
    return [];
  };

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

  return { onAfterToolCall, onBeforeToolCall };
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
  },
};

// The loader follows only the `default` and `module` export keys, and its one
// hard requirement is that `register` is a function — a named export would be
// ignored, so this default is the plugin's entire contract with the core.
export default clawboxWebTaintPlugin;
