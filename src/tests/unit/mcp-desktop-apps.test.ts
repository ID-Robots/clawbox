import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

// Registration and the ui_open_app handler are what this file exercises; the
// device calls behind them (the KV write, the installed-apps read) are stubbed.
vi.mock("../../../mcp/lib/api", () => ({
  apiGet,
  apiPost,
  apiTry: async () => null,
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

import { builtInApps, type McpContext } from "../../../mcp/lib/context";
import { INSTALLED_APP_ID_RE } from "../../../mcp/lib/schema";
import { APP_ID_RE } from "@/lib/code-projects";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerDesktopTools } from "../../../mcp/tools/desktop";
import { UNKNOWN_HARNESS_NOTE } from "../../../mcp/lib/context";
import {
  HARNESS_ONLY_APP_IDS,
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

const ctx = (edition: "openclaw" | "hermes"): McpContext => ({
  edition,
  install: edition,
  appHarness: edition,
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: [],
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: false,
});

beforeEach(() => {
  apiPost.mockResolvedValue({});
  apiGet.mockResolvedValue({ installed_apps: [] });
});

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

  it("marks exactly the apps the desktop opens in a browser tab", () => {
    // `external` decides whether ui_open_app claims the window appeared, so it
    // has to follow the registry rather than a second opinion.
    const externalInRegistry = apps.filter((a) => a.type === "external").map((a) => a.id).sort();
    const externalInMcp = [
      ...new Set(
        (["openclaw", "hermes"] as const).flatMap((edition) =>
          builtInApps(edition).filter((a) => a.external).map((a) => a.id),
        ),
      ),
    ].sort();
    expect(externalInMcp).toEqual(externalInRegistry);
  });
});

describe("ui_open_app accepts every id it advertises", () => {
  // The bug this closes: `system_update` was advertised in the tool's own
  // description and in ui_list_apps, then refused by an id validator that
  // allowed no underscore — with a remedy naming the id that had just failed.
  for (const edition of ["openclaw", "hermes"] as const) {
    it(`opens each built-in on ${edition} instead of rejecting the id`, async () => {
      const h = captureRegistrar(edition);
      registerDesktopTools(h.reg, ctx(edition));
      for (const app of builtInApps(edition)) {
        const outcome = await h.call("ui_open_app", { app_id: app.id });
        expect(outcome.isError, `${app.id}: ${JSON.stringify(outcome)}`).toBe(false);
      }
    });
  }

  it("still refuses an id no app claims, and a malformed installed id", async () => {
    const h = captureRegistrar("hermes");
    registerDesktopTools(h.reg, ctx("hermes"));

    const unknown = await h.call("ui_open_app", { app_id: "not-an-app" });
    expect(unknown.isError).toBe(true);
    if (unknown.isError) expect(unknown.error.code).toBe("NOT_FOUND");

    // The other harness's app is still hidden, not merely unlisted.
    const otherHarness = await h.call("ui_open_app", { app_id: "store" });
    expect(otherHarness.isError).toBe(true);
    if (otherHarness.isError) expect(otherHarness.error.code).toBe("NOT_FOUND");

    const malformed = await h.call("ui_open_app", { app_id: "installed-../etc" });
    expect(malformed.isError).toBe(true);
    if (malformed.isError) expect(malformed.error.code).toBe("BAD_ARGUMENT");
  });

  it("accepts every installed id the device is able to create", async () => {
    // The producers' alphabet is wider than `zSlug`'s: `APP_ID_RE` and the
    // store's SLUG both take upper case and underscores, so a webapp called
    // `Foo_Bar` exists on boxes today. Refusing it would be the tool calling an
    // id the device itself minted invalid.
    for (const id of ["Foo_Bar", "weather", "a", "A1_b-c", "_drafts", "x".repeat(64)]) {
      expect(APP_ID_RE.test(id), `${id} must be creatable`).toBe(true);
      expect(INSTALLED_APP_ID_RE.test(`installed-${id}`), `${id} must be openable`).toBe(true);
    }
    // …and no wider: nothing that could become a path or a second field.
    for (const id of ["../etc", "a/b", "a b", "a.b", "", "-lead"]) {
      expect(INSTALLED_APP_ID_RE.test(`installed-${id}`), `${id} must be refused`).toBe(false);
    }
  });

  it("lets an id it can OPEN also be REMOVED", async () => {
    // Widening what can be listed and opened without widening what can be
    // removed leaves the owner with an app the agent created, shows and opens
    // and cannot delete — `app_uninstall`'s own membership check is
    // deliberately unfiltered so that removal always works, and a narrower
    // schema in front of it refuses the call before the handler ever runs.
    const h = captureRegistrar("hermes");
    registerDesktopTools(h.reg, ctx("hermes"));
    const appId = h.get("app_uninstall").shape.app_id;
    for (const id of ["Foo_Bar", "weather", "A1_b-c", "_drafts"]) {
      expect(appId.safeParse(id).success, `${id} must be removable`).toBe(true);
      // The same alphabet on both surfaces, stated as the invariant rather than
      // as two lists that happen to agree today.
      expect(INSTALLED_APP_ID_RE.test(`installed-${id}`), `${id} must be openable`).toBe(true);
    }
    // Still a closed alphabet: the value reaches /setup-api/apps/uninstall.
    for (const id of ["../etc", "a/b", "a b", "a.b", "", "-lead", "x".repeat(65)]) {
      expect(appId.safeParse(id).success, `${id} must be refused`).toBe(false);
    }
  });

  it("lets an id it can LIST also be UPDATED, BUILT and DELETED", async () => {
    // The same rule one family over. `APP_ID_RE` (src/lib/code-projects.ts) is
    // what /setup-api/code and /setup-api/webapps enforce, and it takes upper
    // case and underscores — so `clawbox code init Weather_App` succeeds and
    // `code_project_list` reports that id "with the id each one is built and
    // deleted by", while a narrower schema refused the build and the delete
    // before the handler ran. An id the device mints and the tools list must be
    // an id the tools can act on.
    const h = captureRegistrar("openclaw");
    registerDesktopTools(h.reg, ctx("openclaw"));
    const actOn: Array<[string, string]> = [
      ["webapp_update", "app_id"],
      ["code_project_build", "project_id"],
      ["code_project_delete", "project_id"],
    ];
    for (const [tool, field] of actOn) {
      const schema = h.get(tool).shape[field];
      for (const id of ["Weather_App", "Foo_Bar", "weather", "_drafts"]) {
        expect(APP_ID_RE.test(id), `${id} must be creatable`).toBe(true);
        expect(schema.safeParse(id).success, `${tool} must accept ${id}`).toBe(true);
      }
      for (const id of ["../etc", "a/b", "a b", "a.b", "", "-lead", "x".repeat(65)]) {
        expect(schema.safeParse(id).success, `${tool} must refuse ${id}`).toBe(false);
      }
    }
  });
});

describe("an installed app the desktop would not open", () => {
  it("is refused on Hermes when it is a store skill, and opened when it is a web app", async () => {
    // The desktop drops a store-installed OpenClaw skill on Hermes — its window
    // shells out to the openclaw binary — so answering "Opened <name>" for one
    // is a tick over a window that never appears. Both gates read the rule from
    // src/lib/desktop-app-editions.ts.
    apiGet.mockResolvedValue({
      installed_apps: ["weather-skill", "notes"],
      installed_meta: { notes: { webappUrl: "/setup-api/webapps?app=notes" } },
    });
    const h = captureRegistrar("hermes");
    registerDesktopTools(h.reg, ctx("hermes"));

    const skill = await h.call("ui_open_app", { app_id: "installed-weather-skill" });
    expect(skill.isError).toBe(true);
    if (skill.isError) expect(skill.error.code).toBe("NOT_FOUND");

    const webapp = await h.call("ui_open_app", { app_id: "installed-notes" });
    expect(webapp.isError, JSON.stringify(webapp)).toBe(false);

    // …and it is still the owner's to REMOVE, on either harness.
    const removed = await h.call("app_uninstall", { app_id: "weather-skill", confirm: true });
    expect(removed.isError, JSON.stringify(removed)).toBe(false);
  });
});

describe("when the harness could not be determined", () => {
  // The MCP resolves its TOOL SET closed onto hermes when the edition lock is
  // unreadable, because those two answers are nested — hermes is openclaw
  // without the shell and file tools. The APP sets are not nested, so the same
  // answer would refuse `store` on a box that has it and tick off `hermes` on
  // a box that does not. `appHarness: null` is the third answer.
  const unknown: McpContext = { ...ctx("hermes"), appHarness: null };

  it("advertises and opens only what both harnesses have", async () => {
    const h = captureRegistrar("hermes");
    registerDesktopTools(h.reg, unknown);
    for (const id of HARNESS_ONLY_APP_IDS) {
      const outcome = await h.call("ui_open_app", { app_id: id });
      expect(outcome.isError, `${id} must not be opened on an undetermined harness`).toBe(true);
    }
    const shared = await h.call("ui_open_app", { app_id: "settings" });
    expect(shared.isError).toBe(false);
  });

  it("says the harness is UNDETERMINED, not that the app does not exist", async () => {
    // The CLI has always drawn this distinction, and its own comment says why:
    // "an app the OTHER harness owns is 'not here'; the same app while the
    // harness is unknown is 'could not be placed'. Saying the first over the
    // second tells the agent as a durable fact that a dual box has no
    // dashboard, which is how it stops asking." The tool said the first.
    const h = captureRegistrar("hermes");
    registerDesktopTools(h.reg, unknown);
    for (const id of HARNESS_ONLY_APP_IDS) {
      const outcome = await h.call("ui_open_app", { app_id: id });
      expect(outcome.isError).toBe(true);
      if (!outcome.isError) continue;
      const said = `${outcome.error.message} ${outcome.error.next ?? ""}`;
      expect(said, `${id} must not be reported as non-existent`)
        .not.toMatch(/no such app/i);
      expect(said, `${id} must name the undetermined harness`).toContain(UNKNOWN_HARNESS_NOTE);
    }
    // An id that exists on NEITHER harness is still an honest "no such app".
    const nonsense = await h.call("ui_open_app", { app_id: "nope" });
    expect(nonsense.isError).toBe(true);
    if (nonsense.isError) expect(nonsense.error.message).toMatch(/no such app/i);
  });

  it("says so in ui_list_apps too, rather than silently dropping five apps", async () => {
    const h = captureRegistrar("hermes");
    registerDesktopTools(h.reg, unknown);
    const outcome = await h.call("ui_list_apps");
    expect(outcome.isError).toBe(false);
    if (outcome.isError) return;
    expect(outcome.text).toContain(UNKNOWN_HARNESS_NOTE);
  });

  it("does not name an app in its own description that it would refuse", async () => {
    const h = captureRegistrar("hermes");
    registerDesktopTools(h.reg, unknown);
    const described = h.tools.get("ui_open_app")?.description ?? "";
    for (const id of HARNESS_ONLY_APP_IDS) expect(described).not.toContain(id);
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
    for (const id of HARNESS_ONLY_APP_IDS) {
      expect(registry, `${id} is gated but not declared`).toContain(id);
    }
  });

  it("joins the two lists into the set the standalone window waits on", () => {
    expect([...HARNESS_ONLY_APP_IDS]).toEqual([
      ...OPENCLAW_ONLY_APP_IDS,
      ...HERMES_ONLY_APP_IDS,
    ]);
  });
});
