/**
 * WHY a coding run is paused, and why "the owner did it" must stay the
 * default answer.
 *
 * Seen on a real box: a run asked for a picture, this box's daily image
 * allowance was spent, the portal answered 429, the run was asked to pause
 * and settled as `paused` — and the only thing said about it anywhere was
 * "Paused — resume to continue". The owner's one move was Resume, which buys
 * the same refusal; nothing on the box or in the API said an allowance was
 * the reason or when it comes back.
 *
 * `pauseRun`'s only caller is the pause route, which knows a run id and
 * nothing else, so the reason cannot be discovered where the pause is made.
 * It is recorded where the refusal IS known — the media routes — and read
 * back at the pause. That indirection is the risk this file exists for: an
 * ordinary pause must never come out wearing an allowance's explanation. So
 * what is pinned here is the narrowness — fresh, single-use, per-meter,
 * cleared the moment the meter delivers again — as much as the feature.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";
import {
  MAX_PAUSE_MESSAGE_CHARS,
  PAUSE_METER_NOUN,
  PAUSE_METERS,
  parsePauseReason,
  pauseResetClock,
} from "@/lib/coding-agent-status";

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

const INIT = '{"type":"system","subtype":"init","session_id":"sess-abc-123","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(cfg), "utf-8");
}

/** A wrapper that starts, reports a session, and then waits to be killed —
 *  the shape a pause needs: a live process with a session to come back to. */
function installWaitingWrapper(flag: string): void {
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      readFirstTurn(),
      `echo '${INIT}'`,
      `while [ ! -f "${flag}" ]; do sleep 0.05; done`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
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
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-pause-"));
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

/** A live run with a session, ready to be paused. */
async function liveRun(name = "site"): Promise<string> {
  installWaitingWrapper(path.join(base, `flag-${name}`));
  writeConfig({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true });
  makeProject(name);
  const started = await lib.startRun({ task: "build", projectId: name, source: "owner" });
  await vi.waitFor(() => { expect(lib.getRun(started.id)?.sessionId).toBe("sess-abc-123"); }, { timeout: 5000 });
  return started.id;
}

async function settled(id: string) {
  const run = await lib.waitForRun(id, 15_000);
  if (!run) throw new Error("run vanished");
  return run;
}

describe("reading a pause reason off a record", () => {
  it("round-trips the two kinds it knows", () => {
    expect(parsePauseReason({ kind: "owner" })).toEqual({ kind: "owner" });
    const allowance = {
      kind: "allowance",
      meter: "images",
      resetsAt: "2026-09-13T00:00:00.000Z",
      message: "You have used up today's ClawBox AI pictures.",
    };
    expect(parsePauseReason(allowance)).toEqual(allowance);
  });

  it("degrades an unknown shape to no reason rather than to a new kind of pause", () => {
    // A hand-edited runs file, or one written by a newer build. Every one of
    // these has to read as "nothing was recorded", because the alternative is
    // a surface asked to word a pause it has no words for.
    for (const bad of [
      null, undefined, "owner", 7, [],
      { kind: "spooked" },
      { kind: "allowance" },
      { kind: "allowance", meter: "gpu" },
      { kind: "allowance", meter: null },
      // Metered, and genuinely exhaustible — but neither ends a run in a
      // pause, so neither is a pause reason this box can word.
      { kind: "allowance", meter: "tokens" },
      { kind: "allowance", meter: "audio" },
      // No refusal quoted. Every writer has one in hand, so a record without
      // one was not written by this code — and unlike a null `resetsAt`,
      // which is a writer saying honestly that the far side named no hour,
      // an absent message is a gap rather than a fact.
      { kind: "allowance", meter: "images", resetsAt: null },
      { kind: "allowance", meter: "images", resetsAt: null, message: null },
      { kind: "allowance", meter: "images", resetsAt: null, message: 42 },
      { kind: "allowance", meter: "images", resetsAt: null, message: { text: "spent" } },
    ]) {
      expect(parsePauseReason(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("accepts a writer that honestly had nothing to quote", () => {
    // "" is a statement — the refusal carried no words — and is not the same
    // as the field being absent, which is a record this code did not write.
    expect(parsePauseReason({ kind: "allowance", meter: "images", resetsAt: null, message: "" }))
      .toEqual({ kind: "allowance", meter: "images", resetsAt: null, message: "" });
  });

  it("drops a reset time it cannot read instead of passing it on", () => {
    // A reset time is a claim about the future; an unreadable one is no claim,
    // and the card says "resume when it is back" rather than showing junk.
    const parsed = parsePauseReason({ kind: "allowance", meter: "images", resetsAt: "soon", message: "out" });
    expect(parsed).toEqual({ kind: "allowance", meter: "images", resetsAt: null, message: "out" });
  });

  it("bounds the upstream sentence it carries", () => {
    // The record is read on every boot and polled by two UIs; an upstream
    // that answered a megabyte of HTML must not become a megabyte of record.
    const parsed = parsePauseReason({ kind: "allowance", meter: "images", resetsAt: null, message: "x".repeat(5_000) });
    expect(parsed).toMatchObject({ kind: "allowance" });
    if (parsed?.kind !== "allowance") throw new Error("unreachable");
    expect(parsed.message).toHaveLength(MAX_PAUSE_MESSAGE_CHARS);
  });

  it("reads a reset instant as the UTC clock both surfaces show", () => {
    // UTC, not the box's zone: the allowance is counted per UTC day, and an
    // hour rendered locally would be a different claim.
    expect(pauseResetClock("2026-09-13T00:00:00.000Z")).toBe("00:00");
    expect(pauseResetClock("2026-09-13T07:05:00.000Z")).toBe("07:05");
    expect(pauseResetClock(null)).toBeNull();
    expect(pauseResetClock("not a time")).toBeNull();
  });

  it("names every meter, so no surface can be handed one it cannot word", () => {
    // Driven off the list itself: a meter added without a noun beside it is
    // an English sentence the agent-facing text cannot say, and the locale
    // catalogues have a parity test of their own for the app's half.
    expect(PAUSE_METERS.length).toBeGreaterThan(0);
    for (const meter of PAUSE_METERS) {
      expect(PAUSE_METER_NOUN[meter], meter).toBeTruthy();
    }
  });

  it("lists only meters something on the box can actually produce", () => {
    // The record format is not a wish list. A run's token ceiling and its
    // cost ceiling settle it as stopped/failed with their own sentence, and a
    // spent per-run media cap refuses the call while the run carries on —
    // none of them is a pause, so none of them belongs here.
    expect([...PAUSE_METERS]).toEqual(["images", "speech"]);
  });
});

describe("what a pause is attributed to", () => {
  it("calls an ordinary pause the owner's, and says so rather than leaving it blank", async () => {
    const id = await liveRun();
    lib.pauseRun(id);
    const paused = await settled(id);
    expect(paused.status).toBe("paused");
    // Explicitly `owner`, never null: null means "nothing was recorded", and
    // a reader must not have to treat the two as the same thing.
    expect(paused.pauseReason).toEqual({ kind: "owner" });
  });

  it("blames the allowance when a refusal for this run came moments before", async () => {
    const id = await liveRun();
    lib.noteAllowanceRefusal(id, "images", {
      resetsAt: "2026-09-13T00:00:00.000Z",
      message: "You have used up today's ClawBox AI pictures. The allowance resets at midnight UTC.",
    });
    lib.pauseRun(id);
    const paused = await settled(id);
    expect(paused.pauseReason).toEqual({
      kind: "allowance",
      meter: "images",
      resetsAt: "2026-09-13T00:00:00.000Z",
      message: "You have used up today's ClawBox AI pictures. The allowance resets at midnight UTC.",
    });
  });

  it("survives the runs file, because the reason outlives the process that knew it", async () => {
    const id = await liveRun();
    lib.noteAllowanceRefusal(id, "images", { resetsAt: "2026-09-13T00:00:00.000Z", message: "spent" });
    lib.pauseRun(id);
    await settled(id);

    // A fresh module, reading the record off disk the way a restarted server
    // does — which is the only state the owner ever actually looks at.
    vi.resetModules();
    const reloaded = await import("@/lib/coding-agent");
    expect(reloaded.getRun(id)?.pauseReason).toEqual({
      kind: "allowance", meter: "images", resetsAt: "2026-09-13T00:00:00.000Z", message: "spent",
    });
  });

  it("will not let a stale refusal explain a later pause", async () => {
    const id = await liveRun();
    lib.noteAllowanceRefusal(id, "images", { resetsAt: null, message: "spent" });
    // Far past the window: the run carried on for an hour and the owner then
    // paused it for reasons of their own. Only the clock is faked, and only
    // across the one synchronous call that reads it — the run being paused is
    // a real child process, and it still has to be waited for on real time.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + lib.PAUSE_AFTER_REFUSAL_MS + 60_000 });
    try {
      lib.pauseRun(id);
    } finally {
      vi.useRealTimers();
    }
    expect((await settled(id)).pauseReason).toEqual({ kind: "owner" });
  });

  it("spends a refusal on one pause only", async () => {
    const id = await liveRun();
    lib.noteAllowanceRefusal(id, "images", { resetsAt: null, message: "spent" });
    lib.pauseRun(id);
    expect((await settled(id)).pauseReason).toMatchObject({ kind: "allowance" });

    // Resumed, and later paused again for no stated reason. The first pause
    // consumed the refusal; nothing is left for this one to borrow.
    await lib.resumeRun(id);
    await vi.waitFor(() => { expect(lib.getRun(id)?.status).toBe("running"); }, { timeout: 5000 });
    lib.pauseRun(id);
    expect((await settled(id)).pauseReason).toEqual({ kind: "owner" });
  });

  it("forgets a refusal once that same meter delivers a file", async () => {
    const id = await liveRun();
    const run = lib.getRun(id)!;
    lib.noteAllowanceRefusal(id, "images", { resetsAt: null, message: "spent" });
    // The allowance came back mid-run and the run got its picture. The meter
    // is plainly not what is stopping it now.
    lib.noteRunMedia(id, path.join(run.directory, "hero.png"), "images");
    lib.pauseRun(id);
    expect((await settled(id)).pauseReason).toEqual({ kind: "owner" });
  });

  it("keeps a refusal that a DIFFERENT meter's delivery cannot speak for", async () => {
    const id = await liveRun();
    const run = lib.getRun(id)!;
    lib.noteAllowanceRefusal(id, "images", { resetsAt: null, message: "spent" });
    // The box spoke a clip. That says nothing about the picture allowance.
    lib.noteRunMedia(id, path.join(run.directory, "line.wav"), "speech");
    lib.pauseRun(id);
    expect((await settled(id)).pauseReason).toMatchObject({ kind: "allowance", meter: "images" });
  });

  it("ignores a refusal aimed at a run that is not live", async () => {
    const id = await liveRun();
    lib.pauseRun(id);
    await settled(id);
    // A media call that outlived its run — the audio route can wait seconds
    // in the speech queue — must not edit a record that already settled.
    lib.noteAllowanceRefusal(id, "images", { resetsAt: null, message: "too late" });
    expect(lib.getRun(id)?.pauseReason).toEqual({ kind: "owner" });
  });
});

describe("when the reason stops being true", () => {
  it("clears it on resume, so it cannot describe the pause before last", async () => {
    const id = await liveRun();
    lib.noteAllowanceRefusal(id, "images", { resetsAt: null, message: "spent" });
    lib.pauseRun(id);
    await settled(id);
    const resumed = await lib.resumeRun(id);
    expect(resumed.status).toBe("running");
    expect(resumed.pauseReason).toBeNull();
  });

  it("clears it when the owner closes the book on a paused run", async () => {
    const id = await liveRun();
    lib.noteAllowanceRefusal(id, "images", { resetsAt: null, message: "spent" });
    lib.pauseRun(id);
    await settled(id);
    const stopped = lib.stopRun(id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.pauseReason).toBeNull();
  });
});
