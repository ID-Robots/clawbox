import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveEnv } from "@/tests/helpers/env";

/**
 * src/lib/stt-local.ts — the on-box speech-to-text engine.
 *
 * The child is mocked at the wrapper (runChild), not at spawn: what matters
 * here is the contract around it — the recording reaches the script as a
 * private file that is gone afterwards, stdout becomes the transcript, and no
 * outcome of the script ever becomes an exception in the transcribe chain.
 */

const runChild = vi.hoisted(() => vi.fn());
vi.mock("@/lib/child-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/child-run")>();
  return { ...actual, runChild };
});

type Lib = typeof import("@/lib/stt-local");
let lib: Lib;
let home: string;
let restoreEnv: () => void;

function ran(over: Record<string, unknown> = {}) {
  return { code: 0, stdout: "", stderr: "", signal: null, timedOut: false, startFailed: false, startError: null, ...over };
}

function installEngine() {
  const script = path.join(home, ".openclaw", "workspace", "scripts", "stt-client.py");
  const unit = path.join(home, ".config", "systemd", "user", "whisper-server.service");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(script, "#!/usr/bin/env python3\n");
  fs.writeFileSync(unit, "[Service]\n");
}

beforeEach(async () => {
  restoreEnv = saveEnv("HOME", "XDG_RUNTIME_DIR", "CLAWBOX_TEST_SECRET");
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-stt-local-"));
  process.env.HOME = home;
  // A developer's desktop session has a runtime dir; the web server under
  // systemd does not. The tests say which case they are in rather than
  // inherit whichever host they run on.
  delete process.env.XDG_RUNTIME_DIR;
  vi.resetModules();
  lib = await import("@/lib/stt-local");
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("transcribeLocally", () => {
  it("hands the script a private copy of the recording and prints stdout back as the transcript", async () => {
    let seen: string | null = null;
    runChild.mockImplementation(async (_bin: string, args: string[]) => {
      seen = args[1];
      // The file is there while the script runs, and readable by nobody else.
      expect(fs.readFileSync(seen).toString()).toBe("opus-bytes");
      expect(fs.statSync(seen).mode & 0o777).toBe(0o600);
      return ran({ stdout: "The lantern turns amber.\n" });
    });

    const result = await lib.transcribeLocally(Buffer.from("opus-bytes"), "recording.webm");

    expect(result).toEqual({ ok: true, text: "The lantern turns amber." });
    expect(runChild.mock.calls[0][0]).toBe("/usr/bin/python3");
    expect(runChild.mock.calls[0][1][0]).toBe(lib.sttClientScriptPath());
    // Gone afterwards, directory included: a box that keeps one recording per
    // call fills its own disk with other people's voices.
    expect(seen).not.toBeNull();
    expect(fs.existsSync(seen!)).toBe(false);
    expect(fs.existsSync(path.dirname(seen!))).toBe(false);
  });

  it("keeps only the extension of whatever name the browser sent", async () => {
    runChild.mockResolvedValue(ran({ stdout: "hi" }));
    await lib.transcribeLocally(Buffer.from("x"), "../../../etc/passwd.webm");
    expect(path.basename(runChild.mock.calls[0][1][1])).toBe("recording.webm");

    await lib.transcribeLocally(Buffer.from("x"), "no extension at all");
    expect(path.basename(runChild.mock.calls[1][1][1])).toBe("recording.webm");
  });

  it("gives the script the environment `systemctl --user` needs, and nothing else of ours", async () => {
    process.env.CLAWBOX_TEST_SECRET = "must-not-leak";
    runChild.mockResolvedValue(ran({ stdout: "hi" }));
    await lib.transcribeLocally(Buffer.from("x"), "r.webm");
    const opts = runChild.mock.calls[0][2] as { env: Record<string, string>; timeoutMs: number };
    expect(opts.env.HOME).toBe(home);
    // With none inherited (a system service), the uid's own runtime dir —
    // where `systemctl --user` finds the bus that starts whisper-server.
    expect(opts.env.XDG_RUNTIME_DIR).toBe(`/run/user/${process.getuid?.() ?? 1000}`);
    expect(opts.env.PATH).toBeTruthy();
    expect(opts.env.CLAWBOX_TEST_SECRET).toBeUndefined();
    // A cold whisper loads its model before it decodes a word; a budget that
    // fits only a warm server fails every first call of the day.
    expect(opts.timeoutMs).toBe(120_000);
  });

  it("keeps a runtime dir the host already named — that is where its user bus is", async () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/4242";
    runChild.mockResolvedValue(ran({ stdout: "hi" }));
    await lib.transcribeLocally(Buffer.from("x"), "r.webm");
    const opts = runChild.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.XDG_RUNTIME_DIR).toBe("/run/user/4242");
  });

  it("reports a script that exited badly as a failure, not an exception, and still cleans up", async () => {
    let seen = "";
    runChild.mockImplementation(async (_bin: string, args: string[]) => {
      seen = args[1];
      return ran({ code: 1, stderr: "Traceback: ModuleNotFoundError: av" });
    });
    const result = await lib.transcribeLocally(Buffer.from("x"), "r.webm");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("ModuleNotFoundError");
    expect(fs.existsSync(seen)).toBe(false);
  });

  it("says a killed decode timed out rather than handing back an empty reason", async () => {
    runChild.mockResolvedValue(ran({ code: null, timedOut: true }));
    const result = await lib.transcribeLocally(Buffer.from("x"), "r.webm");
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("timed out");
  });

  it("names an interpreter that would not start", async () => {
    runChild.mockResolvedValue(ran({ code: null, startFailed: true, startError: "ENOENT", stderr: "python3 could not be started" }));
    const result = await lib.transcribeLocally(Buffer.from("x"), "r.webm");
    expect((result as { error: string }).error).toContain("could not be started");
  });
});

describe("localSttInstalled", () => {
  it("answers 'not installed' from the filesystem alone when the script is missing", async () => {
    const probe = await lib.localSttInstalled();
    expect(probe.installed).toBe(false);
    expect(probe.detail).toContain("not installed");
    // Two stat() calls, no interpreter: this is asked on every chat-mic press.
    expect(runChild).not.toHaveBeenCalled();
  });

  it("needs the user unit as well as the script", async () => {
    installEngine();
    fs.rmSync(path.join(home, ".config", "systemd", "user", "whisper-server.service"));
    const probe = await lib.localSttInstalled();
    expect(probe.installed).toBe(false);
    expect(probe.detail).toContain("whisper-server");
    expect(runChild).not.toHaveBeenCalled();
  });

  it("is installed once python can import faster-whisper", async () => {
    installEngine();
    runChild.mockResolvedValue(ran());
    const probe = await lib.localSttInstalled();
    expect(probe.installed).toBe(true);
    expect(runChild.mock.calls[0].slice(0, 2)).toEqual(["/usr/bin/python3", ["-c", "import faster_whisper"]]);
  });

  it("is not installed when the import fails", async () => {
    installEngine();
    runChild.mockResolvedValue(ran({ code: 1, stderr: "ModuleNotFoundError" }));
    const probe = await lib.localSttInstalled();
    expect(probe.installed).toBe(false);
    expect(probe.detail).toContain("faster-whisper");
  });

  it("remembers the answer for a minute instead of spawning python each time", async () => {
    installEngine();
    runChild.mockResolvedValue(ran());
    await lib.localSttInstalled();
    await lib.localSttInstalled();
    expect(runChild).toHaveBeenCalledTimes(1);
  });
});
