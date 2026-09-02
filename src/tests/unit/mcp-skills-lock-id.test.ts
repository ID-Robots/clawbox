import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-09 — a hub skill whose SKILL.md name differs from its lock key could not be
 * removed by the agent at all.
 *
 * The installed list carries two names per row: `id`, the hub lock key (what
 * `hermes skills uninstall` and the /uninstall route resolve), and `name`, the
 * display name from the skill's own SKILL.md. For most skills they are the same
 * string, which is how the difference went unnoticed. For a ClawHub skill they
 * are not: `martin-weather` installs under that lock key and shows as
 * `weather`.
 *
 * Measured on a Hermes device: skill_install said "Remove it later with
 * skill_uninstall using the name "martin-weather"", skill_uninstall of that name
 * answered NOT_FOUND (the pre-condition matched rows on `name` only), skill_list
 * printed `weather (hub)`, and skill_uninstall of THAT answered NOT_FOUND too
 * (the pre-condition matched, then POSTed `{id:"weather"}`, which is not a lock
 * key). Every name the agent could have been given was refused, so it fell back
 * to running the CLI and editing ~/.hermes files itself.
 *
 * The resolution itself belongs to the ROUTE, and is pinned in
 * routes/hermes/skills-uninstall-lock-key.test.ts. What is pinned here is the
 * agent's side: skill_list prints the lock id as the first word of every line,
 * skill_uninstall accepts the lock id or the display name and always calls the
 * route with the lock id, and a string two removable skills answer to is put
 * back to the USER rather than resolved by a coin toss.
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

import { ApiError } from "../../../mcp/lib/errors";
import { registerSkillTools } from "../../../mcp/tools/skills";
import { registerDesktopTools } from "../../../mcp/tools/desktop";
import type { McpContext } from "../../../mcp/lib/context";
import { captureRegistrar } from "../helpers/mcp-registrar";

const INSTALLED = "/setup-api/hermes/skills/installed";
const UNINSTALL = "/setup-api/hermes/skills/uninstall";

/** One row of enumerateInstalledSkills(), as the route serves it. */
interface Row {
  /**
   * The hub lock key — the only string the uninstall route resolves without
   * help. enumerateInstalledSkills() sets it on EVERY row, from the lock key or
   * from the skill's directory name — both construction paths in
   * enumerateInstalledSkills() set it.
   */
  id: string;
  /** SKILL.md's `name`, which is what the customer sees on a card. */
  name: string;
  origin: "builtin" | "hub" | "local";
  identifier?: string;
  category?: string;
}

/** The measured row: a ClawHub skill whose display name is not its lock key. */
const WEATHER: Row = {
  id: "martin-weather",
  name: "weather",
  identifier: "martin-weather",
  origin: "hub",
  category: "hub",
};
const BUILTIN: Row = { id: "pdf", name: "pdf", origin: "builtin", category: "documents" };

const ctx = (edition: "openclaw" | "hermes"): McpContext => ({
  edition,
  install: edition,
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: [],
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: true,
});

function skills() {
  const h = captureRegistrar("hermes");
  registerSkillTools(h.reg);
  return h;
}

function desktop() {
  const h = captureRegistrar("hermes");
  registerDesktopTools(h.reg, ctx("hermes"));
  return h;
}

/** Answer the installed list one round per GET; the last round repeats. */
function installedIs(...rounds: Row[][]) {
  let i = 0;
  apiGet.mockImplementation(async (route: string) => {
    if (route !== INSTALLED) throw new Error(`unexpected GET ${route}`);
    const rows = rounds[Math.min(i, rounds.length - 1)];
    i += 1;
    return { skills: rows, counts: { total: rows.length } };
  });
}

/**
 * The real route in miniature, AFTER its own resolution pass: `id` is a hub
 * lock key. A key that is a builtin's is refused as such; a key in neither
 * place is `not_installed`.
 */
function routeResolvesLockKeys(rows: Row[]) {
  apiPost.mockImplementation(async (route: string, sent: { id?: string }) => {
    expect(route).toBe(UNINSTALL);
    const row = rows.find((r) => r.id === sent.id);
    if (row?.origin === "hub") return { ok: true };
    if (row?.origin === "builtin") {
      throw new ApiError(
        409,
        JSON.stringify({ error: `"${sent.id}" is a builtin skill.`, code: "builtin_skill" }),
      );
    }
    throw new ApiError(
      404,
      JSON.stringify({
        error: `No store skill called "${sent.id}" is installed on this device.`,
        code: "not_installed",
      }),
    );
  });
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("skill_uninstall — the name skill_install handed out has to work", () => {
  it("removes a hub skill by its lock id, calling the route with that id", async () => {
    installedIs([WEATHER], []);
    routeResolvesLockKeys([WEATHER]);
    const out = await skills().call("skill_uninstall", { name: WEATHER.id });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect(apiPost).toHaveBeenCalledWith(UNINSTALL, { id: WEATHER.id }, expect.anything());
  });

  it("removes the same skill by the display name a card shows, still sending the lock id", async () => {
    installedIs([WEATHER], []);
    routeResolvesLockKeys([WEATHER]);
    const out = await skills().call("skill_uninstall", { name: WEATHER.name });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect(apiPost).toHaveBeenCalledWith(UNINSTALL, { id: WEATHER.id }, expect.anything());
    // The agent asked for "weather" and is being answered about a lock id it
    // may never have seen; say which card that is.
    if (out.isError) return;
    expect(out.text).toContain(`showed as "${WEATHER.name}"`);
  });

  it("resolves a store identifier the route resolves, so it cannot refuse what the route removes", async () => {
    // A lock entry installed under a `--name` override carries an identifier
    // that is neither its key nor any card's name. The route resolves it; the
    // tool searching only id and name answered NOT_FOUND — the F-09 shape, in
    // the one tier the tool had dropped. Both now run matchRemovableSkill().
    const alpha: Row = { id: "alpha", name: "Alpha", origin: "hub", identifier: "weather" };
    installedIs([alpha], []);
    routeResolvesLockKeys([alpha]);
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect(apiPost).toHaveBeenCalledWith(UNINSTALL, { id: "alpha" }, expect.anything());
  });

  it("trims the argument, because the validator that let it through did", async () => {
    installedIs([WEATHER], []);
    routeResolvesLockKeys([WEATHER]);
    const out = await skills().call("skill_uninstall", { name: ` ${WEATHER.name} ` });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    expect(apiPost).toHaveBeenCalledWith(UNINSTALL, { id: WEATHER.id }, expect.anything());
  });

  it("prefers the removable row over a builtin that shares the display name", async () => {
    const builtinWeather: Row = { id: "weather", name: "weather", origin: "builtin" };
    installedIs([builtinWeather, WEATHER], [builtinWeather]);
    routeResolvesLockKeys([builtinWeather, WEATHER]);
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(apiPost).toHaveBeenCalledWith(UNINSTALL, { id: WEATHER.id }, expect.anything());
    // The builtin "weather" is still listed and the agent is about to see it.
    // Unsaid, that reads as an uninstall that did not happen.
    expect(out.text).toMatch(/built-in/i);
    expect(out.text).toMatch(/not a failed removal/i);
  });

});

describe("skill_uninstall — a tie is put back to the user, never guessed", () => {
  const ambiguityNext = (next: string) => {
    // The house pattern from the dangerous-skill refusal: do not decide for the
    // user, ask them, then call again with what they said.
    expect(next).toMatch(/ask the user/i);
    expect(next).toMatch(/do not|never/i);
  };

  it("refuses a display name two removable skills share, naming both lock ids", async () => {
    const other: Row = { id: "acme-weather", name: "weather", origin: "hub", identifier: "acme-weather" };
    installedIs([WEATHER, other]);
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(apiPost).not.toHaveBeenCalled();
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.next).toContain(WEATHER.id);
    expect(out.error.next).toContain(other.id);
    ambiguityNext(out.error.next);
  });

  it("resolves, not refuses, when the string is one skill's exact lock id", async () => {
    // `weather` is the official skill's lock id AND the ClawHub skill's card
    // name. Refusing here left the official skill unremovable by ANY string:
    // the refusal offered "weather, martin-weather", `weather` looped it, and
    // `martin-weather` deleted the other skill. A lock id is a JSON object key
    // — unique by construction — so it is an answer, and it is the answer the
    // route gives for the same lock (skills-uninstall-lock-key.test.ts).
    const official: Row = { id: "weather", name: "weather", origin: "hub", identifier: "official/weather" };
    installedIs([official, WEATHER], [WEATHER]);
    routeResolvesLockKeys([official, WEATHER]);
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(apiPost).toHaveBeenCalledWith(UNINSTALL, { id: "weather" }, expect.anything());
    // The other card still says "weather"; unsaid, that reads as a failure.
    expect(out.text).toContain(WEATHER.id);
    expect(out.text).toMatch(/not a failed removal/i);
  });

  it("refuses when one skill's identifier is another's display name", async () => {
    const alpha: Row = { id: "alpha", name: "Alpha", origin: "hub", identifier: "weather" };
    installedIs([alpha, WEATHER]);
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(apiPost).not.toHaveBeenCalled();
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.next).toContain("alpha");
    expect(out.error.next).toContain(WEATHER.id);
    ambiguityNext(out.error.next);
  });

  it("relays the route's ambiguity refusal WITH the lock ids it listed", async () => {
    // This refusal only reaches the tool when /installed could not be read, so
    // "call skill_list" is advice the agent cannot act on — skill_list reads
    // that same route. The two ids were in the body it was handed.
    apiGet.mockRejectedValue(new ApiError(502, "{}"));
    apiPost.mockRejectedValue(
      new ApiError(
        409,
        JSON.stringify({
          error: 'More than one installed skill on this device answers to "weather".',
          code: "ambiguous_name",
          candidates: ["acme-weather", "martin-weather"],
        }),
      ),
    );
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.next).toContain("acme-weather");
    expect(out.error.next).toContain("martin-weather");
    expect(out.error.next).not.toMatch(/call skill_list/i);
    ambiguityNext(out.error.next);
  });

  it("falls back to the listing advice when the refusal carries no candidates", async () => {
    apiGet.mockRejectedValue(new ApiError(502, "{}"));
    apiPost.mockRejectedValue(
      new ApiError(409, JSON.stringify({ error: "ambiguous", code: "ambiguous_name" })),
    );
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.next).toMatch(/skill_list/i);
    ambiguityNext(out.error.next);
  });
});

describe("skill_uninstall — the argument the schema and the validator accept", () => {
  it("takes a lock key as long as the validator and the route allow", async () => {
    // 128 is the cap isValidSkillName() and the route enforce; a 64-char schema
    // made a key skill_install had just handed out impossible to pass back.
    const shape = skills().get("skill_uninstall").shape as unknown as {
      name: { safeParse(v: unknown): { success: boolean } };
    };
    expect(shape.name.safeParse("a".repeat(128)).success).toBe(true);
    expect(shape.name.safeParse("a".repeat(129)).success).toBe(false);
  });

  it("refuses a display name with a space, and says what to pass instead", async () => {
    // The documented ClawHub shape ("QR Code Decode") cannot be a lock key:
    // NAME_RE has no space in it, here or in the route.
    installedIs([{ id: "qrcode", name: "QR Code Decode", origin: "hub" }]);
    const out = await skills().call("skill_uninstall", { name: "QR Code Decode" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(apiPost).not.toHaveBeenCalled();
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.next).toMatch(/first word/i);
  });

  it("refuses a full store id for its slash, before any lookup", async () => {
    installedIs([WEATHER]);
    const out = await skills().call("skill_uninstall", { name: "clawhub/martin-weather" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe("skill_uninstall — the post-condition keys on the lock id as well", () => {
  it("a store row that survives under the same lock id is a failed uninstall", async () => {
    installedIs([WEATHER], [WEATHER]);
    routeResolvesLockKeys([WEATHER]);
    const out = await skills().call("skill_uninstall", { name: WEATHER.name });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/did not remove/i);
    // Named by the lock id the route was given AND by the card the agent asked
    // about — every message after the POST used to name only the former.
    expect(out.error.message).toContain(WEATHER.id);
    expect(out.error.message).toContain(`showed as "${WEATHER.name}"`);
  });

  it("the #517 half-removal (lock entry gone, directory back as local) is still caught", async () => {
    installedIs([WEATHER], [{ id: WEATHER.id, name: WEATHER.name, origin: "local" }]);
    routeResolvesLockKeys([WEATHER]);
    const out = await skills().call("skill_uninstall", { name: WEATHER.id });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/did not remove/i);
  });

  it("un-shadowing a builtin under the same lock id is reported as the success it is", async () => {
    const storePdf: Row = { id: "pdf", name: "PDF-tools", origin: "hub", identifier: "official/pdf" };
    installedIs([storePdf], [BUILTIN]);
    routeResolvesLockKeys([storePdf]);
    const out = await skills().call("skill_uninstall", { name: "pdf" });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/built-in "pdf" was underneath it/i);
  });

  it("names a DEVICE-MADE skill that still shows under the removed card's name", async () => {
    // Not the half-removal (that shares the lock id and is thrown above): a
    // separate local skill whose SKILL.md happens to say `weather`. The agent
    // is about to see that name on the next skill_list and nothing explained it.
    const localWeather: Row = { id: "my-weather", name: "weather", origin: "local" };
    installedIs([WEATHER, localWeather], [localWeather]);
    routeResolvesLockKeys([WEATHER]);
    const out = await skills().call("skill_uninstall", { name: WEATHER.id });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("my-weather");
    expect(out.text).toMatch(/not a failed removal/i);
  });
});

describe("skill_uninstall — the advice when the installed list cannot be read", () => {
  it("sends the agent to the first word of a skill_list line, not to delete a folder", async () => {
    // This branch is reached only with the list unreadable, so "it is listed,
    // therefore it was made on this device" is a claim nothing here supports —
    // and it was the advice given for a hub skill under another lock key.
    apiGet.mockRejectedValue(new ApiError(502, "{}"));
    apiPost.mockRejectedValue(
      new ApiError(
        404,
        JSON.stringify({ error: "No store skill called \"weather\".", code: "not_installed" }),
      ),
    );
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/first word/i);
  });
});

/**
 * The mixed state: the PRE-read fails, the POST and the second read succeed.
 * Every other "list could not be read" test in this file rejects ALL GETs, so
 * the tool's own reporting on this branch went untested — and it judged the
 * removal by the string the agent typed while the ROUTE had resolved it to a
 * different lock key.
 */
describe("skill_uninstall — when only the pre-read fails, the route says which skill went", () => {
  /** First GET rejects; later GETs answer `after`. POST answers as the route. */
  function blindPreRead(after: Row[], answer: Record<string, unknown>) {
    let first = true;
    apiGet.mockImplementation(async (route: string) => {
      if (route !== INSTALLED) throw new Error(`unexpected GET ${route}`);
      if (first) {
        first = false;
        throw new ApiError(502, "{}");
      }
      return { skills: after, counts: { total: after.length } };
    });
    apiPost.mockResolvedValue(answer);
  }

  const RESOLVED = { ok: true, id: WEATHER.id, name: WEATHER.id, requested: "weather" };

  it("does not call a successful removal a CONFLICT over a device-made namesake", async () => {
    // A local directory `weather` sits beside the ClawHub `martin-weather` that
    // shows as `weather`. The route removed martin-weather; keying the
    // post-condition on the raw argument found the LOCAL row under id
    // "weather", which isStoreSkill() counts, and reported a refusal.
    const localWeather: Row = { id: "weather", name: "weather", origin: "local" };
    blindPreRead([localWeather], RESOLVED);
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(apiPost).toHaveBeenCalledWith(UNINSTALL, { id: "weather" }, expect.anything());
    expect(out.text).toContain(WEATHER.id);
    expect(out.text).toContain('you asked for "weather"');
  });

  it("does not claim it removed a store skill that never existed", async () => {
    // Same shape with a BUILTIN namesake. Keyed on the argument, `unshadowed`
    // matched the builtin and the tool answered "Removed the store skill
    // weather. The device's own built-in weather was underneath it" — there was
    // no store skill called weather, and martin-weather is what went.
    const builtinWeather: Row = { id: "weather", name: "weather", origin: "builtin" };
    blindPreRead([builtinWeather], RESOLVED);
    const out = await skills().call("skill_uninstall", { name: "weather" });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain(WEATHER.id);
    expect(out.text).not.toMatch(/store skill "weather"/);
    expect(out.text).not.toMatch(/built-in "weather" was underneath/);
  });

  it("says nothing extra when the route acted on the string it was given", async () => {
    blindPreRead([], { ok: true, id: "invoices", name: "invoices", requested: "invoices" });
    const out = await skills().call("skill_uninstall", { name: "invoices" });
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).toBe('Removed the skill "invoices".');
  });
});

describe("skill_list — the first word of a line is what skill_uninstall takes", () => {
  it("prints the lock id first, and says what the skill shows as when that differs", async () => {
    installedIs([BUILTIN, WEATHER]);
    const out = await skills().call("skill_list", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const line = out.text.split("\n").find((l) => l.split(" ")[0] === WEATHER.id);
    expect(line, `no line starts with "${WEATHER.id}":\n${out.text}`).toBeDefined();
    expect(line).toContain(`"${WEATHER.name}"`);
    expect(line).toMatch(/from the store/);
  });

  it("orders the lines by the lock id it prints, not by the display name", async () => {
    // The route sorts by display name: "weather" (lock id martin-weather)
    // sorts after "pdf" there, and before it here.
    installedIs([BUILTIN, WEATHER]);
    const out = await skills().call("skill_list", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const first = out.text.split("\n").slice(1).map((l) => l.split(" ")[0]);
    expect(first).toEqual(["martin-weather", "pdf"]);
  });

  it("does not annotate a skill whose display name is its lock id", async () => {
    installedIs([BUILTIN, WEATHER]);
    const out = await skills().call("skill_list", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const line = out.text.split("\n").find((l) => l.split(" ")[0] === BUILTIN.id);
    expect(line).toBeDefined();
    expect(line).not.toMatch(/shows as/);
  });

  /**
   * The property the measured session broke: every removable name skill_list
   * prints is one skill_uninstall removes — against a route that, like the real
   * one, resolves lock keys.
   */
  it("every \"from the store\" row round-trips through skill_uninstall", async () => {
    // The fixture carries the collision the sibling test above models: an
    // official `weather` whose lock id is also WEATHER's display name. Without
    // it the property is vacuous — that is the state where skill_list offered a
    // row skill_uninstall refused.
    const rows: Row[] = [
      BUILTIN,
      WEATHER,
      { id: "weather", name: "weather", origin: "hub", identifier: "official/weather" },
      { id: "invoices", name: "invoices", origin: "hub" },
    ];
    installedIs(rows);
    const listed = await skills().call("skill_list", {});
    expect(listed.isError).toBe(false);
    if (listed.isError) return;
    const marked = listed.text
      .split("\n")
      .slice(1)
      .filter((l) => l.includes("from the store"))
      .map((l) => l.split(" ")[0]);
    expect(marked).toHaveLength(3);

    for (const name of marked) {
      apiGet.mockReset();
      apiPost.mockReset();
      installedIs(rows, rows.filter((r) => r.id !== name));
      routeResolvesLockKeys(rows);
      const out = await skills().call("skill_uninstall", { name });
      expect(out.isError, `skill_uninstall refused "${name}", which skill_list offered: ${JSON.stringify(out)}`).toBe(false);
      expect(apiPost).toHaveBeenCalledWith(UNINSTALL, { id: name }, expect.anything());
    }
  });
});

describe("ui_list_apps — the desktop's skill list agrees with skill_list", () => {
  const listApps = async (rows: Row[]) => {
    apiGet.mockImplementation(async (route: string) => {
      if (route === INSTALLED) return { skills: rows };
      return { installed_apps: [] };
    });
    return desktop().call("ui_list_apps", {});
  };

  it("reports each skill's lock id, and the name its card shows when that differs", async () => {
    const out = await listApps([WEATHER, BUILTIN]);
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    const body = JSON.parse(out.text) as { agent_skills?: string[] };
    // The lock id leads, exactly as it does in skill_list; the display name is
    // added only when it is a different string.
    expect(body.agent_skills).toEqual([`${WEATHER.id} (${WEATHER.name})`, BUILTIN.id]);
  });

  it("still parses as JSON at the volume a real device carries", async () => {
    // A stock Hermes device ships ~77 skills (mcp/tools/skills.ts, and the disk
    // walk in hermes-skills-server.ts, both say so). capText() hard-SLICES at
    // maxChars, so a list that outgrows the cap does not degrade — it stops
    // mid-object and the agent gets unparseable JSON plus "narrow the query",
    // on a tool that takes no arguments.
    const rows: Row[] = Array.from({ length: 77 }, (_, i) => ({
      id: `installed-skill-${String(i).padStart(2, "0")}`,
      name: `installed-skill-${String(i).padStart(2, "0")}`,
      origin: "hub",
    }));
    const out = await listApps(rows);
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).not.toContain("truncated");
    const body = JSON.parse(out.text) as { agent_skills?: string[] };
    expect(body.agent_skills).toHaveLength(77);
    expect(out.text.length).toBeLessThanOrEqual(desktop().get("ui_list_apps").opts.maxChars ?? 0);
  });
});
