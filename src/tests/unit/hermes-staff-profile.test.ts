import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import {
  ensureStaffHermesProfile,
  forgetStaffHermesProfile,
  staffHermesConfig,
  staffHermesProfilePaths,
} from "@/lib/hermes-staff-profile";
import { STAFF_HERMES_TOOLS } from "@/lib/org-staff-policy";

// A member of staff's own Hermes profile (src/lib/hermes-staff-profile.ts) and
// the pre_tool_call hook that guards it (scripts/hermes-plugins/
// clawbox_staff_guard, driven through python3 — the module Hermes imports).

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-staff-")));
  fs.writeFileSync(path.join(root, "config.yaml"), yaml.dump({
    model: { default: "deepseek-v4-flash", provider: "clawai" },
    platform_toolsets: { cli: ["hermes-cli"] },
    agent: { max_turns: 90, disabled_toolsets: [] },
    mcp_servers: { clawbox: { command: "bun", args: ["run", "mcp/clawbox-mcp.ts"], env: { CLAWBOX_MCP_TOKEN: "placeholder" } } },
    memory: { memory_enabled: false, provider: "honcho", write_approval: true, memory_char_limit: 2200 },
    auxiliary: { background_review: { enabled: true }, compression: { provider: "clawai" } },
    curator: { enabled: true },
    plugins: { enabled: ["clawbox_staff_guard"] },
    gateway: { multiplex_profiles: true },
  }));
  fs.writeFileSync(path.join(root, ".env"), "CLAWAI_API_KEY=placeholder\n");
  fs.writeFileSync(path.join(root, "SOUL.md"), "You are the ClawBox assistant.\n");
  fs.mkdirSync(path.join(root, "memories"));
  // The staff guard as register-mcp.sh installs it.
  fs.mkdirSync(path.join(root, "plugins", "clawbox_staff_guard"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "clawbox_staff_guard", "__init__.py"), "");
  fs.writeFileSync(path.join(root, "memories", "MEMORY.md"), "the owner's private fact\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a staff profile's config", () => {
  const config = () => staffHermesConfig(yaml.load(fs.readFileSync(path.join(root, "config.yaml"), "utf-8")), "/p/workspace");

  it("builds the agent with the staff toolsets only and no MCP server", () => {
    const cfg = config();
    expect(cfg.platform_toolsets).toEqual({ cli: [...STAFF_HERMES_TOOLS.toolsets] });
    expect((cfg.agent as { disabled_toolsets: string[]; max_turns: number }).disabled_toolsets).toEqual([...STAFF_HERMES_TOOLS.disabledToolsets]);
    expect((cfg.agent as { max_turns: number }).max_turns).toBe(90);
    expect(cfg.mcp_servers).toBeUndefined();
  });

  it("keeps its own built-in memory, writes it without asking, and learns no skills", () => {
    const cfg = config();
    expect(cfg.memory).toEqual({ memory_enabled: true, user_profile_enabled: true, write_approval: false, provider: "", memory_char_limit: 2200 });
    expect((cfg.auxiliary as { background_review: { enabled: boolean }; compression: unknown }).background_review.enabled).toBe(false);
    expect((cfg.auxiliary as { compression: unknown }).compression).toEqual({ provider: "clawai" });
    expect((cfg.curator as { enabled: boolean }).enabled).toBe(false);
  });

  it("follows the owner's model, works in the member's folder and stays out of the messaging multiplexer", () => {
    const cfg = config();
    expect(cfg.model).toEqual({ default: "deepseek-v4-flash", provider: "clawai" });
    expect((cfg.terminal as { cwd: string }).cwd).toBe("/p/workspace");
    expect(cfg.gateway).toEqual({ multiplex_profiles: true, standalone: true });
  });
});

describe("ensureStaffHermesProfile", () => {
  it("makes the profile once and keeps it following the owner's config", async () => {
    const made = await ensureStaffHermesProfile("maria", root);
    expect(made).toEqual(staffHermesProfilePaths("maria", root));
    expect(made!.profile).toBe("clawbox-staff-maria");
    expect(made!.home).toBe(path.join(root, "profiles", "clawbox-staff-maria"));
    expect(fs.statSync(made!.home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(made!.folder).isDirectory()).toBe(true);
    expect(fs.readlinkSync(path.join(made!.home, ".env"))).toBe(path.join(root, ".env"));
    expect(fs.existsSync(path.join(made!.home, "auth.json"))).toBe(false);
    expect(fs.readFileSync(path.join(made!.home, "SOUL.md"), "utf-8")).toBe("You are the ClawBox assistant.\n");
    // Their memory starts empty: nothing of the owner's is copied in.
    expect(fs.readdirSync(path.join(made!.home, "memories"))).toEqual([]);

    const cfgFile = path.join(made!.home, "config.yaml");
    const first = fs.readFileSync(cfgFile, "utf-8");
    expect((yaml.load(first) as { platform_toolsets: unknown }).platform_toolsets).toEqual({ cli: [...STAFF_HERMES_TOOLS.toolsets] });
    const mtime = fs.statSync(cfgFile).mtimeMs;
    await ensureStaffHermesProfile("maria", root);
    expect(fs.statSync(cfgFile).mtimeMs).toBe(mtime);

    // The owner moves the box to another model: the member's profile follows.
    fs.writeFileSync(path.join(root, "config.yaml"), yaml.dump({ model: { default: "claude-sonnet", provider: "anthropic" }, plugins: { enabled: ["clawbox_staff_guard"] } }));
    fs.writeFileSync(path.join(root, "auth.json"), "{}");
    await ensureStaffHermesProfile("maria", root);
    expect((yaml.load(fs.readFileSync(cfgFile, "utf-8")) as { model: unknown }).model).toEqual({ default: "claude-sonnet", provider: "anthropic" });
    expect(fs.readlinkSync(path.join(made!.home, "auth.json"))).toBe(path.join(root, "auth.json"));
  });

  it("gives every member their own profile, and a removed member's goes with them", async () => {
    const a = await ensureStaffHermesProfile("maria", root);
    const b = await ensureStaffHermesProfile("ivan", root);
    expect(a!.home).not.toBe(b!.home);
    await forgetStaffHermesProfile("maria", root);
    expect(fs.existsSync(a!.home)).toBe(false);
    expect(fs.existsSync(b!.home)).toBe(true);
  });

  it("refuses, fail closed, while the staff guard is not installed and enabled", async () => {
    fs.rmSync(path.join(root, "plugins", "clawbox_staff_guard"), { recursive: true });
    expect(await ensureStaffHermesProfile("maria", root)).toBeNull();
    fs.mkdirSync(path.join(root, "plugins", "clawbox_staff_guard"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugins", "clawbox_staff_guard", "__init__.py"), "");
    fs.writeFileSync(path.join(root, "config.yaml"), yaml.dump({ plugins: { enabled: ["clawai"] } }));
    expect(await ensureStaffHermesProfile("maria", root)).toBeNull();
    // `hermes config set` stores the list as a JSON string.
    fs.writeFileSync(path.join(root, "config.yaml"), yaml.dump({ plugins: { enabled: '["clawai", "clawbox_staff_guard"]' } }));
    expect(await ensureStaffHermesProfile("maria", root)).not.toBeNull();
  });

  it("refuses a name that is not a username", async () => {
    expect(await ensureStaffHermesProfile("../owner", root)).toBeNull();
    expect(staffHermesProfilePaths("Maria", root)).toBeNull();
  });
});

const REPO = path.resolve(__dirname, "../../..");
const PLUGINS_ROOT = path.join(REPO, "scripts/hermes-plugins");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 ? describe : describe.skip;

/** `judge(tool, args, hermes_home, user_home)` through python3; `null` or the directive. */
function judge(tool: string, args: Record<string, unknown>, hermesHome: string, userHome = "/home/clawbox"): { action: string; message?: string; args?: Record<string, string> } | null {
  const program = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from clawbox_staff_guard.staff_guard import judge",
    "a = json.loads(sys.stdin.read())",
    "print(json.dumps(judge(a['tool'], a['args'], a['home'], a['user'])))",
  ].join("\n");
  const out = execFileSync("python3", ["-I", "-c", program, PLUGINS_ROOT], {
    input: JSON.stringify({ tool, args, home: hermesHome, user: userHome }),
    encoding: "utf-8",
  });
  return JSON.parse(out);
}

d("the Hermes staff guard (clawbox_staff_guard)", () => {
  it("has no opinion on the owner's profile", () => {
    expect(judge("terminal", { command: "rm -rf ~" }, root)).toBeNull();
    expect(judge("write_file", { path: "/etc/x", content: "y" }, root)).toBeNull();
  });

  it.each(["terminal", "process_manage", "web_search", "web_extract", "browser_navigate", "execute_code", "delegate_task",
    "cronjob_manage", "skill_manage", "image_generate", "text_to_speech", "send_message", "mcp__clawbox__email_send", "computer_use"])(
    "refuses %s on a staff profile", async (tool) => {
      const staff = (await ensureStaffHermesProfile("maria", root))!;
      expect(judge(tool, {}, staff.home)).toMatchObject({ action: "block", message: expect.stringMatching(/not available to members of staff/) });
    },
  );

  it("holds the file tools to the member's own folder, making a relative path absolute inside it", async () => {
    const staff = (await ensureStaffHermesProfile("maria", root))!;
    const other = (await ensureStaffHermesProfile("ivan", root))!;
    expect(judge("write_file", { path: path.join(staff.folder, "report.md"), content: "x" }, staff.home)).toBeNull();
    expect(judge("write_file", { path: "report.md", content: "x" }, staff.home)).toEqual({ action: "modify", args: { path: path.join(staff.folder, "report.md") } });
    expect(judge("search_files", { pattern: "invoice" }, staff.home)).toEqual({ action: "modify", args: { path: staff.folder } });
    for (const target of [
      path.join(root, "memories", "MEMORY.md"),
      path.join(staff.home, "config.yaml"),
      path.join(other.home, "memories", "MEMORY.md"),
      path.join(other.folder, "notes.md"),
      "../memories/MEMORY.md",
      "~/clawbox/data/config.json",
    ]) {
      expect(judge("write_file", { path: target, content: "x" }, staff.home)).toMatchObject({ action: "block" });
      expect(judge("read_file", { path: target }, staff.home)).toMatchObject({ action: "block" });
    }
    expect(judge("patch", { path: path.join(root, "config.yaml"), old_string: "a", new_string: "b" }, staff.home)).toMatchObject({ action: "block" });
    expect(judge("write_file", { content: "x" }, staff.home)).toMatchObject({ action: "block" });
    // A patch envelope must name its files absolutely, inside the folder.
    expect(judge("patch", { patch: `*** Begin Patch\n*** Add File: ${path.join(staff.folder, "a.md")}\n+x\n*** End Patch` }, staff.home)).toBeNull();
    expect(judge("patch", { patch: "*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch" }, staff.home)).toMatchObject({ action: "block" });
  });

  it("never reaches the web through vision or a file URL elsewhere", async () => {
    const staff = (await ensureStaffHermesProfile("maria", root))!;
    expect(judge("vision_analyze", { image_url: "https://example.com/x.png", question: "?" }, staff.home)).toMatchObject({ action: "block", message: expect.stringMatching(/nothing on the web/) });
    expect(judge("read_file", { path: `file://${path.join(root, "SOUL.md")}` }, staff.home)).toMatchObject({ action: "block" });
  });

  it("two members and the owner: A's memory is A's, B cannot open it, the owner's is untouched", async () => {
    const a = (await ensureStaffHermesProfile("maria", root))!;
    const b = (await ensureStaffHermesProfile("ivan", root))!;
    const ownerMemory = path.join(root, "memories", "MEMORY.md");
    const before = fs.readFileSync(ownerMemory, "utf-8");
    // The `memory` tool writes the PROFILE's memories/MEMORY.md (HERMES_HOME is
    // the session's profile home), and is allowed; it names no path.
    expect(judge("memory", { action: "add", target: "memory", content: "the vault code is 4711" }, a.home)).toBeNull();
    fs.writeFileSync(path.join(a.home, "memories", "MEMORY.md"), "the vault code is 4711\n");
    // B reading A's memory file is refused every way.
    for (const target of [path.join(a.home, "memories", "MEMORY.md"), "../../clawbox-staff-maria/memories/MEMORY.md"]) {
      expect(judge("read_file", { path: target }, b.home)).toMatchObject({ action: "block" });
      expect(judge("search_files", { path: target, pattern: "4711" }, b.home)).toMatchObject({ action: "block" });
    }
    // B's own memory file is not A's.
    expect(fs.existsSync(path.join(b.home, "memories", "MEMORY.md"))).toBe(false);
    expect(fs.readFileSync(ownerMemory, "utf-8")).toBe(before);
  });
});
