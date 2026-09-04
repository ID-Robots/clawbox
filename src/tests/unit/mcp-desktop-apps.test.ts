import { describe, expect, it } from "vitest";

import { builtInApps } from "../../../mcp/lib/context";
import {
  hiddenAppIdsForHarness,
  HERMES_ONLY_APP_IDS,
  OPENCLAW_ONLY_APP_IDS,
} from "@/lib/desktop-app-editions";
import { apps } from "@/lib/desktop-apps";

/**
 * TASK-541 — `ui_open_app` / `ui_list_apps` denied four apps the desktop shows.
 *
 * `mcp/lib/context.ts` kept its own hand-written copy of the built-in app list,
 * and it had drifted from the desktop registry (`src/lib/desktop-apps.ts`):
 * `clawbox` (the chat app), `clawkeep`, `system_update` and — on Hermes — the
 * `hermes` dashboard itself were missing. `mcp/tools/desktop.ts` gates
 * `ui_open_app` on exactly that list, so the agent was told its own dashboard
 * "does not exist on this ClawBox" while `src/app/page.tsx` pins it on the
 * shelf and opens it happily.
 *
 * The property pinned here is the one that makes the bug unrepeatable: the two
 * surfaces read the SAME registry and the SAME edition gate.
 */

function idsFor(edition: "openclaw" | "hermes"): string[] {
  return builtInApps(edition).map((a) => a.id);
}

describe("MCP built-in apps match the desktop registry", () => {
  it("offers the Hermes dashboard, chat, ClawKeep and System Update on Hermes", () => {
    const ids = idsFor("hermes");
    for (const id of ["hermes", "clawbox", "clawkeep", "system_update"]) {
      expect(ids, `ui_open_app must accept "${id}" on Hermes`).toContain(id);
    }
  });

  it("offers chat, ClawKeep and System Update on OpenClaw", () => {
    const ids = idsFor("openclaw");
    for (const id of ["clawbox", "clawkeep", "system_update"]) {
      expect(ids, `ui_open_app must accept "${id}" on OpenClaw`).toContain(id);
    }
  });

  it("hides only the other harness's apps", () => {
    expect(idsFor("hermes")).not.toContain("openclaw");
    expect(idsFor("hermes")).not.toContain("store");
    expect(idsFor("hermes")).not.toContain("memory-shard");
    expect(idsFor("openclaw")).not.toContain("hermes");
    expect(idsFor("openclaw")).not.toContain("hermes-skills");
  });

  it("lists exactly the desktop registry, edition-gated, in registry order", () => {
    const registry = apps.map((a) => a.id);
    const hermesOnly: readonly string[] = HERMES_ONLY_APP_IDS;
    const openclawOnly: readonly string[] = OPENCLAW_ONLY_APP_IDS;
    expect(idsFor("hermes")).toEqual(registry.filter((id) => !openclawOnly.includes(id)));
    expect(idsFor("openclaw")).toEqual(registry.filter((id) => !hermesOnly.includes(id)));
  });

  it("gives every app a name and a description for the agent", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      for (const app of builtInApps(edition)) {
        expect(app.name, `${app.id} name`).toBeTruthy();
        expect(app.description, `${app.id} description`).toBeTruthy();
      }
    }
  });
});

describe("the edition gate has one copy", () => {
  it("hides the other harness's apps, and both sets while the harness is unknown", () => {
    expect(hiddenAppIdsForHarness("hermes")).toEqual([...OPENCLAW_ONLY_APP_IDS]);
    expect(hiddenAppIdsForHarness("openclaw")).toEqual([...HERMES_ONLY_APP_IDS]);
    // null (still fetching) and "dual" both fail closed, as the desktop did
    // before the lists moved out of src/app/page.tsx.
    for (const harness of [null, "dual"]) {
      expect(hiddenAppIdsForHarness(harness)).toEqual([
        ...OPENCLAW_ONLY_APP_IDS,
        ...HERMES_ONLY_APP_IDS,
      ]);
    }
  });

  it("names only ids the desktop registry actually declares", () => {
    const registry = apps.map((a) => a.id);
    for (const id of [...OPENCLAW_ONLY_APP_IDS, ...HERMES_ONLY_APP_IDS]) {
      expect(registry, `${id} is gated but not declared`).toContain(id);
    }
  });
});
