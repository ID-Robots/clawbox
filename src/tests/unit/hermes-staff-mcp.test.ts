import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

// TASK-2516 on Hermes: an MCP server the owner configured in config.yaml and
// granted to staff reaches a member through their OWN profile — its
// `mcp_servers` holds only the relay entries granted to them, each with their
// own relay token — and clawbox_staff_guard lets a member's agent call only the
// relay entries listed for THEIR profile. A server the owner did not grant is
// never in any staff profile; another member's entry and the owner's profile
// calling a member's entry are refused.

vi.mock("@/lib/hermes-plugin-set", () => ({ readLoadedHermesPlugins: vi.fn(async () => ["clawbox_staff_guard"]) }));
vi.mock("@/lib/hermes-plugin-reload", () => ({ reloadHermesPlugins: vi.fn(async () => ({})) }));
const reloadMcp = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/hermes-mcp-reload", () => ({ reloadMcpServers: reloadMcp }));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
let dataRoot: string;
let profile: typeof import("@/lib/hermes-staff-profile");
let mcp: typeof import("@/lib/staff-mcp");
const saved = process.env.CLAWBOX_ROOT;

const REPO = path.resolve(__dirname, "../../..");
const PLUGINS_ROOT = path.join(REPO, "scripts/hermes-plugins");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-staff-mcp-")));
  dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-staff-mcp-data-")));
  process.env.CLAWBOX_ROOT = dataRoot;
  fs.writeFileSync(path.join(root, "config.yaml"), yaml.dump({
    model: { default: "m", provider: "p" },
    mcp_servers: {
      clawbox: { command: "bun", args: ["run", "mcp/clawbox-mcp.ts"] },
      worddoc: { url: "http://127.0.0.1:8765/mcp" },
      ungranted: { url: "http://127.0.0.1:9000/mcp", headers: { Authorization: "Bearer owner-only-token-000" } },
    },
    plugins: { enabled: ["clawbox_staff_guard"] },
  }));
  fs.mkdirSync(path.join(root, "plugins", "clawbox_staff_guard"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "clawbox_staff_guard", "__init__.py"), "");
  vi.resetModules();
  reloadMcp.mockClear();
  profile = await import("@/lib/hermes-staff-profile");
  mcp = await import("@/lib/staff-mcp");
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = saved;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const grant = (worddoc: Record<string, unknown> | null) =>
  mcp.updateStaffMcpStore((store) => ({ ...store, servers: worddoc ? { worddoc: { header: "Authorization", ...worddoc } } : ({} as Record<string, never>) }));
const profileConfig = (username: string) =>
  yaml.load(fs.readFileSync(path.join(profile.staffHermesProfilePaths(username, root)!.home, "config.yaml"), "utf-8")) as Record<string, unknown>;
const grantsFile = () => JSON.parse(fs.readFileSync(path.join(root, "plugins", "clawbox_staff_guard", "staff-mcp-grants.json"), "utf-8"));

describe("a member's Hermes profile", () => {
  it("carries exactly the relay entries granted to them, with their own relay token — never the owner's servers", async () => {
    await grant({ needsCredential: false, writeTools: true });
    expect(await profile.ensureStaffHermesProfile("maria", root)).not.toBeNull();
    const servers = profileConfig("maria").mcp_servers as Record<string, { url: string; headers: Record<string, string> }>;
    const entry = mcp.staffEntryName("maria", "worddoc");
    expect(Object.keys(servers)).toEqual([entry]);
    expect(servers[entry].url).toMatch(/\/setup-api\/staff-mcp\/worddoc$/);
    const store = await mcp.readStaffMcpStore();
    expect(servers[entry].headers).toEqual({ Authorization: `Bearer ${store.relayTokens.maria}` });
    expect(JSON.stringify(profileConfig("maria"))).not.toContain("owner-only-token-000");
    expect(grantsFile().agents).toEqual({ "clawbox-staff-maria": [entry] });
    expect(reloadMcp).toHaveBeenCalled();
  });

  it("gives a server granted by name only to those members, and nothing while it is not granted", async () => {
    await grant({ needsCredential: false, members: ["ivan"] });
    await profile.ensureStaffHermesProfile("maria", root);
    await profile.ensureStaffHermesProfile("ivan", root);
    expect(profileConfig("maria").mcp_servers).toBeUndefined();
    expect(Object.keys(profileConfig("ivan").mcp_servers as object)).toEqual([mcp.staffEntryName("ivan", "worddoc")]);

    await grant(null);
    expect(await profile.syncHermesStaffMcp(["maria", "ivan"], root)).toBe(true);
    expect(profileConfig("ivan").mcp_servers).toBeUndefined();
    expect(grantsFile().agents).toEqual({});
  });

  it("drops a removed member's line from the guard's grants", async () => {
    await grant({ needsCredential: false });
    await profile.ensureStaffHermesProfile("maria", root);
    await profile.ensureStaffHermesProfile("ivan", root);
    expect(Object.keys(grantsFile().agents).sort()).toEqual(["clawbox-staff-ivan", "clawbox-staff-maria"]);
    await profile.syncHermesStaffMcp(["ivan"], root);
    expect(Object.keys(grantsFile().agents)).toEqual(["clawbox-staff-ivan"]);
  });

  it("grants nothing when the store cannot be read (fail closed)", async () => {
    await grant({ needsCredential: false });
    fs.writeFileSync(mcp.STAFF_MCP_STORE_PATH, "{ not json");
    await profile.ensureStaffHermesProfile("maria", root);
    expect(profileConfig("maria").mcp_servers).toBeUndefined();
  });
});

(hasPython3 ? describe : describe.skip)("clawbox_staff_guard and relay entries", () => {
  function judge(tool: string, hermesHome: string, grants: Record<string, string[]>) {
    const program = [
      "import json, sys",
      "sys.path.insert(0, sys.argv[1])",
      "from clawbox_staff_guard.staff_guard import judge",
      "a = json.loads(sys.stdin.read())",
      "print(json.dumps(judge(a['tool'], {}, a['home'], '/home/clawbox', {'staffMcpGrants': {'agents': a['grants']}})))",
    ].join("\n");
    return JSON.parse(execFileSync("python3", ["-I", "-c", program, PLUGINS_ROOT], {
      input: JSON.stringify({ tool, home: hermesHome, grants }),
      encoding: "utf-8",
    })) as { action: string; message?: string } | null;
  }

  it("lets a member call their own granted entry's tools (either Hermes naming), and nothing else over MCP", () => {
    const maria = path.join(root, "profiles", "clawbox-staff-maria");
    const ivan = path.join(root, "profiles", "clawbox-staff-ivan");
    const entry = mcp.staffEntryName("maria", "worddoc");
    const sanitized = entry.replace(/[^A-Za-z0-9_]/g, "_");
    const grants = { "clawbox-staff-maria": [entry] };
    expect(judge(`mcp__${sanitized}__create_word_document`, maria, grants)).toBeNull();
    expect(judge(`mcp_${sanitized}_create_word_document`, maria, grants)).toBeNull();
    // Another member's agent calling it, or a member calling an entry not theirs.
    expect(judge(`mcp__${sanitized}__create_word_document`, ivan, grants)).toMatchObject({ action: "block" });
    // The owner's servers, and anything when the grants say nothing.
    expect(judge("mcp__clawbox__status", maria, grants)).toMatchObject({ action: "block" });
    expect(judge("mcp__worddoc__create_word_document", maria, grants)).toMatchObject({ action: "block" });
    expect(judge(`mcp__${sanitized}__create_word_document`, maria, {})).toMatchObject({ action: "block" });
  });

  it("refuses the owner's profile a member's relay entry, and leaves the owner's own tools alone", () => {
    const entry = mcp.staffEntryName("maria", "worddoc").replace(/[^A-Za-z0-9_]/g, "_");
    expect(judge(`mcp__${entry}__create_word_document`, root, { "clawbox-staff-maria": [entry] })).toMatchObject({ action: "block" });
    expect(judge("mcp__worddoc__create_word_document", root, {})).toBeNull();
  });
});
