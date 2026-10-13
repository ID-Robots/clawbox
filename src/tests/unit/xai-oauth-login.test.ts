import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

// The xAI sign-in runs the core's own CLI and reads what it prints. Nothing in
// this repository has seen that output, so the parser is written to tolerate
// several plausible wordings and these tests pin each of them — together with
// the property that matters more than any one format: a login that prints
// nothing usable FAILS, with the CLI's own lines, rather than hanging.
//
// Every code below is made up.

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  spawnOpenclawCli: vi.fn(),
}));

import { spawnOpenclawCli } from "@/lib/openclaw-config";
import {
  cancelXaiLogin,
  claimXaiLoginAttempt,
  cleanTuiOutput,
  outputTail,
  parseXaiDeviceLogin,
  pollXaiLogin,
  ptyCommand,
  readXaiStoredProfiles,
  startXaiLogin,
  xaiLoginArgs,
  xaiLoginSpawn,
} from "@/lib/xai-oauth-login";

// The prompt as the real CLI printed it under a pseudo-terminal (OpenClaw
// 2026.9.4, measured on a box), cleaned of escapes, CR/LF and rails. The code
// is a fake.
const MEASURED_CLEAN =
  "Starting xAI OAuth  Requesting xAI OAuth device code  xAI OAuth Open this URL in your LOCAL browser"
  + " and enter the code below. URL: <https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234>"
  + " Code: WXYZ-1234 Code expires in 30 minutes. Never share it. Open this URL in your LOCAL"
  + " browser:https://accounts.x.ai/oauth2/device";

// The same prompt the way it actually ARRIVES: clack escapes, CR without LF,
// box-drawing rails and step glyphs, the spinner redrawing its message a
// character at a time, and words split across writes. The parser is fed the
// accumulated buffer, as the lib does, never lines.
const ESC = "\u001b";
const MEASURED_RAW_CHUNKS = [
  `${ESC}[?25l│\r\n◒  S`, `${ESC}[999D${ESC}[J◐  St`, `${ESC}[999D${ESC}[J◓  Starting xAI OAuth`,
  `\r${ESC}[2K◇  Starting xAI OAuth\r\n│\r\n◑  Requesting xAI OA`, `uth device code`,
  `\r${ESC}[2K◇  Requesting xAI OAuth device code\r\n│\r\n`,
  `◇  xAI OAuth ─────────────────────────────────╮\r\n│                                              │\r\n`,
  `│  Open this URL in your LOCAL browser and enter the code below.  │\r\n`,
  `│  URL: <${ESC}[36mhttps://accounts.x.ai/oauth2/de`, `vice?user_code=WXYZ-1234${ESC}[39m>  │\r\n`,
  `│  Code: ${ESC}[1mWXYZ-1234${ESC}[22m  │\r\n`,
  `│  Code expires in 30 minutes. Never share it.  │\r\n├──────────────────────────────╯\r\n`,
  `│\r\n◇  Open this URL in your LOCAL browser:https://accounts.x.ai/oauth2/device\r\n│\r\n`,
  `◒  W`, `${ESC}[999D${ESC}[J◐  Wa`, `${ESC}[999D${ESC}[J◓  Waiting for xAI device authorization...`,
  `${ESC}[999D${ESC}[J◑  Waiting for xAI device authorization...`,
];

const MEASURED_PROMPT = {
  verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234",
  userCode: "WXYZ-1234",
  expiresInMinutes: 30,
};

describe("parseXaiDeviceLogin", () => {
  it("reads the measured prompt, cleaned", () => {
    expect(parseXaiDeviceLogin(MEASURED_CLEAN + " Waiting for xAI device authorization...")).toEqual(MEASURED_PROMPT);
  });

  it("reads the measured prompt from the raw TUI stream", () => {
    expect(parseXaiDeviceLogin(MEASURED_RAW_CHUNKS.join(""))).toEqual(MEASURED_PROMPT);
  });

  it("never takes the `>` that closes `<URL>` as part of the URL", () => {
    expect(parseXaiDeviceLogin("URL: <https://example.test/device?user_code=ABCD-1234> Code: ABCD-1234 …").verificationUrl)
      .toBe("https://example.test/device?user_code=ABCD-1234");
  });

  it("finds nothing until the URL has finished arriving, then finds all of it", () => {
    // Every prefix of the stream: a URL cut mid-redraw must never be offered.
    let buffer = "";
    const seen = new Set<string>();
    for (const chunk of MEASURED_RAW_CHUNKS) {
      buffer += chunk;
      const url = parseXaiDeviceLogin(buffer).verificationUrl;
      if (url) seen.add(url);
    }
    expect([...seen]).toEqual([MEASURED_PROMPT.verificationUrl]);
  });

  it("does not take a URL that runs to the end of what has arrived", () => {
    expect(parseXaiDeviceLogin("URL: <https://accounts.x.ai/oauth2/devi").verificationUrl).toBeNull();
  });

  it("prefers the URL that carries the code over the bare one printed after it", () => {
    expect(parseXaiDeviceLogin(
      "browser:https://accounts.x.ai/oauth2/device then URL: <https://accounts.x.ai/oauth2/device?user_code=ABCD-1234> …",
    ).verificationUrl).toBe("https://accounts.x.ai/oauth2/device?user_code=ABCD-1234");
  });

  it("reads a labelled code when the URL carries none", () => {
    expect(parseXaiDeviceLogin("Open https://example.test/device and enter the code below. Code: QRST-9012 …"))
      .toMatchObject({ verificationUrl: "https://example.test/device", userCode: "QRST-9012" });
  });

  it("reads an ungrouped code after a label", () => {
    expect(parseXaiDeviceLogin("https://example.test/device user code: K7M2P9QX").userCode).toBe("K7M2P9QX");
  });

  it("falls back to a bare grouped code with no label at all", () => {
    expect(parseXaiDeviceLogin("https://example.test/device\n\n   HJKL-3456\n").userCode).toBe("HJKL-3456");
  });

  it("does not take a word after 'code' for the code", () => {
    expect(parseXaiDeviceLogin("https://example.test/device The code expires in 15 minutes.").userCode).toBeNull();
  });

  it("does not take a path fragment of the URL for the code", () => {
    expect(parseXaiDeviceLogin("Open https://example.test/oauth/code/device now").userCode).toBeNull();
  });

  it("reads the code's lifetime as the CLI states it, and nothing when it does not", () => {
    expect(parseXaiDeviceLogin("https://example.test/device Code expires in 10 minutes.").expiresInMinutes).toBe(10);
    expect(parseXaiDeviceLogin("https://example.test/device Code: ABCD-1234 …").expiresInMinutes).toBeNull();
  });

  it("answers nulls for output with nothing in it", () => {
    const empty = { verificationUrl: null, userCode: null, expiresInMinutes: null };
    expect(parseXaiDeviceLogin("Starting…\n")).toEqual(empty);
    expect(parseXaiDeviceLogin("")).toEqual(empty);
  });
});

describe("cleanTuiOutput / outputTail", () => {
  it("turns the raw TUI stream into the prose the measured sample shows", () => {
    const cleaned = cleanTuiOutput(MEASURED_RAW_CHUNKS.join(""));
    expect(cleaned).toContain("URL: <https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234>");
    expect(cleaned).toContain("Code: WXYZ-1234 Code expires in 30 minutes. Never share it.");
    expect(cleaned).not.toMatch(/[\u001b\r\n│─◇◒◐◓◑╮╯├]/);
  });

  it("keeps the end of a long output, cleaned", () => {
    const tail = outputTail(`${"x".repeat(1000)}\r\n│ ${ESC}[31mError: subscription required${ESC}[0m\r\n`);
    expect(tail.endsWith("Error: subscription required")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(401);
  });
});

describe("the command", () => {
  it("is the oauth login at the shared profile id — never with --device-code", () => {
    // Measured: `--device-code cannot be combined with --method unless method
    // is device-code.` (exit 1).
    expect(xaiLoginArgs(false).join(" ")).toBe(
      "models auth login --provider xai --method oauth --profile-id xai:default",
    );
    expect(xaiLoginArgs(true)).not.toContain("--device-code");
  });

  it("adds --force only when there is a profile to replace", () => {
    expect(xaiLoginArgs(true)).toContain("--force");
    expect(xaiLoginArgs(false)).not.toContain("--force");
  });

  it("runs under a pseudo-terminal, because the login refuses without one", () => {
    // Measured: `models auth login requires an interactive TTY` (exit 1).
    expect(ptyCommand("/opt/openclaw/bin/openclaw", xaiLoginArgs(false))).toEqual({
      file: "script",
      args: [
        "-qfec",
        "'/opt/openclaw/bin/openclaw' 'models' 'auth' 'login' '--provider' 'xai' '--method' 'oauth'"
          + " '--profile-id' 'xai:default'",
        "/dev/null",
      ],
    });
  });

  it("quotes a path with a quote in it", () => {
    expect(ptyCommand("/a b/it's", ["x"]).args[1]).toBe(`'/a b/it'\\''s' 'x'`);
  });
});

type FakeChild = EventEmitter & {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("the login in flight", () => {
  let child: FakeChild;
  const realSpawn = xaiLoginSpawn.spawn;
  const realProcesses = xaiLoginSpawn.processes;
  let spawnArgs: string[] = [];
  // Every signal the lib sends by pid is recorded here and never delivered:
  // the pids below are made up, and must not reach a real process.
  let signals: MockInstance<typeof process.kill>;

  beforeEach(() => {
    vi.useFakeTimers();
    child = fakeChild();
    spawnArgs = [];
    xaiLoginSpawn.spawn = (_bin, args) => {
      spawnArgs = args;
      return child as unknown as ChildProcess;
    };
    signals = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    cancelXaiLogin();
    xaiLoginSpawn.spawn = realSpawn;
    xaiLoginSpawn.processes = realProcesses;
    vi.useRealTimers();
    signals.mockRestore();
  });

  /** Start, let the CLI "print" something, and collect start's answer. */
  async function startWith(print: () => void, opts = { replaceExisting: false }) {
    const started = startXaiLogin(opts);
    print();
    await vi.advanceTimersByTimeAsync(250);
    return started;
  }

  /** Let `ms` pass with the browser polling, as the open panel does. */
  async function polledFor(ms: number) {
    for (let left = ms; left > 0; left -= 60_000) {
      pollXaiLogin();
      await vi.advanceTimersByTimeAsync(Math.min(60_000, left));
    }
  }

  /**
   * The tree a real login runs as: `script` (the child, `pid`), the CLI it
   * starts in the pty's own session (`pid + 1`), and a process the CLI started
   * (`pid + 2`) — plus somebody else's process beside them.
   */
  function processTree(pid: number, table: { pid: number; ppid: number; startTime: string }[] = []) {
    child.pid = pid;
    table.push(
      { pid, ppid: process.pid, startTime: `${pid}0` },
      { pid: pid + 1, ppid: pid, startTime: `${pid}1` },
      { pid: pid + 2, ppid: pid + 1, startTime: `${pid}2` },
      { pid: 999, ppid: 1, startTime: "9990" },
    );
    xaiLoginSpawn.processes = () => table;
    return table;
  }

  const PROMPT = "Open https://example.test/device\nCode: ABCD-1234\n";

  it("answers start with the URL and code as soon as the CLI prints them", async () => {
    const answer = await startWith(() => {
      child.stdout.emit("data", Buffer.from("Open https://example.test/device\nCode: ABCD-1234\n"));
    });

    expect(answer).toEqual({
      status: "pending",
      verificationUrl: "https://example.test/device",
      userCode: "ABCD-1234",
      // The CLI stated no lifetime here, so the measured default.
      expiresInMinutes: 30,
    });
    expect(spawnArgs).toEqual(xaiLoginArgs(false));
    expect(pollXaiLogin()).toMatchObject({ status: "pending", userCode: "ABCD-1234" });
  });

  it("reads the prompt from stderr too", async () => {
    const answer = await startWith(() => {
      child.stderr.emit("data", Buffer.from("Open https://example.test/device\nCode: ABCD-1234\n"));
    });
    expect(answer.status).toBe("pending");
  });

  it("passes --force through when a profile is being replaced", async () => {
    await startWith(() => {
      child.stdout.emit("data", Buffer.from("https://example.test/device ABCD-1234\n"));
    }, { replaceExisting: true });
    expect(spawnArgs).toContain("--force");
  });

  it("reports complete once the CLI exits 0, then forgets the login", async () => {
    await startWith(() => {
      child.stdout.emit("data", Buffer.from("Open https://example.test/device\nCode: ABCD-1234\n"));
    });
    child.emit("close", 0);

    expect(pollXaiLogin()).toEqual({ status: "complete" });
    // A stale tab cannot replay the success.
    expect(pollXaiLogin().status).toBe("failed");
  });

  it("reports a failed exit with the CLI's own last lines", async () => {
    const answer = await startWith(() => {
      child.stderr.emit("data", Buffer.from("Error: xAI OAuth requires a SuperGrok or X Premium subscription\n"));
      child.emit("close", 1);
    });

    expect(answer).toEqual({
      status: "failed",
      detail: "The sign-in did not complete (exit 1).",
      output: "Error: xAI OAuth requires a SuperGrok or X Premium subscription",
    });
  });

  it("fails visibly, with the raw output, when no link ever appears — it never hangs", async () => {
    const started = startXaiLogin({ replaceExisting: false });
    child.stdout.emit("data", Buffer.from("? Choose an account (use arrow keys)\n"));
    // Past start's own wait: the browser is told to keep polling...
    await vi.advanceTimersByTimeAsync(30_500);
    expect(await started).toEqual({ status: "starting" });
    // ...and past the parse deadline the login is failed and the CLI stopped.
    await vi.advanceTimersByTimeAsync(30_000);

    expect(pollXaiLogin()).toEqual({
      status: "failed",
      detail: "The sign-in did not show a verification link. This is what OpenClaw printed:",
      output: "? Choose an account (use arrow keys)",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("ends a login nobody approved when the CLI's own stated lifetime is up", async () => {
    await startWith(() => {
      child.stdout.emit("data", Buffer.from(MEASURED_RAW_CHUNKS.join("").replace("30 minutes", "10 minutes")));
    });
    expect(pollXaiLogin()).toMatchObject({ status: "pending", expiresInMinutes: 10 });

    await polledFor(9 * 60_000);
    expect(pollXaiLogin().status).toBe("pending");
    await vi.advanceTimersByTimeAsync(60_000 + 1_000);

    expect(pollXaiLogin()).toMatchObject({ status: "failed", detail: expect.stringContaining("expired") });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to the measured 30 minutes when the CLI states no lifetime", async () => {
    await startWith(() => {
      child.stdout.emit("data", Buffer.from("Open https://example.test/device\nCode: ABCD-1234\n"));
    });
    await polledFor(29 * 60_000);
    expect(pollXaiLogin().status).toBe("pending");
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    expect(pollXaiLogin()).toMatchObject({ status: "failed", detail: expect.stringContaining("expired") });
  });

  it("completes from the store when the sign-in lands and the CLI lingers", async () => {
    // What the CLI prints after approval is unmeasured; the store is not.
    vi.mocked(spawnOpenclawCli).mockResolvedValue(
      JSON.stringify({ profiles: [{ id: "xai:default", provider: "xai", type: "oauth" }] }),
    );
    await startWith(() => {
      child.stdout.emit("data", Buffer.from(MEASURED_RAW_CHUNKS.join("")));
    });

    expect(pollXaiLogin().status).toBe("pending"); // asks the store, in the background
    await vi.advanceTimersByTimeAsync(10);
    expect(pollXaiLogin()).toEqual({ status: "complete" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.mocked(spawnOpenclawCli).mockReset();
  });

  it("does not count a sign-in that was already stored before this login began", async () => {
    vi.mocked(spawnOpenclawCli).mockResolvedValue(
      JSON.stringify({ profiles: [{ id: "xai:default", provider: "xai", type: "oauth" }] }),
    );
    const started = startXaiLogin({ replaceExisting: true, signInAlreadyStored: true });
    child.stdout.emit("data", Buffer.from(MEASURED_RAW_CHUNKS.join("")));
    await vi.advanceTimersByTimeAsync(250);
    await started;

    pollXaiLogin();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(pollXaiLogin().status).toBe("pending");
    expect(spawnOpenclawCli).not.toHaveBeenCalled();
    // Only the CLI's own exit can finish it.
    child.emit("close", 0);
    expect(pollXaiLogin()).toEqual({ status: "complete" });
    vi.mocked(spawnOpenclawCli).mockReset();
  });

  it("stops the CLI on cancel", async () => {
    await startWith(() => {
      child.stdout.emit("data", Buffer.from("Open https://example.test/device\nCode: ABCD-1234\n"));
    });
    cancelXaiLogin();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(pollXaiLogin()).toMatchObject({ status: "failed", detail: expect.stringContaining("No sign-in") });
  });

  it("replaces a login in flight when a second one starts", async () => {
    await startWith(() => {
      child.stdout.emit("data", Buffer.from("Open https://example.test/device\nCode: ABCD-1234\n"));
    });
    const first = child;
    child = fakeChild();
    const second = await startWith(() => {
      child.stdout.emit("data", Buffer.from("Open https://example.test/device\nCode: WXYZ-5678\n"));
    });

    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    expect(second).toMatchObject({ status: "pending", userCode: "WXYZ-5678" });
  });

  // `script` starts the CLI in the pty's own session, so the signal to
  // `script`'s process group never reaches it, and a CLI that catches the
  // SIGTERM `script` passes on (clack's spinner does) and the pty's hangup
  // outlives it. Seen on a box: a cancelled sign-in left its
  // `openclaw models auth login` running.
  it("stops the CLI under the pseudo-terminal on cancel, SIGKILL after the grace period", async () => {
    processTree(4100);
    await startWith(() => { child.stdout.emit("data", Buffer.from(PROMPT)); });
    cancelXaiLogin();

    expect(signals).toHaveBeenCalledWith(-4100, "SIGTERM");
    expect(signals).toHaveBeenCalledWith(4101, "SIGTERM");
    expect(signals).toHaveBeenCalledWith(4102, "SIGTERM");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(signals).toHaveBeenCalledWith(4101, "SIGKILL");
    expect(signals).toHaveBeenCalledWith(4102, "SIGKILL");
    expect(signals).toHaveBeenCalledWith(-4100, "SIGKILL");
    expect(signals).not.toHaveBeenCalledWith(999, expect.anything());
    expect(pollXaiLogin()).toMatchObject({ status: "failed", detail: expect.stringContaining("No sign-in") });
  });

  it("never SIGKILLs a pid that is no longer the process it was", async () => {
    const table = processTree(4100);
    await startWith(() => { child.stdout.emit("data", Buffer.from(PROMPT)); });
    cancelXaiLogin();
    // 4102 exits on the SIGTERM and its pid is handed to something new.
    table[2] = { pid: 4102, ppid: 1, startTime: "77777" };
    await vi.advanceTimersByTimeAsync(3_000);

    expect(signals).toHaveBeenCalledWith(4101, "SIGKILL");
    expect(signals).not.toHaveBeenCalledWith(4102, "SIGKILL");
  });

  it("stops the first login's CLI, not only its `script`, when a second one starts", async () => {
    const table = processTree(4100);
    await startWith(() => { child.stdout.emit("data", Buffer.from(PROMPT)); });
    child = fakeChild();
    processTree(4200, table);
    const second = await startWith(() => {
      child.stdout.emit("data", Buffer.from("Open https://example.test/device\nCode: WXYZ-5678\n"));
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(signals).toHaveBeenCalledWith(4101, "SIGTERM");
    expect(signals).toHaveBeenCalledWith(4101, "SIGKILL");
    expect(signals).toHaveBeenCalledWith(4102, "SIGKILL");
    // The new login is left running.
    expect(signals).not.toHaveBeenCalledWith(-4200, expect.anything());
    expect(signals).not.toHaveBeenCalledWith(4201, expect.anything());
    expect(second).toMatchObject({ status: "pending", userCode: "WXYZ-5678" });
    expect(pollXaiLogin()).toMatchObject({ status: "pending", userCode: "WXYZ-5678" });
  });

  it("stops a login nobody has polled for five minutes — a page that left without a word", async () => {
    processTree(4100);
    await startWith(() => { child.stdout.emit("data", Buffer.from(PROMPT)); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollXaiLogin().status).toBe("pending");

    // Five minutes from the START, but only four from the last poll.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(signals).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 + 1_000);
    expect(signals).toHaveBeenCalledWith(-4100, "SIGTERM");
    expect(signals).toHaveBeenCalledWith(4101, "SIGTERM");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(signals).toHaveBeenCalledWith(4101, "SIGKILL");

    expect(pollXaiLogin()).toMatchObject({ status: "failed", detail: expect.stringContaining("stopped checking") });
    expect(pollXaiLogin()).toMatchObject({ status: "failed", detail: expect.stringContaining("No sign-in") });
  });

  it("starts no CLI for a sign-in cancelled, or superseded, before it reached the spawn", async () => {
    // The route reads the store first — a CLI cold start, ~10 s on a Jetson —
    // while the panel shows "starting" and its Cancel.
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    xaiLoginSpawn.spawn = spawn;
    const cancelled = claimXaiLoginAttempt();
    cancelXaiLogin();
    expect(await startXaiLogin({ replaceExisting: false, attempt: cancelled })).toMatchObject({ status: "failed" });

    const older = claimXaiLoginAttempt();
    const newer = claimXaiLoginAttempt();
    expect(await startXaiLogin({ replaceExisting: false, attempt: older })).toMatchObject({ status: "failed" });
    expect(spawn).not.toHaveBeenCalled();

    const started = startXaiLogin({ replaceExisting: false, attempt: newer });
    child.stdout.emit("data", Buffer.from(PROMPT));
    await vi.advanceTimersByTimeAsync(250);
    expect(await started).toMatchObject({ status: "pending", userCode: "ABCD-1234" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("answers a spawn that throws as a failure, not an exception", async () => {
    xaiLoginSpawn.spawn = () => { throw new Error("ENOENT"); };
    expect(await startXaiLogin({ replaceExisting: false })).toMatchObject({ status: "failed" });
  });
});

describe("readXaiStoredProfiles", () => {
  const mockCli = vi.mocked(spawnOpenclawCli);

  it("returns the xai rows of the store and nobody else's", async () => {
    mockCli.mockResolvedValueOnce(JSON.stringify({
      profiles: [
        { id: "xai:default", provider: "xai", type: "oauth" },
        { id: "anthropic:default", provider: "anthropic", type: "api_key" },
        { id: "xai:manual", type: "API_KEY" },
      ],
    }));

    expect(await readXaiStoredProfiles()).toEqual([
      { id: "xai:default", type: "oauth" },
      { id: "xai:manual", type: "api_key" },
    ]);
    expect(mockCli).toHaveBeenCalledWith(["models", "auth", "list", "--json"], expect.anything());
  });

  it("answers an empty list for a store with no xai profile", async () => {
    mockCli.mockResolvedValueOnce(JSON.stringify({ profiles: [] }));
    expect(await readXaiStoredProfiles()).toEqual([]);
  });

  it("answers null — unknown — when the store cannot be read or parsed", async () => {
    mockCli.mockRejectedValueOnce(new Error("timeout"));
    expect(await readXaiStoredProfiles()).toBeNull();
    mockCli.mockResolvedValueOnce("not json");
    expect(await readXaiStoredProfiles()).toBeNull();
    mockCli.mockResolvedValueOnce("null");
    expect(await readXaiStoredProfiles()).toBeNull();
    mockCli.mockResolvedValueOnce(JSON.stringify({ profiles: {} }));
    expect(await readXaiStoredProfiles()).toBeNull();
  });
});
