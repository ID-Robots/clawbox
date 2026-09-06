import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TASK-741 — where this device's OpenClaw tree is, derived once.
 *
 * The same two-line rule — `CLAWBOX_OPENCLAW_HOME`, then `OPENCLAW_HOME`, then
 * `$HOME/.openclaw` — appeared three times in `src/lib/updater.ts`: in the
 * environment for an `openclaw` child, in the environment for the gateway
 * pre-start, and in the config read the plugin repairs reason over. Three
 * copies of one rule is two chances for a repair to decide about a different
 * config from the one the CLI it just ran was writing.
 *
 * A SOURCE assertion, deliberately. The three callers are private, the rule is
 * environment-derived, and what has to stay true is that there is one copy of
 * it — which is a property of the file, not of any one call. This fails the day
 * a fourth site is written by hand.
 *
 * `OPENCLAW_HOME` is read as a FALLBACK and must never be EXPORTED to a child:
 * ClawBox uses that name for the `.openclaw` directory itself, while the
 * OpenClaw CLI reads it as the ACCOUNT home and builds its tree at
 * `$OPENCLAW_HOME/.openclaw` — the 2026-09-04 defect where every `openclaw` the
 * pre-start ran wrote a second config under `~/.openclaw/.openclaw/` and
 * reported success. Both spawning callers still delete it, and that is pinned
 * here too.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UPDATER = readFileSync(path.join(REPO, "src", "lib", "updater.ts"), "utf-8");

describe("the OpenClaw tree is derived in one place", () => {
  it("has exactly one derivation of openclawHome", () => {
    const copies = UPDATER.match(/process\.env\.CLAWBOX_OPENCLAW_HOME\s*\n?\s*\|\|\s*process\.env\.OPENCLAW_HOME/g) ?? [];
    expect(copies).toHaveLength(1);
    expect(UPDATER).toContain("function openclawTreePaths()");
  });

  it("still deletes OPENCLAW_HOME from every child environment it builds", () => {
    // The helper hands back paths, not an environment, precisely so each caller
    // keeps the one it actually sets — and both callers that spawn something
    // owe this line.
    expect(UPDATER.match(/delete env\.OPENCLAW_HOME;/g) ?? []).toHaveLength(2);
  });
});
