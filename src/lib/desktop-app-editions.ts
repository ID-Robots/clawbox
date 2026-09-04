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

/** The harness whose app set applies. `dual` resolves to `openclaw`. */
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

/**
 * Built-in ids to hide for a harness that is not resolved yet.
 *
 * `null` — the harness is still being fetched — hides BOTH sets: showing an app
 * and then taking it away is the surface flash the desktop is built to avoid,
 * and a wrong app is worse than a late one.
 */
export function hiddenAppIdsForHarness(harness: string | null): string[] {
  if (harness === "hermes") return [...OPENCLAW_ONLY_APP_IDS];
  if (harness === "openclaw") return [...HERMES_ONLY_APP_IDS];
  return [...OPENCLAW_ONLY_APP_IDS, ...HERMES_ONLY_APP_IDS];
}

/** Whether a built-in app id exists on this edition at all. */
export function appExistsOnEdition(id: string, edition: AppEdition): boolean {
  const hidden: readonly string[] =
    edition === "hermes" ? OPENCLAW_ONLY_APP_IDS : HERMES_ONLY_APP_IDS;
  return !hidden.includes(id);
}
