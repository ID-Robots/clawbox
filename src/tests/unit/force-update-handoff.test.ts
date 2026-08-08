import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// force-update.sh recovers a device whose UI updater is broken, but it only
// restores the setup app — it does NOT run the full updater's gateway/OpenClaw
// steps. It must not claim the update is finished, and must point the user at
// the "Force full update" affordance (SystemUpdateApp) to complete it.
const script = readFileSync(join(process.cwd(), "scripts/force-update.sh"), "utf8");

describe("force-update.sh recovery messaging", () => {
  it("hands off to 'Force full update' instead of claiming the update is done", () => {
    expect(script).not.toContain("Done. Reload");
    expect(script).toMatch(/recovered the UI only/);
    expect(script).toContain("Force full update");
  });
});
