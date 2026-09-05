// ClawBox's protected-path deny, as an OpenClaw plugin.
//
// WHAT IT IS FOR. TASK-605: an agent turn asked to "delete the largest of those
// files" ran `rm` on a 3.2 GB local-model GGUF. The owner's ruling of
// 2026-09-04 is a hard deny on the local-model folder and the ClawBox tree,
// with no confirmation prompt anywhere — "narrower, but silent when it bites".
//
// HARNESS FIRST, AND WHAT OPENCLAW ACTUALLY OWNS. OpenClaw 2026.8.1 has no
// path-scoped deny to configure. Its exec policy is allowlist-shaped end to
// end: `tools.exec.mode` is `deny|allowlist|ask|auto|full` over ALL host exec,
// and an allowlist entry is a glob over the BINARY, never over the file a
// command touches (`docs/tools/exec-approvals.md`, "Allowlist + safe bins":
// "Manual allowlist enforcement matches resolved binary path globs and bare
// command-name globs"). Tool policy is per-tool, not per-path
// (`docs/gateway/config-tools.md`). Its own advice for a hard block is
// all-or-nothing — "To hard-block host exec, set approvals security to `deny`
// or deny the `exec` tool via tool policy" — which would take the shell away
// from the agent entirely.
//
// The seam that CAN express a path is the core's own typed hook:
// `before_tool_call`, documented as "Block a tool or request approval", with
// `{ block: true, blockReason }` (`docs/plugins/hooks.md`, "Tool call policy").
// That is the same seam `clawbox-email-directives` already uses for
// `reply_payload_sending`, and this plugin is deployed the same way — copied
// out of the checkout by gateway-pre-start.sh on every boot, because
// ~/.openclaw does not survive a factory reset.
//
// The Hermes edition of this rule is `approvals.deny` in ~/.hermes/config.yaml,
// written by scripts/register-mcp.sh. Both read one table,
// config/protected-paths.json, and src/tests/unit/protected-paths.test.ts runs
// a single case table through both so they cannot drift.
//
// NO MATCHER. The registration deliberately does not narrow to a list of tool
// ids. A matcher is validated against canonical ids and rejects aliases, so a
// list is a thing that can be wrong in two directions — a tool renamed upstream
// silently stops being guarded, and an alias in the list fails the whole
// registration. `toolCallDenyReason` already answers `null` for every tool it
// does not know, which costs a Set lookup per call and cannot fall behind.

import { toolCallDenyReason, denyMessage } from "./path-guard.mjs";

/** The plugin id, which must match `openclaw.plugin.json` and the config key. */
const PLUGIN_ID = "clawbox-path-guard";

/**
 * The hook. Total by construction — every field is type-checked before it is
 * read and nothing here does I/O — because a `before_tool_call` handler that
 * throws is a guard whose behaviour is the dispatcher's business rather than
 * ours. `undefined` is "no opinion"; `block: true` is terminal and skips
 * lower-priority handlers, so this needs no priority of its own.
 */
export function onBeforeToolCall(event) {
  const reason = toolCallDenyReason(event);
  if (!reason) return undefined;
  return { block: true, blockReason: denyMessage(reason) };
}

const clawboxPathGuardPlugin = {
  id: PLUGIN_ID,
  name: "ClawBox path guard",
  description: "Refuses tool calls that delete, overwrite, truncate or move the ClawBox tree or a local-model folder.",
  register(api) {
    api.on("before_tool_call", onBeforeToolCall);
  },
};

// The loader follows only the `default` and `module` export keys, and its one
// hard requirement is that `register` is a function — a named export would be
// ignored, so this default is the plugin's entire contract with the core.
export default clawboxPathGuardPlugin;
