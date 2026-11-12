import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2377 — the staff roster sync fails CLOSED around the staff MCP grants:
 * when the guard's grants file cannot be written, or the store cannot be
 * planned from, no relay entry is written into openclaw.json (revocations
 * still go through) and the sync answers false, which the owner's settings
 * POST reports as `applied: false`.
 */

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "staff-sync-")));
const OPENCLAW_HOME = path.join(ROOT, ".openclaw");
const GUARD_DIR = path.join(OPENCLAW_HOME, "extensions", "clawbox-staff-guard");

const h = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  sets: [] as unknown[][],
  unsets: [] as string[],
  planThrows: false,
}));

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/config-store", () => ({ get: vi.fn(async () => undefined), set: vi.fn(async () => undefined), DATA_DIR: "/nonexistent" }));
vi.mock("@/lib/org-mode-server", () => ({ readOrgMode: vi.fn(async () => true) }));
vi.mock("@/lib/clawbox-users", () => ({ listUsers: vi.fn(async () => [{ username: "maria", createdAt: "x", sv: "1" }]) }));
vi.mock("@/lib/language-persona", () => ({ openclawWorkspaceDir: () => path.join(OPENCLAW_HOME, "workspace") }));
vi.mock("@/lib/local-ai-proxy-url", () => ({ getLocalAiProxyRootUrl: () => "http://127.0.0.1" }));
vi.mock("@/lib/openclaw-config", () => ({
  OPENCLAW_HOME: path.join(fs.realpathSync(os.tmpdir()), "unused"),
  openclawIsAbsent: () => false,
  isPlainObject: (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v),
  readConfigStrict: vi.fn(async () => h.config),
  runOpenclawConfigSetBatch: vi.fn(async (batch: unknown[][]) => { h.sets.push(...batch); }),
  runOpenclawConfigUnset: vi.fn(async (p: string) => { h.unsets.push(p); }),
}));
vi.mock("@/lib/staff-mcp", async () => {
  const actual = await vi.importActual<typeof import("@/lib/staff-mcp")>("@/lib/staff-mcp");
  return {
    ...actual,
    ensureRelayTokens: vi.fn(async () => {
      if (h.planThrows) throw new Error("store unreadable");
      return actual.parseStore({ servers: { docs: { header: "Authorization" } }, credentials: { maria: { docs: "tok" } }, relayTokens: { maria: "a".repeat(64) } });
    }),
  };
});

let sync: () => Promise<boolean>;

beforeAll(async () => {
  fs.mkdirSync(GUARD_DIR, { recursive: true });
  fs.mkdirSync(path.join(OPENCLAW_HOME, "workspace"), { recursive: true });
  const mod = await import("@/lib/openclaw-config");
  (mod as { OPENCLAW_HOME: string }).OPENCLAW_HOME = OPENCLAW_HOME;
  ({ syncStaffAgents: sync } = await import("@/lib/org-staff-agents"));
});

beforeEach(() => {
  h.sets.length = 0;
  h.unsets.length = 0;
  h.planThrows = false;
  h.config = {
    agents: { entries: { main: { workspace: path.join(OPENCLAW_HOME, "workspace") } } },
    mcp: { servers: { docs: { url: "https://docs.example.com/mcp", transport: "streamable-http" }, "cbstaff-deadbeef-old": { url: "http://127.0.0.1/setup-api/staff-mcp/old" } } },
  };
  fs.chmodSync(GUARD_DIR, 0o755);
});

afterAll(() => {
  fs.chmodSync(GUARD_DIR, 0o755);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const relaySets = () => h.sets.filter(([p]) => String(p).startsWith("mcp.servers["));

describe("the staff MCP part of the roster sync", () => {
  it("writes the member's relay entry and the guard's grants when all is well", async () => {
    expect(await sync()).toBe(true);
    expect(relaySets()).toHaveLength(1);
    expect(fs.readFileSync(path.join(GUARD_DIR, "staff-mcp-grants.json"), "utf-8")).toContain("clawbox-staff-maria");
  });

  it("grants nothing in the config, still revokes, and says so when the grants file cannot be written", async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    fs.rmSync(path.join(GUARD_DIR, "staff-mcp-grants.json"), { force: true });
    fs.chmodSync(GUARD_DIR, 0o555);
    expect(await sync()).toBe(false);
    expect(relaySets()).toHaveLength(0);
    expect(h.unsets).toContain('mcp.servers["cbstaff-deadbeef-old"]');
  });

  it("grants nothing and says so when the store cannot be planned from", async () => {
    h.planThrows = true;
    expect(await sync()).toBe(false);
    expect(relaySets()).toHaveLength(0);
  });
});
