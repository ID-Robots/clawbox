/**
 * The owner's allow-list where it actually bites: the deny rules a run is
 * started with, and the argv that carries both halves.
 *
 * The rule grammar has its own file (coding-permission-rules.test.ts). What is
 * under test HERE is the consequence: a deny rule outranks an allow rule in
 * Claude Code, so an owner rule for the harness's own per-project notes grants
 * exactly nothing unless the wholesale tree deny is taken out of `fileDenyRules`
 * for that one run. The property that must survive that: EVERYTHING ELSE stays
 * shut — the OAuth credential, the settings, the cross-project caches, and every
 * project the rule did not name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsSync from "fs";
import osMod from "os";
import pathMod from "path";
import { saveEnv } from "@/tests/helpers/env";

const configGet = vi.hoisted(() => vi.fn());
const configGetAll = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  getAll: configGetAll,
  set: configSet,
}));

let home = "";
let restoreEnv: () => void;

/** A home that looks like a box the harness has been used on. */
function makeHome(): string {
  const dir = fsSync.realpathSync(fsSync.mkdtempSync(pathMod.join(osMod.tmpdir(), "coding-allow-home-")));
  for (const harness of [".claude", ".claude-ds"]) {
    fsSync.mkdirSync(pathMod.join(dir, harness, "projects", "app"), { recursive: true });
    fsSync.mkdirSync(pathMod.join(dir, harness, "projects", "other"), { recursive: true });
    fsSync.mkdirSync(pathMod.join(dir, harness, "plans"), { recursive: true });
    fsSync.writeFileSync(pathMod.join(dir, harness, ".credentials.json"), "{}");
    fsSync.writeFileSync(pathMod.join(dir, harness, "settings.json"), "{}");
  }
  fsSync.mkdirSync(pathMod.join(dir, ".ssh"), { recursive: true });
  return dir;
}

beforeEach(() => {
  configGet.mockReset().mockResolvedValue(undefined);
  configGetAll.mockReset().mockResolvedValue({});
  configSet.mockReset().mockResolvedValue(undefined);
  restoreEnv = saveEnv("HOME");
  home = makeHome();
  process.env.HOME = home;
  vi.resetModules();
});

afterEach(() => {
  restoreEnv();
  fsSync.rmSync(home, { recursive: true, force: true });
});

/** True when some Read/Edit/Write deny rule covers `abs`, tree or file. */
function denied(rules: readonly string[], abs: string): boolean {
  return rules.some((rule) => {
    const m = /^(?:Read|Edit|Write)\(\/(.+?)(\/\*\*)?\)$/.exec(rule);
    if (!m) return false;
    const root = `/${m[1]}`.replace(/\/+/g, "/");
    return m[2] ? abs === root || abs.startsWith(`${root}/`) : abs === root;
  });
}

describe("fileDenyRules with no owner rules", () => {
  it("denies each harness state directory wholesale", async () => {
    const { fileDenyRules } = await import("@/lib/coding-agent");
    const rules = fileDenyRules();
    for (const harness of [".claude", ".claude-ds"]) {
      expect(rules, harness).toContain(`Read(/${pathMod.join(home, harness)}/**)`);
      expect(denied(rules, pathMod.join(home, harness, "projects", "app", "memory", "notes.md"))).toBe(true);
    }
  });

  it("denies the credential stores whatever else happens", async () => {
    const { fileDenyRules } = await import("@/lib/coding-agent");
    expect(denied(fileDenyRules(), pathMod.join(home, ".ssh", "id_ed25519"))).toBe(true);
  });
});

describe("fileDenyRules with one soft rule", () => {
  const rule = (h: string) => `Read(/${pathMod.join(h, ".claude-ds", "projects", "app")}/**)`;

  it("opens exactly the project folder the rule named", async () => {
    const { fileDenyRules } = await import("@/lib/coding-agent");
    const rules = fileDenyRules([rule(home)]);
    const app = pathMod.join(home, ".claude-ds", "projects", "app");
    expect(denied(rules, pathMod.join(app, "memory", "notes.md"))).toBe(false);
    expect(denied(rules, app)).toBe(false);
  });

  it("keeps every OTHER project of the same harness shut", async () => {
    const { fileDenyRules } = await import("@/lib/coding-agent");
    const rules = fileDenyRules([rule(home)]);
    expect(denied(rules, pathMod.join(home, ".claude-ds", "projects", "other", "memory", "x.md"))).toBe(true);
  });

  it("keeps the harness's own credential, settings and caches shut", async () => {
    const { fileDenyRules } = await import("@/lib/coding-agent");
    const rules = fileDenyRules([rule(home)]);
    for (const entry of [".credentials.json", "settings.json", "plans"]) {
      expect(denied(rules, pathMod.join(home, ".claude-ds", entry)), entry).toBe(true);
    }
    // Listed even though this box has never written them.
    expect(denied(rules, pathMod.join(home, ".claude-ds", "history.jsonl"))).toBe(true);
    expect(denied(rules, pathMod.join(home, ".claude-ds", "file-history", "a"))).toBe(true);
  });

  it("leaves the OTHER harness denied wholesale", async () => {
    // One rule opens one folder of one harness; `~/.claude` is untouched.
    const { fileDenyRules } = await import("@/lib/coding-agent");
    const rules = fileDenyRules([rule(home)]);
    expect(rules).toContain(`Read(/${pathMod.join(home, ".claude")}/**)`);
    expect(denied(rules, pathMod.join(home, ".claude", "projects", "app", "x.md"))).toBe(true);
  });

  it("never opens a credential store, whatever the rule says", async () => {
    const { fileDenyRules } = await import("@/lib/coding-agent");
    // A rule the validator would have refused, handed straight to the builder.
    for (const forged of [
      `Read(/${pathMod.join(home, ".ssh")}/**)`,
      `Read(/${pathMod.join(home, ".claude-ds")}/**)`,
      `Read(/${pathMod.join(home, ".claude-ds", "projects")}/**)`,
      "Read(//**)",
    ]) {
      const rules = fileDenyRules([forged]);
      expect(denied(rules, pathMod.join(home, ".ssh", "id_ed25519")), forged).toBe(true);
      expect(denied(rules, pathMod.join(home, ".claude-ds", ".credentials.json")), forged).toBe(true);
    }
  });

  it("a rule for a project that does not exist yet opens nothing else", async () => {
    const { fileDenyRules } = await import("@/lib/coding-agent");
    const rules = fileDenyRules([`Read(/${pathMod.join(home, ".claude-ds", "projects", "unborn")}/**)`]);
    expect(denied(rules, pathMod.join(home, ".claude-ds", "projects", "app", "x.md"))).toBe(true);
    expect(denied(rules, pathMod.join(home, ".claude-ds", ".credentials.json"))).toBe(true);
  });
});

describe("buildRunArgs carries both halves", () => {
  /** The values of one repeated flag, up to the next flag. */
  function valuesOf(args: string[], flag: string): string[] {
    const at = args.indexOf(flag);
    if (at < 0) return [];
    const out: string[] = [];
    for (let i = at + 1; i < args.length && !args[i].startsWith("--"); i++) out.push(args[i]);
    return out;
  }

  it("puts the owner's rules last in --allowedTools, after everything the device ships", async () => {
    const lib = await import("@/lib/coding-agent");
    const rule = `Read(/${pathMod.join(home, ".claude-ds", "projects", "app")}/**)`;
    const allowed = valuesOf(lib.buildRunArgs({ allowRules: [rule] }), "--allowedTools");
    expect(allowed).toContain("Bash(*)");
    expect(allowed.at(-1)).toBe(rule);
  });

  it("hands the same rules to fileDenyRules, or the allow would be inert", async () => {
    const lib = await import("@/lib/coding-agent");
    const rule = `Read(/${pathMod.join(home, ".claude-ds", "projects", "app")}/**)`;
    const args = lib.buildRunArgs({ allowRules: [rule] });
    const disallowed = valuesOf(args, "--disallowedTools");
    expect(disallowed).not.toContain(`Read(/${pathMod.join(home, ".claude-ds")}/**)`);
    expect(denied(disallowed, pathMod.join(home, ".claude-ds", "projects", "app", "x.md"))).toBe(false);
    expect(denied(disallowed, pathMod.join(home, ".claude-ds", "projects", "other", "x.md"))).toBe(true);
  });

  it("re-validates on the way to argv, so an unvetted rule never reaches the CLI", async () => {
    // buildRunArgs is exported, so a caller that assembled a list by hand is
    // the case this guards: the rule is dropped from BOTH lists.
    const lib = await import("@/lib/coding-agent");
    const forged = `Read(/${pathMod.join(home, ".ssh")}/**)`;
    const args = lib.buildRunArgs({ allowRules: [forged, "Read(//**)", "nonsense"] });
    expect(valuesOf(args, "--allowedTools")).not.toContain(forged);
    expect(args).not.toContain("nonsense");
    expect(denied(valuesOf(args, "--disallowedTools"), pathMod.join(home, ".ssh", "id_ed25519"))).toBe(true);
  });

  it("a run with no rules is argv-identical to one given only junk", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(lib.buildRunArgs({ allowRules: ["Bash(rm -rf /)", "", "Read(//home/**)"] }))
      .toEqual(lib.buildRunArgs({}));
  });

  it("a read-only run gets the owner's rules but still no Bash", async () => {
    const lib = await import("@/lib/coding-agent");
    const rule = `Read(/${pathMod.join(home, ".claude-ds", "projects", "app")}/**)`;
    const allowed = valuesOf(lib.buildRunArgs({ readOnly: true, allowRules: [rule] }), "--allowedTools");
    expect(allowed).toContain(rule);
    expect(allowed).not.toContain("Bash(*)");
  });
});

describe("the stored list", () => {
  const KEY = "coding_agent_allow_rules";

  it("is read back re-validated against this box", async () => {
    const lib = await import("@/lib/coding-agent");
    const good = `Read(/${pathMod.join(home, ".claude-ds", "projects", "app")}/**)`;
    configGet.mockResolvedValue([good, `Read(/${pathMod.join(home, ".ssh")}/**)`, 7, "Read(//**)"]);
    expect(await lib.getAllowRules(lib.allowRuleContext())).toEqual([good]);
  });

  it("saves one rule, appended, and answers the whole list", async () => {
    const lib = await import("@/lib/coding-agent");
    const first = `Read(/${pathMod.join(home, "Projects", "notes")}/**)`;
    const second = `Write(/${pathMod.join(home, "Projects", "app")}/**)`;
    configGet.mockResolvedValue([first]);
    expect(await lib.addAllowRule(second)).toEqual([first, second]);
    expect(configSet).toHaveBeenCalledWith(KEY, [first, second]);
  });

  it("refuses a rule the device could never honour, and writes nothing", async () => {
    const lib = await import("@/lib/coding-agent");
    configGet.mockResolvedValue([]);
    await expect(lib.addAllowRule(`Read(/${pathMod.join(home, ".ssh")}/**)`)).rejects.toMatchObject({
      name: "AllowRuleError",
      code: "protected",
      kind: "invalid",
    });
    expect(configSet).not.toHaveBeenCalled();
  });

  it("refuses a duplicate against what is STORED, not what the browser saw", async () => {
    const lib = await import("@/lib/coding-agent");
    const rule = `Read(/${pathMod.join(home, "Projects", "notes")}/**)`;
    configGet.mockResolvedValue([rule]);
    await expect(lib.addAllowRule(rule)).rejects.toMatchObject({ code: "duplicate" });
  });

  it("removing a rule that is not there succeeds and writes nothing", async () => {
    const lib = await import("@/lib/coding-agent");
    const rule = `Read(/${pathMod.join(home, "Projects", "notes")}/**)`;
    configGet.mockResolvedValue([rule]);
    expect(await lib.removeAllowRule("Read(//nowhere/at/all/**)")).toEqual([rule]);
    expect(configSet).not.toHaveBeenCalled();
    // ...and removing one that IS there writes the shorter list.
    expect(await lib.removeAllowRule(rule)).toEqual([]);
    expect(configSet).toHaveBeenCalledWith(KEY, []);
  });

  it("refuses to remove anything that is not text", async () => {
    const lib = await import("@/lib/coding-agent");
    await expect(lib.removeAllowRule(null)).rejects.toMatchObject({ code: "malformed" });
  });
});

describe("suggestAllowRule: what the run page offers", () => {
  it("offers the folder rule for a refusal an owner may answer", async () => {
    const lib = await import("@/lib/coding-agent");
    const target = pathMod.join(home, ".claude-ds", "projects", "app", "memory", "notes.md");
    const { rule, refusal } = lib.suggestAllowRule({ tool: "Read", target });
    expect(rule).toBe(`Read(/${pathMod.join(home, ".claude-ds", "projects", "app", "memory")}/**)`);
    expect(refusal).toBeNull();
  });

  it("offers no rule for a credential store, and says why", async () => {
    const lib = await import("@/lib/coding-agent");
    const { rule, refusal } = lib.suggestAllowRule({ tool: "Read", target: pathMod.join(home, ".ssh", "id_ed25519") });
    expect(rule).toBeNull();
    expect(refusal).toBe("protected");
  });

  it("offers nothing at all for a refused command", async () => {
    const lib = await import("@/lib/coding-agent");
    expect(lib.suggestAllowRule({ tool: "Bash", target: "pkill -f next-server" }))
      .toEqual({ rule: null, refusal: null });
  });
});
