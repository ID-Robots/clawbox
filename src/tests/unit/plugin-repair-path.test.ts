import { describe, it, expect } from "vitest";
import path from "path";

import { DATA_DIR } from "@/lib/config-store";
import { pluginRepairPath } from "@/lib/plugin-repair";

// THE DRIFT GUARD for the one thing plugin-repair.ts deliberately does not
// import. It resolves its own path from the environment rather than from
// `config-store`'s `DATA_DIR`, because 114 suites mock that module with only
// the keys they use and a module-scope `path.join(DATA_DIR, …)` throws at
// import under such a mock — taking every route that transitively reaches this
// file down with it, in tests that have nothing to do with plugin repair.
//
// This suite mocks neither, so it is the one place the two derivations can be
// held to the same answer. If `CONFIG_ROOT` ever stops being
// `CLAWBOX_ROOT || cwd-in-dev || /home/clawbox/clawbox`, this fails here rather
// than by the boot script and the setup server writing two different files.
describe("plugin-repair — the marker path", () => {
  it("is the same file config-store's DATA_DIR would name", () => {
    expect(pluginRepairPath()).toBe(path.join(DATA_DIR, "plugin-repair.json"));
  });

  it("is the file scripts/gateway-pre-start.sh writes", () => {
    // `CLAWBOX_PLUGIN_REPAIR_FILE="$CLAWBOX_ROOT/data/plugin-repair.json"`.
    const root = process.env.CLAWBOX_ROOT;
    expect(root, "the suite pins CLAWBOX_ROOT to a temp dir").toBeTruthy();
    expect(pluginRepairPath()).toBe(path.join(root as string, "data", "plugin-repair.json"));
  });
});
