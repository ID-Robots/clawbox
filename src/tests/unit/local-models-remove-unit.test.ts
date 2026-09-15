import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * `removeUserUnit` — the uninstall half of an engine whose unit install-voice.sh
 * writes: stop and disable, delete the file, tell systemd. In that order,
 * because a unit file deleted under a running service leaves the process up
 * with a unit systemd can no longer name.
 */

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile: execFileMock }));

let home: string;
const calls: string[][] = [];

function answer(fail: (args: string[]) => boolean = () => false) {
  type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void;
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Cb) => {
    calls.push(args);
    if (fail(args)) {
      cb(Object.assign(new Error("Command failed"), { stdout: "", stderr: "Failed to connect to bus" }));
      return;
    }
    cb(null, { stdout: "", stderr: "" });
  });
}

function unitFile(name = "whisper-server.service") {
  const dir = path.join(home, ".config/systemd/user");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "[Unit]\n");
  return file;
}

async function load() {
  vi.resetModules();
  return import("@/lib/local-models");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-unit-"));
  process.env.CLAWBOX_HOME = home;
  calls.length = 0;
  execFileMock.mockReset();
});

afterEach(() => {
  delete process.env.CLAWBOX_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("removeUserUnit", () => {
  it("disables the unit now, deletes its file, then reloads — in that order", async () => {
    answer();
    const file = unitFile();
    const { removeUserUnit, WHISPER_UNIT } = await load();

    expect(await removeUserUnit(WHISPER_UNIT)).toEqual({ ok: true });
    expect(calls).toEqual([
      ["--user", "disable", "--now", "whisper-server.service"],
      ["--user", "daemon-reload"],
    ]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("still removes the file when systemd would not answer the disable, and when there was no file", async () => {
    // A unit that is already gone answers "no such unit" to the disable; that
    // is not a reason to leave the rest of the uninstall undone.
    answer((args) => args.includes("disable"));
    const file = unitFile("kokoro-server.service");
    const { removeUserUnit, KOKORO_UNIT } = await load();

    expect(await removeUserUnit(KOKORO_UNIT)).toEqual({ ok: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(await removeUserUnit(KOKORO_UNIT)).toEqual({ ok: true });
  });

  it("refuses a unit it is not allowed to name", async () => {
    answer();
    const { removeUserUnit } = await load();
    expect(await removeUserUnit("sshd.service")).toEqual({ ok: false, error: "Unknown service." });
    expect(calls).toEqual([]);
  });
});
