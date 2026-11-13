/**
 * An Anthropic account hits its usage limit in the middle of a coding run
 * (TASK-902) — end to end, through the real runner and a fake harness.
 *
 * The outage this exists for: on 2026-09-18 the overnight coding queue died at
 * 22:27 on "You've hit your session limit · resets 10:50pm", and every run and
 * review round until 22:50 failed. With a second account connected:
 *
 *  - the run that hit the limit is NOT failed. It goes on, in place, on the next
 *    account — the SAME record and the SAME session (`--resume`), the attempt
 *    count untouched — and the harness is handed the second account's
 *    credential, never the first one's again;
 *  - when NO account can answer the run waits, paused, with the reset time on
 *    the record, and the box resumes it by itself when the limit is over;
 *  - a new run is refused with `limited` while every account is capped, so a
 *    queue waits instead of spending an attempt;
 *  - the owner's test hook ends a live run as a limit would, and the real
 *    switch path takes it from there.
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

const KEY_A = "sk-ant-api03-account-A-work-000000000000";
const KEY_B = "sk-ant-api03-account-B-personal-111111111";
const LIMIT_LINE = "You've hit your session limit · resets 10:50pm";
const SESSION = "sess-limit-1";

/** Single-quote a string for bash. */
function sq(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: SESSION, model: "claude-opus-5" });
/** What the CLI writes when the account is capped: a synthetic message, tagged. */
const SYNTHETIC_LIMIT = JSON.stringify({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: LIMIT_LINE }] } });
const LIMIT_RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: LIMIT_LINE, num_turns: 4 });
const OK_RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 2 });
/** What the CLI writes when Anthropic refuses the credential (TASK-1260). */
const AUTH_LINE = "Invalid API key · Please run /login";
const SYNTHETIC_AUTH = JSON.stringify({ type: "assistant", error: "authentication_failed", message: { model: "<synthetic>", content: [{ type: "text", text: AUTH_LINE }] } });
const AUTH_RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: AUTH_LINE, num_turns: 1 });
/** What a run on a subscription its organisation switched off ended with (TASK-1271): the line, untagged. */
const DISABLED_LINE = "Your organization has disabled Claude subscription access for Claude Code";
const DISABLED_RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: DISABLED_LINE, num_turns: 1 });

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

/**
 * A fake claude-ds that does, on its Nth spawn, what line N of the plan says:
 * `limit` (the CLI's own limit line and a failed result), `ok`, or `hang`
 * (works until something ends it). It reads — and deletes — the credential
 * handoff exactly as the real wrapper does, and logs what it was handed.
 */
function installWrapper(plan: readonly ("limit" | "limitlock" | "ok" | "hang" | "auth" | "disabled")[]): void {
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
      `  limit) printf '%s\\n' ${sq(INIT)} ${sq(SYNTHETIC_LIMIT)} ${sq(LIMIT_RESULT)}; exit 1 ;;`,
      // The owner turns the local-only AI lock on while this attempt runs (TASK-2501).
      `  limitlock) sed -i '1s/^{/{"ai_cloud_lock":true,/' ${sq(path.join(root, "data", "config.json"))}; printf '%s\\n' ${sq(INIT)} ${sq(SYNTHETIC_LIMIT)} ${sq(LIMIT_RESULT)}; exit 1 ;;`,
      `  auth) printf '%s\\n' ${sq(INIT)} ${sq(SYNTHETIC_AUTH)} ${sq(AUTH_RESULT)}; exit 1 ;;`,
      `  disabled) printf '%s\\n' ${sq(INIT)} ${sq(DISABLED_RESULT)}; exit 1 ;;`,
      `  hang) printf '%s\\n' ${sq(INIT)}; sleep 30; exit 0 ;;`,
      `  *) printf '%s\\n' ${sq(INIT)} ${sq(OK_RESULT)}; exit 0 ;;`,
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-accounts-")));
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
  writeConfig({ clawai_token: "claw_test_token", clawai_tier: "pro", coding_agent_enabled: true, coding_agent_provider: "anthropic" });
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
  // The account switch puts the record straight back to "running", so a
  // single wait can wake on the first settle; wait until it really stops.
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

async function twoAccounts() {
  const work = await pool.addApiKeyAccount({ label: "Work", key: KEY_A });
  const personal = await pool.addApiKeyAccount({ label: "Personal", key: KEY_B });
  return { work, personal };
}

describe("an account at its limit mid-run", () => {
  it("does not carry the run on to another account once the local-only AI lock has gone on (TASK-2501)", async () => {
    installWrapper(["limitlock", "ok"]);
    makeProject("site");
    await twoAccounts();

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    const run = await settled(started.id);

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Local-only AI is on/);
    // One process, the one that ran before the lock: no second spawn.
    expect(calls()).toHaveLength(1);
  });

  it("carries the SAME run on, in the same session, on the next account", async () => {
    installWrapper(["limit", "ok"]);
    makeProject("site");
    const { work, personal } = await twoAccounts();

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    const run = await settled(started.id);

    expect(run.id).toBe(started.id);
    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    // Not the transient retry, and not a new attempt: the same run, carried on.
    expect(run.retries).toBe(0);
    expect(run.anthropicAccount).toBe(personal.id);
    expect(run.accountSwitches).toHaveLength(1);
    expect(run.accountSwitches[0]).toMatchObject({ fromId: work.id, fromLabel: "Work", toId: personal.id, toLabel: "Personal", kind: "session" });
    expect(run.progress.some((line) => /^Anthropic account "Work" hit its usage limit \(back at 22:50\); carrying on with "Personal" in the same session$/.test(line))).toBe(true);

    const [first, second] = calls();
    // Each spawn was handed ONE account's credential, and the second never got the first's.
    expect(first.cred).toBe(`api_key:${KEY_A}:`);
    expect(second.cred).toBe(`api_key:${KEY_B}:`);
    // The same session, resumed — not the task started over.
    expect(first.args).not.toContain("--resume");
    expect(second.args).toContain(`--resume ${SESSION}`);
    // The handoff files are gone: the wrapper read and deleted them.
    const handoffDir = path.join(root, "data", ".anthropic-handoff");
    expect(fs.existsSync(handoffDir) ? fs.readdirSync(handoffDir) : []).toEqual([]);

    // The pool knows account #1 is limited, until the time the CLI said.
    const accounts = await pool.readAccounts();
    const limited = accounts.find((a) => a.id === work.id);
    expect(limited?.status).toBe("limited");
    expect(limited?.limitedUntil).toBeGreaterThan(Date.now());
    // One notice: the account became limited and the box switched.
    expect(announceAnthropicLimit).toHaveBeenCalledTimes(1);
    expect(announceAnthropicLimit).toHaveBeenCalledWith(expect.objectContaining({ kind: "switched", fromLabel: "Work", toLabel: "Personal", runId: run.id }));
    // The swap says the run WAS carried on (the card and the notice read this):
    // it moved by its own path, before the fan-out's coding consumer looked,
    // and on 2026-10-14 that read "Coding runs: nothing to move" over a run
    // that had just moved.
    await (await import("@/lib/anthropic-swap")).whenSwapsSettled();
    expect((await pool.readPoolState()).lastSwap?.consumers.coding).toEqual({ status: "ok", code: "moved", count: 1 });
    // And nothing about any credential reached the record.
    const record = JSON.stringify(run);
    expect(record).not.toContain(KEY_A);
    expect(record).not.toContain(KEY_B);
  });

  it("waits, paused, when no account can answer — and the box resumes it itself after the reset", async () => {
    installWrapper(["limit", "ok"]);
    makeProject("site");
    const only = await pool.addApiKeyAccount({ label: "Only", key: KEY_A });

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    const paused = await settled(started.id);
    expect(paused.status).toBe("paused");
    expect(paused.error).toBeNull();
    expect(paused.pauseReason).toMatchObject({ kind: "allowance", meter: "anthropic" });
    const resetsAt = Date.parse((paused.pauseReason as { resetsAt: string }).resetsAt);
    expect(resetsAt).toBeGreaterThan(Date.now());
    expect(paused.progress.some((line) => /^Every Anthropic account is at its usage limit; waiting for the reset at 22:50$/.test(line))).toBe(true);
    await vi.waitFor(() => expect(announceAnthropicLimit).toHaveBeenCalledWith(expect.objectContaining({ kind: "all_limited" })));

    // A new run is refused while every account is capped — with the time.
    await expect(lib.startRun({ task: "another", projectId: "site", source: "owner", provider: "anthropic" }))
      .rejects.toMatchObject({ kind: "limited", message: expect.stringContaining("22:50") });

    // The limit is over.
    await pool.clearLimit(only.id);
    const attemptsBefore = paused.attempts.length;
    expect(await lib.resumeRunsWaitingForAnthropic()).toEqual([started.id]);
    const done = await settled(started.id);
    expect(done.status).toBe("completed");
    expect(done.attempts.length).toBe(attemptsBefore);
    expect(done.progress).toContain("The usage limit reset; carrying on where it left off");
    const [, second] = calls();
    expect(second.args).toContain(`--resume ${SESSION}`);
    // No notice when the box goes back: only the two that matter were sent.
    expect(announceAnthropicLimit.mock.calls.map((c) => (c as unknown as [{ kind: string }])[0].kind)).toEqual(["all_limited"]);
  });

  it("is only ever a limit when the harness said so — an ordinary failure still fails", async () => {
    installWrapper(["ok"]);
    // A wrapper whose failure merely QUOTES a limit, deep in the run's own words.
    const prose = `${"I reworked the account pool and its tests. ".repeat(12)}Fixture: ${LIMIT_LINE}`;
    fs.writeFileSync(
      path.join(binDir, "claude-ds"),
      ["#!/usr/bin/env bash", readFirstTurn(), `printf '%s\\n' ${sq(INIT)} ${sq(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: prose, num_turns: 9 }))}`, "exit 1"].join("\n"),
      { mode: 0o755 },
    );
    makeProject("site");
    await twoAccounts();
    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);
    expect(run.status).toBe("failed");
    expect(run.accountSwitches).toEqual([]);
    expect(announceAnthropicLimit).not.toHaveBeenCalled();
  });
});

describe("the owner's test hook", () => {
  it("ends a live run on account #1 as a limit would, and the run carries on on #2", async () => {
    installWrapper(["hang", "ok"]);
    makeProject("site");
    const { work, personal } = await twoAccounts();
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    await vi.waitFor(() => expect(lib.getRun(started.id)?.sessionId).toBe(SESSION), { timeout: 10_000 });
    expect(lib.getRun(started.id)?.anthropicAccount).toBe(work.id);

    const interrupted = lib.simulateAnthropicLimit(work.id, Date.now() + 30 * 60_000);
    expect(interrupted).toEqual([started.id]);

    const run = await settled(started.id);
    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(personal.id);
    expect(run.accountSwitches).toHaveLength(1);
    expect(calls()[1].args).toContain(`--resume ${SESSION}`);
    // What the box's swap test showed on 2026-10-14 with one live run.
    await (await import("@/lib/anthropic-swap")).whenSwapsSettled();
    expect((await pool.readPoolState()).lastSwap?.consumers.coding).toEqual({ status: "ok", code: "moved", count: 1 });
  });
});

// ── TASK-1260: a refused credential, and a swap another consumer caused ──────

/** Anthropic's answer to the key check (`verifyAnthropicKey`): a 401 for the keys in `refused`. */
function anthropicRefuses(...refused: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const key = (init?.headers as Record<string, string> | undefined)?.["x-api-key"] ?? "";
    return new Response("{}", { status: refused.includes(key) ? 401 : 200 });
  }));
}

describe("an account Anthropic refuses mid-run (TASK-1260)", () => {
  it("confirms the refusal, takes the account out, and carries the SAME run on on the next account", async () => {
    installWrapper(["auth", "ok"]);
    makeProject("site");
    const { work, personal } = await twoAccounts();
    anthropicRefuses(KEY_A);

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    const run = await settled(started.id);

    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(personal.id);
    expect(run.accountSwitches).toEqual([expect.objectContaining({ fromId: work.id, toId: personal.id, kind: "auth", limitedUntil: null })]);
    expect(run.progress).toContain('Anthropic refused the credential of account "Work"; carrying on with "Personal" in the same session');
    const [first, second] = calls();
    expect(first.cred).toBe(`api_key:${KEY_A}:`);
    expect(second.cred).toBe(`api_key:${KEY_B}:`);
    expect(second.args).toContain(`--resume ${SESSION}`);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("revoked");
    // The swap says so, once: an account that needs the owner, not one waiting for a reset.
    await vi.waitFor(() => expect(announceAnthropicLimit).toHaveBeenCalledWith(expect.objectContaining({ kind: "switched", reason: "auth", fromLabel: "Work", toLabel: "Personal" })));
  });

  it("keeps an account Anthropic still accepts, but never hands the run the key it was refused with again (TASK-2139)", async () => {
    installWrapper(["auth", "ok"]);
    makeProject("site");
    const { work, personal } = await twoAccounts();
    anthropicRefuses();

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);
    expect(run.status).toBe("completed");
    // Nothing fresher than the refused key: the run goes on on the next account.
    expect(run.anthropicAccount).toBe(personal.id);
    expect(run.accountSwitches).toEqual([expect.objectContaining({ fromId: work.id, toId: personal.id, kind: "auth" })]);
    expect(calls().map((c) => c.cred)).toEqual([`api_key:${KEY_A}:`, `api_key:${KEY_B}:`]);
    expect((await pool.readAccounts()).every((a) => a.status === "ok")).toBe(true);
  });

  it("goes back on the same account once when the owner put another key in since the run was handed the refused one", async () => {
    installWrapper(["auth", "ok"]);
    makeProject("site");
    const { work } = await twoAccounts();
    const NEW_KEY = "sk-ant-api03-account-A-replaced-22222222";
    // Anthropic refuses the old key — once the owner has replaced it, so the
    // refusal reaches the runner with the new key already in the store.
    const gate = path.join(base, "replaced");
    fs.writeFileSync(
      path.join(binDir, "claude-ds"),
      [
        "#!/usr/bin/env bash",
        readFirstTurn(),
        'cred=$(tr "\\n" ":" < "$CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE"); rm -f "$CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE"',
        `printf 'call 0 cred=%s args=%s\\n' "$cred" "$*" >> ${sq(callsLog())}`,
        'case "$cred" in',
        `  *${KEY_A}*) while [ ! -f ${sq(gate)} ]; do sleep 0.05; done; printf '%s\\n' ${sq(INIT)} ${sq(SYNTHETIC_AUTH)} ${sq(AUTH_RESULT)}; exit 1 ;;`,
        `  *) printf '%s\\n' ${sq(INIT)} ${sq(OK_RESULT)}; exit 0 ;;`,
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const verify = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", verify);

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    await vi.waitFor(() => expect(calls()).toHaveLength(1), { timeout: 10_000 });
    await pool.replaceCredential(work.id, { kind: "api_key", key: NEW_KEY });
    fs.writeFileSync(gate, "");
    const run = await settled(started.id);

    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(work.id);
    expect(run.accountSwitches).toEqual([]);
    expect(calls().map((c) => c.cred)).toEqual([`api_key:${KEY_A}:`, `api_key:${NEW_KEY}:`]);
    // The new key is the answer: nothing was spent asking about the old one.
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails with the way out when no account is left and none comes back by itself", async () => {
    installWrapper(["auth", "ok"]);
    makeProject("site");
    await pool.addApiKeyAccount({ label: "Only", key: KEY_A });
    anthropicRefuses(KEY_A);

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Anthropic refused the credential of every account/);
    expect(calls()).toHaveLength(1);
  });

  it("takes out an account its organisation switched off without asking Anthropic, and carries the run on on the next", async () => {
    installWrapper(["disabled", "ok"]);
    makeProject("site");
    const tokens = (access: string) => ({ access, refresh: `refresh-${access}`, expires: Date.now() + 8 * 3_600_000 });
    const work = await pool.addOAuthAccount({ label: "Work", email: "work@example.com", tokens: tokens("work-access") });
    const personal = await pool.addOAuthAccount({ label: "Personal", email: "me@example.com", tokens: tokens("personal-access") });
    // The grant renews fine: a probe would have kept the account and put the run straight back on it.
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ access_token: "renewed", refresh_token: "r2", expires_in: 28_800 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);

    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(personal.id);
    expect(run.accountSwitches).toEqual([expect.objectContaining({ fromId: work.id, toId: personal.id, kind: "auth" })]);
    expect(calls()[1].cred).toBe("oauth:personal-access:");
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("revoked");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/oauth/token"))).toEqual([]);
  });

  it("does not tell the owner every account was refused when the next one's sign-in only could not be renewed", async () => {
    installWrapper(["auth", "ok"]);
    makeProject("site");
    const hours = (n: number) => Date.now() + n * 3_600_000;
    await pool.addOAuthAccount({ label: "Work", email: "work@example.com", tokens: { access: "work-access", refresh: "refresh-work", expires: hours(8) } });
    // Its token ran out while the box was offline; the grant behind it is fine.
    await pool.addOAuthAccount({ label: "Personal", email: "me@example.com", tokens: { access: "personal-access", refresh: "refresh-personal", expires: hours(-0.1) } });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);

    expect(run.status).toBe("failed");
    expect(run.error).not.toMatch(/refused the credential of every account/);
    expect(run.error).toMatch(/could not be renewed/);
    expect((await pool.readAccounts()).map((a) => a.status)).toEqual(["ok", "ok"]);
    expect(calls()).toHaveLength(1);
  });

  it("still says the credential was refused when the run's own account was refused and nothing else can answer", async () => {
    installWrapper(["auth", "ok"]);
    makeProject("site");
    await pool.addApiKeyAccount({ label: "Only", key: KEY_A });
    // Anthropic refused the key in the run; the check afterwards only got a 503, so the account stays listed as fine.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/refused the credential this run was using/);
    expect(run.error).not.toMatch(/offline/);
  });

  it("does not call a sign-in that only could not be checked again refused for good", async () => {
    installWrapper(["auth", "ok"]);
    makeProject("site");
    // The only account: its token ran out mid-run while the box was offline, so the renewal that would confirm it cannot be made.
    await pool.addOAuthAccount({ label: "Only", email: "only@example.com", tokens: { access: "only-access", refresh: "refresh-only", expires: Date.now() + 8 * 3_600_000 } });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);

    expect(run.status).toBe("failed");
    expect(run.error).not.toMatch(/refused the credential of every account/);
    expect(run.error).toMatch(/could not be checked again/);
    expect((await pool.readAccounts())[0].status).toBe("ok");
  });

  it("does not bounce a run for ever on a refusal nobody can pin on the account", async () => {
    installWrapper(["auth", "auth", "auth", "auth", "auth", "ok"]);
    makeProject("site");
    await twoAccounts();
    anthropicRefuses();

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);
    expect(run.status).toBe("failed");
    // Each key once: Anthropic accepts both when asked, but neither is handed
    // to the run again, as nothing fresher appeared — then it stops, with the
    // way out rather than the CLI's own words.
    expect(calls().map((c) => c.cred)).toEqual([`api_key:${KEY_A}:`, `api_key:${KEY_B}:`]);
    expect(run.error).toMatch(/Anthropic refused the credential of every account this run could use/);
  });
});

// ── TASK-2139: a refused token the probe calls fine, many runs at once ──────

describe("a credential refused mid-run that Anthropic still accepts when asked (TASK-2139)", () => {
  const hours = (n: number) => Date.now() + n * 3_600_000;
  const tokens = (name: string) => ({ access: `${name}-access`, refresh: `refresh-${name}`, expires: hours(8) });

  /** Two Claude accounts, in that order: "Work" then "Personal". */
  async function twoClaudeAccounts() {
    const work = await pool.addOAuthAccount({ label: "Work", email: "work@example.com", tokens: tokens("work") });
    const personal = await pool.addOAuthAccount({ label: "Personal", email: "me@example.com", tokens: tokens("personal") });
    return { work, personal };
  }

  /**
   * Anthropic's token endpoint renewing every grant: `refresh-<name>` answers
   * `<name>-fresh`, a little later, so callers that ask together overlap.
   */
  function anthropicRenews() {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).includes("/oauth/token")) return new Response("{}", { status: 200 });
      const { refresh_token } = JSON.parse(String(init?.body)) as { refresh_token: string };
      const name = refresh_token.replace(/^refresh-/, "");
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ access_token: `${name}-fresh`, refresh_token: `refresh-${name}-2`, expires_in: 28_800 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/oauth/token")).length;
  }

  it("restarts the run on the SAME account with the credential read again from the store, and marks nothing", async () => {
    installWrapper(["auth", "ok"]);
    makeProject("site");
    const { work } = await twoClaudeAccounts();
    const renewals = anthropicRenews();

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);

    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(work.id);
    expect(run.accountSwitches).toEqual([]);
    const [first, second] = calls();
    expect(first.cred).toBe("oauth:work-access:");
    // The renewed token, never the refused one again.
    expect(second.cred).toBe("oauth:work-fresh:");
    expect(second.args).toContain(`--resume ${SESSION}`);
    expect(renewals()).toBe(1);
    expect((await pool.readAccounts()).map((a) => a.status)).toEqual(["ok", "ok"]);
  });

  it("moves the run to the next account when the fresh credential is refused too — and does not ask again", async () => {
    installWrapper(["auth", "auth", "ok"]);
    makeProject("site");
    const { work, personal } = await twoClaudeAccounts();
    const renewals = anthropicRenews();

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);

    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(personal.id);
    expect(calls().map((c) => c.cred)).toEqual(["oauth:work-access:", "oauth:work-fresh:", "oauth:personal-access:"]);
    expect(calls()[2].args).toContain(`--resume ${SESSION}`);
    expect(run.accountSwitches).toEqual([expect.objectContaining({ fromId: work.id, toId: personal.id, kind: "auth" })]);
    expect(run.progress).toContain('Anthropic refused the credential of account "Work"; carrying on with "Personal" in the same session');
    // Work's grant was renewed once, for the restart; the second refusal asked nothing.
    expect(renewals()).toBe(1);
    // The probe vouched for Work: it is not taken out of the pool for the box's other consumers.
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("ok");
  });

  it("fails with one clear error only once every account has been refused", async () => {
    installWrapper(["auth", "auth", "auth", "auth", "ok"]);
    makeProject("site");
    await twoClaudeAccounts();
    const renewals = anthropicRenews();

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);

    expect(run.status).toBe("failed");
    expect(calls().map((c) => c.cred)).toEqual(["oauth:work-access:", "oauth:work-fresh:", "oauth:personal-access:", "oauth:personal-fresh:"]);
    // Neither account is marked — Anthropic accepts both when asked — so the
    // way out does not pretend they only need signing in again.
    expect(run.error).toBe(
      "Anthropic refused the credential of every account this run could use — including one it still accepts when asked, which stays connected."
      + " Check the accounts in Settings → Providers → Anthropic accounts, sign in again any that need it, then start the run again.",
    );
    expect((await pool.readAccounts()).map((a) => a.status)).toEqual(["ok", "ok"]);
    expect(renewals()).toBe(2);
  });

  it("does not go back to an account it gave up on when the box resumes it after a reset", async () => {
    installWrapper(["auth", "auth", "limit", "ok"]);
    makeProject("site");
    const { work, personal } = await twoClaudeAccounts();
    anthropicRenews();

    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    const paused = await settled(started.id);
    // Work was given up on after its one restart, and Personal is at its limit: only the wait is left.
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toMatchObject({ kind: "allowance", meter: "anthropic" });

    await pool.clearLimit(personal.id);
    await lib.resumeRunsWaitingForAnthropic();
    const done = await settled(started.id);

    expect(done.status).toBe("completed");
    // Back on Personal after the reset — never on Work, still the active account.
    expect(done.anthropicAccount).toBe(personal.id);
    expect(calls().map((c) => c.cred)).toEqual(["oauth:work-access:", "oauth:work-fresh:", "oauth:personal-access:", "oauth:personal-access:"]);
    expect((await pool.readAccounts()).find((a) => a.id === work.id)?.status).toBe("ok");
  });

  it("caps the carried-on tries of one run however many accounts there are", async () => {
    installWrapper(Array.from({ length: 12 }, () => "auth" as const));
    makeProject("site");
    for (const name of ["one", "two", "three", "four"]) await pool.addOAuthAccount({ label: name, email: `${name}@example.com`, tokens: tokens(name) });
    anthropicRenews();

    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" })).id);

    expect(run.status).toBe("failed");
    // The first try and six carried-on ones: accounts 1-3 twice each (as they
    // were, then on the renewed token), account 4 once.
    expect(calls().map((c) => c.cred)).toEqual([
      "oauth:one-access:", "oauth:one-fresh:", "oauth:two-access:", "oauth:two-fresh:", "oauth:three-access:", "oauth:three-fresh:", "oauth:four-access:",
    ]);
    expect(run.error).toMatch(/^Anthropic kept refusing this run's credential: it was carried on 6 times/);
  });

  it("asks Anthropic ONCE when several runs on the account are refused together, and every one goes on on the fresh token", async () => {
    writeConfig({ clawai_token: "claw_test_token", clawai_tier: "pro", coding_agent_enabled: true, coding_agent_provider: "anthropic", coding_agent_max_parallel_runs: 3 });
    // Anthropic refuses the token every run started with, and only that one.
    fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(binDir, "claude-ds"),
      [
        "#!/usr/bin/env bash",
        readFirstTurn(),
        'cred=$(tr "\\n" ":" < "$CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE"); rm -f "$CLAUDE_DS_ANTHROPIC_CREDENTIAL_FILE"',
        // Three of these append at once: a short line is one write, so the
        // lines cannot interleave the way the long argument lists did.
        `printf 'call 0 cred=%s args=\\n' "$cred" >> ${sq(callsLog())}`,
        'case "$cred" in',
        // Refused only once all three hold the first token: a refusal before
        // that would renew it under a run that has not read it yet.
        `  *work-access*) for _ in $(seq 200); do [ "$(grep -c work-access ${sq(callsLog())})" -ge 3 ] && break; sleep 0.05; done; printf '%s\\n' ${sq(INIT)} ${sq(SYNTHETIC_AUTH)} ${sq(AUTH_RESULT)}; exit 1 ;;`,
        `  *) printf '%s\\n' ${sq(INIT)} ${sq(OK_RESULT)}; exit 0 ;;`,
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    for (const id of ["one", "two", "three"]) makeProject(id);
    const { work } = await twoClaudeAccounts();
    const renewals = anthropicRenews();

    const started = await Promise.all(["one", "two", "three"].map((projectId) => lib.startRun({ task: "build", projectId, source: "owner", provider: "anthropic" })));
    const runs = await Promise.all(started.map((r) => settled(r.id)));

    for (const run of runs) {
      expect(run.status).toBe("completed");
      expect(run.anthropicAccount).toBe(work.id);
      expect(run.accountSwitches).toEqual([]);
    }
    // One renewal for the three refusals: a second would have replaced the
    // token the first restarted run had just been handed.
    expect(renewals()).toBe(1);
    const creds = calls().map((c) => c.cred).sort();
    expect(creds).toEqual(["oauth:work-access:", "oauth:work-access:", "oauth:work-access:", "oauth:work-fresh:", "oauth:work-fresh:", "oauth:work-fresh:"]);
    expect((await pool.readAccounts()).map((a) => a.status)).toEqual(["ok", "ok"]);
  });
});

describe("a swap another consumer caused (TASK-1260)", () => {
  it("moves a live run off the account that can no longer answer and resumes it in its session", async () => {
    installWrapper(["hang", "ok"]);
    makeProject("site");
    const { work, personal } = await twoAccounts();
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    await vi.waitFor(() => expect(lib.getRun(started.id)?.sessionId).toBe(SESSION), { timeout: 10_000 });
    expect(lib.getRun(started.id)?.anthropicAccount).toBe(work.id);

    // The chat hit the weekly limit on the same account.
    await pool.markLimited(work.id, Date.now() + 60 * 60_000, "weekly", { source: "chat" });

    const run = await settled(started.id);
    expect(run.status).toBe("completed");
    expect(run.anthropicAccount).toBe(personal.id);
    expect(run.accountSwitches).toEqual([expect.objectContaining({ fromId: work.id, toId: personal.id, kind: "moved" })]);
    expect(run.progress).toContain('Anthropic account "Work" can no longer answer; carrying on with "Personal" in the same session');
    expect(calls()[1].args).toContain(`--resume ${SESSION}`);
    expect(calls()[1].cred).toBe(`api_key:${KEY_B}:`);
    expect(run.retries).toBe(0);
    // One notice for the one move, whoever saw the limit.
    await vi.waitFor(() => expect(announceAnthropicLimit).toHaveBeenCalledTimes(1));
  });

  it("leaves a run on an account that can still answer when the owner changes the order", async () => {
    installWrapper(["hang", "ok"]);
    makeProject("site");
    const { work, personal } = await twoAccounts();
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner", provider: "anthropic" });
    await vi.waitFor(() => expect(lib.getRun(started.id)?.sessionId).toBe(SESSION), { timeout: 10_000 });

    await pool.reorderAccounts([personal.id, work.id]);
    await (await import("@/lib/anthropic-swap")).whenSwapsSettled();
    expect(lib.getRun(started.id)).toMatchObject({ status: "running", anthropicAccount: work.id });
    expect(calls()).toHaveLength(1);
  });
});
