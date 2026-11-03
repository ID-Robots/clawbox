/**
 * The usage scheme of 2026-11 in a coding run (TASK-2141) — end to end,
 * through the real runner, a fake harness and a fake usage endpoint.
 *
 *  - "Usage limit reached · continuing automatically" and "… — grace window
 *    active" are the CLI carrying on by itself: the run is not ended, its
 *    account is not changed, nothing is marked — the feed says so once.
 *  - "You've hit your limit" names no window and no time: Anthropic's own
 *    answer says which and until when. A spent model week (`weekly_scoped`)
 *    moves only the run on that model and keeps the account for every other
 *    model; the account's own week moves the account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const announceAnthropicLimit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/coding-agent-notify", () => ({
  announceCodingAgent: vi.fn(async () => undefined),
  announceAnthropicLimit,
}));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

type Lib = typeof import("@/lib/coding-agent");
type Pool = typeof import("@/lib/anthropic-accounts");

let lib: Lib;
let pool: Pool;
let base: string;
let home: string;
let root: string;
let binDir: string;
let restore: () => void;

const H = 3_600_000;
const TOKEN_A = "sk-ant-oat01-account-a-000000000000";
const TOKEN_B = "sk-ant-oat01-account-b-111111111111";
const SESSION = "sess-usage-1";
const FABLE = "claude-fable-5-1";

const CONTINUING = "Usage limit reached · continuing automatically";
const AGAIN = "Usage limit reached again · continuing automatically";
const GRACE = "Usage limit reached — grace window active";
const HIT = "You've hit your limit";

function sq(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: SESSION, model: FABLE });
const synthetic = (text: string) => JSON.stringify({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text }] } });
const OK_RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 2 });
const HIT_RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: HIT, num_turns: 3 });
const BROKE_RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "The build script exited with code 2.", num_turns: 3 });

function callsLog(): string {
  return path.join(base, "calls.log");
}

function calls(): { n: number; cred: string; args: string }[] {
  if (!fs.existsSync(callsLog())) return [];
  return fs.readFileSync(callsLog(), "utf-8").trim().split("\n").filter(Boolean).map((line) => {
    const m = /^call (\d+) cred=(.*?) args=(.*)$/.exec(line);
    return { n: Number(m?.[1]), cred: m?.[2] ?? "", args: m?.[3] ?? "" };
  });
}

type Mode = "carry-on" | "carry-on-then-broke" | "hit" | "ok";

/** A fake claude-ds: on its Nth spawn, what line N of the plan says. Reads and deletes the credential handoff as the real wrapper does. */
function installWrapper(plan: readonly Mode[]): void {
  fs.writeFileSync(path.join(base, "plan"), `${plan.join("\n")}\n`);
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      readFirstTurn(),
      `counter=${sq(path.join(base, "counter"))}`,
      'n=$(cat "$counter" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$counter"',
      'cred=""',
      'if [ -n "${CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE:-}" ]; then cred=$(tr "\\n" ":" < "$CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE"); rm -f "$CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE"; fi',
      `printf 'call %s cred=%s args=%s\\n' "$n" "$cred" "$*" >> ${sq(callsLog())}`,
      `mode=$(sed -n "\${n}p" ${sq(path.join(base, "plan"))})`,
      'case "$mode" in',
      `  carry-on) printf '%s\\n' ${sq(INIT)} ${sq(synthetic(CONTINUING))} ${sq(synthetic(AGAIN))} ${sq(synthetic(GRACE))} ${sq(OK_RESULT)}; exit 0 ;;`,
      `  carry-on-then-broke) printf '%s\\n' ${sq(INIT)} ${sq(synthetic(CONTINUING))} ${sq(BROKE_RESULT)}; exit 1 ;;`,
      `  hit) printf '%s\\n' ${sq(INIT)} ${sq(synthetic(HIT))} ${sq(HIT_RESULT)}; exit 1 ;;`,
      `  *) printf '%s\\n' ${sq(INIT)} ${sq(OK_RESULT)}; exit 0 ;;`,
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** Anthropic's `/api/oauth/usage`, per access token, in the shape of 2026-11 (`five_hour: null`). */
function usageEndpoint(byToken: Record<string, { week: number; fable: number | null }>, resets: { week: number; fable: number }): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/api/oauth/usage")) return new Response("not here", { status: 404 });
    const access = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
    asked.push(access);
    const u = byToken[access];
    if (!u) return new Response("{}", { status: 403 });
    const week = new Date(resets.week).toISOString();
    return new Response(JSON.stringify({
      five_hour: null,
      seven_day: { utilization: u.week, resets_at: week },
      seven_day_opus: null,
      seven_day_sonnet: null,
      limits: [
        { kind: "weekly_all", group: "weekly", percent: u.week, severity: u.week >= 100 ? "exceeded" : "normal", resets_at: week, scope: null, is_active: true },
        { kind: "weekly_scoped", group: "weekly", percent: u.fable ?? 0, severity: "normal", resets_at: new Date(resets.fable).toISOString(), scope: { model: { id: null, display_name: "Fable" } }, is_active: u.fable !== null },
      ],
      weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 17, allowance_percent_of_weekly: 50 }],
      extra_usage: { is_enabled: false, spend_limit_reached: false },
    }), { status: 200 });
  }));
  return asked;
}

function makeProject(id: string): void {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-usage-")));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "9d".repeat(32), { mode: 0o600 });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ clawai_token: "claw_test_token", clawai_tier: "pro", coding_agent_enabled: true, coding_agent_provider: "anthropic" }));
  announceAnthropicLimit.mockClear();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
  pool = await import("@/lib/anthropic-accounts");
  pool._resetAnthropicAccountsForTests();
  (await import("@/lib/anthropic-swap"))._resetAnthropicSwapForTests();
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  pool._resetAnthropicAccountsForTests();
  (await import("@/lib/anthropic-swap"))._resetAnthropicSwapForTests();
  vi.unstubAllGlobals();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function settled(id: string) {
  for (let i = 0; i < 40; i += 1) {
    const run = await lib.waitForRun(id, 20_000);
    if (!run) throw new Error("run vanished");
    if (run.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const again = lib.getRun(id);
      if (again && again.status !== "running") return again;
    }
  }
  throw new Error("run never settled");
}

const oauth = (label: string, access: string) =>
  pool.addOAuthAccount({ label, email: `${label.toLowerCase()}@example.com`, tokens: { access, refresh: `refresh-${access}`, expires: Date.now() + 8 * H } });

describe("the CLI carrying on by itself", () => {
  it("is no stop: the run finishes on the same account, nothing is marked, and the feed says so", async () => {
    const asked = usageEndpoint({}, { week: Date.now() + 100 * H, fable: Date.now() + 50 * H });
    installWrapper(["carry-on"]);
    makeProject("site");
    const a = await oauth("A", TOKEN_A);
    await oauth("B", TOKEN_B);

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic", model: FABLE })).id);
    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(a.id);
    expect(run.accountSwitches).toEqual([]);
    expect(calls()).toHaveLength(1);
    expect(run.progress).toContain("Anthropic usage limit reached; Claude Code is continuing automatically on the same account");
    expect(run.progress).toContain("Anthropic usage limit reached; Claude Code is in its grace window and carries on on the same account");
    const accounts = await pool.readAccounts();
    expect(accounts.every((x) => x.status === "ok" && !x.modelLimits)).toBe(true);
    expect(announceAnthropicLimit).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it("does not turn a later, unrelated failure into a limit", async () => {
    usageEndpoint({}, { week: Date.now() + 100 * H, fable: Date.now() + 50 * H });
    installWrapper(["carry-on-then-broke"]);
    makeProject("site");
    await oauth("A", TOKEN_A);
    await oauth("B", TOKEN_B);
    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic", model: FABLE })).id);
    expect(run.status).toBe("failed");
    expect(run.accountSwitches).toEqual([]);
    expect(calls()).toHaveLength(1);
    expect((await pool.readAccounts()).every((x) => x.status === "ok")).toBe(true);
  });
});

describe("a model week the pool already knows is spent", () => {
  it("starts a Fable run on the next account from its very first spawn, and an Opus run still on the active one", async () => {
    const asked = usageEndpoint({}, { week: Date.now() + 100 * H, fable: Date.now() + 50 * H });
    installWrapper(["ok", "ok"]);
    makeProject("site");
    const a = await oauth("A", TOKEN_A);
    const b = await oauth("B", TOKEN_B);
    await pool.markModelLimited(a.id, { family: "fable", name: "Fable" }, Date.now() + 30 * H);

    const fable = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic", model: FABLE })).id);
    expect(fable.status).toBe("completed");
    expect(fable.anthropicAccount).toBe(b.id);
    expect(calls()[0].cred).toBe(`oauth:${TOKEN_B}:`);

    const opus = await settled((await lib.startRun({ task: "more", projectId: "site", source: "owner", provider: "anthropic", model: "claude-opus-5-5" })).id);
    expect(opus.anthropicAccount).toBe(a.id);
    expect(calls()[1].cred).toBe(`oauth:${TOKEN_A}:`);
    expect((await pool.readPoolState()).activeId).toBe(a.id);
    expect(asked).toEqual([]);
  });
});

describe("\"You've hit your limit\", read against Anthropic's answer", () => {
  it("moves only the Fable run when the Fable week is what is spent — the account stays active for every other model", async () => {
    const fableReset = Date.now() + 50 * H;
    const asked = usageEndpoint({ [TOKEN_A]: { week: 56, fable: 100 }, [TOKEN_B]: { week: 30, fable: 10 } }, { week: Date.now() + 100 * H, fable: fableReset });
    installWrapper(["hit", "ok", "ok"]);
    makeProject("site");
    const a = await oauth("A", TOKEN_A);
    const b = await oauth("B", TOKEN_B);

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic", model: FABLE })).id);
    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(b.id);
    expect(run.accountSwitches).toHaveLength(1);
    // Until Anthropic's own reset of the Fable week — not the five-hour guess.
    expect(run.accountSwitches[0]).toMatchObject({ fromId: a.id, toId: b.id, kind: "weekly", limitedUntil: Date.parse(new Date(fableReset).toISOString()) });
    expect(asked).toContain(TOKEN_A);
    const [first, second] = calls();
    expect(first.cred).toBe(`oauth:${TOKEN_A}:`);
    expect(second.cred).toBe(`oauth:${TOKEN_B}:`);
    expect(second.args).toContain(`--resume ${SESSION}`);

    // A is NOT limited: only its Fable week is spent, and it is still the box's active account.
    const state = await pool.readPoolState();
    const recordA = state.accounts.find((x) => x.id === a.id);
    expect(recordA?.status).toBe("ok");
    expect(recordA?.modelLimits).toEqual([{ family: "fable", name: "Fable", until: Date.parse(new Date(fableReset).toISOString()) }]);
    expect(state.activeId).toBe(a.id);
    expect(state.health).toMatchObject({ healthy: 2, limited: 0 });
    expect(announceAnthropicLimit).not.toHaveBeenCalled();

    // A run on another model still gets A.
    const opus = await settled((await lib.startRun({ task: "more", projectId: "site", source: "owner", provider: "anthropic", model: "claude-opus-5-5" })).id);
    expect(opus.status).toBe("completed");
    expect(opus.anthropicAccount).toBe(a.id);
    expect(calls()[2].cred).toBe(`oauth:${TOKEN_A}:`);
  });

  it("sets the whole account aside until Anthropic's weekly reset when the account's own week is spent", async () => {
    const weekReset = Date.now() + 100 * H;
    usageEndpoint({ [TOKEN_A]: { week: 100, fable: 40 }, [TOKEN_B]: { week: 30, fable: 10 } }, { week: weekReset, fable: Date.now() + 50 * H });
    installWrapper(["hit", "ok"]);
    makeProject("site");
    const a = await oauth("A", TOKEN_A);
    const b = await oauth("B", TOKEN_B);

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic", model: FABLE })).id);
    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(b.id);
    expect(run.accountSwitches[0]).toMatchObject({ fromId: a.id, kind: "weekly", limitedUntil: Date.parse(new Date(weekReset).toISOString()) });
    const state = await pool.readPoolState();
    expect(state.accounts.find((x) => x.id === a.id)).toMatchObject({ status: "limited", limitKind: "weekly", limitedUntil: Date.parse(new Date(weekReset).toISOString()) });
    expect(state.activeId).toBe(b.id);
  });

  it("waits, with the reset Anthropic gave, when no other account can take the run", async () => {
    const weekReset = Date.now() + 100 * H;
    usageEndpoint({ [TOKEN_A]: { week: 100, fable: null } }, { week: weekReset, fable: Date.now() + 50 * H });
    installWrapper(["hit", "ok"]);
    makeProject("site");
    await oauth("Only", TOKEN_A);

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic", model: FABLE });
    const paused = await settled(started.id);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toMatchObject({ kind: "allowance", meter: "anthropic" });
    // The words gave no time; the record ends up with Anthropic's, not the five-hour guess.
    await vi.waitFor(() => {
      const now = lib.getRun(started.id);
      expect(Date.parse((now?.pauseReason as { resetsAt: string }).resetsAt)).toBe(Date.parse(new Date(weekReset).toISOString()));
    });
  });
});
