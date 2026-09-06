import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TASK-603 — the plugin refresh inside `step_openclaw_install` records consent.
 *
 * OpenClaw 2 refuses to install a managed plugin whose declared capability
 * surface has not been consented to (`resolvePluginArtifactCapabilityConsent`
 * in the pinned core's `dist/capability-consent-*.js`), and a spawned,
 * non-interactive CLI has no consent callback to answer with — so without
 * `--accept-capabilities` the install cannot succeed at all. The gateway then
 * refuses readiness with `Plugin "<id>" requires capability consent` for as
 * long as the config says to load it.
 *
 * That loop (`install.sh`, inside `step_openclaw_install`) reinstalls every
 * external plugin the box already has against the new core target, which is
 * exactly the moment a declared surface changes. Its failure branch is a WARN,
 * so the refusal was invisible and the box came up without a gateway.
 *
 * Two things have to stay true of it, and they pull in opposite directions:
 * the flag must be passed for the plugins ClawBox installs, and must NOT be
 * passed for a plugin the owner installed himself — consenting to a widened
 * surface in his name is the thing the whitelist in `src/lib/updater.ts`
 * exists to prevent. It is also gated on the installed generation, because a
 * v1 pin rejects the option and would fail every refresh behind that WARN.
 *
 * Source assertions rather than a run: this loop reaches the network and the
 * plugin registry, and what has to be true of it is its argv.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const LINES = INSTALL_SH.split("\n");

/** Lines that actually run a CLI verb, comments excluded. */
function callsTo(verb: string): string[] {
  return LINES.filter(
    (line) => !line.trimStart().startsWith("#") && new RegExp(`\\bplugins ${verb}\\b`).test(line),
  );
}

describe("install.sh plugin refresh", () => {
  it("passes the consent argv it built, rather than a hard-coded flag", () => {
    const installs = callsTo("install");
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain('"${CAP_ARGS[@]}"');
  });

  it("builds that argv only on OpenClaw 2", () => {
    // A v1 pin (OPENCLAW_PIN_VERSION is a documented rollback override) gives a
    // CLI that rejects the unknown option — every iteration would then fail
    // behind the swallowed WARN with no plugin refreshed at all.
    const built = LINES.findIndex((l) => l.includes("CAP_ARGS=(--accept-capabilities)"));
    expect(built).toBeGreaterThan(-1);
    expect(LINES[built]).toContain("openclaw_is_v2");
  });

  it("builds it only for the plugins ClawBox installs", () => {
    // The same whitelist as CLAWBOX_MANAGED_PLUGIN_IDS in src/lib/updater.ts.
    // The flag consents to the NEW surface, so passing it for a plugin the
    // owner installed himself answers a widened-capabilities question in his
    // name — which is exactly what that whitelist exists to prevent.
    const built = LINES.findIndex((l) => l.includes("CAP_ARGS=(--accept-capabilities)"));
    const guard = LINES[built - 1];
    expect(guard).toContain("codex|deepseek|discord|whatsapp|clawbox-email-directives)");
  });

  it("matches the whitelist on the NORMALISED plugin id", () => {
    // `plugins list --json` can key the Discord plugin as `openclaw-discord` or
    // `@openclaw/discord`. The raw name would fall through the case to the
    // default arm and be refreshed without consent — silently, behind the WARN
    // — while `$spec` still has to carry the raw name for the CLI.
    const built = LINES.findIndex((l) => l.includes("CAP_ARGS=(--accept-capabilities)"));
    // The whole loop body, not a fixed window above the guard: `PLUGIN_KEY` is
    // hoisted to the top of the iteration because the pin repair reads it too,
    // so a window would only pin where the assignment happens to sit today.
    const loopStart = LINES.findIndex((l) => l.includes("read -r plugin pkg; do"));
    expect(loopStart).toBeGreaterThanOrEqual(0);
    expect(loopStart).toBeLessThan(built);
    const region = LINES.slice(loopStart, built).join("\n");
    expect(region).toContain("${plugin#@openclaw/}");
    expect(region).toContain("${PLUGIN_KEY#openclaw-}");
    // Still adjacent to the guard: the whitelist is matched on the normalised
    // id, never on the raw one.
    expect(LINES[built - 2]).toContain('case "$PLUGIN_KEY" in');
  });

  it("never refreshes a ClawBox plugin at @latest because its payload is gone", () => {
    // TASK-602. A core upgrade re-keys the npm project directories, so
    // `plugins list --json` lists the orphaned plugin with no rootDir/source;
    // the package derivation above then yields "" and `$spec` stays the BARE
    // id, which npm resolves as @latest — on the very boxes this refresh
    // exists for. The pin has to be rebuilt from the id for the @openclaw
    // packages ClawBox installs, and left alone for anyone else's plugin.
    const loopStart = LINES.findIndex((l) => l.includes("read -r plugin pkg; do"));
    const install = LINES.findIndex(
      (l, i) => i > loopStart && l.includes('plugins install "$spec" --force'),
    );
    expect(loopStart).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(loopStart);
    const region = LINES.slice(loopStart, install).join("\n");
    expect(region).toContain('if [ "$spec" = "$plugin" ] && [ -n "$TARGET" ]; then');
    expect(region).toContain('codex|discord|whatsapp) spec="@openclaw/$PLUGIN_KEY@$TARGET" ;;');
  });

  it("has no `plugins install` or `plugins enable` that skips consent entirely", () => {
    // The invariant this PR is about: every ClawBox-driven use of either verb
    // either carries the flag or carries the argv that may hold it. install.sh
    // has no `plugins enable` today, which is when a guard is cheapest to add.
    const offenders = [...callsTo("install"), ...callsTo("enable")].filter(
      (line) => !line.includes("--accept-capabilities") && !line.includes("CAP_ARGS"),
    );
    expect(offenders).toEqual([]);
  });
});
