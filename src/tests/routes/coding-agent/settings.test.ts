/**
 * /setup-api/coding-agent/settings — the coding TEAM's parameters, the one
 * door through which the ASSISTANT may change a coding-agent setting
 * (src/lib/coding-settings-patch.ts).
 *
 * The properties under test: the owner's cookie and the MCP bearer are both
 * admitted, a signed-in non-owner is 403 `owner_only`, every field the enable
 * route keeps for the owner's consent is refused HERE by name (400, naming
 * the Settings page) with nothing written, every settable field round-trips
 * through the enable route's own setter, a bad value is refused whole before
 * any setter runs, and the history setting hands Claude Code's transcript
 * period back the way the enable route does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createSessionCookie } from "@/lib/auth";
import { applyRoleModelsPatch, type RoleModels } from "@/lib/coding-role-models";
import { saveEnv } from "@/tests/helpers/env";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

const setters = vi.hoisted(() => ({
  setEffort: vi.fn(),
  setRoleModels: vi.fn(),
  setReviewPass: vi.fn(),
  setAutoPr: vi.fn(),
  setAutoMerge: vi.fn(),
  setPrBodyIncludesTask: vi.fn(),
  setTeamDynamic: vi.fn(),
  setMaxParallelRuns: vi.fn(),
  setHistoryRetention: vi.fn(),
  setGenerateMedia: vi.fn(),
  setCodingGitAuthor: vi.fn(),
  // The owner-only setters: the test proves none of them is ever reached.
  setCodingAgentEnabled: vi.fn(),
  setDefaultDirectory: vi.fn(),
  setCodingProvider: vi.fn(),
  setConnectedProviders: vi.fn(),
  setRealBrowser: vi.fn(),
  setSetupComplete: vi.fn(),
  clearHarnessFault: vi.fn(),
}));
const getStatus = vi.hoisted(() => vi.fn());
const getConnectedProviders = vi.hoisted(() => vi.fn());
/** What is stored for the roles — the real patch logic runs against it. */
const stored = vi.hoisted(() => ({ roles: {} as Record<string, unknown> }));

vi.mock("@/lib/coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/coding-agent")>();
  const { applyRoleModelsPatch } = await import("@/lib/coding-role-models");
  return {
    ...actual,
    ...setters,
    hostMaxParallelRuns: () => 4,
    getCodingAgentStatus: getStatus,
    getConnectedProviders,
    checkRoleModelsPatch: async (patch: unknown) => {
      const r = applyRoleModelsPatch(stored.roles as RoleModels, patch);
      return r.ok ? null : r.error;
    },
  };
});

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";
const ALICE = { username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: "a1b2c3d4e5f60718" };

const STATUS = {
  effort: "xhigh",
  effortLevels: ["low", "xhigh", "max", "ultracode"],
  roleModels: {
    planner: { provider: "auto", model: "auto", effort: "auto" },
    worker: { provider: "auto", model: "auto", effort: "auto" },
    reviewer: { provider: "auto", model: "auto", effort: "auto" },
  },
  roleModelMap: {
    planner: { provider: "clawbox-ai", model: "deepseek-v4-flash", effort: "xhigh", auto: true, ready: true, problems: [], relativeCost: 1 },
    worker: { provider: "clawbox-ai", model: null, effort: "xhigh", auto: true, ready: true, problems: [], relativeCost: null },
    reviewer: { provider: "clawbox-ai", model: "deepseek-v4-flash", effort: "xhigh", auto: true, ready: true, problems: [], relativeCost: 1 },
  },
  connectedProviders: ["clawbox-ai", "anthropic"],
  reviewPass: false,
  autoPr: false,
  autoMerge: false,
  prBodyIncludesTask: "summary",
  teamDynamic: false,
  maxParallelRuns: 2,
  minMaxParallelRuns: 1,
  maxMaxParallelRuns: 4,
  historyRetention: "standard",
  generateMedia: true,
  gitAuthorName: null,
  gitAuthorEmail: null,
  maxGitAuthorChars: 200,
  // Fields of the status this door must NOT hand out or take.
  enabled: true,
  defaultDirectory: "/srv/projects",
  realBrowser: true,
  allowRules: ["Bash(npm test)"],
  injectSecrets: false,
  setupComplete: true,
  provider: "clawbox-ai",
  providers: ["clawbox-ai", "anthropic"],
};

let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let session: SessionFixture;
let restore: () => void;

type Auth = { cookie?: string; bearer?: string; origin?: string };

function post(body: unknown, auth: Auth = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.origin !== undefined) headers.origin = auth.origin;
  return new Request("http://localhost/setup-api/coding-agent/settings", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function get(auth: Auth = {}): Request {
  const headers: Record<string, string> = { host: "localhost" };
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  return new Request("http://localhost/setup-api/coding-agent/settings", { headers });
}

/** A cookie of a ClawBox user who is not the owner, listed in the fixture's registry. */
function userCookie(): string {
  const dataDir = path.join(session.root, "data");
  const configPath = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.clawbox_users = [ALICE];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const secret = fs.readFileSync(path.join(dataDir, ".session-secret"), "utf8");
  return `clawbox_session=${createSessionCookie(3600, secret, 0, { u: ALICE.username, sv: ALICE.sv })}`;
}

const owner = () => ({ cookie: session.cookie });
const agent = () => ({ bearer: MCP_TOKEN });

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  stored.roles = {};
  getStatus.mockResolvedValue(STATUS);
  getConnectedProviders.mockResolvedValue(["clawbox-ai", "anthropic"]);
  setters.setEffort.mockImplementation(async (v: string) => v);
  setters.setRoleModels.mockImplementation(async (patch: unknown) => {
    const r = applyRoleModelsPatch(stored.roles as RoleModels, patch);
    if (!r.ok) throw new Error(r.error);
    stored.roles = r.value;
    return r.value;
  });
  for (const s of [setters.setReviewPass, setters.setAutoPr, setters.setAutoMerge, setters.setTeamDynamic, setters.setGenerateMedia]) {
    s.mockImplementation(async (on: boolean) => on);
  }
  setters.setPrBodyIncludesTask.mockImplementation(async (m: string) => m);
  setters.setMaxParallelRuns.mockImplementation(async (n: number) => n);
  setters.setHistoryRetention.mockImplementation(async (mode: string) => ({
    policy: { mode },
    transcripts: [{ file: "/srv/home/box/.claude-ds/settings.json", state: mode === "everything" ? "pinned" : "released" }],
  }));
  setters.setCodingGitAuthor.mockImplementation(async (input: { name?: string | null; email?: string | null }) => ({
    ...(input.name !== undefined ? { name: input.name && input.name.trim() ? input.name.trim() : null } : {}),
    ...(input.email !== undefined ? { email: input.email && input.email.trim() ? input.email.trim() : null } : {}),
  }));
  const route = await import("@/app/setup-api/coding-agent/settings/route");
  GET = route.GET;
  POST = route.POST;
});

afterEach(() => {
  session.cleanup();
  restore();
});

const ownerOnlySetters = () => [
  setters.setCodingAgentEnabled, setters.setDefaultDirectory, setters.setCodingProvider, setters.setConnectedProviders,
  setters.setRealBrowser, setters.setSetupComplete, setters.clearHarnessFault,
];
const everySetter = () => Object.values(setters);

describe("who may read and change the team's settings", () => {
  it("admits the owner's cookie to both verbs", async () => {
    expect((await GET(get(owner()))).status).toBe(200);
    const res = await POST(post({ reviewPass: true }, owner()));
    expect(res.status).toBe(200);
    expect(setters.setReviewPass).toHaveBeenCalledWith(true);
  });

  it("admits the MCP bearer — the assistant is the party the route exists for — with no Origin to check", async () => {
    expect((await GET(get(agent()))).status).toBe(200);
    const res = await POST(post({ reviewPass: true }, agent()));
    expect(res.status).toBe(200);
    expect(setters.setReviewPass).toHaveBeenCalledWith(true);
  });

  it("answers a signed-in non-owner 403 owner_only — never 401 — and writes nothing", async () => {
    const cookie = userCookie();
    const res = await POST(post({ reviewPass: true }, { cookie }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
    expect((await GET(get({ cookie }))).status).toBe(403);
    expect(setters.setReviewPass).not.toHaveBeenCalled();
  });

  it("refuses no credential, and a bearer that is not the box's own, with the identical 403", async () => {
    const bare = await POST(post({ reviewPass: true }));
    const wrong = await POST(post({ reviewPass: true }, { bearer: "not-the-token-0123456789abcdef" }));
    expect(bare.status).toBe(403);
    expect(wrong.status).toBe(403);
    const answer = await bare.json();
    expect(answer).toEqual(await wrong.json());
    expect(answer.kind).toBe("owner_only");
    expect(setters.setReviewPass).not.toHaveBeenCalled();
  });

  it("refuses another site's page even with the owner's cookie", async () => {
    const res = await POST(post({ reviewPass: true }, { ...owner(), origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("cross_origin");
    expect(setters.setReviewPass).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("answers the settable set and the valid choices, and none of the owner-only fields", async () => {
    const body = await (await GET(get(agent()))).json();
    expect(body).toMatchObject({
      effort: "xhigh",
      effortLevels: ["low", "xhigh", "max", "ultracode"],
      roleModels: STATUS.roleModels,
      roleModelMap: STATUS.roleModelMap,
      roleModelTiers: ["standard", "economy"],
      connectedProviders: ["clawbox-ai", "anthropic"],
      providerModels: {
        "clawbox-ai": ["deepseek-v4-flash"],
        anthropic: ["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"],
      },
      reviewPass: false,
      autoPr: false,
      autoMerge: false,
      prBodyIncludesTask: "summary",
      prBodyTaskModes: ["summary", "full-redacted", "none"],
      teamDynamic: false,
      maxParallelRuns: 2,
      minMaxParallelRuns: 1,
      maxMaxParallelRuns: 4,
      historyRetention: "standard",
      historyRetentionModes: ["standard", "everything"],
      generateMedia: true,
      gitAuthorName: null,
      gitAuthorEmail: null,
    });
    expect(body.roleEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
    for (const key of ["enabled", "defaultDirectory", "realBrowser", "allowRules", "injectSecrets", "setupComplete", "provider", "providers"]) {
      expect(body, key).not.toHaveProperty(key);
    }
  });
});

describe("the excluded set", () => {
  it.each([
    ["enabled", { enabled: false }],
    ["defaultDirectory", { defaultDirectory: "/srv/elsewhere" }],
    ["provider", { provider: "anthropic" }],
    ["providers", { providers: ["anthropic"] }],
    ["realBrowser", { realBrowser: true }],
    ["allowRules", { allowRules: ["Bash(*)"] }],
    ["injectSecrets", { injectSecrets: true }],
    ["secrets", { secrets: { API_KEY: "x" } }],
    ["setupComplete", { setupComplete: true }],
    ["clearHarnessFault", { clearHarnessFault: true }],
  ])("refuses %s by name with 400 owner_setting, naming the Settings page, and writes nothing", async (field, body) => {
    for (const auth of [owner(), agent()]) {
      const res = await POST(post(body, auth));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.kind).toBe("owner_setting");
      expect(json.error).toContain(`"${field}"`);
      expect(json.error).toContain("Settings page");
    }
    for (const s of everySetter()) expect(s).not.toHaveBeenCalled();
  });

  it("refuses an owner-only field even beside a good settable one, before anything is written", async () => {
    const res = await POST(post({ reviewPass: true, enabled: false }, agent()));
    expect(res.status).toBe(400);
    expect((await res.json()).kind).toBe("owner_setting");
    expect(setters.setReviewPass).not.toHaveBeenCalled();
    for (const s of ownerOnlySetters()) expect(s).not.toHaveBeenCalled();
  });

  it("refuses an unknown field, an empty body and a non-object body as 400 invalid", async () => {
    for (const body of [{ maxTurns: 50 }, {}, "a string", 42, [1]]) {
      const res = await POST(post(body, agent()));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).kind).toBe("invalid");
    }
    expect((await POST(post("{not json", agent()))).status).toBe(400);
    for (const s of everySetter()) expect(s).not.toHaveBeenCalled();
  });
});

describe("each settable field round-trips through the enable route's own setter", () => {
  it.each([
    ["effort", { effort: "max" }, () => setters.setEffort, "max"],
    ["reviewPass", { reviewPass: true }, () => setters.setReviewPass, true],
    ["autoPr", { autoPr: true }, () => setters.setAutoPr, true],
    ["autoMerge", { autoMerge: true }, () => setters.setAutoMerge, true],
    ["prBodyIncludesTask", { prBodyIncludesTask: "none" }, () => setters.setPrBodyIncludesTask, "none"],
    ["teamDynamic", { teamDynamic: true }, () => setters.setTeamDynamic, true],
    ["maxParallelRuns", { maxParallelRuns: 3 }, () => setters.setMaxParallelRuns, 3],
    ["generateMedia", { generateMedia: false }, () => setters.setGenerateMedia, false],
  ] as const)("%s", async (field, body, setter, value) => {
    const res = await POST(post(body, agent()));
    expect(res.status).toBe(200);
    expect(setter()).toHaveBeenCalledTimes(1);
    expect(setter()).toHaveBeenCalledWith(value);
    const json = await res.json();
    expect(json.changed).toEqual([field]);
    expect(json.settings).toMatchObject({ effort: "xhigh" });
    expect(json.settings).not.toHaveProperty("enabled");
  });

  it("sets the commit identity in ONE setter call for both halves, and clears a half with null or an empty string", async () => {
    let res = await POST(post({ gitAuthorName: "Ada Lovelace", gitAuthorEmail: "ada@example.com" }, owner()));
    expect(res.status).toBe(200);
    expect(setters.setCodingGitAuthor).toHaveBeenCalledTimes(1);
    expect(setters.setCodingGitAuthor).toHaveBeenCalledWith({ name: "Ada Lovelace", email: "ada@example.com" });
    expect((await res.json()).changed).toEqual(["gitAuthorName", "gitAuthorEmail"]);
    res = await POST(post({ gitAuthorEmail: null }, agent()));
    expect(res.status).toBe(200);
    expect(setters.setCodingGitAuthor).toHaveBeenLastCalledWith({ email: null });
    res = await POST(post({ gitAuthorName: "" }, agent()));
    expect(res.status).toBe(200);
    expect(setters.setCodingGitAuthor).toHaveBeenLastCalledWith({ name: "" });
  });

  it("pins a role's provider, model and effort through setRoleModels, and 'auto' resets a half", async () => {
    let res = await POST(post({ roleModels: { planner: { provider: "anthropic", model: "claude-sonnet-5", effort: "high" } } }, agent()));
    expect(res.status).toBe(200);
    expect(setters.setRoleModels).toHaveBeenCalledWith({ planner: { provider: "anthropic", model: "claude-sonnet-5", effort: "high" } });
    expect(stored.roles).toEqual({ planner: { provider: "anthropic", model: "claude-sonnet-5", effort: "high" } });
    expect((await res.json()).changed).toEqual(["roleModels"]);
    res = await POST(post({ roleModels: { planner: { provider: "auto", effort: null } } }, agent()));
    expect(res.status).toBe(200);
    // The provider reset took the Anthropic-only model with it; nothing is left.
    expect(stored.roles).toEqual({});
  });

  it("applies several fields in one body, in the enable route's order, and answers them all as changed", async () => {
    const res = await POST(post({ teamDynamic: true, effort: "low", maxParallelRuns: 1, gitAuthorName: "Box" }, owner()));
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toEqual(["gitAuthorName", "effort", "maxParallelRuns", "teamDynamic"]);
  });
});

describe("the history setting", () => {
  it("hands Claude Code's transcript period back through setHistoryRetention and answers what happened to it", async () => {
    let res = await POST(post({ historyRetention: "everything" }, agent()));
    expect(res.status).toBe(200);
    expect(setters.setHistoryRetention).toHaveBeenCalledWith("everything");
    expect((await res.json()).transcripts).toEqual([{ file: "/srv/home/box/.claude-ds/settings.json", state: "pinned" }]);
    res = await POST(post({ historyRetention: "standard" }, agent()));
    expect(setters.setHistoryRetention).toHaveBeenLastCalledWith("standard");
    expect((await res.json()).transcripts).toEqual([{ file: "/srv/home/box/.claude-ds/settings.json", state: "released" }]);
  });

  it("answers an empty transcripts list when the history setting did not move", async () => {
    const res = await POST(post({ reviewPass: true }, agent()));
    expect((await res.json()).transcripts).toEqual([]);
    expect(setters.setHistoryRetention).not.toHaveBeenCalled();
  });
});

describe("a bad value is refused whole, before any setter runs, in the enable route's words", () => {
  it.each([
    [{ effort: "medium" }, /Effort must be one of: low, xhigh, max, ultracode/],
    [{ effort: 3 }, /Effort must be one of/],
    [{ reviewPass: "yes" }, /review pass switch must be true or false/],
    [{ autoPr: 1 }, /pull-request switch must be true or false/],
    [{ autoMerge: "on" }, /merge switch must be true or false/],
    [{ generateMedia: null }, /media switch must be true or false/],
    [{ teamDynamic: "true" }, /team lead switch must be true or false/],
    [{ prBodyIncludesTask: "everything" }, /must be one of: summary, full-redacted, none/],
    [{ maxParallelRuns: 0 }, /between 1 and 4/],
    [{ maxParallelRuns: 5 }, /between 1 and 4/],
    [{ maxParallelRuns: 2.5 }, /whole number/],
    [{ maxParallelRuns: "2" }, /whole number/],
    [{ historyRetention: "archive" }, /run history setting must be one of: standard, everything/],
    [{ gitAuthorName: "<script>" }, /without angle brackets/],
    [{ gitAuthorEmail: "not-an-address" }, /e-mail address/],
    [{ gitAuthorName: 7 }, /Give a name/],
    [{ roleModels: "planner" }, /roleModels must be an object/],
    [{ roleModels: { lead: { effort: "low" } } }, /Unknown role "lead"/],
    [{ roleModels: { planner: { model: "claude-sonnet-5" } } }, /names a model, so roleModels.planner.provider must name the account/],
    [{ roleModels: { worker: { effort: "turbo" } } }, /roleModels.worker.effort must be one of/],
  ])("%j", async (body, message) => {
    const res = await POST(post({ reviewPass: true, ...body }, agent()));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.kind).toBe("invalid");
    expect(json.error).toMatch(message);
    // The good field beside it was not written either.
    for (const s of everySetter()) expect(s).not.toHaveBeenCalled();
  });

  it("refuses pinning a role to a provider the owner has not connected, naming the connected ones and the Settings page", async () => {
    getConnectedProviders.mockResolvedValue(["clawbox-ai"]);
    const res = await POST(post({ roleModels: { reviewer: { provider: "anthropic" } } }, agent()));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.kind).toBe("invalid");
    expect(json.error).toContain("connected providers (clawbox-ai)");
    expect(json.error).toContain("Settings page");
    expect(setters.setRoleModels).not.toHaveBeenCalled();
  });

  it("passes a setter's own refusal through as 400 invalid", async () => {
    const { CodingAgentError } = await import("@/lib/coding-agent");
    setters.setEffort.mockRejectedValue(new CodingAgentError("invalid", "Effort must be one of: low, medium, high, xhigh, max, ultracode."));
    const res = await POST(post({ effort: "low" }, agent()));
    expect(res.status).toBe(400);
    expect((await res.json()).kind).toBe("invalid");
  });
});
