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

/**
 * Whether a built-in app id exists on this harness at all.
 *
 * `null` is "which harness this is could not be determined" — an unreadable
 * edition lock, a `dual` box whose device did not answer — and it hides BOTH
 * harness-only sets, exactly as the desktop does while its own fetch is in
 * flight. There is no smaller-of-the-two to fail closed onto here: the two app
 * sets are different, not nested, so picking one would BOTH hide apps the box
 * has and offer apps it does not.
 */
export function appExistsOnEdition(id: string, edition: AppEdition | null): boolean {
  return !hiddenFor(edition).includes(id);
}

/**
 * Should an app the user INSTALLED still be shown on this harness?
 *
 * An `installed` app is normally an OpenClaw skill: its window calls
 * /setup-api/apps/settings + /apps/skill-info, both of which shell out to the
 * openclaw binary, and its uninstall reloads the OpenClaw gateway. None of that
 * exists on a Hermes device, so the window would open onto errors. A WEBAPP
 * (`webappUrl`) is different: harness-independent, served by
 * /setup-api/webapps, and frequently the Hermes agent's OWN output.
 *
 * Takes the meta ROW rather than the id, because "is it a webapp" is the whole
 * question and only the row knows. Lives here, beside the built-in gate, so the
 * desktop grid and the two agent-facing gates (`ui_open_app`, `clawbox app
 * open`) cannot answer it differently — the drift this module exists to end.
 *
 * `null` (the harness is not resolved yet, or could not be) keeps them VISIBLE,
 * unlike the built-in harness apps: they are the majority case on an OpenClaw
 * box, and hiding then re-showing them would flash the whole desktop on every
 * load.
 */
export function isInstalledAppVisible(
  meta: { webappUrl?: unknown } | undefined,
  harness: string | null,
): boolean {
  return harness !== "hermes" || !!meta?.webappUrl;
}
