import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import table from "../../../config/org-staff-policy.json";
import {
  STAFF_AGENT_PREFIX,
  STAFF_HERMES_TOOLS,
  STAFF_OPENCLAW_TOOLS,
  isStaffCatalogueCommand,
  staffAgentId,
  staffMessageVerdict,
  staffUsernameFromAgentId,
} from "@/lib/org-staff-policy";
import { staffAgentEntry } from "@/lib/org-staff-agents";

// One table, four readers (config/org-staff-policy.json): the TypeScript rules,
// their CommonJS mirror the user relay runs, and the two hook plugins. This
// file holds the first two to one case table and pins what the table says.

const require = createRequire(import.meta.url);
const cjs = require("../../../scripts/org-staff-policy.js") as {
  STAFF_AGENT_PREFIX: string;
  staffAgentId(username: string): string | null;
  staffMessageVerdict(message: unknown, options: { inline: boolean }): { ok: boolean; command?: string };
  isStaffCatalogueCommand(name: unknown): boolean;
  staffAgentConfigured(config: unknown, agentId: string): boolean;
  staffMcpAllowPrefix(agentId: string): string | null;
};

type Case = [message: string, inline: { ok: boolean; command?: string }, leading: { ok: boolean; command?: string }];

const OK = { ok: true };
const no = (command: string) => ({ ok: false, command });

/** [message, verdict with inline directives checked (OpenClaw), verdict on the leading command only (Hermes)] */
const CASES: Case[] = [
  ["hello there", OK, OK],
  ["/new", OK, OK],
  ["  /new  ", OK, OK],
  ["/NEW", OK, OK],
  ["/new claude-opus", no("/new <model>"), no("/new <model>")],
  ["/reasoning", OK, OK],
  ["/reasoning on", OK, OK],
  ["/reasoning high", OK, OK],
  ["/model", no("/model"), no("/model")],
  ["/model openai/gpt-5", no("/model"), no("/model")],
  ["/config set tools.profile full", no("/config"), no("/config")],
  ["/restart", no("/restart"), no("/restart")],
  ["/bash ls", no("/bash"), no("/bash")],
  ["/think:high", no("/think"), no("/think")],
  ["/cron add every day", no("/cron"), no("/cron")],
  ["/skill lead-finder", no("/skill"), no("/skill")],
  ["/learn", no("/learn"), no("/learn")],
  ["! ls -la", no("!"), no("!")],
  ["!rm -rf ~", no("!"), no("!")],
  // An inline directive is applied by OpenClaw from the middle of a message;
  // Hermes reads a command only at the start.
  ["please answer /model gpt-5", no("/model"), OK],
  ["summarise this /think high", no("/think"), OK],
  ["/reasoning on and /model x", no("/model"), OK],
  ["/new /model x", no("/new <model>"), no("/new <model>")],
  // Not commands: a path, a fraction, "and/or", a bare slash.
  ["read /srv/shared/report.pdf please", OK, OK],
  ["[Attached file: /home/clawbox/.openclaw/media/chat-attachments/abc/q3.xlsx — ClawBox saved its text in /home/clawbox/.openclaw/media/chat-attachments/abc/q3.xlsx.txt; read that file]", OK, OK],
  ["1/2 cup and/or 3/4", OK, OK],
  ["a / b", OK, OK],
  ["https://example.com/model is a link", OK, OK],
];

describe("the staff message rule, TypeScript and CommonJS alike", () => {
  it.each(CASES)("%j", (message, inline, leading) => {
    expect(staffMessageVerdict(message, { inline: true })).toEqual(inline);
    expect(cjs.staffMessageVerdict(message, { inline: true })).toEqual(inline);
    expect(staffMessageVerdict(message, { inline: false })).toEqual(leading);
    expect(cjs.staffMessageVerdict(message, { inline: false })).toEqual(leading);
  });

  it("lets anything that is not text through to the transport's own checks", () => {
    expect(staffMessageVerdict(undefined, { inline: true })).toEqual(OK);
    expect(cjs.staffMessageVerdict(42, { inline: true })).toEqual(OK);
  });
});

describe("the staff ids", () => {
  it("are the prefix and the username, in both readers", () => {
    expect(STAFF_AGENT_PREFIX).toBe("clawbox-staff-");
    expect(cjs.STAFF_AGENT_PREFIX).toBe(STAFF_AGENT_PREFIX);
    expect(staffAgentId("maria")).toBe("clawbox-staff-maria");
    expect(cjs.staffAgentId("maria")).toBe("clawbox-staff-maria");
    expect(staffUsernameFromAgentId("clawbox-staff-maria")).toBe("maria");
  });

  it("refuse a name that is not a ClawBox username", () => {
    for (const bad of ["", "Maria", "../x", "a b", "x".repeat(33), "-x"]) {
      expect(staffAgentId(bad)).toBeNull();
      expect(cjs.staffAgentId(bad)).toBeNull();
    }
    expect(staffUsernameFromAgentId("main")).toBeNull();
    expect(staffUsernameFromAgentId("clawbox-staff-")).toBeNull();
  });

  it("fit both cores' agent/profile id rule", () => {
    const longest = staffAgentId("a".repeat(32))!;
    expect(longest).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  });
});

describe("the catalogue a member of staff is shown", () => {
  it("is /new and /reasoning", () => {
    for (const name of ["new", "/new", "reasoning", "/Reasoning"]) {
      expect(isStaffCatalogueCommand(name)).toBe(true);
      expect(cjs.isStaffCatalogueCommand(name)).toBe(true);
    }
    for (const name of ["model", "/config", "restart", "think", "reset", "bash", "", null]) {
      expect(isStaffCatalogueCommand(name)).toBe(false);
      expect(cjs.isStaffCatalogueCommand(name)).toBe(false);
    }
  });
});

describe("the table", () => {
  it("gives staff no web, browser, messages, automations, sub-agents, generation, shell or system tools on OpenClaw", () => {
    const deny = STAFF_OPENCLAW_TOOLS.deny;
    for (const group of ["group:runtime", "group:web", "group:ui", "group:automation", "group:messaging", "group:sessions", "group:nodes"]) {
      expect(deny).toContain(group);
    }
    for (const tool of ["image_generate", "music_generate", "video_generate", "tts", "skill_workshop", "clawbox__*"]) {
      expect(deny).toContain(tool);
    }
    // The allow-list names none of them.
    for (const tool of ["exec", "process", "code_execution", "web_search", "web_fetch", "browser", "message", "cron", "automations",
      "gateway", "plugins", "openclaw", "sessions_spawn", "subagents", "sessions_send", "image_generate", "tts", "skill_workshop"]) {
      expect(STAFF_OPENCLAW_TOOLS.allow).not.toContain(tool);
    }
    // What they keep: their files, attachments and their own memory.
    expect(STAFF_OPENCLAW_TOOLS.allow).toEqual(expect.arrayContaining(["read", "write", "edit", "pdf", "view_image", "memory_search", "memory_get"]));
  });

  it("gives staff no web, browser, terminal, code, delegation, cron, generation, TTS or skills on Hermes", () => {
    for (const toolset of ["web", "search", "browser", "terminal", "code_execution", "delegation", "cronjob", "image_gen", "video_gen", "tts", "skills", "computer_use"]) {
      expect(STAFF_HERMES_TOOLS.disabledToolsets).toContain(toolset);
      expect(STAFF_HERMES_TOOLS.toolsets).not.toContain(toolset);
    }
    for (const tool of ["terminal", "web_search", "web_extract", "execute_code", "delegate_task", "cronjob_manage", "skill_manage", "image_generate", "text_to_speech"]) {
      expect(STAFF_HERMES_TOOLS.allowTools).not.toContain(tool);
    }
    expect(STAFF_HERMES_TOOLS.toolsets).toEqual(expect.arrayContaining(["file", "vision", "memory"]));
  });

  it("allows only the two commands the card names", () => {
    expect(table.slashCommands).toEqual(["new", "reasoning"]);
  });

  it("keeps its write and read tools inside its allow-lists", () => {
    for (const tool of [...STAFF_OPENCLAW_TOOLS.writeTools, ...STAFF_OPENCLAW_TOOLS.readTools]) expect(STAFF_OPENCLAW_TOOLS.allow).toContain(tool);
    for (const tool of [...STAFF_HERMES_TOOLS.writeTools, ...STAFF_HERMES_TOOLS.readTools]) expect(STAFF_HERMES_TOOLS.allowTools).toContain(tool);
  });
});

describe("the relay's readiness check and a member's MCP grants (TASK-2377)", () => {
  it("passes a member's own relay entries and fails another member's", async () => {
    const { staffEntryName } = await import("@/lib/staff-mcp");
    const mine = staffEntryName("maria", "docs");
    const hashed = staffEntryName("maria", "a-very-long-server-name-for-hashing");
    const theirs = staffEntryName("ivan", "docs");
    const entry = staffAgentEntry("/home/clawbox/.openclaw", "maria", [mine, hashed]);
    expect(cjs.staffMcpAllowPrefix("clawbox-staff-maria")).toBe(mine.slice(0, mine.length - "docs".length));
    expect(cjs.staffAgentConfigured({ agents: { entries: { "clawbox-staff-maria": entry } } }, "clawbox-staff-maria")).toBe(true);
    const foreign = staffAgentEntry("/home/clawbox/.openclaw", "maria", [theirs]);
    expect(cjs.staffAgentConfigured({ agents: { entries: { "clawbox-staff-maria": foreign } } }, "clawbox-staff-maria")).toBe(false);
    const glob = { ...entry, tools: { ...(entry.tools as object), allow: [...STAFF_OPENCLAW_TOOLS.allow, "cbstaff-*"] } };
    expect(cjs.staffAgentConfigured({ agents: { entries: { "clawbox-staff-maria": glob } } }, "clawbox-staff-maria")).toBe(false);
    expect(cjs.staffMcpAllowPrefix("main")).toBeNull();
  });
});

describe("the relay's readiness check against the roster entry ClawBox writes", () => {
  const entry = staffAgentEntry("/home/clawbox/.openclaw", "maria");

  it("passes the entry as written, keyed or listed", () => {
    expect(cjs.staffAgentConfigured({ agents: { entries: { main: {}, "clawbox-staff-maria": entry } } }, "clawbox-staff-maria")).toBe(true);
    expect(cjs.staffAgentConfigured({ agents: { list: [{ id: "main" }, { id: "clawbox-staff-maria", ...entry }] } }, "clawbox-staff-maria")).toBe(true);
  });

  it("fails an agent the roster does not have, or one whose policy was widened", () => {
    const widen = (tools: Record<string, unknown>) => ({ agents: { entries: { "clawbox-staff-maria": { ...entry, tools: { ...(entry.tools as object), ...tools } } } } });
    expect(cjs.staffAgentConfigured({}, "clawbox-staff-maria")).toBe(false);
    expect(cjs.staffAgentConfigured({ agents: { entries: { main: {} } } }, "clawbox-staff-maria")).toBe(false);
    expect(cjs.staffAgentConfigured(widen({ allow: [...STAFF_OPENCLAW_TOOLS.allow, "exec"] }), "clawbox-staff-maria")).toBe(false);
    expect(cjs.staffAgentConfigured(widen({ deny: ["group:web"] }), "clawbox-staff-maria")).toBe(false);
    expect(cjs.staffAgentConfigured(widen({ alsoAllow: ["web_search"] }), "clawbox-staff-maria")).toBe(false);
    expect(cjs.staffAgentConfigured(widen({ profile: "coding" }), "clawbox-staff-maria")).toBe(false);
    // entries wins over list, as in the core.
    expect(cjs.staffAgentConfigured({ agents: { entries: { main: {} }, list: [{ id: "clawbox-staff-maria", ...entry }] } }, "clawbox-staff-maria")).toBe(false);
  });
});
