import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  outputTail,
  parseXaiDeviceLogin,
  pollXaiLogin,
  readXaiStoredProfiles,
  startXaiLogin,
  xaiLoginArgs,
  xaiLoginSpawn,
} from "@/lib/xai-oauth-login";

describe("parseXaiDeviceLogin", () => {
  it("reads a URL and a labelled code on separate lines", () => {
    expect(parseXaiDeviceLogin([
      "Sign in to xAI",
      "Open: https://accounts.example.test/device",
      "Code: ABCD-1234",
      "Waiting for approval...",
    ].join("\n"))).toEqual({
      verificationUrl: "https://accounts.example.test/device",
      userCode: "ABCD-1234",
    });
  });

  it("reads a code carried in the URL's user_code parameter", () => {
    expect(parseXaiDeviceLogin(
      "Visit https://auth.example.test/activate?user_code=wxyz-5678 to continue.",
    )).toEqual({
      verificationUrl: "https://auth.example.test/activate?user_code=wxyz-5678",
      userCode: "WXYZ-5678",
    });
  });

  it("reads a code printed on the line after its label", () => {
    expect(parseXaiDeviceLogin(
      "Go to https://example.test/verify and enter the code:\n\n    QRST-9012\n",
    )).toEqual({ verificationUrl: "https://example.test/verify", userCode: "QRST-9012" });
  });

  it("reads an ungrouped code after a label", () => {
    expect(parseXaiDeviceLogin("https://example.test/device\nuser code: K7M2P9QX").userCode).toBe("K7M2P9QX");
  });

  it("falls back to a bare grouped code with no label at all", () => {
    expect(parseXaiDeviceLogin("https://example.test/device\n\n   HJKL-3456\n").userCode).toBe("HJKL-3456");
  });

  it("strips colour and trailing sentence punctuation from the URL", () => {
    const out = parseXaiDeviceLogin("\u001b[36mOpen https://example.test/device.\u001b[0m\nCode: \u001b[1mABCD-1234\u001b[0m");
    expect(out).toEqual({ verificationUrl: "https://example.test/device", userCode: "ABCD-1234" });
  });

  it("prefers the verification page over an unrelated link printed first", () => {
    expect(parseXaiDeviceLogin(
      "Docs: https://docs.example.test/providers/xai\nOpen https://accounts.example.test/device and enter ABCD-1234",
    ).verificationUrl).toBe("https://accounts.example.test/device");
  });

  it("does not take a word after 'code' for the code", () => {
    expect(parseXaiDeviceLogin("https://example.test/device\nThe code expires in 15 minutes.").userCode).toBeNull();
  });

  it("does not take a path or query fragment of the URL for the code", () => {
    expect(parseXaiDeviceLogin("Open https://example.test/oauth/code/device").userCode).toBeNull();
  });

  it("answers nulls for output with nothing in it", () => {
    expect(parseXaiDeviceLogin("Starting…\n")).toEqual({ verificationUrl: null, userCode: null });
    expect(parseXaiDeviceLogin("")).toEqual({ verificationUrl: null, userCode: null });
  });
});

describe("outputTail", () => {
  it("keeps the last few non-empty lines, cleaned", () => {
    expect(outputTail("a\n\nb\nc\nd\n\u001b[31me\u001b[0m\n")).toBe("b\nc\nd\ne");
  });
});

describe("xaiLoginArgs", () => {
  it("is the device-code OAuth login at the shared profile id", () => {
    expect(xaiLoginArgs(false).join(" ")).toBe(
      "models auth login --provider xai --method oauth --device-code --profile-id xai:default",
    );
  });

  it("adds --force only when there is a profile to replace", () => {
    expect(xaiLoginArgs(true)).toContain("--force");
    expect(xaiLoginArgs(false)).not.toContain("--force");
  });
});

type FakeChild = EventEmitter & {
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
  let spawnArgs: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    child = fakeChild();
    spawnArgs = [];
    xaiLoginSpawn.spawn = (_bin, args) => {
      spawnArgs = args;
      return child as unknown as ChildProcess;
    };
  });

  afterEach(() => {
    cancelXaiLogin();
    xaiLoginSpawn.spawn = realSpawn;
    vi.useRealTimers();
  });

  /** Start, let the CLI "print" something, and collect start's answer. */
  async function startWith(print: () => void, opts = { replaceExisting: false }) {
    const started = startXaiLogin(opts);
    print();
    await vi.advanceTimersByTimeAsync(250);
    return started;
  }

  it("answers start with the URL and code as soon as the CLI prints them", async () => {
    const answer = await startWith(() => {
      child.stdout.emit("data", Buffer.from("Open https://example.test/device\nCode: ABCD-1234\n"));
    });

    expect(answer).toEqual({
      status: "pending",
      verificationUrl: "https://example.test/device",
      userCode: "ABCD-1234",
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

  it("ends a login nobody approved when the code's lifetime is up", async () => {
    await startWith(() => {
      child.stdout.emit("data", Buffer.from("Open https://example.test/device\nCode: ABCD-1234\n"));
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);

    expect(pollXaiLogin()).toMatchObject({ status: "failed", detail: expect.stringContaining("expired") });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
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
