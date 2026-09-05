import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-666 — the two agent-facing "what is on this device" lists against the
 * volume a stocked device actually reaches.
 *
 * Both `skill_list` and `ui_list_apps` carry `maxChars: 6_000`, and the cap is
 * enforced by capText(), which HARD-SLICES the finished string and appends
 * "narrow the query" — advice neither tool can take, because neither takes an
 * argument. What that costs differs per tool and both are silent:
 *
 *   skill_list   loses the tail of an alphabetically sorted list. It is the
 *                stated pre-condition of skill_install ("so you do not install
 *                something twice") and of skill_uninstall ("to get the exact
 *                name"), so a lost tail is an agent that installs a duplicate
 *                or tells the user a skill it can see on the card is not there.
 *   ui_list_apps emits JSON. A slice lands mid-object and the agent gets a
 *                parse error where the list of openable apps should be.
 *
 * #582 made every row longer without moving the cap: the lock id leads and a
 * display name that differs is spelled out (`, shows as "…"`), which is the
 * shape a HUB install has and a builtin does not. Measured against a real
 * Hermes box (90 installed rows: 82 builtin, 3 hub, 5 local — skill_list emits
 * 3,165 chars there), the headroom that shape leaves is 46 further hub
 * installs, against 89 for the pre-#582 line. The fixtures below are that
 * device, stocked from the store.
 *
 * Every volume here is chosen to CROSS the cap, not to sit under it: a fixture
 * that never fills the budget exercises none of the code that decides what to
 * drop, which is the trap the card raised against the previous 77-row test.
 */

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock("../../../mcp/lib/api", async () => {
  const { ApiError, matchRule } = await import("../../../mcp/lib/errors");
  const withRules =
    (fn: (...a: unknown[]) => unknown) =>
    async (route: string, ...rest: unknown[]) => {
      try {
        return await fn(route, ...rest);
      } catch (err) {
        const opts = (rest[rest.length - 1] ?? {}) as { rules?: Parameters<typeof matchRule>[1] };
        if (err instanceof ApiError) throw matchRule(err, opts?.rules) ?? err;
        throw err;
      }
    };
  return {
    apiGet: withRules(apiGet),
    apiPost: withRules(apiPost),
    apiTry: vi.fn(async () => null),
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

import { registerSkillTools } from "../../../mcp/tools/skills";
import { registerDesktopTools } from "../../../mcp/tools/desktop";
import type { McpContext } from "../../../mcp/lib/context";
import { captureRegistrar } from "../helpers/mcp-registrar";

const INSTALLED = "/setup-api/hermes/skills/installed";
const UNINSTALL = "/setup-api/hermes/skills/uninstall";
const PREFERENCES = "/setup-api/preferences";

interface Row {
  id: string;
  name: string;
  origin: "builtin" | "hub" | "local";
  category?: string;
  identifier?: string;
  enabled?: boolean;
  incompatible?: boolean;
}

const ctx: McpContext = {
  edition: "hermes",
  install: "hermes",
  appHarness: "hermes",
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: [],
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: true,
};

/** The 82 skills a stock Hermes device ships: lock id and card name agree. */
const builtins = (): Row[] =>
  Array.from({ length: 82 }, (_, i) => ({
    id: `bundled-skill-${String(i).padStart(2, "0")}`,
    name: `bundled-skill-${String(i).padStart(2, "0")}`,
    origin: "builtin" as const,
    category: "documents",
  }));

/**
 * Store installs in the shape #582 introduced: the ClawHub lock key is not the
 * name on the card, so every one of these rows carries the `, shows as "…"`
 * clause AND the "from the store" mark.
 */
const hubInstalls = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `publisher-skill-${String(i).padStart(2, "0")}`,
    name: `skill-${String(i).padStart(2, "0")}`,
    identifier: `publisher-skill-${String(i).padStart(2, "0")}`,
    origin: "hub" as const,
    category: "hub",
  }));

/** A device with the store used, at a volume that crosses the cap. */
const STOCKED = [...builtins(), ...hubInstalls(60)];

/**
 * Past it, so the drop branch is the one under test — and sized so the store
 * rows still fit on their own: what has to give way at this volume is the
 * built-ins, and a fixture where nothing fits could not tell the two apart.
 */
const OVERSTOCKED = [...builtins(), ...hubInstalls(90)];

function serve(rows: Row[], installedApps: string[] = []) {
  apiGet.mockImplementation(async (route: string) => {
    if (route === INSTALLED) {
      return {
        skills: rows,
        counts: {
          total: rows.length,
          builtin: rows.filter((r) => r.origin === "builtin").length,
          hub: rows.filter((r) => r.origin === "hub").length,
        },
      };
    }
    if (route === PREFERENCES) {
      // On Hermes an installed app is listed only when its meta carries a
      // webappUrl (isInstalledAppVisible), so the fixture has to supply one.
      return {
        installed_apps: installedApps,
        installed_meta: Object.fromEntries(
          installedApps.map((id) => [id, { webappUrl: `http://127.0.0.1/apps/${id}` }]),
        ),
      };
    }
    throw new Error(`unexpected GET ${route}`);
  });
}

function skills() {
  const h = captureRegistrar("hermes");
  registerSkillTools(h.reg);
  return h;
}

function desktop() {
  const h = captureRegistrar("hermes");
  registerDesktopTools(h.reg, ctx);
  return h;
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("skill_list — a stocked device still gets a usable list", () => {
  const listedIds = (out: string, rows: Row[]) =>
    rows.filter((r) => new RegExp(`^${r.id} \\(`, "m").test(out)).map((r) => r.id);

  it("never hands the agent a hard-sliced list and 'narrow the query'", async () => {
    serve(OVERSTOCKED);

    const out = await skills().call("skill_list", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    // capText()'s slice: mid-line, and advice this tool cannot take.
    expect(out.text).not.toContain("truncated");
    expect(out.text).not.toContain("narrow the query");
    expect(out.text.length).toBeLessThanOrEqual(skills().get("skill_list").opts.maxChars ?? 0);
  });

  it("keeps EVERY removable skill and drops built-ins instead", async () => {
    // What the tool exists for: "before skill_install so you do not install
    // something twice, and before skill_uninstall to get the exact name". A
    // built-in answers to neither — it cannot be removed and nothing collides
    // with it — so it is the row that gives way. Fitting the sorted list
    // front-to-back instead kept all 82 builtins and dropped the store skills.
    serve(OVERSTOCKED);

    const out = await skills().call("skill_list", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    const hub = OVERSTOCKED.filter((r) => r.origin === "hub");
    expect(listedIds(out.text, hub)).toHaveLength(hub.length);
    const bundled = OVERSTOCKED.filter((r) => r.origin === "builtin");
    expect(listedIds(out.text, bundled).length).toBeLessThan(bundled.length);
  });

  it("says how many it left out, and points at a tool that can answer for them", async () => {
    serve(OVERSTOCKED);

    const out = await skills().call("skill_list", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    const bundled = OVERSTOCKED.filter((r) => r.origin === "builtin");
    const missing = bundled.length - listedIds(out.text, bundled).length;
    expect(missing).toBeGreaterThan(0);
    expect(out.text).toContain(`${missing} built-in skills are not listed`);
    // NOT "ask about it by name": no tool queries the INSTALLED list by name,
    // which is the same dead end capText's own "narrow the query" is.
    expect(out.text).toContain("skill_search");
    expect(out.text).not.toMatch(/ask about it by name/i);
  });

  it("counts the store skills it had to drop separately, when even those do not fit", async () => {
    // The removable rows are kept in preference to the built-ins, not without
    // limit: a device with hundreds of store installs overruns the cap on those
    // alone, and the answer has to say so rather than be sliced.
    serve(hubInstalls(400));

    const out = await skills().call("skill_list", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).not.toContain("truncated");
    expect(out.text.length).toBeLessThanOrEqual(skills().get("skill_list").opts.maxChars ?? 0);
    const listed = listedIds(out.text, hubInstalls(400)).length;
    expect(listed).toBeLessThan(400);
    expect(out.text).toContain(`${400 - listed} more skills from the store or made here are not listed`);
  });

  it("keeps the last row whole, so the id skill_uninstall needs is never half a word", async () => {
    serve(OVERSTOCKED);

    const out = await skills().call("skill_list", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    for (const line of out.text.split("\n").slice(1)) {
      if (/not listed/.test(line)) continue;
      // Every row line the tool emits is `<id> (<category>…)` — a sliced one
      // loses the closing bracket and, with it, the id's boundary.
      expect(line, `half a row: ${JSON.stringify(line)}`).toMatch(/^\S+ \(.*\)/);
    }
  });

  it("lists everything, and says nothing about omissions, when it all fits", async () => {
    serve(STOCKED.slice(0, 40));

    const out = await skills().call("skill_list", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(listedIds(out.text, STOCKED.slice(0, 40))).toHaveLength(40);
    expect(out.text).not.toContain("not listed");
  });
});

describe("ui_list_apps — the desktop list still parses on a stocked device", () => {
  const apps = (n: number, width = 8) =>
    Array.from({ length: n }, (_, i) => `webapp-${String(i).padStart(width, "0")}`);

  const parsed = async (rows: Row[], installedApps: string[]) => {
    serve(rows, installedApps);
    const out = await desktop().call("ui_list_apps", {});
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) throw new Error("refused");
    expect(out.text).not.toContain("truncated");
    expect(out.text.length).toBeLessThanOrEqual(desktop().get("ui_list_apps").opts.maxChars ?? 0);
    return JSON.parse(out.text) as {
      built_in?: unknown[];
      installed_apps?: { id: string }[];
      installed_apps_not_listed?: number;
      agent_skills?: string[];
      agent_skills_not_listed?: number;
      agent_skills_unavailable?: boolean;
    };
  };

  it("returns JSON the agent can read, with the skills volume of a stocked device", async () => {
    const body = await parsed(OVERSTOCKED, apps(20));

    expect(Array.isArray(body.built_in)).toBe(true);
    expect(body.installed_apps).toHaveLength(20);
  });

  it("accounts for every skill it does not list", async () => {
    const body = await parsed(OVERSTOCKED, apps(20));

    expect((body.agent_skills?.length ?? 0) + (body.agent_skills_not_listed ?? 0)).toBe(OVERSTOCKED.length);
    expect(body.agent_skills_not_listed).toBeGreaterThan(0);
  });

  it("still parses when the APPS alone overrun the cap and there are no skills", async () => {
    // `installed_apps` is the list that grows without bound over a device's
    // life — every webapp_create, every app_install — and it is the one
    // `ui_open_app` needs. Bounding only the skills left this input sliced
    // mid-object, and on the OpenClaw edition, which carries no skills at all,
    // that was every input.
    const body = await parsed([], apps(300, 24));

    expect(Array.isArray(body.built_in)).toBe(true);
    expect((body.installed_apps?.length ?? 0) + (body.installed_apps_not_listed ?? 0)).toBe(300);
    expect(body.installed_apps_not_listed).toBeGreaterThan(0);
  });

  it("survives card names that JSON has to escape", async () => {
    // A skill's display name is third-party text out of its own SKILL.md. Every
    // `"` costs an extra character once serialised and a control character up
    // to five, so a per-row estimate off the row's own length is a guess about
    // exactly the input somebody else writes.
    const nasty: Row[] = Array.from({ length: 200 }, (_, i) => ({
      id: `publisher-skill-${String(i).padStart(3, "0")}`,
      name: `${'"'.repeat(29)}\u0007`,
      origin: "hub" as const,
      category: "hub",
    }));

    const body = await parsed(nasty, []);

    expect((body.agent_skills?.length ?? 0) + (body.agent_skills_not_listed ?? 0)).toBe(200);
  });

  it("says the skills could not be read, rather than answering an empty list", async () => {
    // A failed read used to be byte-identical to a device with no skills, so
    // the agent told the user this ClawBox had none installed.
    apiGet.mockImplementation(async (route: string) => {
      if (route === PREFERENCES) return { installed_apps: [], installed_meta: {} };
      throw new Error("the device could not list its skills");
    });

    const out = await desktop().call("ui_list_apps", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    const body = JSON.parse(out.text) as { agent_skills?: unknown; agent_skills_unavailable?: boolean };
    expect(body.agent_skills_unavailable).toBe(true);
    expect(body.agent_skills).toBeUndefined();
  });
});

describe("skill_uninstall — the answer is about what the DEVICE removed", () => {
  const HUB: Row = { id: "publisher-weather", name: "weather", identifier: "publisher-weather", origin: "hub" };

  it("reports the lock key the route says it removed, not the one read beforehand", async () => {
    // The reachable shape of the divergence, from the route's own resolver:
    // the pre-read matches the hub row whose CARD says "weather"; before the
    // POST lands the owner removes that skill from Settings, so the lock no
    // longer holds its key and `resolveUninstallKey` falls through to
    // `matchRemovableSkill`, which matches a DIFFERENT hub row by the same
    // display name. The route removes that one and says so. Judging by the
    // pre-read then checks the post-condition against a skill nobody touched.
    const OTHER: Row = { id: "martin-weather", name: "weather", origin: "hub" };
    let call = 0;
    apiGet.mockImplementation(async (route: string) => {
      if (route !== INSTALLED) throw new Error(`unexpected GET ${route}`);
      call += 1;
      return { skills: call === 1 ? [HUB, OTHER] : [] };
    });
    apiPost.mockImplementation(async (route: string) => {
      expect(route).toBe(UNINSTALL);
      return { id: OTHER.id, requested: HUB.id };
    });

    const out = await skills().call("skill_uninstall", { name: HUB.id });

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain(OTHER.id);
  });

  it("does not call a removal confirmed when the list could not be read back", async () => {
    // The route's 200 is not proof — the CLI prints its refusal and exits 0,
    // which is why this tool reads the list again. When THAT read fails the
    // answer has to say so: `after` is null, every check below it is skipped,
    // and the tool used to answer a flat "Removed the skill".
    let call = 0;
    apiGet.mockImplementation(async (route: string) => {
      if (route !== INSTALLED) throw new Error(`unexpected GET ${route}`);
      call += 1;
      if (call === 1) return { skills: [HUB] };
      throw new Error("the device could not list its skills");
    });
    apiPost.mockImplementation(async () => ({ id: HUB.id, requested: HUB.id }));

    const out = await skills().call("skill_uninstall", { name: HUB.id });

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/could not (be )?(read|check|confirm)|not confirmed|unconfirmed/i);
  });
});
