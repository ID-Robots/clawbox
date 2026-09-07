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
// WHY IT IS NOT PART OF clawbox-path-guard. That plugin encodes the owner's
// 2026-09-04 ruling — a hard, SILENT deny on two paths, "narrower, but silent
// when it bites" — and `src/tests/unit/protected-paths.test.ts` pins that it
// never emits `requireApproval`. Two different rulings do not belong in one
// handler. They do share an ordering: this gate registers at a LOWER priority
// than the guard (higher priority runs first, default 0), so a command the
// ruling refuses outright is refused without first asking the owner a question
// whose "yes" would change nothing.
//
// THE OTHER EDITION. Hermes is not covered and cannot be from here: the tools
// this gates — `bash`, `web_fetch`, `web_search`, the browser family — are
// OpenClaw-edition only (`mcp/check-tools.ts` `OPENCLAW_ONLY`), and Hermes'
// own tool gate is `approvals.deny`, a list of fnmatch globs that blocks
// unconditionally with no "ask" outcome, while `hermes-dashboard-turn.ts`
// answers Hermes' own approval frames with `once`. Recorded as a gap in the PR
// rather than papered over with a second approval surface.

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
  /** Set when a taint could not be scoped; read as "assume tainted" until then. */
  let unscopedTaintUntilMs = 0;

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
    // A failed call that brought nothing back holds no content to distrust, and
    // tainting on it would make an offline box ask forever. A call that carries
    // BOTH an error and a result does taint: whatever came back came from
    // outside, and the safe direction here is to remember more, not less.
    if (event.error && event.result === undefined) return;

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
    if (!wrote) unscopedTaintUntilMs = now() + UNSCOPED_TAINT_WINDOW_MS;
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
    // A taint this gate could not record is still a taint; until the window
    // lapses, no turn can be shown to be clean.
    let cannotProveClean = now() < unscopedTaintUntilMs;
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
