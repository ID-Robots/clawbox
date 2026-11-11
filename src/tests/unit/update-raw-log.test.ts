/**
 * The raw update log (TASK-2428): every byte the update's root steps wrote to
 * their journal, in order, once, redacted — and the same file again after the
 * web server that was writing it is replaced half-way.
 *
 * journalctl and systemctl are a fake journal here (the `spawn` seam): units,
 * entries with cursors, and `--since` / `--after-cursor` / `--show-cursor`
 * answered the way journalctl answers them. The timers are a queue the test
 * runs by hand, so "the next poll" is a line in the test, not a sleep.
 */
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_LOG_KEEP,
  UPDATE_LOG_MAX_BYTES,
  closeUpdateLog,
  currentUpdateLogId,
  finishUpdateUnitFollows,
  followUpdateUnit,
  latestUpdateLog,
  logUpdateCommand,
  logUpdateStepEnd,
  logUpdateStepStart,
  openUpdateLog,
  parseUpdateLogResumeId,
  readUpdateLogChunk,
  resetUpdateLogForTests,
  setUpdateLogDepsForTests,
  settleUpdateLogForTests,
  splitCursor,
  updateLogDir,
  updateLogInfo,
  wholeUtf8Length,
  writeUpdateLog,
} from "@/lib/update-raw-log";

interface Entry { unit: string; at: number; message: string; cursor: string }

let entries: Entry[] = [];
let unitState: Record<string, string> = {};
/** journalctl refuses every --after-cursor read (a rotated journal). */
let cursorRefused = false;
let journalCalls: string[][] = [];
let now = 1_800_000_000_000;
let timers: { fn: () => void; at: number; id: number }[] = [];
let timerId = 0;
let root = "";
let previousRoot: string | undefined;

function say(unit: string, message: string, at = now): void {
  entries.push({ unit: `clawbox-root-update@${unit}.service`, at, message, cursor: `c${entries.length + 1}` });
}

function fakeChild(output: string, code = 0) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => boolean };
  child.stdout = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => {
    if (output) child.stdout.emit("data", Buffer.from(output, "utf8"));
    child.emit("close", code);
  });
  return child;
}

function fakeSpawn(command: string, args: readonly string[]) {
  if (command === "/usr/bin/systemctl") {
    const unit = args[1];
    return fakeChild(`${unitState[unit] ?? "inactive"}\n`);
  }
  journalCalls.push([...args]);
  const unit = args[args.indexOf("-u") + 1];
  const after = args.includes("--after-cursor") ? args[args.indexOf("--after-cursor") + 1] : null;
  if (after && cursorRefused) return fakeChild("Failed to seek to cursor: Invalid argument\n", 1);
  if (args.includes("-n") && args[args.indexOf("-n") + 1] === "1") {
    const last = entries.filter((e) => e.unit === unit).at(-1);
    return fakeChild(last ? `${last.message}\n-- cursor: ${last.cursor}\n` : "");
  }
  const since = args.includes("--since") ? Number(args[args.indexOf("--since") + 1].slice(1)) * 1000 : 0;
  let mine = entries.filter((e) => e.unit === unit);
  if (after) mine = mine.slice(mine.findIndex((e) => e.cursor === after) + 1);
  else mine = mine.filter((e) => e.at >= since);
  if (mine.length === 0) return fakeChild("");
  return fakeChild(mine.map((e) => `${e.message}\n`).join("") + `-- cursor: ${mine[mine.length - 1].cursor}\n`);
}

/** Let every spawned child answer and every write land, however slow the disk. */
async function settle(): Promise<void> {
  await settleUpdateLogForTests();
}

/** Run the timers due within `ms`, then settle. */
async function advance(ms: number): Promise<void> {
  await settle();
  now += ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    due.fn();
    await settle();
  }
  await settle();
}

function logText(id: string): string {
  return fs.readFileSync(path.join(updateLogDir(), `${id}.log`), "utf8");
}

beforeEach(async () => {
  previousRoot = process.env.CLAWBOX_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-update-log-"));
  process.env.CLAWBOX_ROOT = root;
  entries = [];
  unitState = {};
  cursorRefused = false;
  journalCalls = [];
  timers = [];
  setUpdateLogDepsForTests({
    spawn: fakeSpawn as never,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms, id: ++timerId };
      timers.push(t);
      return t;
    },
    clearTimer: (handle) => { timers = timers.filter((t) => t !== handle); },
  });
  await resetUpdateLogForTests();
});

afterEach(async () => {
  await resetUpdateLogForTests();
  setUpdateLogDepsForTests();
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("capture", () => {
  it("writes a step's journal byte for byte — colours and carriage returns included — under a header, then the step's result", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    expect(id).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{4}$/);
    const step = { id: "apt_update", label: "Updating system packages" };
    await logUpdateStepStart(step, 1, 9);
    const dispatched = now;
    const follow = followUpdateUnit("apt_update", dispatched);
    say("apt_update", "\x1b[1;34m  Refreshing apt\x1b[0m");
    say("apt_update", "Reading package lists... 0%\rReading package lists... 100%");
    await advance(1_000);
    say("apt_update", "Done");
    await follow.finish();
    await settle();
    await logUpdateStepEnd(step, "completed", undefined, dispatched);

    const text = logText(id!);
    expect(text).toContain("==> [2/9] Updating system packages");
    expect(text).toContain(
      `$ journalctl -u clawbox-root-update@apt_update.service --since @${(dispatched / 1000).toFixed(3)} -o cat`,
    );
    expect(text).toContain("\x1b[1;34m  Refreshing apt\x1b[0m\nReading package lists... 0%\rReading package lists... 100%\nDone\n");
    expect(text).toContain("==> Updating system packages: completed");
    // In order: header, source line, output, result.
    const order = ["==> [2/9]", "$ journalctl", "Refreshing apt", "Done", ": completed"].map((s) => text.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The first read is bounded by the dispatch, every later one by the cursor.
    expect(journalCalls[0]).toEqual(expect.arrayContaining(["--since", `@${(dispatched / 1000).toFixed(3)}`, "-o", "cat", "--show-cursor", "-q"]));
    const since = journalCalls.filter((args) => !args.includes("--after-cursor"));
    expect(since.every((args) => args.includes(`@${(dispatched / 1000).toFixed(3)}`))).toBe(true);
    expect(journalCalls.filter((args) => args.includes("--after-cursor")).length).toBeGreaterThan(0);
  });

  it("reads each entry once however often it polls, and only this dispatch's", async () => {
    say("post_update", "line from the PREVIOUS run", now - 60_000);
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    const follow = followUpdateUnit("post_update", now);
    for (let i = 1; i <= 5; i++) {
      say("post_update", `fixup ${i}`);
      await advance(1_000);
      await advance(1_000);
    }
    await follow.finish();
    await advance(5_000);
    const text = logText(id!);
    expect(text).not.toContain("PREVIOUS run");
    for (let i = 1; i <= 5; i++) expect(text.split(`fixup ${i}\n`)).toHaveLength(2);
    // One source line: nothing else wrote between the reads.
    expect(text.split("$ journalctl")).toHaveLength(2);
  });

  it("reads a unit a little after its step returned, for the lines journald stored late", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    const follow = followUpdateUnit("gateway_setup", now);
    say("gateway_setup", "configured");
    await follow.finish();
    say("gateway_setup", "clawbox-root-update@gateway_setup.service: Deactivated successfully.");
    await logUpdateStepEnd({ id: "gateway_setup", label: "Configuring gateway service" }, "completed");
    await advance(3_000);
    const text = logText(id!);
    expect(text).toContain("configured\n");
    expect(text).toContain("$ journalctl -u clawbox-root-update@gateway_setup.service");
    expect(text).toMatch(/\(continued\).*\nclawbox-root-update@gateway_setup\.service: Deactivated successfully\.\n/);
  });

  it("follows an overrun unit until it has stopped, then lets go", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    const follow = followUpdateUnit("llamacpp_runtime", now);
    unitState["clawbox-root-update@llamacpp_runtime.service"] = "active";
    say("llamacpp_runtime", "[ 10%] Building CUDA object");
    await advance(1_000);
    follow.settleThenFinish();
    say("llamacpp_runtime", "[100%] Linking");
    await advance(1_000);
    unitState["clawbox-root-update@llamacpp_runtime.service"] = "inactive";
    await advance(1_000);
    await advance(1_000);
    const calls = journalCalls.length;
    await advance(10_000);
    expect(journalCalls.length).toBe(calls);
    expect(logText(id!)).toContain("[ 10%] Building CUDA object\n[100%] Linking\n");
  });

  it("finishUpdateUnitFollows ends the follows of one step", async () => {
    await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    followUpdateUnit("openclaw_install", now);
    await settle();
    await finishUpdateUnitFollows("openclaw_install");
    await advance(3_000);
    const calls = journalCalls.length;
    await advance(10_000);
    expect(journalCalls.length).toBe(calls);
  });

  it("writes a command the server runs itself, then what it printed, and passes the answer and the error through", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    const answer = await logUpdateCommand(["git", "reset", "--hard", "HEAD"], async () => ({ stdout: "HEAD is now at abc1234 msg\n", stderr: "" }));
    expect(answer.stdout).toBe("HEAD is now at abc1234 msg\n");
    const failure = Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "error: build failed" });
    await expect(logUpdateCommand(["bun", "run", "build"], async () => { throw failure; })).rejects.toBe(failure);
    await settle(); // the lines are queued, not waited for by the command
    const text = logText(id!);
    expect(text).toContain("$ git reset --hard HEAD");
    expect(text).toContain("HEAD is now at abc1234 msg\n");
    expect(text).toContain("$ bun run build");
    expect(text).toContain("error: build failed\n");
    expect(text).toContain("(exit 1)");
  });

  it("is a no-op — and never a throw — while no run is open", async () => {
    expect(currentUpdateLogId()).toBeNull();
    await writeUpdateLog("nothing\n");
    const follow = followUpdateUnit("apt_update");
    await follow.finish();
    expect(await logUpdateCommand(["true"], async () => 7)).toBe(7);
    await closeUpdateLog("completed");
    expect(fs.existsSync(updateLogDir())).toBe(false);
  });

  it("costs the log, not the update, when the data folder cannot be written", async () => {
    fs.writeFileSync(path.join(root, "data"), "a file where the folder should be");
    expect(await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" })).toBeNull();
    expect(await logUpdateCommand(["true"], async () => "ok")).toBe("ok");
  });
});

describe("capture, when things go wrong", () => {
  it("moves on from the unit's newest entry when journald no longer knows the cursor", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    followUpdateUnit("post_update", now);
    say("post_update", "before the rotation");
    await advance(1_000);
    cursorRefused = true;
    say("post_update", "lost in the rotation");
    for (let i = 0; i < 4; i++) await advance(1_000);
    cursorRefused = false;
    say("post_update", "after the rotation");
    await advance(1_000);
    await advance(1_000);
    const text = logText(id!);
    expect(text).toContain("before the rotation\n");
    expect(text).toContain("could not be read on from where the log stopped");
    expect(text).toContain("after the rotation\n");
    expect(text.split("before the rotation")).toHaveLength(2);
  });

  it("keeps the follow moving when one read is more than the log takes", async () => {
    setUpdateLogDepsForTests({
      spawn: fakeSpawn as never,
      journalMaxBytes: 64,
      now: () => now,
      setTimer: (fn, ms) => { const t = { fn, at: now + ms, id: ++timerId }; timers.push(t); return t; },
      clearTimer: (handle) => { timers = timers.filter((t) => t !== handle); },
    });
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    followUpdateUnit("rebuild_reboot", now);
    for (let i = 0; i < 20; i++) say("rebuild_reboot", `compiling module ${i}`);
    await advance(1_000);
    say("rebuild_reboot", "Build complete");
    await advance(1_000);
    const text = logText(id!);
    expect(text).toContain("compiling module 0\n");
    expect(text).toMatch(/\d+ more bytes of this unit's output came in one read/);
    expect(text).toContain("Build complete\n");
    expect(text).not.toContain("compiling module 19");
  });

  it("takes a half-written chunk back off the file, so the record never points into it", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    await writeUpdateLog("whole line\n");
    const real = fs.promises.appendFile.bind(fs.promises);
    vi.spyOn(fs.promises, "appendFile").mockImplementationOnce(async (file, data) => {
      await real(file as string, String(data).slice(0, 5));
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    await writeUpdateLog("this write fails half-way\n");
    await writeUpdateLog("next line\n");
    const text = logText(id!);
    expect(text).not.toContain("this ");
    expect(text.endsWith("whole line\nnext line\n")).toBe(true);
    expect(await updateLogInfo(id!)).toMatchObject({ size: Buffer.byteLength(text) });
  });

  it("marks the run finished even when its closing line cannot be written", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    vi.spyOn(fs.promises, "appendFile").mockRejectedValueOnce(new Error("EIO"));
    await closeUpdateLog("failed", "gateway did not start");
    expect(await updateLogInfo(id!)).toMatchObject({ finished: true, outcome: "failed" });
  });

  it("opens one run at a time: a second fresh open closes the first instead of racing it", async () => {
    const [first, second] = await Promise.all([
      openUpdateLog({ fresh: true, flow: "update", title: "first" }),
      (now += 1_000, openUpdateLog({ fresh: true, flow: "update", title: "second" })),
    ]);
    expect(first).not.toBe(second);
    expect(currentUpdateLogId()).toBe(second);
    await settle(); // the first is closed in the background
    expect(await updateLogInfo(first!)).toMatchObject({ finished: true, outcome: "failed" });
  });

  it("serves only what the record accounts for: bytes a dying process wrote after it are not handed out", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    await writeUpdateLog("recorded\n");
    const recorded = Buffer.byteLength(logText(id!));
    fs.appendFileSync(path.join(updateLogDir(), `${id}.log`), "never recorded\n");
    const info = await updateLogInfo(id!);
    expect(info!.size).toBe(recorded);
    const chunk = await readUpdateLogChunk(id!, 0, 1 << 20, info!.size);
    expect(chunk!.text).not.toContain("never recorded");
    expect(chunk!.next).toBe(recorded);
  });
});

describe("the run started last, and a full log", () => {
  it("follows the run started last even when the clock was stepped back before it", async () => {
    const first = await openUpdateLog({ fresh: true, flow: "update", title: "first" });
    await closeUpdateLog("completed");
    now -= 3_600_000; // timesyncd stepped the clock back an hour
    const second = await openUpdateLog({ fresh: true, flow: "update", title: "second" });
    expect(second! < first!).toBe(true); // its id sorts before the older run's
    expect(await latestUpdateLog()).toMatchObject({ id: second, finished: false });
    // The second half of the update goes on in ITS file, not the older one.
    await resetUpdateLogForTests();
    expect(await openUpdateLog({ fresh: false, flow: "update", title: "ClawBox restarted" })).toBe(second);
  });

  it("still writes where each step starts and how it ended once the log is full", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    await settle(); // the title line is in
    const { size } = (await updateLogInfo(id!))!;
    await writeUpdateLog(`${"x".repeat(UPDATE_LOG_MAX_BYTES - size - 6)}\n`); // five bytes short of full
    await writeUpdateLog("dropped output\n");
    await logUpdateStepStart({ id: "post_update", label: "Applying system fixups" }, 6, 9);
    await writeUpdateLog("more dropped output\n");
    await logUpdateStepEnd({ id: "post_update", label: "Applying system fixups" }, "failed", "exit 1");
    const tail = fs.readFileSync(path.join(updateLogDir(), `${id}.log`), "utf8").slice(-600);
    expect(tail).toContain("further output is in the journal");
    expect(tail).not.toContain("dropped output");
    expect(tail).toContain("==> [7/9] Applying system fixups");
    expect(tail).toContain("==> Applying system fixups: failed — exit 1");
  });
});

describe("commands the web server runs itself", () => {
  /** A promise that carries its child, the way util.promisify(execFile) hands it out. */
  function running(script: (out: EventEmitter, err: EventEmitter) => Promise<void>, fail = false) {
    const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
    const promise = (async () => {
      // A child speaks only after it was started: after the caller has it.
      await new Promise((resolve) => setImmediate(resolve));
      await script(child.stdout, child.stderr);
      if (fail) throw Object.assign(new Error("Command failed"), { code: 2, stdout: "ignored", stderr: "ignored" });
      return { stdout: "ignored", stderr: "ignored" };
    })() as Promise<{ stdout: string; stderr: string }> & { child: typeof child };
    promise.child = child;
    return promise;
  }

  it("writes the output live, in the order it arrives, a whole line at a time", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    let seenMidway = "";
    await logUpdateCommand(["bun", "run", "build"], () => running(async (out, err) => {
      out.emit("data", "Creating an optimized production build ...\n");
      err.emit("data", "warn: a deprecat");
      out.emit("data", "✓ Compiled succ");
      // Whole lines go out together, at most a quarter second after the first.
      await advance(300);
      seenMidway = logText(id!);
      err.emit("data", "ion\n");
      out.emit("data", "essfully\n");
      out.emit("data", "no newline at the end");
    }));
    await settle();
    expect(seenMidway).toContain("Creating an optimized production build ...\n");
    expect(seenMidway).not.toContain("warn: a deprecat");
    const text = logText(id!);
    expect(text).toContain("$ bun run build");
    expect(text).toContain("Creating an optimized production build ...\nwarn: a deprecation\n✓ Compiled successfully\nno newline at the end\n");
    expect(text).not.toContain("ignored");
  });

  it("still says how a streamed command ended when it fails", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    await expect(logUpdateCommand(["bun", "install"], () => running(async (_out, err) => {
      err.emit("data", "error: lockfile had changes\n");
    }, true))).rejects.toThrow("Command failed");
    await settle();
    const text = logText(id!);
    expect(text).toContain("error: lockfile had changes\n");
    expect(text).toContain("(exit 2)");
    expect(text).not.toContain("ignored");
  });
});

describe("redaction", () => {
  it("takes tokens and passwords out of journal lines, command output and the closing error before they reach the disk", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    const follow = followUpdateUnit("openclaw_install", now);
    say("openclaw_install", "npm http fetch GET 200 https://registry.example/x Authorization: Bearer abcdefghijklmnop123456");
    say("openclaw_install", "\x1b[33mwarn\x1b[0m config password=hunter2hunter2 token: sk-abcdefghijklmnopqrstuvwx");
    await follow.finish();
    await logUpdateCommand(["git", "fetch"], async () => ({ stdout: "", stderr: "remote: ghp_PLACEHOLDERnotreal0 is not valid\n" }));
    await writeUpdateLog("claw_abcdefghijklmnop leaked into a line\n");
    await closeUpdateLog("failed", "gateway answered api_key=zyxwvutsrqponm");
    const text = logText(id!);
    for (const secret of ["abcdefghijklmnop123456", "hunter2hunter2", "sk-abcdefghijklmnopqrstuvwx", "ghp_PLACEHOLDERnotreal0", "claw_abcdefghijklmnop", "zyxwvutsrqponm"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[redacted]");
    // The colour around the redacted line is kept.
    expect(text).toContain("\x1b[33mwarn\x1b[0m");
  });
});

describe("a restart in the middle of the run", () => {
  it("goes on in the same file: truncates what no cursor accounts for, reads the unit on from its cursor, and writes nothing twice", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    await logUpdateStepStart({ id: "restart", label: "Updating ClawBox and restarting" }, 5, 9);
    unitState["clawbox-root-update@rebuild_reboot.service"] = "active";
    followUpdateUnit("rebuild_reboot", now);
    say("rebuild_reboot", "Installing dependencies");
    await advance(1_000);
    say("rebuild_reboot", "Building ClawBox");
    await advance(1_000);
    // The process dies here, after writing bytes it never recorded a cursor for.
    const recorded = JSON.parse(fs.readFileSync(path.join(updateLogDir(), `${id}.json`), "utf8"));
    fs.appendFileSync(path.join(updateLogDir(), `${id}.log`), "half a chunk the old server wrote");
    await resetUpdateLogForTests();
    timers = [];
    expect(recorded.follows.find((f: { step: string }) => f.step === "rebuild_reboot").cursor).toBe("c2");

    // While no server ran.
    say("rebuild_reboot", "\x1b[32m✓ Compiled successfully\x1b[0m");
    say("rebuild_reboot", "Restarting ClawBox services — no reboot needed");

    const again = await openUpdateLog({ fresh: false, flow: "update", title: "ClawBox restarted on the new build — from step 7: Applying system fixups" });
    expect(again).toBe(id);
    await settle();
    await logUpdateStepStart({ id: "post_update", label: "Applying system fixups" }, 6, 9);
    // The rebuild unit is still finishing: its last lines are read on.
    say("rebuild_reboot", "restart_services_after_update: done");
    await advance(1_000);
    unitState["clawbox-root-update@rebuild_reboot.service"] = "inactive";
    await advance(1_000);
    await advance(1_000);
    await closeUpdateLog("completed");
    await settle();

    const text = logText(id!);
    expect(text).not.toContain("half a chunk");
    for (const line of ["Installing dependencies", "Building ClawBox", "Compiled successfully", "Restarting ClawBox services", "restart_services_after_update: done"]) {
      expect(text.split(line), line).toHaveLength(2);
    }
    expect(text.indexOf("Building ClawBox")).toBeLessThan(text.indexOf("Compiled successfully"));
    expect(text.indexOf("Compiled successfully")).toBeLessThan(text.indexOf("ClawBox restarted on the new build"));
    expect(text).toMatch(/\(continued\)[^\n]*\nrestart_services_after_update: done\n/);
    expect(text).toContain("=== Update finished");
    const info = await updateLogInfo(id!);
    expect(info).toMatchObject({ id, finished: true, outcome: "completed", size: Buffer.byteLength(text) });
  });

  it("a fresh run closes a log its dead server left unfinished, and starts its own", async () => {
    const first = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    await writeUpdateLog("step 1 output\n");
    await resetUpdateLogForTests();
    now += 60_000;
    const second = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    expect(second).not.toBe(first);
    // Closed in the background: the new run does not wait for it.
    await settle();
    expect(await updateLogInfo(first!)).toMatchObject({ finished: true, outcome: "failed" });
    expect(logText(first!)).toContain("This update did not finish");
    expect(await latestUpdateLog()).toMatchObject({ id: second, finished: false });
  });

  it("resumeOnly goes on with an unfinished log and never starts one", async () => {
    expect(await openUpdateLog({ fresh: false, resumeOnly: true, flow: "update", title: "x" })).toBeNull();
    expect(await latestUpdateLog()).toBeNull();
    const first = await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" });
    await resetUpdateLogForTests();
    expect(await openUpdateLog({ fresh: false, resumeOnly: true, flow: "update", title: "ClawBox restarted" })).toBe(first);
    await closeUpdateLog("failed", "Rebuild failed before the restart");
    expect(logText(first!)).toContain("=== Update failed: Rebuild failed before the restart");
  });

  it("keeps the last few runs", async () => {
    const ids: string[] = [];
    for (let i = 0; i < UPDATE_LOG_KEEP + 3; i++) {
      now += 1_000;
      ids.push((await openUpdateLog({ fresh: true, flow: "update", title: `run ${i}` }))!);
      await closeUpdateLog("completed");
    }
    const left = fs.readdirSync(updateLogDir()).filter((n) => n.endsWith(".log")).map((n) => n.slice(0, -4)).sort();
    expect(left).toEqual(ids.slice(-UPDATE_LOG_KEEP).sort());
  });
});

describe("reading from an offset", () => {
  it("hands the log back in chunks that never split a character, whose offsets resume exactly", async () => {
    const id = await openUpdateLog({ fresh: true, flow: "update", title: "Обновяване ✓ 更新" });
    await writeUpdateLog("ünïcødé — 漢字 — 🦀 crab\n".repeat(20));
    await closeUpdateLog("completed");
    const whole = logText(id!);
    let offset = 0;
    let text = "";
    for (;;) {
      const chunk = await readUpdateLogChunk(id!, offset, 7);
      expect(chunk).not.toBeNull();
      if (chunk!.next === offset) break;
      expect(chunk!.text).not.toContain("�");
      text += chunk!.text;
      offset = chunk!.next;
    }
    expect(text).toBe(whole);
    expect(offset).toBe(Buffer.byteLength(whole));
    // From the middle: exactly the rest.
    const mid = Buffer.byteLength(whole.slice(0, 100));
    expect((await readUpdateLogChunk(id!, mid, 1 << 20))!.text).toBe(whole.slice(100));
  });

  it("wholeUtf8Length stops before a character that is not all there", () => {
    const crab = Buffer.from("a🦀", "utf8");
    expect(wholeUtf8Length(crab)).toBe(5);
    for (let cut = 2; cut < 5; cut++) expect(wholeUtf8Length(crab.subarray(0, cut))).toBe(1);
    expect(wholeUtf8Length(Buffer.from("é", "utf8").subarray(0, 1))).toBe(0);
    expect(wholeUtf8Length(Buffer.alloc(0))).toBe(0);
  });

  it("refuses an id that is not one, and answers null for a run it has no log for", async () => {
    expect(await readUpdateLogChunk("../../etc/passwd", 0)).toBeNull();
    expect(await updateLogInfo("../x")).toBeNull();
    expect(await updateLogInfo("20261111T000000000Z-abcd")).toBeNull();
  });

  it("parses the resume id the stream hands out, and nothing else", () => {
    expect(parseUpdateLogResumeId("20261111T093015123Z-a1b2:1234")).toEqual({ run: "20261111T093015123Z-a1b2", offset: 1234 });
    for (const bad of [null, "", "x:1", "20261111T093015123Z-a1b2:-1", "20261111T093015123Z-a1b2:1.5", "20261111T093015123Z-a1b2", "../a:1"]) {
      expect(parseUpdateLogResumeId(bad)).toBeNull();
    }
  });

  it("splits journalctl's cursor line off the output, and only that line", () => {
    expect(splitCursor("a\nb\n-- cursor: s=1;i=2\n")).toEqual({ text: "a\nb\n", cursor: "s=1;i=2" });
    expect(splitCursor("-- cursor: s=1\n")).toEqual({ text: "", cursor: "s=1" });
    expect(splitCursor("say -- cursor: x\n")).toEqual({ text: "say -- cursor: x\n", cursor: null });
    expect(splitCursor("")).toEqual({ text: "", cursor: null });
  });
});
