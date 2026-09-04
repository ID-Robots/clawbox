// Which built-in desktop apps exist on which harness — and nothing else.
//
// This used to be copied into three places: the desktop grid (src/app/page.tsx),
// the standalone `/app/<id>` window (src/app/app/[id]/page.tsx) and the MCP
// server's own app list (mcp/lib/context.ts). The MCP copy had drifted: it
// listed neither the Hermes dashboard nor chat, ClawKeep or System Update, so
// `ui_open_app("hermes")` told the agent its own dashboard does not exist on a
// box whose desktop pins it (TASK-541).
//
// Deliberately dependency-free. mcp/tsconfig.json admits only src/lib modules
// whose import graph is relative paths and node builtins — the `@/` alias, and
// anything React, would drag the Next.js runtime into that stdio process.

/**
 * A RESOLVED harness: the premium `dual` install has already become
 * `openclaw` by the time an edition reaches here. Not the same value as the
 * `harness` string the browser holds — see `hiddenAppIdsForHarness`.
 */
export type AppEdition = "openclaw" | "hermes";

// Apps that only make sense on ONE harness. The other harness's backend isn't
// installed, so its app would open onto errors:
//   - "openclaw" is the OpenClaw gateway Control UI.
//   - "store" is the OpenClaw App Store — it installs OpenClaw desktop apps via
//     the openclaw binary and reloads the OpenClaw gateway. On Hermes the Skills
//     app ("hermes-skills") is the equivalent surface.
//   - "memory-shard" is OpenClaw's memory index (`openclaw memory status`);
//     Hermes has no equivalent, and ClawKeep hid the same panel on that box.
//   - "hermes" / "hermes-skills" are the Hermes dashboard and skills store.
export const OPENCLAW_ONLY_APP_IDS = ["openclaw", "store", "memory-shard"] as const;
export const HERMES_ONLY_APP_IDS = ["hermes", "hermes-skills"] as const;

/** Every id that is gated on a harness at all — the two lists above, joined. */
export const HARNESS_ONLY_APP_IDS: readonly string[] = [
  ...OPENCLAW_ONLY_APP_IDS,
  ...HERMES_ONLY_APP_IDS,
];

function hiddenFor(harness: string | null): readonly string[] {
  if (harness === "hermes") return OPENCLAW_ONLY_APP_IDS;
  if (harness === "openclaw") return HERMES_ONLY_APP_IDS;
  // Fail closed. `null` is "still fetching"; anything else — `"dual"`, a value
  // from a newer release — is a harness this build cannot reason about, and a
  // wrong app is worse than a late one.
  return HARNESS_ONLY_APP_IDS;
}

/**
 * Built-in ids hidden on this harness — the whole per-harness policy, read by
 * the desktop grid, the icon layout, the launcher menu and the standalone
 * window.
 *
 * Takes the ACTIVE harness the browser resolved, which is `null` while the
 * fetch is in flight and can be any string the device reports. Both hide BOTH
 * sets.
 */
export function hiddenAppIdsForHarness(harness: string | null): string[] {
  return [...hiddenFor(harness)];
}

/** Whether a built-in app id exists on this (resolved) edition at all. */
export function appExistsOnEdition(id: string, edition: AppEdition): boolean {
  return !hiddenFor(edition).includes(id);
}
