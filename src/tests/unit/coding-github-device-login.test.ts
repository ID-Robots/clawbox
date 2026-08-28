/**
 * The device-flow login (src/lib/coding-github.ts) against a mocked
 * github.com and a mocked gh.
 *
 * The property that matters most: the token GitHub answers with goes to gh's
 * STDIN and nowhere else — never into argv (world-readable in /proc), never
 * into a reply. The rest pins the flow's verdicts: pending stays pending,
 * slow_down slows down, declined and expired end the flow, and a fresh start
 * is always the retry.
 *
 * The cadence is pinned here too, because it is enforced HERE: github.com
 * answers slow_down to this process, and a caller that polls early must be
 * answered from memory, not with another request that earns the next one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runChild = vi.hoisted(() => vi.fn());
vi.mock("@/lib/child-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/child-run")>();
  return { ...actual, runChild };
});

type Lib = typeof import("@/lib/coding-github");
let lib: Lib;

const fetchMock = vi.fn();

function githubAnswers(body: Record<string, unknown>, ok = true): void {
  fetchMock.mockResolvedValueOnce({ ok, json: async () => body } as Response);
}

const CODES = { device_code: "dev-123", user_code: "8A5B-0396", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };

/** The clock the cadence is measured on; tests move it instead of waiting. */
let now = 1_700_000_000_000;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  now = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  runChild.mockResolvedValue({ code: 0, stdout: "", stderr: "Logged in to github.com as yalexx", signal: null, timedOut: false, startFailed: false, startError: null });
  lib = await import("@/lib/coding-github");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("starting", () => {
  it("returns the code and the link the card shows", async () => {
    githubAnswers(CODES);
    const out = await lib.startDeviceLogin();
    expect(out).toMatchObject({ userCode: "8A5B-0396", verificationUri: "https://github.com/login/device", interval: 5 });
  });

  it("answers an error, not a throw, when github.com cannot be reached", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const out = await lib.startDeviceLogin();
    expect("error" in out).toBe(true);
  });
});

describe("polling", () => {
  beforeEach(async () => {
    githubAnswers(CODES);
    await lib.startDeviceLogin();
  });

  it("stays pending while the owner has not entered the code, and slows down when told to", async () => {
    githubAnswers({ error: "authorization_pending" });
    expect(await lib.pollDeviceLogin()).toEqual({ status: "pending", interval: 5 });
    now += 5_000;
    githubAnswers({ error: "slow_down" });
    // RFC 8628: slow_down adds five seconds. The answer carries the new
    // cadence so the card can fall into step.
    expect(await lib.pollDeviceLogin()).toEqual({ status: "pending", interval: 10 });
  });

  it("answers an early poll from memory, without asking github.com", async () => {
    githubAnswers({ error: "authorization_pending" });
    await lib.pollDeviceLogin();
    expect(fetchMock).toHaveBeenCalledTimes(2); // start + one poll
    // Four seconds later: too soon at a five-second cadence.
    now += 4_000;
    expect(await lib.pollDeviceLogin()).toEqual({ status: "pending", interval: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Once the cadence has passed, the next poll goes out.
    now += 1_000;
    githubAnswers({ error: "authorization_pending" });
    await lib.pollDeviceLogin();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("holds the slower cadence after a slow_down — the old one would earn another", async () => {
    githubAnswers({ error: "slow_down" });
    expect(await lib.pollDeviceLogin()).toEqual({ status: "pending", interval: 10 });
    // A caller still on the original five-second timer.
    now += 5_000;
    expect(await lib.pollDeviceLogin()).toEqual({ status: "pending", interval: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 5_000;
    githubAnswers({ error: "authorization_pending" });
    await lib.pollDeviceLogin();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats a transient network fault as pending — the code is still valid", async () => {
    fetchMock.mockRejectedValueOnce(new Error("flaky"));
    expect(await lib.pollDeviceLogin()).toEqual({ status: "pending", interval: 5 });
  });

  it("does not let a poll that was in flight when the login was cancelled store a token", async () => {
    // The answer belongs to a flow that no longer exists.
    let answer: (body: Record<string, unknown>) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      answer = (body) => resolve({ ok: true, json: async () => body } as Response);
    }));
    const poll = lib.pollDeviceLogin();
    lib.cancelDeviceLogin();
    answer({ access_token: "gho_secret_token_value" });
    expect((await poll).status).toBe("failed");
    expect(runChild.mock.calls.some(([bin, args]) => bin === "gh" && (args as string[]).includes("--with-token"))).toBe(false);
  });

  it("ends the flow when the owner declines, and a new start is the retry", async () => {
    githubAnswers({ error: "access_denied" });
    const out = await lib.pollDeviceLogin();
    expect(out.status).toBe("failed");
    // Cleared: the next poll no longer has a login to ask about.
    now += 5_000;
    expect((await lib.pollDeviceLogin()).status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hands the token to gh's stdin, never to argv, and never returns it", async () => {
    githubAnswers({ access_token: "gho_secret_token_value" });
    const out = await lib.pollDeviceLogin();
    expect(out.status).toBe("connected");
    expect(JSON.stringify(out)).not.toContain("gho_secret_token_value");
    const call = runChild.mock.calls.find(([bin, args]) => bin === "gh" && (args as string[]).includes("--with-token"));
    expect(call).toBeTruthy();
    const [, args, opts] = call as [string, string[], { input?: string }];
    expect(args.join(" ")).not.toContain("gho_secret_token_value");
    expect(opts.input).toBe("gho_secret_token_value");
  });

  it("reports gh refusing the token as a failure with gh's words", async () => {
    githubAnswers({ access_token: "gho_secret_token_value" });
    runChild.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "bad scopes", signal: null, timedOut: false, startFailed: false, startError: null });
    const out = await lib.pollDeviceLogin();
    expect(out).toMatchObject({ status: "failed" });
    expect((out as { detail: string }).detail).toContain("bad scopes");
  });
});

describe("cancelling", () => {
  it("forgets the login in flight", async () => {
    githubAnswers(CODES);
    await lib.startDeviceLogin();
    lib.cancelDeviceLogin();
    expect((await lib.pollDeviceLogin()).status).toBe("failed");
  });
});
