/**
 * When the harness itself cannot get a model to answer.
 *
 * Seen on a real box. A run died in seconds and the card carried, whole and
 * alone, the line the CLI had printed:
 *
 *     [claude-code:unrecognized_model] {"model":"deepseek-v4-pro[1m]","query_source":"sdk"}
 *
 * Nothing in that is actionable by the person it was shown to, and nothing on
 * the box acted on it either: the next run asked for the same model and died
 * the same way, and so did the one after it.
 *
 * Two things are pinned here. The record and the card must say, in words, that
 * the DEVICE is not ready — and a box that has just proved that must refuse
 * the next run before spawning it rather than after it dies.
 *
 * And one thing must NOT change: `unrecognized_model` is in the transient set
 * on evidence (one run died to it minutes after another finished a whole build
 * on the same model string), so the one automatic retry still happens first.
 * The retry is what tells a flap apart from a fault; only the FINAL failure is
 * a verdict about the device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import {
  HARNESS_FAULT_CONFIG_KEY,
  HARNESS_FAULT_TTL_MS,
  HARNESS_NOT_READY_SENTENCE,
  harnessFaultMessage,
  isHarnessFault,
  parseHarnessFault,
} from "@/lib/coding-harness-fault";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

type Lib = typeof import("@/lib/coding-agent");

let lib: Lib;
let base: string;
let home: string;
let root: string;
let binDir: string;
let restore: () => void;

/** The line the box actually died on. */
const UNRECOGNIZED = '[claude-code:unrecognized_model] {"model":"deepseek-v4-pro[1m]","query_source":"sdk"}';

const INIT = '{"type":"system","subtype":"init","session_id":"sess-abc-123","model":"deepseek-v4-pro","permissionMode":"acceptEdits"}';

function resultError(message: string): string {
  return JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: message, num_turns: 0 });
}

function okResult(): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 1 });
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf-8")) as Record<string, unknown>;
}

/** A wrapper whose body is the bash the test wants. */
function installWrapper(body: string): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    ["#!/usr/bin/env bash", "cat > /dev/null", body].join("\n"),
    { mode: 0o755 },
  );
}

/**
 * A wrapper that dies the way the box died — every time it is asked, so the
 * automatic retry finds the same wall the first attempt did.
 */
function installFailingWrapper(message = UNRECOGNIZED): void {
  installWrapper([`printf '%s\\n' '${INIT}' '${resultError(message).replace(/'/g, "'\\''")}'`, "exit 1"].join("\n"));
}

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

function enableAgent(): void {
  writeConfig({ clawai_token: "claw_test_token", clawai_tier: "pro", coding_agent_enabled: true });
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-harness-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  writeConfig({});
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function settled(id: string) {
  const run = await lib.waitForRun(id, 20_000);
  if (!run) throw new Error("run vanished");
  return run;
}

describe("what counts as the harness not being ready", () => {
  it("recognises the line the box actually died on", () => {
    expect(isHarnessFault(UNRECOGNIZED)).toBe(true);
  });

  it("recognises the other ways a model refuses to answer at all", () => {
    for (const err of [
      "API Error: 400 Model not allowed",
      "model_not_found: deepseek-v4-pro",
      "Unknown model: deepseek-v4-pro[1m]",
      "invalid_api_key: the provided key is not valid",
      "authentication_error",
      "API Error: 401 Unauthorized",
      "API Error: 403 Forbidden",
      "Claude Code is not installed on this ClawBox.",
      "ClawBox AI is not connected. Open Settings → AI Models.",
    ]) {
      expect(isHarnessFault(err), err).toBe(true);
    }
  });

  it("is not a verdict on the TASK", () => {
    // Every one of these is an answer about the work, and dressing it up as a
    // device fault would send the owner to Settings for a problem that is in
    // their own prompt — and, worse, would have the box refuse the next run.
    for (const err of [
      "Stopped after 60 turns without finishing.",
      "Stopped at the cost ceiling for one run.",
      "Stopped at the token limit (12,000 of 10,000).",
      "Ran longer than 20 minutes and was stopped.",
      "Stopped before it finished.",
      "Claude Code exited with code 1 before reporting a result.",
      "The task refers to a file that does not exist.",
      "API Error: 502 Bad Gateway",
      "socket hang up",
      null,
      undefined,
      "",
    ]) {
      expect(isHarnessFault(err), String(err)).toBe(false);
    }
  });

  it("still counts as transient, so the one automatic retry is untouched", async () => {
    // The hard constraint. A fault is only declared once the retry has failed
    // to shake it off; if this ever stopped being transient, a flap would kill
    // a run that a second attempt would have completed.
    expect(lib.isTransientFailure(UNRECOGNIZED)).toBe(true);
  });
});

describe("the message the owner is left with", () => {
  it("leads with what to do and keeps what the harness said", () => {
    const message = harnessFaultMessage(UNRECOGNIZED);
    expect(message.startsWith(HARNESS_NOT_READY_SENTENCE)).toBe(true);
    expect(message).toContain("Settings → AI Models");
    // The model that was refused is the first thing anyone looking into this
    // needs, so it survives — just not as the opening line.
    expect(message).toContain("deepseek-v4-pro[1m]");
  });

  it("bounds the line it quotes and flattens it to one", () => {
    const message = harnessFaultMessage(`${"x".repeat(4_000)}\n\nand more`);
    expect(message.length).toBeLessThan(HARNESS_NOT_READY_SENTENCE.length + 300);
    expect(message.split("\n\n")).toHaveLength(2);
  });

  it("says the sentence alone when there was nothing to quote", () => {
    expect(harnessFaultMessage("")).toBe(HARNESS_NOT_READY_SENTENCE);
    expect(harnessFaultMessage(null)).toBe(HARNESS_NOT_READY_SENTENCE);
  });
});

describe("reading a remembered fault", () => {
  it("keeps one inside its window", () => {
    const at = Date.now() - 1_000;
    expect(parseHarnessFault({ at })).toEqual({ at });
  });

  it("drops one that has expired, so a box is never pinned shut", () => {
    expect(parseHarnessFault({ at: Date.now() - HARNESS_FAULT_TTL_MS - 1 })).toBeNull();
  });

  it("drops one stamped in the future", () => {
    // A clock that jumped forward and back would otherwise refuse runs for as
    // long as the jump lasted, with nothing on screen explaining it.
    expect(parseHarnessFault({ at: Date.now() + 60_000 })).toBeNull();
  });

  it("carries nothing but the time", () => {
    // Anything else stored here would be stored for a reader that does not
    // exist: the readiness sentence deliberately quotes no error code, and
    // the run's own record already carries the full message.
    expect(Object.keys(parseHarnessFault({ at: Date.now(), error: "x" }) ?? {})).toEqual(["at"]);
  });

  it("reads anything else as no fault at all", () => {
    for (const bad of [null, undefined, "yes", 1, [], {}, { at: "soon" }, { at: NaN }]) {
      expect(parseHarnessFault(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("a run that dies because the harness is not ready", () => {
  it("retries once, then says so on the record instead of handing over the raw line", async () => {
    installFailingWrapper();
    enableAgent();
    makeProject("site");
    const started = await lib.startRun({ task: "build", projectId: "site", source: "owner" });
    const run = await settled(started.id);

    expect(run.status).toBe("failed");
    // The retry happened — and it is what makes the verdict below a verdict
    // rather than a guess at the first sign of trouble.
    expect(run.retries).toBe(1);
    expect(run.failureKind).toBe("harness_not_ready");
    expect(run.error).toContain(HARNESS_NOT_READY_SENTENCE);
    // The evidence is kept, but it is no longer the whole message.
    expect(run.error).toContain("deepseek-v4-pro[1m]");
    expect(run.error?.startsWith("[claude-code:")).toBe(false);
    // Resuming replays a failure Claude Code persists in the session, and
    // there is no work in it to come back to anyway.
    expect(run.resumable).toBe(false);
  });

  it("leaves an ordinary failure of the work exactly as it was", async () => {
    installFailingWrapper("The task refers to a file that does not exist.");
    enableAgent();
    makeProject("site");
    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);
    expect(run.status).toBe("failed");
    expect(run.failureKind).toBeNull();
    expect(run.error).toContain("does not exist");
    expect(run.error).not.toContain(HARNESS_NOT_READY_SENTENCE);
    // And nothing is remembered, so the next run is not refused.
    expect(readConfig()[HARNESS_FAULT_CONFIG_KEY]).toBeFalsy();
  });
});

describe("the pre-flight check", () => {
  it("refuses the next run before spawning it, rather than after it dies", async () => {
    // The whole point. Before this, a box in this state produced a column of
    // identical dead runs, each one costing a spawn and telling the owner the
    // same unreadable thing.
    installFailingWrapper();
    enableAgent();
    makeProject("site");
    await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);

    const before = lib.listRuns(50).length;
    await expect(lib.startRun({ task: "build again", projectId: "site", source: "owner" }))
      .rejects.toThrow(/not ready/i);
    // Refused, not recorded: no second dead run on the owner's list.
    expect(lib.listRuns(50)).toHaveLength(before);
  });

  it("says why, and says it where the app already looks", async () => {
    installFailingWrapper();
    enableAgent();
    makeProject("site");
    await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);

    const readiness = await lib.checkReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.harnessHealthy).toBe(false);
    // Everything that is about the DISK is still fine, which is exactly why
    // this needed a check of its own.
    expect(readiness.claudeInstalled).toBe(true);
    expect(readiness.wrapperInstalled).toBe(true);
    expect(readiness.clawaiConnected).toBe(true);
    expect(readiness.problems.join(" ")).toContain("not ready");
  });

  it("lets runs through again once the fault has expired", async () => {
    installFailingWrapper();
    enableAgent();
    makeProject("site");
    await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);
    expect((await lib.checkReadiness()).harnessHealthy).toBe(false);

    // An entitlement flap comes right on its own, and a box that refused work
    // for ever over one would need an owner to find a switch nobody
    // documented. Only the clock is moved.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + HARNESS_FAULT_TTL_MS + 1_000 });
    try {
      expect((await lib.checkReadiness()).harnessHealthy).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the fault the moment a run completes", async () => {
    installFailingWrapper();
    enableAgent();
    makeProject("site");
    await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);
    expect((await lib.checkReadiness()).harnessHealthy).toBe(false);

    // The only proof that matters, and the reliable way back: the harness
    // worked. Cleared by hand here because the pre-flight would refuse the
    // run that would otherwise prove it — which is the point of the refusal.
    await lib.clearHarnessFault();
    installWrapper([`printf '%s\\n' '${INIT}' '${okResult()}'`, "exit 0"].join("\n"));
    const run = await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);
    expect(run.status).toBe("completed");
    expect((await lib.checkReadiness()).harnessHealthy).toBe(true);
    expect(readConfig()[HARNESS_FAULT_CONFIG_KEY]).toBeFalsy();
  });

  it("clears on the owner's say-so, so the message is never a dead end", async () => {
    installFailingWrapper();
    enableAgent();
    makeProject("site");
    await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);

    await lib.clearHarnessFault();
    expect((await lib.checkReadiness()).harnessHealthy).toBe(true);
    // And a run is accepted again — it may well fail the same way, but that
    // is the owner's call to make after they have changed something.
    const again = await lib.startRun({ task: "build again", projectId: "site", source: "owner" });
    await settled(again.id);
  });

  it("refuses even when the fault never reached the disk", async () => {
    // finishRun cannot await, so the write is fired and forgotten; a full disk
    // or a permissions change loses it silently. The process keeps its own
    // copy for exactly that, and for the window between the call and the file
    // landing — the agent starting a follow-up the moment the first run
    // settles used to read a config that said nothing was wrong.
    installFailingWrapper();
    enableAgent();
    makeProject("site");
    await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);

    // The durable copy, taken away underneath the process.
    const cfg = readConfig();
    delete cfg[HARNESS_FAULT_CONFIG_KEY];
    writeConfig(cfg);
    expect(readConfig()[HARNESS_FAULT_CONFIG_KEY]).toBeUndefined();

    expect((await lib.checkReadiness()).harnessHealthy).toBe(false);
    await expect(lib.startRun({ task: "build again", projectId: "site", source: "owner" }))
      .rejects.toThrow(/not ready/i);
  });

  it("clears the copy the disk never had, so Try again is not a no-op", async () => {
    installFailingWrapper();
    enableAgent();
    makeProject("site");
    await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);
    const cfg = readConfig();
    delete cfg[HARNESS_FAULT_CONFIG_KEY];
    writeConfig(cfg);

    // An early return over the absent config key would have left the copy
    // that is doing the refusing exactly where it was.
    await lib.clearHarnessFault();
    expect((await lib.checkReadiness()).harnessHealthy).toBe(true);
  });

  it("ages the process's own copy out on the same clock as the disk's", async () => {
    installFailingWrapper();
    enableAgent();
    makeProject("site");
    await settled((await lib.startRun({ task: "build", projectId: "site", source: "owner" })).id);
    const cfg = readConfig();
    delete cfg[HARNESS_FAULT_CONFIG_KEY];
    writeConfig(cfg);
    expect((await lib.checkReadiness()).harnessHealthy).toBe(false);

    // One TTL rule for both copies — a second one would be a second thing to
    // get wrong, and a box pinned shut by a fault nothing can see.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + HARNESS_FAULT_TTL_MS + 1_000 });
    try {
      expect((await lib.checkReadiness()).harnessHealthy).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about the harness on a box that has never seen a fault", async () => {
    enableAgent();
    const readiness = await lib.checkReadiness();
    expect(readiness.harnessHealthy).toBe(true);
    expect(readiness.problems.join(" ")).not.toContain(HARNESS_NOT_READY_SENTENCE);
  });
});
