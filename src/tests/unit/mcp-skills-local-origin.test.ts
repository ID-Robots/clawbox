import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MCP-02a — the residual left by #513.
 *
 * A Hermes device has THREE skill origins, not two (`src/lib/hermes-skills.ts`,
 * and the two writers in `src/lib/hermes-skills-server.ts`):
 *
 *   builtin — shipped with the device (name is in .bundled_manifest)
 *   hub     — installed from the store (name is a key in the hub lock)
 *   local   — a directory on disk that is NEITHER of those
 *
 * `hermes skills uninstall` works off the HUB LOCK, so only `hub` is removable.
 * The Skills page has always said so — `HermesSkillsStore.tsx` offers Remove
 * only for `origin === 'hub'` and badges a `local` skill as unremovable — but
 * `mcp/tools/skills.ts` decided removability with `origin !== "builtin"`, which
 * puts `local` on the removable side.
 *
 * So for one device state the agent and the customer's own Skills page told two
 * different stories:
 *
 *   skill_list       marks the row "from the store", under a header saying only
 *                    such rows can be removed
 *   skill_uninstall  waves it past its own pre-condition, POSTs, and the route
 *                    answers 404 `not_installed` (not in the lock, not in
 *                    .bundled_manifest)
 *   #513's new rule  turns that into "There is no installed skill called "x" on
 *                    this device. Call skill_list and pass the name field of a
 *                    skill it actually lists. Do not retry this name."
 *
 * skill_list DOES list it. The agent is sent to the one tool that reproduces the
 * contradiction, and told not to retry. Before #513 the same state gave the
 * vaguer generic resource-404, so the fix made the false claim confident — which
 * is the anti-drift property #513 exists to guarantee, inverted.
 *
 * `local` is reachable on shipped aarch64 Hermes hardware: a directory left by a
 * failed install rollback or a partial removal (both named in the install and
 * uninstall routes' own #517/TASK-547 comments), a hand-copied skill folder, a
 * skill the agent wrote itself, and — because readHubLock() returns {} for an
 * unreadable or corrupt lock — EVERY hub skill on a box whose lock file got
 * truncated. It is reached by a plain "remove the X skill" chat request.
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
import { captureRegistrar } from "../helpers/mcp-registrar";

const INSTALLED = "/setup-api/hermes/skills/installed";
const UNINSTALL = "/setup-api/hermes/skills/uninstall";

interface Row {
  name: string;
  origin?: string;
  identifier?: string;
  category?: string;
}

/** What enumerateInstalledSkills() puts on the wire, in miniature. */
const BUILTIN: Row = { name: "pdf-builtin", origin: "builtin", category: "documents" };
const HUB: Row = { name: "invoices", origin: "hub", identifier: "official/invoices", category: "hub" };
/** A directory on disk that is in neither the lock nor the bundled manifest. */
const LOCAL: Row = { name: "scratchpad", origin: "local", category: "other" };

function skills() {
  const h = captureRegistrar("hermes");
  registerSkillTools(h.reg);
  return h;
}

/**
 * Answer the installed list with one round per GET, so a test can describe the
 * device before and after the uninstall. The last round repeats.
 */
function installedIs(...rounds: Row[][]) {
  let i = 0;
  apiGet.mockImplementation(async (route: string) => {
    if (route !== INSTALLED) throw new Error(`unexpected GET ${route}`);
    const rows = rounds[Math.min(i, rounds.length - 1)];
    i += 1;
    return { skills: rows, counts: { total: rows.length } };
  });
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

// ── skill_list must not advertise what skill_uninstall cannot do ────────────

describe("skill_list — \"from the store\" has to mean removable", () => {
  it("does not mark a local-origin skill \"from the store\"", async () => {
    installedIs([BUILTIN, HUB, LOCAL]);
    const out = await skills().call("skill_list", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const line = out.text.split("\n").find((l) => l.startsWith(LOCAL.name));
    expect(line, "skill_list dropped the local skill entirely").toBeDefined();
    expect(line).not.toMatch(/from the store/);
  });

  it("still marks a hub-installed skill \"from the store\"", async () => {
    installedIs([BUILTIN, HUB, LOCAL]);
    const out = await skills().call("skill_list", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const line = out.text.split("\n").find((l) => l.startsWith(HUB.name));
    expect(line).toMatch(/from the store/);
  });

  it("says why the local one is not removable rather than leaving it unexplained", async () => {
    installedIs([BUILTIN, HUB, LOCAL]);
    const out = await skills().call("skill_list", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    const line = out.text.split("\n").find((l) => l.startsWith(LOCAL.name));
    expect(line).toMatch(/made on this device/i);
  });
});

// ── skill_uninstall must refuse it locally, in its own words ────────────────

describe("skill_uninstall — a local skill is not a missing skill", () => {
  it("refuses a local-origin skill without ever calling the route", async () => {
    installedIs([BUILTIN, HUB, LOCAL]);
    apiPost.mockRejectedValue(new Error("skill_uninstall must not POST for a local skill"));
    const out = await skills().call("skill_uninstall", { name: LOCAL.name });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("does not claim the skill is not installed — skill_list lists it", async () => {
    installedIs([BUILTIN, HUB, LOCAL]);
    const out = await skills().call("skill_uninstall", { name: LOCAL.name });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.message).not.toMatch(/there is no installed skill called/i);
    expect(out.error.next).not.toMatch(/a skill it actually lists/i);
    // It IS on the device — say so.
    expect(out.error.message).toMatch(new RegExp(`"${LOCAL.name}" is on this device`, "i"));
  });

  it("does not call it built in either — it did not ship with the device", async () => {
    installedIs([BUILTIN, HUB, LOCAL]);
    const out = await skills().call("skill_uninstall", { name: LOCAL.name });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.message).not.toMatch(/came with the device/i);
  });

  it("tells the agent to stop and hand the user the only real next step", async () => {
    installedIs([BUILTIN, HUB, LOCAL]);
    const out = await skills().call("skill_uninstall", { name: LOCAL.name });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.next).toMatch(/do not retry/i);
    expect(out.error.next).toMatch(/deleted on the device/i);
  });

  /**
   * The contradiction itself, as an invariant over the whole list rather than
   * over one fixture row: skill_list's header says the rows it marks "from the
   * store" are the removable ones, so feeding every marked name straight back to
   * skill_uninstall must never produce "there is no such skill".
   */
  it("every row skill_list marks \"from the store\" is one skill_uninstall accepts", async () => {
    const rows = [BUILTIN, HUB, LOCAL];
    installedIs(rows);
    const listed = await skills().call("skill_list", {});
    expect(listed.isError).toBe(false);
    if (listed.isError) return;
    const marked = listed.text
      .split("\n")
      // The first line is the header, which names the mark rather than carrying it.
      .slice(1)
      .filter((l) => l.includes("from the store"))
      .map((l) => l.split(" ")[0]);
    expect(marked.length, "nothing was marked, so the invariant is vacuous").toBeGreaterThan(0);

    for (const name of marked) {
      apiGet.mockReset();
      apiPost.mockReset();
      // The device removed it: gone from the second read.
      installedIs(rows, rows.filter((r) => r.name !== name));
      // The real route, not an obliging stub. `hermes skills uninstall` works
      // off the hub lock, so a name that is not a lock key gets the 404 the
      // route's own not-installed branch sends.
      apiPost.mockImplementation(async (route: string, sent: { id?: string }) => {
        expect(route).toBe(UNINSTALL);
        const row = rows.find((r) => r.name === sent.id);
        if (row?.origin !== "hub") {
          throw new ApiError(
            404,
            JSON.stringify({
              error: `No store skill called "${sent.id}" is installed on this device.`,
              code: "not_installed",
            }),
          );
        }
        return { ok: true };
      });
      const out = await skills().call("skill_uninstall", { name });
      expect(out.isError, `skill_uninstall refused "${name}", which skill_list offered`).toBe(false);
      expect(apiPost).toHaveBeenCalledWith(UNINSTALL, { id: name }, expect.anything());
    }
  });
});

// ── The same claim, made by the route instead of the pre-condition ──────────

/**
 * The pre-condition is skipped whenever the installed list cannot be read
 * (installedSkills() swallows the failure and returns null), and then the
 * route's own 404 is the whole story. The route reaches `not_installed` for a
 * name in neither the hub lock nor .bundled_manifest — a name the device does
 * not have AND a `local` skill — and its own sentence says "No STORE skill
 * called x is installed". #513 mapped it to the stronger "There is no installed
 * skill called x on this device", which in that window is the same false claim
 * about a skill skill_list shows, reached by a different path.
 */
describe("the route's not_installed, when the pre-condition could not run", () => {
  const blindfolded = () => apiGet.mockRejectedValue(new ApiError(502, "{}"));

  beforeEach(() => {
    blindfolded();
    apiPost.mockRejectedValue(
      new ApiError(
        404,
        JSON.stringify({
          error: 'No store skill called "scratchpad" is installed on this device.',
          code: "not_installed",
        }),
      ),
    );
  });

  it("does not claim more than the route established", async () => {
    const out = await skills().call("skill_uninstall", { name: LOCAL.name });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.message).toMatch(/from the skill store/i);
    expect(out.error.message).not.toMatch(/on this device\.$/);
  });

  it("does not send the agent to skill_list expecting the name to be absent from it", async () => {
    const out = await skills().call("skill_uninstall", { name: LOCAL.name });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.next).not.toMatch(/pass the name field of a skill it actually lists/i);
    // Both branches, because from here the two cannot be told apart.
    expect(out.error.next).toMatch(/if it is listed/i);
    expect(out.error.next).toMatch(/do not retry/i);
  });
});

// ── Everything #513 established has to keep working ─────────────────────────

describe("anti-regression — the refusals #513 shipped", () => {
  it("a builtin is still refused as built in", async () => {
    installedIs([BUILTIN, HUB, LOCAL]);
    const out = await skills().call("skill_uninstall", { name: BUILTIN.name });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/came with the device/i);
  });

  it("a name the device does not have is still \"there is no installed skill called\"", async () => {
    installedIs([BUILTIN, HUB, LOCAL]);
    const out = await skills().call("skill_uninstall", { name: "ghost" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.message).toMatch(/there is no installed skill called "ghost"/i);
    expect(out.error.next).toMatch(/do not retry this name/i);
  });

  it("a hub skill is still removed, and the success says so", async () => {
    installedIs([BUILTIN, HUB], [BUILTIN]);
    apiPost.mockResolvedValue({ ok: true });
    const out = await skills().call("skill_uninstall", { name: HUB.name });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/removed the skill "invoices"/i);
  });

  it("un-shadowing a builtin is still reported as a success, not a failure", async () => {
    installedIs(
      [{ name: "pdf", origin: "hub", identifier: "official/pdf" }],
      [{ name: "pdf", origin: "builtin" }],
    );
    apiPost.mockResolvedValue({ ok: true });
    const out = await skills().call("skill_uninstall", { name: "pdf" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/built-in "pdf" was underneath it/i);
  });

  /**
   * The post-condition keeps the WIDER not-builtin test on purpose. #517 and
   * TASK-547 both name the half-removed state where the CLI drops the lock entry
   * and leaves the directory: the row comes back as origin `local`, and that is
   * a FAILED uninstall, not a clean one. Narrowing removability must not narrow
   * this.
   */
  it("a hub skill that came back as `local` still reads as a failed uninstall", async () => {
    installedIs([HUB], [{ name: HUB.name, origin: "local" }]);
    apiPost.mockResolvedValue({ ok: true });
    const out = await skills().call("skill_uninstall", { name: HUB.name });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/did not remove "invoices"/i);
  });
});

// ── Anti-drift: one device state, one story ─────────────────────────────────

describe("the agent and the Skills page must answer one device state the same way", () => {
  /**
   * The defect was a SECOND definition of "removable" that had drifted from the
   * store's. This is the check that stops a third appearing: the removability
   * test is spelled against `hub`, in one named predicate, and `!== "builtin"`
   * survives only inside the wider isStoreSkill() the post-condition needs.
   */
  it("no removability test in mcp/tools/skills.ts is written as `!== builtin`", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "mcp/tools/skills.ts"), "utf-8");
    expect(src, "isRemovable() is gone or was renamed").toMatch(/function isRemovable\s*\(/);
    expect(src).toMatch(/origin\s*===\s*"hub"/);
    const notBuiltin = src.match(/origin\s*!==\s*"builtin"/g) ?? [];
    expect(notBuiltin.length, "`origin !== \"builtin\"` leaked back out of isStoreSkill()").toBe(1);
  });

  it("agrees with HermesSkillsStore.tsx on which origin can be removed", () => {
    const store = fs.readFileSync(
      path.join(process.cwd(), "src/components/HermesSkillsStore.tsx"),
      "utf-8",
    );
    // The store's rule, unchanged by this fix and the reference the MCP side is
    // now aligned to.
    expect(store).toMatch(/match\.origin\s*!==\s*'hub'/);
    expect(store).toMatch(/skill\.origin\s*!==\s*'hub'/);
  });
});
