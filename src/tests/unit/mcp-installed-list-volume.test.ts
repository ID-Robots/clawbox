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

/** A device with the store used: 82 bundled + 60 hub installs. */
const STOCKED = [...builtins(), ...hubInstalls(60)];

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
  it("never hands the agent a hard-sliced list and 'narrow the query'", async () => {
    serve(STOCKED);

    const out = await skills().call("skill_list", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    // capText()'s slice: mid-line, and advice this tool cannot take.
    expect(out.text).not.toContain("truncated");
    expect(out.text).not.toContain("narrow the query");
  });

  it("accounts for every installed skill — listed, or counted as not listed", async () => {
    serve(STOCKED);

    const out = await skills().call("skill_list", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    const listed = STOCKED.filter((r) => out.text.includes(r.id)).length;
    if (listed === STOCKED.length) return;
    // A shorter list is allowed, but only if the answer SAYS it is short: this
    // list is the pre-condition of skill_install and skill_uninstall, and an
    // agent that cannot tell a complete list from a cut one installs twice.
    expect(out.text).toMatch(new RegExp(`${STOCKED.length - listed}\\b.*not listed`, "i"));
  });

  it("keeps the last row whole, so the id skill_uninstall needs is never half a word", async () => {
    serve(STOCKED);

    const out = await skills().call("skill_list", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    for (const line of out.text.split("\n").slice(1)) {
      if (/not listed/i.test(line)) continue;
      // Every row line the tool emits is `<id> (<category>…)` — a sliced one
      // loses the closing bracket and, with it, the id's boundary.
      expect(line, `half a row: ${JSON.stringify(line)}`).toMatch(/^\S+ \(.*\)/);
    }
  });
});

describe("ui_list_apps — the desktop list still parses on a stocked device", () => {
  it("returns JSON the agent can read, with the same skills volume", async () => {
    serve(STOCKED, Array.from({ length: 20 }, (_, i) => `webapp-${String(i).padStart(2, "0")}`));

    const out = await desktop().call("ui_list_apps", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).not.toContain("truncated");
    // The failure this pins: capText() slices the finished JSON mid-object, so
    // the answer is not JSON at all and the agent has no app list to open from.
    const body = JSON.parse(out.text) as {
      built_in?: unknown[];
      installed_apps?: unknown[];
      agent_skills?: string[];
    };
    expect(Array.isArray(body.built_in)).toBe(true);
    expect(body.installed_apps).toHaveLength(20);
  });

  it("accounts for every skill it does not list", async () => {
    serve(STOCKED, Array.from({ length: 20 }, (_, i) => `webapp-${String(i).padStart(2, "0")}`));

    const out = await desktop().call("ui_list_apps", {});

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    const body = JSON.parse(out.text) as { agent_skills?: string[]; agent_skills_not_listed?: number };
    const listed = body.agent_skills?.length ?? 0;
    expect(listed + (body.agent_skills_not_listed ?? 0)).toBe(STOCKED.length);
  });
});
