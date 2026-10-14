/**
 * The chat runs on the box's Anthropic account pool (TASK-1260, the gateway
 * leg of 2026-10-14) — the real pool and the real stores, a stand-in for the
 * `openclaw` CLI that writes them the way core does.
 *
 * On the box, the chat signed in with one Claude account hit a real 429:
 * core logged `rotations=0` — it held ONE anthropic profile, so it had
 * nothing to rotate to — fell back to ClawBox AI, and the pool never heard of
 * it. What would make this worthless if it broke:
 *
 *  1. EVERY POOL ACCOUNT IS ITS OWN PROFILE in core's store — so core rotates
 *     between them inside a turn — written by core's own writer, access token
 *     only, in the pool's order with the active account first, and the
 *     owner's own sign-in kept (last).
 *  2. A LIMIT CORE SAW IS THE POOL'S LIMIT: core's per-profile failure state
 *     is read, the account is recorded as limited until Anthropic's own reset,
 *     the active account moves, and the gateway's order follows — no restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { saveEnv } from "@/tests/helpers/env";

const h = vi.hoisted(() => ({
  /** openclaw.json as the gateway has it. */
  config: { agents: { defaults: { model: { primary: "anthropic/claude-opus-5-5" } } }, auth: { profiles: {} as Record<string, unknown> } } as Record<string, unknown>,
  /** Every CLI call, argv only — never the token. */
  cli: [] as string[][],
  restarts: 0,
  storeFile: "",
}));

vi.mock("@/lib/coding-agent-notify", () => ({ announceAnthropicLimit: vi.fn(async () => undefined) }));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const homedir = () => process.env.CLAWBOX_TEST_HOME ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock("@/lib/port-probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/port-probe")>()),
  waitForPortOpen: vi.fn(async () => true),
}));
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>()),
  gatewayWsCall: vi.fn(async (method: string) => (method === "cron.list" ? { jobs: [] } : {})),
}));
// PARTIAL, over the real module — see openclaw-config-mock-completeness.test.ts.
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  gatewayIsAbsent: () => false,
  openclawIsAbsent: () => false,
  readConfig: vi.fn(async () => h.config),
  readConfigStrict: vi.fn(async () => h.config),
  restartGateway: vi.fn(async () => { h.restarts += 1; }),
  spawnOpenclawCli: vi.fn(async (args: string[], options: { stdinData?: string } = {}) => fakeCli(args, options.stdinData)),
}));

const H = 3_600_000;

/** One JSON cell of the main agent's database: the credentials, or the state beside them. */
function readCell(table: "auth_profile_store" | "auth_profile_state"): Record<string, unknown> {
  const db = new DatabaseSync(h.storeFile);
  try {
    const sql = table === "auth_profile_store"
      ? "SELECT store_json AS json FROM auth_profile_store WHERE store_key = 'primary'"
      : "SELECT state_json AS json FROM auth_profile_state WHERE state_key = 'primary'";
    const row = db.prepare(sql).get() as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Record<string, unknown> : {};
  } finally {
    db.close();
  }
}

function writeCell(table: "auth_profile_store" | "auth_profile_state", value: unknown): void {
  const db = new DatabaseSync(h.storeFile);
  try {
    const sql = table === "auth_profile_store"
      ? "UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = 'primary'"
      : "UPDATE auth_profile_state SET state_json = ?, updated_at = ? WHERE state_key = 'primary'";
    db.prepare(sql).run(JSON.stringify(value), Date.now());
  } finally {
    db.close();
  }
}

type Profiles = Record<string, Record<string, unknown>>;
const storeProfiles = (): Profiles => (readCell("auth_profile_store").profiles ?? {}) as Profiles;
const storedOrder = (): string[] | undefined => ((readCell("auth_profile_state").order ?? {}) as Record<string, string[]>).anthropic;

/**
 * `openclaw models auth …` as the pinned core (2026.10.2) does it, against
 * the main agent's store: `paste-token` upserts `{type:"token", provider,
 * token, expires}` and registers `auth.profiles.<id>`; `logout` drops the
 * profile and every order entry naming it; `order set` refuses an id the
 * store does not hold and stores the order beside the credentials.
 */
function fakeCli(args: string[], stdin: string | undefined): string {
  h.cli.push([...args]);
  const [group, sub, verb, ...rest] = args;
  if (group !== "models" || sub !== "auth") throw new Error(`unexpected CLI call: ${args.join(" ")}`);
  const flag = (name: string) => {
    const at = rest.indexOf(name);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  if (verb === "paste-token") {
    const profileId = flag("--profile-id") ?? "anthropic:manual";
    const expiresIn = flag("--expires-in");
    const seconds = expiresIn ? Number(/^(\d+)s$/.exec(expiresIn)?.[1]) : NaN;
    const store = readCell("auth_profile_store");
    const profiles = (store.profiles ?? {}) as Profiles;
    profiles[profileId] = {
      type: "token", provider: "anthropic", token: (stdin ?? "").trim(),
      ...(Number.isFinite(seconds) ? { expires: Date.now() + seconds * 1000 } : {}),
    };
    writeCell("auth_profile_store", { ...store, profiles });
    (h.config.auth as { profiles: Record<string, unknown> }).profiles[profileId] = { provider: "anthropic", mode: "token" };
    return "";
  }
  if (verb === "logout") {
    const profileId = rest[0];
    const store = readCell("auth_profile_store");
    const profiles = (store.profiles ?? {}) as Profiles;
    if (!profiles[profileId]) throw new Error(`Auth profile "${profileId}" is not in the store`);
    delete profiles[profileId];
    writeCell("auth_profile_store", { ...store, profiles });
    const state = readCell("auth_profile_state");
    const order = (state.order ?? {}) as Record<string, string[]>;
    for (const key of Object.keys(order)) order[key] = order[key].filter((id) => id !== profileId);
    writeCell("auth_profile_state", { ...state, order });
    delete (h.config.auth as { profiles: Record<string, unknown> }).profiles[profileId];
    return "";
  }
  if (verb === "order") {
    const action = rest[0];
    const ids = rest.slice(3);
    const state = readCell("auth_profile_state");
    const order = { ...((state.order ?? {}) as Record<string, string[]>) };
    if (action === "set") {
      const profiles = storeProfiles();
      const missing = ids.find((id) => !profiles[id]);
      if (missing) throw new Error(`Auth profile "${missing}" not found`);
      order.anthropic = ids;
    } else {
      delete order.anthropic;
    }
    writeCell("auth_profile_state", { ...state, order });
    return "";
  }
  throw new Error(`unexpected CLI call: ${args.join(" ")}`);
}

/**
 * The main agent's database as 2026.10.2 lays it out, holding what the box had
 * on 2026-10-14: the chat's OWN Claude sign-in at `anthropic:default`, which
 * core owns and refreshes itself.
 */
function writeAgentDb(openclawHome: string): string {
  const dir = path.join(openclawHome, "agents", "main", "agent");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "openclaw-agent.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT");
  db.exec("CREATE TABLE auth_profile_state (state_key TEXT NOT NULL PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT");
  db.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run("primary", JSON.stringify({
    version: 1,
    profiles: {
      "anthropic:default": { type: "oauth", provider: "anthropic", access: "sk-ant-oat01-the-chats-own-sign-in", refresh: "sk-ant-ort01-the-chats-own-refresh", expires: Date.now() + 8 * H },
    },
  }), 1);
  db.prepare("INSERT INTO auth_profile_state VALUES (?, ?, ?)").run("primary", JSON.stringify({ version: 1 }), 1);
  db.close();
  return file;
}

let root = "";
let restoreEnv: () => void;
let pool: typeof import("@/lib/anthropic-accounts");
let swap: typeof import("@/lib/anthropic-swap");
let gw: typeof import("@/lib/anthropic-gateway");

/** Anthropic's `/api/oauth/usage` for an account: the five-hour window spent, back at `resetsAt`. */
let usage: (token: string) => Record<string, unknown> = () => ({ five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 20, resets_at: null } });

beforeEach(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "CLAWBOX_TEST_HOME", "CLAWBOX_OPENCLAW_HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_AGENTS_DIR");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-gw-pool-")));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "5e".repeat(32), { mode: 0o600 });
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "ef".repeat(32);
  process.env.CLAWBOX_TEST_HOME = path.join(root, "home");
  process.env.CLAWBOX_OPENCLAW_HOME = path.join(root, "openclaw");
  delete process.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_AGENTS_DIR;
  h.storeFile = writeAgentDb(path.join(root, "openclaw"));
  h.config = { agents: { defaults: { model: { primary: "anthropic/claude-opus-5-5" } } }, auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } } };
  h.cli = [];
  h.restarts = 0;
  usage = () => ({ five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 20, resets_at: null } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/oauth/usage")) {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      return new Response(JSON.stringify(usage(auth.replace(/^Bearer /, ""))), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }));
  vi.resetModules();
  pool = await import("@/lib/anthropic-accounts");
  swap = await import("@/lib/anthropic-swap");
  gw = await import("@/lib/anthropic-gateway");
  (await import("@/lib/project-secrets"))._resetSecretKeyCacheForTests();
  pool._resetAnthropicAccountsForTests();
  swap._resetAnthropicSwapForTests();
});

afterEach(() => {
  gw._setGatewayDepsForTests(null);
  swap._resetAnthropicSwapForTests();
  pool._resetAnthropicAccountsForTests();
  vi.unstubAllGlobals();
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

const oauth = (access: string) => ({ access, refresh: `sk-ant-ort01-${access.slice(-8)}`, expires: Date.now() + 8 * H });

async function twoClaudeAccounts() {
  const work = await pool.addOAuthAccount({ label: "Work Max", email: "work@example.com", tokens: oauth("sk-ant-oat01-work-account-access") });
  const personal = await pool.addOAuthAccount({ label: "Personal Max", email: "me@example.com", tokens: oauth("sk-ant-oat01-personal-account-access") });
  return { work, personal };
}

const anthropicProfiles = () => Object.keys(storeProfiles()).filter((id) => id.startsWith("anthropic:")).sort();

describe("the chat on the box's Claude accounts (TASK-1260, 2026-10-14)", () => {
  it("puts every pool account in the gateway as its own profile, active first, the chat's own sign-in kept last", async () => {
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await swap.whenSwapsSettled();

    await gw.keepGatewayMirror();

    // Two accounts, two profiles core can rotate between — and the chat's own
    // sign-in still there, untouched.
    expect(anthropicProfiles()).toEqual(["anthropic:clawbox-" + personal.id, "anthropic:clawbox-" + work.id, "anthropic:default"].sort());
    const profiles = storeProfiles();
    expect(profiles["anthropic:default"]).toMatchObject({ type: "oauth", access: "sk-ant-oat01-the-chats-own-sign-in", refresh: "sk-ant-ort01-the-chats-own-refresh" });
    expect(profiles[`anthropic:clawbox-${work.id}`]).toMatchObject({ type: "token", provider: "anthropic", token: "sk-ant-oat01-work-account-access" });
    expect(profiles[`anthropic:clawbox-${work.id}`].expires).toEqual(expect.any(Number));
    // The pool stays the only holder of each refresh token.
    for (const account of [work, personal]) expect(JSON.stringify(profiles[`anthropic:clawbox-${account.id}`])).not.toContain("sk-ant-ort01");
    // The pool's order, the active account first; the owner's own sign-in last.
    expect(storedOrder()).toEqual([`anthropic:clawbox-${work.id}`, `anthropic:clawbox-${personal.id}`, "anthropic:default"]);
    // No restart: core reads its store, and the CLI tells the running gateway.
    expect(h.restarts).toBe(0);
    // The token travelled on stdin, never on a command line.
    expect(h.cli.flat().join(" ")).not.toContain("sk-ant-oat01");
    expect((await pool.describePool()).gateway).toMatchObject({ following: true, accountId: work.id, label: "Work Max" });
  });

  it("records a limit core rotated off as the pool's own, until Anthropic's reset, and moves the order — no restart", async () => {
    gw.startGatewaySwap();
    const { work, personal } = await twoClaudeAccounts();
    await swap.whenSwapsSettled();
    // The gateway already holds both accounts (as the first pass puts them).
    const store = readCell("auth_profile_store");
    const profiles = (store.profiles ?? {}) as Profiles;
    profiles[`anthropic:clawbox-${work.id}`] = { type: "token", provider: "anthropic", token: "sk-ant-oat01-work-account-access", expires: Date.now() + 8 * H };
    profiles[`anthropic:clawbox-${personal.id}`] = { type: "token", provider: "anthropic", token: "sk-ant-oat01-personal-account-access", expires: Date.now() + 8 * H };
    writeCell("auth_profile_store", { ...store, profiles });

    // A real 429 in a chat turn on the work account: core cools its profile
    // down (`auth_profile_failure_state_updated … reason=rate_limit`), rotates
    // to the next profile in the same turn — and Anthropic's usage says the
    // five-hour window is spent until `resetsAt`.
    const resetsAt = Date.now() + 2 * H;
    usage = (token) => token.includes("work")
      ? { five_hour: { utilization: 100, resets_at: new Date(resetsAt).toISOString() }, seven_day: { utilization: 40, resets_at: null } }
      : { five_hour: { utilization: 5, resets_at: null }, seven_day: { utilization: 10, resets_at: null } };
    writeCell("auth_profile_state", {
      version: 1,
      usageStats: {
        [`anthropic:clawbox-${work.id}`]: { errorCount: 1, failureCounts: { rate_limit: 1 }, lastFailureAt: Date.now() - 1_000, cooldownUntil: Date.now() + 30_000, cooldownReason: "rate_limit", cooldownModel: "claude-opus-5-5" },
      },
    });

    await gw.keepGatewayMirror();
    await swap.whenSwapsSettled();

    const state = await pool.readPoolState();
    const limited = state.accounts.find((a) => a.id === work.id);
    expect(limited?.status).toBe("limited");
    // Anthropic's own reset, not core's 30-second backoff.
    expect(Math.abs((limited?.limitedUntil ?? 0) - resetsAt)).toBeLessThan(2_000);
    expect(state.activeId).toBe(personal.id);
    expect(state.lastSwap).toMatchObject({ fromId: work.id, toId: personal.id, cause: "limit" });
    // The gateway's order follows the pool: the limited account last of the pool's.
    expect(storedOrder()).toEqual([`anthropic:clawbox-${personal.id}`, `anthropic:clawbox-${work.id}`, "anthropic:default"]);
    expect(h.restarts).toBe(0);
  });
});
