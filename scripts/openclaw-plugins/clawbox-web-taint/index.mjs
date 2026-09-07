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
//   1. THE TAINT SIGNAL. `after_tool_call` is the hook that carries a tool's
//      RESULT (`PluginHookAfterToolCallEvent` has `result` and `error`). It is
//      observe-only — it returns void — which is exactly right here: reading a
//      web page is not something to block, only something to remember.
//
//   2. THE TAINT STORE. `api.runContext` is the core's own per-RUN plugin
//      scratch state, namespaced per plugin and documented as "Cleared on run
//      end/error". That is what makes the mark per TURN honestly, instead of a
//      TTL of our own that would either outlive the turn (probe-once) or expire
//      inside it.
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
 * How long a taint the gate COULD NOT RECORD keeps every shell asking.
 *
 * This is the fail-closed path and nothing else: it is armed only when a web
 * result arrived that could not be written to the run store — no run id, no
 * run-context surface, or a write the core refused. A clean turn never arms it,
 * so ordinary work, cron included, is untouched.
 */
const UNSCOPED_TAINT_WINDOW_MS = 5 * 60_000;

/** How many distinct source tools the mark names, so the card stays bounded. */
const MAX_SOURCES = 4;

/**
 * How many runs may hold an unrecordable taint before the gate stops tracking
 * them one by one and falls back to the process-wide window. A bound, not a
 * policy: it keeps a gateway that has lost its run store from growing a map,
 * and it fails in the safe direction.
 */
const MAX_UNRECORDED_RUNS = 64;

/** Lower than the path guard's default 0, so its silent deny is answered first. */
const GATE_PRIORITY = -10;

/**
 * The core's per-run plugin scratch state, as this file uses it. Named so the
 * unit test's stand-in and the boot self-test's are checked against the same
 * three methods the pinned core exposes on `api.runContext`.
 *
 * @typedef {object} WebTaintRunStore
 * @property {(patch: { runId: string, namespace: string, value?: unknown }) => boolean} setRunContext
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
   * Taints the harness would not keep, held here instead: `runId` → when this
   * gate may stop assuming it. Bounded, and swept on every write, because a
   * gateway runs for weeks.
   */
  const unrecordedTaintRuns = new Map();

  /**
   * The same thing for a turn that carried NO run identity at all — the only
   * case where there is nothing to key on, so the window has to be
   * process-wide. It is armed by a web read and by nothing else, so a box that
   * never reads the web never sees it.
   */
  let unscopedTaintUntilMs = 0;

  const rememberUnrecordedTaint = (runId) => {
    const until = now() + UNSCOPED_TAINT_WINDOW_MS;
    for (const [key, expires] of unrecordedTaintRuns) if (expires <= now()) unrecordedTaintRuns.delete(key);
    if (unrecordedTaintRuns.size >= MAX_UNRECORDED_RUNS) unscopedTaintUntilMs = until;
    else unrecordedTaintRuns.set(runId, until);
  };

  const hasUnrecordedTaint = (runId) => {
    if (now() < unscopedTaintUntilMs) return true;
    const until = unrecordedTaintRuns.get(runId);
    if (until === undefined) return false;
    if (until > now()) return true;
    unrecordedTaintRuns.delete(runId);
    return false;
  };

  const runIdOf = (event, ctx) => {
    const runId = event?.runId ?? ctx?.runId;
    return typeof runId === "string" && runId ? runId : null;
  };

  const readSources = (runId) => {
    const value = runContext.getRunContext({ runId, namespace: TAINT_NAMESPACE });
    const sources = value && typeof value === "object" ? value.sources : undefined;
    return Array.isArray(sources) ? sources.filter((name) => typeof name === "string") : [];
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
    const runId = runIdOf(event, ctx);
    if (!runId || !runContext) {
      unscopedTaintUntilMs = now() + UNSCOPED_TAINT_WINDOW_MS;
      return;
    }
    let wrote = false;
    try {
      const sources = readSources(runId);
      const next = sources.includes(event.toolName) ? sources : [...sources, event.toolName].slice(0, MAX_SOURCES);
      wrote = runContext.setRunContext({ runId, namespace: TAINT_NAMESPACE, value: { sources: next } }) === true;
    } catch {
      wrote = false;
    }
    // A write the core refused is a taint we cannot hand to the harness, so it
    // is kept HERE — against this run, not against the whole process. The core
    // refuses for ordinary reasons (a run already closed, a plugin whose global
    // side effects are inactive), and one aborted run must not make every other
    // session and every cron ask for five minutes.
    if (wrote) unrecordedTaintRuns.delete(runId);
    else rememberUnrecordedTaint(runId);
  }

  /**
   * The core's `PluginHookBeforeToolCallEvent`, and the tool ctx beside it.
   *
   * @param {{ toolName?: unknown, params?: unknown, runId?: string, toolCallId?: string, derivedPaths?: readonly string[] }} event
   * @param {{ runId?: string, sessionKey?: string, agentId?: string }} [ctx]
   * @returns {{ requireApproval: ReturnType<typeof taintApprovalRequest> } | undefined}
   */
  function onBeforeToolCall(event, ctx) {
    if (!isDangerousTool(event?.toolName)) return undefined;

    const runId = runIdOf(event, ctx);
    let sources = [];
    // A taint this gate could not record is still a taint; until its window
    // lapses, this run cannot be shown to be clean.
    let cannotProveClean = hasUnrecordedTaint(runId);
    if (runId && runContext) {
      try {
        sources = readSources(runId);
      } catch {
        // The store is the only thing that can say this turn is clean. It
        // cannot, so the turn is not clean.
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
