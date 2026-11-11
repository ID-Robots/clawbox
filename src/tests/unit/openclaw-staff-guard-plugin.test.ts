import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin, { onBeforeToolCall } from "../../../scripts/openclaw-plugins/clawbox-staff-guard/index.mjs";
import { staffDenyMessage, staffMemberOf, staffToolCallDenyReason } from "../../../scripts/openclaw-plugins/clawbox-staff-guard/staff-guard.mjs";
import { STAFF_OPENCLAW_TOOLS } from "@/lib/org-staff-policy";
import { staffWorkspaceDir } from "@/lib/org-staff-agents";

// clawbox-staff-guard (TASK-2444, TASK-2445): the before_tool_call hook that
// holds a member of staff's OpenClaw agent to the staff allow-list and its
// file tools to that member's own folder — and has no opinion at all on the
// owner's agent. Run against a real directory tree, symlinks included.

let root: string;
let home: string;
let openclawHome: string;
let opts: { openclawHome: string; home: string; mediaOwners: string };

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "staff-guard-")));
  home = path.join(root, "home");
  openclawHome = path.join(home, ".openclaw");
  opts = { openclawHome, home, mediaOwners: path.join(root, "chat-media-owners.json") };
  for (const dir of [
    staffWorkspaceDir(openclawHome, "maria"),
    staffWorkspaceDir(openclawHome, "ivan"),
    path.join(openclawHome, "workspace"),
    path.join(openclawHome, "media", "chat-attachments", "batch1"),
  ]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(openclawHome, "workspace", "MEMORY.md"), "# Owner's memory\n- the owner's private fact\n");
  fs.writeFileSync(path.join(openclawHome, "media", "chat-attachments", "batch1", "q3.xlsx.txt"), "a,b\n1,2\n");
  fs.mkdirSync(path.join(openclawHome, "media", "chat-attachments", "batch2"), { recursive: true });
  fs.writeFileSync(path.join(openclawHome, "media", "chat-attachments", "batch2", "payroll.txt"), "ivan's\n");
  fs.writeFileSync(path.join(openclawHome, "media", "chat-attachments", "owners-own.txt"), "the owner's\n");
  // Whose upload each staged file is (src/lib/chat-media-owners.ts): maria's
  // dropped folder by its root, ivan's file by itself; the owner's has none.
  fs.writeFileSync(opts.mediaOwners, JSON.stringify({
    [path.join(openclawHome, "media", "chat-attachments", "batch1")]: "maria",
    [path.join(openclawHome, "media", "chat-attachments", "batch2", "payroll.txt")]: "ivan",
  }));
  // A link planted inside maria's folder that points at the owner's workspace.
  fs.symlinkSync(path.join(openclawHome, "workspace"), path.join(staffWorkspaceDir(openclawHome, "maria"), "owner-link"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const MARIA = { agentId: "clawbox-staff-maria", sessionKey: "agent:clawbox-staff-maria:clawbox-user-maria" };
const IVAN = { agentId: "clawbox-staff-ivan", sessionKey: "agent:clawbox-staff-ivan:clawbox-user-ivan" };
const OWNER = { agentId: "main", sessionKey: "agent:main:main" };

const call = (toolName: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ toolName, params, ...extra });

describe("whose calls it judges", () => {
  it("is a member of staff's agent, named by the context or by the session key", () => {
    expect(staffMemberOf(MARIA)).toBe("maria");
    expect(staffMemberOf({ sessionKey: "agent:clawbox-staff-ivan:clawbox-utab-0123456789ab-ivan" })).toBe("ivan");
    expect(staffMemberOf(OWNER)).toBeNull();
    expect(staffMemberOf({ agentId: "clawbox-staff-" })).toBeNull();
    expect(staffMemberOf({})).toBeNull();
  });

  it("never the owner's agent, whatever it calls", () => {
    for (const tool of ["exec", "web_search", "browser", "cron", "message", "gateway", "write"]) {
      expect(staffToolCallDenyReason(call(tool, { path: "/etc/passwd", command: "rm -rf /" }), OWNER, opts)).toBeNull();
    }
  });
});

describe("a member of staff's tools", () => {
  it.each([
    "exec", "process", "code_execution", "web_search", "web_fetch", "x_search", "browser", "terminal",
    "message", "cron", "automations", "gateway", "plugins", "openclaw", "sessions_spawn", "subagents", "sessions_send",
    "image_generate", "music_generate", "video_generate", "tts", "skill_workshop",
    "clawbox__email_send", "clawbox__browser_open", "clawbox__bash", "clawbox__system_power", "clawbox__update_run",
    "clawbox__ai_set_model", "clawbox__memory_shard_source_add", "clawbox__prime_radiant_page_create",
  ])("refuses %s", (tool) => {
    expect(staffToolCallDenyReason(call(tool), MARIA, opts)).toMatch(/not available to members of staff/);
  });

  it("lets Tool Search's controls through and judges a tool_call by the tool it names", () => {
    expect(staffToolCallDenyReason(call("tool_search", { query: "memory" }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("tool_describe", { id: "openclaw:core:memory_search" }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("tool_call", { id: "openclaw:core:memory_search", args: { query: "locker" } }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("tool_call", { id: "openclaw:core:automations", args: {} }), MARIA, opts)).toMatch(/`automations` is not available/);
    expect(staffToolCallDenyReason(call("tool_call", { id: "web_fetch", args: { url: "https://example.com" } }), MARIA, opts)).toMatch(/`web_fetch` is not available/);
    expect(staffToolCallDenyReason(call("tool_call", { id: "openclaw:core:write", args: { path: path.join(openclawHome, "openclaw.json"), content: "x" } }), MARIA, opts)).toMatch(/outside/);
    expect(staffToolCallDenyReason(call("tool_call", { args: {} }), MARIA, opts)).toMatch(/without a tool/);
    // The flat form: the target's fields beside the id.
    expect(staffToolCallDenyReason(call("tool_call", { id: "read", path: path.join(openclawHome, "openclaw.json") }), MARIA, opts)).toMatch(/outside/);
    expect(staffToolCallDenyReason(call("tool_call", { id: "write", path: "notes.md", content: "x" }), MARIA, opts)).toBeNull();
  });

  it("allows memory search and the clarifying question", () => {
    for (const tool of ["memory_search", "memory_get", "ask_user", "progress_card"]) {
      expect(STAFF_OPENCLAW_TOOLS.allow).toContain(tool);
      expect(staffToolCallDenyReason(call(tool, { query: "x" }), MARIA, opts)).toBeNull();
    }
  });
});

describe("a member of staff's files", () => {
  const maria = () => staffWorkspaceDir(openclawHome, "maria");

  it("may be written in their own folder, by absolute or relative path", () => {
    expect(staffToolCallDenyReason(call("write", { path: path.join(maria(), "report.md"), content: "x" }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("write", { path: "memory/2026-11-11.md", content: "x" }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("edit", { path: "MEMORY.md", oldText: "a", newText: "/etc/passwd" }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("apply_patch", { input: "*** Begin Patch\n*** Add File: out/summary.md\n+hi\n*** End Patch" }), MARIA, opts)).toBeNull();
  });

  it.each([
    ["the owner's MEMORY.md", () => path.join(openclawHome, "workspace", "MEMORY.md")],
    ["another member's MEMORY.md", () => path.join(staffWorkspaceDir(openclawHome, "ivan"), "MEMORY.md")],
    ["openclaw.json", () => path.join(openclawHome, "openclaw.json")],
    ["the owner's home", () => path.join(home, "notes.txt")],
    ["a path climbing out", () => "../ivan/MEMORY.md"],
    ["a tilde path", () => "~/x.txt"],
    ["through a link planted in their folder", () => "owner-link/MEMORY.md"],
  ])("may not be written to %s", (_label, target) => {
    expect(staffToolCallDenyReason(call("write", { path: target(), content: "x" }), MARIA, opts)).toMatch(/outside their own folder/);
  });

  it("refuses an apply_patch that names a file outside, or none at all", () => {
    expect(staffToolCallDenyReason(call("apply_patch", { input: `*** Begin Patch\n*** Update File: ${path.join(openclawHome, "openclaw.json")}\n*** End Patch` }), MARIA, opts)).toMatch(/outside/);
    expect(staffToolCallDenyReason(call("apply_patch", {}, { derivedPaths: [path.join(openclawHome, "workspace", "SOUL.md")] }), MARIA, opts)).toMatch(/outside/);
    expect(staffToolCallDenyReason(call("apply_patch", { input: "garbage" }), MARIA, opts)).toMatch(/without a file/);
    expect(staffToolCallDenyReason(call("write", { content: "x" }), MARIA, opts)).toMatch(/without a file/);
  });

  it("may be read from their folder and from the chat's staged attachments, and from nowhere else", () => {
    const attachment = path.join(openclawHome, "media", "chat-attachments", "batch1", "q3.xlsx.txt");
    expect(staffToolCallDenyReason(call("read", { path: attachment }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("pdf", { pdfs: [path.join(openclawHome, "media", "chat-attachments", "batch1", "a.pdf")] }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("read", { path: "report.md" }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("read", { path: path.join(openclawHome, "workspace", "MEMORY.md") }), MARIA, opts)).toMatch(/outside/);
    expect(staffToolCallDenyReason(call("view_image", { image: path.join(home, "photo.png") }), MARIA, opts)).toMatch(/outside/);
  });

  it("opens a staged attachment only for the member it was staged for, never another's by its path", () => {
    const staged = (...p: string[]) => path.join(openclawHome, "media", "chat-attachments", ...p);
    expect(staffToolCallDenyReason(call("read", { path: staged("batch2", "payroll.txt") }), IVAN, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("read", { path: staged("batch2", "payroll.txt") }), MARIA, opts)).toMatch(/attachment that is not theirs/);
    expect(staffToolCallDenyReason(call("read", { path: staged("batch1", "q3.xlsx.txt") }), IVAN, opts)).toMatch(/attachment that is not theirs/);
    // No record is nobody's: the owner's own uploads and the gateway's files.
    expect(staffToolCallDenyReason(call("read", { path: staged("owners-own.txt") }), MARIA, opts)).toMatch(/attachment that is not theirs/);
    expect(staffToolCallDenyReason(call("pdf", { pdfs: [staged("batch1", "a.pdf"), staged("batch2", "payroll.txt")] }), MARIA, opts)).toMatch(/not theirs/);
    // No owner record at all (not written, or unreadable): fail closed.
    expect(staffToolCallDenyReason(call("read", { path: staged("batch1", "q3.xlsx.txt") }), MARIA, { ...opts, mediaOwners: undefined })).toMatch(/not theirs/);
    expect(staffToolCallDenyReason(call("read", { path: staged("batch1", "q3.xlsx.txt") }), MARIA, { ...opts, mediaOwners: path.join(root, "missing.json") })).toMatch(/not theirs/);
    // The owner is not judged at all.
    expect(staffToolCallDenyReason(call("read", { path: staged("batch2", "payroll.txt") }), OWNER, opts)).toBeNull();
  });

  it("refuses a read that names no file, and lets an inline picture through", () => {
    expect(staffToolCallDenyReason(call("read", {}), MARIA, opts)).toMatch(/without a file/);
    expect(staffToolCallDenyReason(call("view_image", { prompt: "what is this?" }), MARIA, opts)).toMatch(/without a file/);
    expect(staffToolCallDenyReason(call("view_image", { image: "data:image/png;base64,iVBORw0KGgo=" }), MARIA, opts)).toBeNull();
    expect(staffToolCallDenyReason(call("read", { paths: [path.join(openclawHome, "workspace", "MEMORY.md")] }), MARIA, opts)).toMatch(/outside/);
  });

  it("is never fetched from the web", () => {
    expect(staffToolCallDenyReason(call("pdf", { pdf: "https://example.com/a.pdf" }), MARIA, opts)).toMatch(/nothing on the web/);
    expect(staffToolCallDenyReason(call("view_image", { image: "http://169.254.169.254/latest" }), MARIA, opts)).toMatch(/nothing on the web/);
  });
});

describe("two members of staff and the owner (the memory test, at the guard)", () => {
  it("lets A keep a fact in A's own MEMORY.md, never lets B read it, and never touches the owner's", () => {
    const aMemory = path.join(staffWorkspaceDir(openclawHome, "maria"), "MEMORY.md");
    const ownerMemory = path.join(openclawHome, "workspace", "MEMORY.md");
    const ownerBefore = fs.readFileSync(ownerMemory, "utf-8");

    // A: "remember that the vault code is 4711" — the agent writes its own memory.
    expect(staffToolCallDenyReason(call("write", { path: "MEMORY.md", content: "- the vault code is 4711\n" }), MARIA, opts)).toBeNull();
    fs.writeFileSync(aMemory, "- the vault code is 4711\n");
    // A writing it into the owner's memory instead is refused.
    expect(staffToolCallDenyReason(call("edit", { path: ownerMemory, oldText: "x", newText: "4711" }), MARIA, opts)).toMatch(/outside/);

    // B asks for it every way a file tool can.
    for (const target of [aMemory, "../maria/MEMORY.md", `file://${aMemory}`]) {
      expect(staffToolCallDenyReason(call("read", { path: target }), IVAN, opts)).toMatch(/outside/);
    }
    // B's own memory is B's.
    expect(staffToolCallDenyReason(call("read", { path: "MEMORY.md" }), IVAN, opts)).toBeNull();

    expect(fs.readFileSync(ownerMemory, "utf-8")).toBe(ownerBefore);
  });
});

describe("the plugin", () => {
  it("registers before_tool_call and answers with the core's block shape", () => {
    const hooks: string[] = [];
    plugin.register({ on: (name: string) => hooks.push(name) });
    expect(hooks).toEqual(["before_tool_call"]);
    const out = onBeforeToolCall({ toolName: "web_search", params: {} }, MARIA);
    expect(out).toEqual({ block: true, blockReason: staffDenyMessage("`web_search` is not available to members of staff") });
    expect(onBeforeToolCall({ toolName: "web_search", params: {} }, OWNER)).toBeUndefined();
  });

  it("tells the agent to stop and say so, not to look for another way", () => {
    expect(staffDenyMessage("x")).toMatch(/Do not retry/);
    expect(staffDenyMessage("x")).toMatch(/administrator/);
  });
});
