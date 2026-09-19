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
function installWrapper(plan: readonly ("limit" | "ok" | "hang")[]): void {
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
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  pool._resetAnthropicAccountsForTests();
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
  });
});
