import { describe, expect, it } from "vitest";
import { NO_MARKS, planStaffRoster, staffAgentEntry, staffWorkspaceDir, type RosterWrite, type StaffRosterMarks } from "@/lib/org-staff-agents";

// The OpenClaw roster an organisation box keeps (src/lib/org-staff-agents.ts):
// one agent per member of staff while `org_mode` is on, each with the staff
// tool policy and its own workspace; the owner's agent named as the fleet's
// owner so channels and heartbeats keep going to it; and, with the switch
// off, exactly what ClawBox added taken back — nothing the owner set.

const HOME = "/home/clawbox/.openclaw";
const OWNER_WS = "/home/clawbox/.openclaw/workspace";

/** Apply a plan to a config the way the gateway's merge patch would. */
function apply(config: Record<string, unknown>, writes: readonly RosterWrite[]): Record<string, unknown> {
  const out = structuredClone(config);
  for (const write of writes) {
    const segments = write.path.match(/[^.[\]"]+/g)!;
    let node = out as Record<string, unknown>;
    for (const seg of segments.slice(0, -1)) {
      if (typeof node[seg] !== "object" || node[seg] === null) node[seg] = {};
      node = node[seg] as Record<string, unknown>;
    }
    const last = segments[segments.length - 1];
    if (write.value === undefined) delete node[last];
    else node[last] = structuredClone(write.value);
  }
  return out;
}

function sync(config: Record<string, unknown>, staff: string[], marks: StaffRosterMarks | null) {
  const plan = planStaffRoster(config, { staff, openclawHome: HOME, ownerWorkspace: OWNER_WS, marks });
  return { config: apply(config, plan.writes), marks: plan.marks, writes: plan.writes };
}

describe("a box with no roster, the switch turned on with two members of staff", () => {
  const before = { agents: { defaults: { model: { primary: "clawai/flash" } } }, tools: { profile: "full" } };
  const on = sync(before, ["maria", "ivan"], null);

  it("gets one agent each, with the staff policy and its own workspace", () => {
    const entries = (on.config.agents as { entries: Record<string, unknown> }).entries;
    expect(entries["clawbox-staff-maria"]).toEqual(staffAgentEntry(HOME, "maria"));
    expect(entries["clawbox-staff-ivan"]).toEqual(staffAgentEntry(HOME, "ivan"));
    expect((entries["clawbox-staff-maria"] as { workspace: string }).workspace).toBe(staffWorkspaceDir(HOME, "maria"));
    expect(staffWorkspaceDir(HOME, "maria")).not.toBe(staffWorkspaceDir(HOME, "ivan"));
    // Under the state directory, where the Files app's workspace carve-out does not reach.
    expect(staffWorkspaceDir(HOME, "maria")).toBe(`${HOME}/staff/maria`);
  });

  it("names the owner's agent as the fleet's owner, its workspace pinned where it is", () => {
    const agents = on.config.agents as Record<string, unknown> & { entries: Record<string, unknown>; defaults: Record<string, unknown> };
    expect(agents.entries.main).toEqual({ workspace: OWNER_WS });
    expect(agents.ownership).toBe("explicit");
    expect((agents.defaults.systemAgent as { agentId: string }).agentId).toBe("main");
    expect(on.marks).toEqual({ ownerEntry: { id: "main", workspace: OWNER_WS }, ownership: true, systemAgent: "main" });
  });

  it("gives every staff agent the tool policy that cannot reach the web, the shell or the device", () => {
    const tools = (staffAgentEntry(HOME, "maria") as { tools: { allow: string[]; deny: string[]; profile: string; elevated: { enabled: boolean } } }).tools;
    expect(tools.profile).toBe("full");
    expect(tools.allow).not.toEqual(expect.arrayContaining(["exec"]));
    expect(tools.deny).toEqual(expect.arrayContaining(["group:web", "group:runtime", "group:automation", "group:messaging", "group:sessions", "group:ui", "skill_workshop", "clawbox__*"]));
    expect(tools.elevated).toEqual({ enabled: false });
    expect((staffAgentEntry(HOME, "maria") as { skills: unknown[] }).skills).toEqual([]);
  });

  it("is idempotent: the same switch again writes nothing", () => {
    expect(sync(on.config, ["maria", "ivan"], on.marks).writes).toEqual([]);
  });

  it("adds and removes one member without touching the others", () => {
    const next = sync(on.config, ["maria", "elena"], on.marks);
    expect(next.writes).toEqual([
      { path: 'agents.entries["clawbox-staff-ivan"]' },
      { path: 'agents.entries["clawbox-staff-elena"]', value: staffAgentEntry(HOME, "elena") },
    ]);
    expect(next.marks).toEqual(on.marks);
  });

  it("repairs an entry someone widened", () => {
    const widened = structuredClone(on.config) as { agents: { entries: Record<string, { tools: { allow: string[] } }> } };
    widened.agents.entries["clawbox-staff-maria"].tools.allow.push("exec");
    const fix = sync(widened, ["maria", "ivan"], on.marks);
    expect(fix.writes).toEqual([{ path: 'agents.entries["clawbox-staff-maria"]', value: staffAgentEntry(HOME, "maria") }]);
  });

  it("turned off again, loses every staff agent and keeps the owner's agent exactly where it was", () => {
    const off = sync(on.config, [], on.marks);
    expect(off.writes).toEqual([
      { path: 'agents.entries["clawbox-staff-maria"]' },
      { path: 'agents.entries["clawbox-staff-ivan"]' },
    ]);
    const agents = off.config.agents as { entries: Record<string, unknown>; ownership: string; defaults: { systemAgent: { agentId: string } } };
    // The same agent, the same workspace the core resolved before the switch:
    // nothing the owner's assistant does changes, and no write takes the
    // roster away from under a running gateway.
    expect(agents.entries).toEqual({ main: { workspace: OWNER_WS } });
    expect(agents.ownership).toBe("explicit");
    expect(agents.defaults.systemAgent.agentId).toBe("main");
    expect(off.marks).toEqual(on.marks);
    // And it settles: the same switch again writes nothing, and on again only adds staff.
    expect(sync(off.config, [], off.marks).writes).toEqual([]);
    const again = sync(off.config, ["maria"], off.marks);
    expect(again.writes).toEqual([{ path: 'agents.entries["clawbox-staff-maria"]', value: staffAgentEntry(HOME, "maria") }]);
  });
});

describe("a box whose owner already has a roster", () => {
  const before = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "home" } },
      entries: { home: { workspace: "/w/home" }, work: { workspace: "/w/work" } },
    },
  };

  it("only gains the staff agents; the owner's fleet and its owner are left as they are", () => {
    const on = sync(before, ["maria"], null);
    expect(on.writes).toEqual([{ path: 'agents.entries["clawbox-staff-maria"]', value: staffAgentEntry(HOME, "maria") }]);
    expect(on.marks).toEqual(NO_MARKS);
    const off = sync(on.config, [], on.marks);
    expect(off.config).toEqual(before);
  });

  it("with a legacy list, gets the staff agents appended and taken back out", () => {
    const legacy = { agents: { list: [{ id: "main", default: true }, { id: "ops" }] } };
    const on = sync(legacy, ["maria"], null);
    expect((on.config.agents as { list: Array<{ id: string }> }).list.map((a) => a.id)).toEqual(["main", "ops", "clawbox-staff-maria"]);
    // The legacy default marker still names the owner's agent; nothing else is written.
    expect((on.config.agents as Record<string, unknown>).ownership).toBeUndefined();
    const off = sync(on.config, [], on.marks);
    expect((off.config.agents as { list: Array<{ id: string }> }).list.map((a) => a.id)).toEqual(["main", "ops"]);
  });
});

describe("a member of staff's agent never becomes the box's", () => {
  it("is never named the fleet's owner, even on a roster that holds nothing else", () => {
    const config = { agents: { entries: { "clawbox-staff-maria": staffAgentEntry(HOME, "maria") } } };
    const plan = planStaffRoster(config, { staff: ["maria"], openclawHome: HOME, ownerWorkspace: OWNER_WS, marks: null });
    expect(plan.writes).toContainEqual({ path: "agents.defaults.systemAgent.agentId", value: "main" });
    expect(plan.writes).toContainEqual({ path: 'agents.entries["main"]', value: { workspace: OWNER_WS } });
  });
});

// TASK-2377 (G2): the MCP servers the owner granted to staff reach each
// member's agent as relay entries of their own — `<entry>__*` in THAT agent's
// allow-list, the entry in `mcp.servers`, and a `cbstaff-*` deny on every
// agent of the owner's — and go again with the grant.
describe("staff MCP grants", () => {
  const entry = (name: string, token: string) => ({
    name,
    server: "docs",
    config: { url: "http://127.0.0.1/setup-api/staff-mcp/docs", transport: "streamable-http", headers: { Authorization: `Bearer ${token}` } },
  });
  const grants = new Map([
    ["maria", [entry("cbstaff-aaaaaaaa-docs", "a".repeat(64))]],
    ["ivan", [entry("cbstaff-bbbbbbbb-docs", "b".repeat(64))]],
  ]);
  const syncWith = (config: Record<string, unknown>, staff: string[], mcp?: typeof grants) => {
    const plan = planStaffRoster(config, { staff, openclawHome: HOME, ownerWorkspace: OWNER_WS, marks: null, mcp });
    return apply(config, plan.writes);
  };
  const owned = {
    agents: { entries: { main: { workspace: OWNER_WS, tools: { deny: ["browser"] } } }, ownership: "explicit", defaults: { systemAgent: { agentId: "main" } } },
    mcp: { servers: { docs: { url: "https://docs.example.com/mcp" }, clawbox: { command: "bun" } } },
  };

  it("gives each member exactly their own relay entry, and the owner's agent the deny", () => {
    const next = syncWith(owned, ["maria", "ivan"], grants) as { agents: { entries: Record<string, { tools: { allow?: string[]; deny?: string[] } }> }; mcp: { servers: Record<string, unknown> } };
    const maria = next.agents.entries["clawbox-staff-maria"].tools;
    const ivan = next.agents.entries["clawbox-staff-ivan"].tools;
    expect(maria.allow).toContain("cbstaff-aaaaaaaa-docs__*");
    expect(maria.allow).not.toContain("cbstaff-bbbbbbbb-docs__*");
    expect(ivan.allow).toContain("cbstaff-bbbbbbbb-docs__*");
    expect(ivan.allow).not.toContain("cbstaff-aaaaaaaa-docs__*");
    // Never the device's own tools.
    expect(maria.deny).toContain("clawbox__*");
    expect(maria.allow?.some((t) => t.startsWith("clawbox__") || t === "docs__*")).toBe(false);
    expect(next.mcp.servers["cbstaff-aaaaaaaa-docs"]).toEqual(grants.get("maria")![0].config);
    expect(next.mcp.servers["cbstaff-bbbbbbbb-docs"]).toEqual(grants.get("ivan")![0].config);
    // The owner's own servers untouched; the owner's agent keeps its deny and gains the staff one.
    expect(next.mcp.servers.docs).toEqual({ url: "https://docs.example.com/mcp" });
    expect(next.agents.entries.main.tools.deny).toEqual(["browser", "cbstaff-*"]);
  });

  it("takes the entries, the allow and the deny away again when nothing is granted", () => {
    const granted = syncWith(owned, ["maria", "ivan"], grants);
    const next = syncWith(granted, ["maria", "ivan"], new Map()) as typeof owned & { agents: { entries: Record<string, { tools: { allow?: string[]; deny?: string[] } }> } };
    expect(Object.keys(next.mcp.servers).sort()).toEqual(["clawbox", "docs"]);
    expect(next.agents.entries.main.tools.deny).toEqual(["browser"]);
    expect(next.agents.entries["clawbox-staff-maria"].tools.allow?.some((t) => t.startsWith("cbstaff-"))).toBe(false);
  });

  it("is idempotent", () => {
    const once = syncWith(owned, ["maria", "ivan"], grants);
    const plan = planStaffRoster(once, { staff: ["maria", "ivan"], openclawHome: HOME, ownerWorkspace: OWNER_WS, marks: null, mcp: grants });
    expect(plan.writes).toEqual([]);
  });

  it("pins the owner's agent with the deny on a box with no roster", () => {
    const next = syncWith({}, ["maria"], new Map([["maria", grants.get("maria")!]])) as { agents: { entries: Record<string, { tools?: { deny?: string[] } }> } };
    expect(next.agents.entries.main.tools?.deny).toEqual(["cbstaff-*"]);
  });

  it("writes no deny and no entry for a member without grants", () => {
    const next = syncWith(owned, ["maria"]) as typeof owned;
    expect(Object.keys(next.mcp.servers).sort()).toEqual(["clawbox", "docs"]);
    expect((next.agents.entries.main as { tools: { deny: string[] } }).tools.deny).toEqual(["browser"]);
  });
});
