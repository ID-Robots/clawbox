import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The attended CLI login behind the provider panel's Anthropic / Copilot
 * cards. Hermes 2026.9.7 marks those providers "external" — its dashboard
 * will not run the login — so ClawBox drives the provider's own CLI and
 * presents it in the dashboard's session shape. A fake child stands in for
 * the CLI: what it prints, and when it exits, is the whole contract.
 */

vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/opt/fake/hermes", getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn(async () => {}) }));

type Fake = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough & { written: string[] };
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
  spawnfile: string;
  spawnargs: string[];
};

function fakeChild(): Fake {
  const child = new EventEmitter() as Fake;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stdin = new PassThrough() as Fake["stdin"];
  stdin.written = [];
  stdin.on("data", (chunk) => stdin.written.push(String(chunk)));
  child.stdin = stdin;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => { child.signalCode = "SIGTERM"; return true; });
  return child;
}

let lib: typeof import("@/lib/hermes-cli-login");
let children: Fake[];
let spawnArgs: { bin: string; args: readonly string[]; env: NodeJS.ProcessEnv; detached: boolean }[];

/** The spawn is a few awaits away (binary lookup, the Hermes pin). */
async function waitForChild(index = 0): Promise<Fake> {
  for (let i = 0; i < 200 && children.length <= index; i++) await new Promise((r) => setTimeout(r, 10));
  if (children.length <= index) throw new Error("the login was never spawned");
  return children[index];
}

beforeEach(async () => {
  vi.resetModules();
  lib = await import("@/lib/hermes-cli-login");
  children = [];
  spawnArgs = [];
  lib._setSpawnForTests((bin, args, opts) => {
    const child = fakeChild();
    child.spawnfile = bin;
    child.spawnargs = [...args];
    children.push(child);
    spawnArgs.push({ bin, args, env: opts.env, detached: opts.detached });
    return child as unknown as import("child_process").ChildProcess;
  });
});

afterEach(() => {
  lib._resetCliLoginsForTests();
  lib._setSpawnForTests(null);
});

const ANTHROPIC_BANNER = [
  "",
  "Authorize Hermes with your Claude Pro/Max subscription.",
  "",
  "  https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz",
  "",
  "After authorizing, you'll see a code. Paste it below.",
  "",
].join("\n");

async function startAnthropic() {
  const started = lib.startCliLogin("anthropic");
  const child = await waitForChild();
  child.stdout.write(ANTHROPIC_BANNER);
  child.stdout.write("Authorization code: ");
  return { session: await started, child };
}

describe("Anthropic — Hermes' own attended login, driven for the panel", () => {
  it("runs `hermes auth add anthropic --no-browser` with no display, and answers the link once the CLI asks for the code", async () => {
    const { session } = await startAnthropic();
    expect(spawnArgs[0].bin).toBe("/opt/fake/hermes");
    expect(spawnArgs[0].args).toEqual(["auth", "add", "anthropic", "--no-browser"]);
    expect(spawnArgs[0].env.DISPLAY).toBeUndefined();
    // Its own process group, so a cancel can take the launcher's children too.
    expect(spawnArgs[0].detached).toBe(true);
    expect(session.flow).toBe("pkce");
    expect(session.status).toBe("pending");
    expect(session.authUrl).toBe("https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz");
  });

  it("hands the pasted code to the CLI's stdin and reports approved on exit 0", async () => {
    const { session, child } = await startAnthropic();
    const submitted = lib.submitCliLoginCode(session.id, "code123#xyz");
    await new Promise((r) => setTimeout(r, 20));
    expect(child.stdin.written.join("")).toBe("code123#xyz\n");
    child.stdout.write("Credential stored for anthropic (sk-ant-oat01-SECRETSECRETSECRETSECRETSECRET)\n");
    child.exitCode = 0;
    child.emit("exit", 0, null);
    const done = await submitted;
    expect(done?.status).toBe("approved");
    expect(done?.error).toBe("");
  });

  it("reports a refusal with a scrubbed reason — never the CLI's transcript", async () => {
    const { session, child } = await startAnthropic();
    const submitted = lib.submitCliLoginCode(session.id, "bad");
    await new Promise((r) => setTimeout(r, 20));
    child.stderr.write("Token exchange failed: invalid_grant (token sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789)\n");
    child.exitCode = 1;
    child.emit("exit", 1, null);
    const done = await submitted;
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("invalid_grant");
    expect(done?.error).not.toContain("sk-ant");
    expect(done?.error).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });

  it("fails the start, and kills the child, when no link arrives", async () => {
    vi.useFakeTimers();
    try {
      const started = lib.startCliLogin("anthropic");
      await vi.advanceTimersByTimeAsync(21_000);
      const session = await started;
      expect(session.status).toBe("failed");
      expect(children[0].kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starting again cancels the previous attempt for the same provider", async () => {
    const first = await startAnthropic();
    const second = lib.startCliLogin("anthropic");
    (await waitForChild(1)).stdout.write(ANTHROPIC_BANNER + "Authorization code: ");
    await second;
    expect(first.child.kill).toHaveBeenCalled();
    expect(lib.readCliLogin(first.session.id)?.status).toBe("cancelled");
  });

  it("cancel kills the CLI and the poll reads cancelled", async () => {
    const { session, child } = await startAnthropic();
    expect(lib.cancelCliLogin(session.id)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(lib.readCliLogin(session.id)?.status).toBe("cancelled");
  });

  it("escalates to SIGKILL when the CLI ignores SIGTERM — a cancelled login must not keep polling", async () => {
    const { session, child } = await startAnthropic();
    vi.useFakeTimers();
    try {
      child.kill = vi.fn(() => true); // ignores every signal: exitCode/signalCode stay null
      lib.cancelCliLogin(session.id);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(3_100);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GitHub Copilot — GitHub's device flow, read off the CLI", () => {
  it("answers the link and the code, then approved once the CLI exits 0 on its own", async () => {
    const started = lib.startCliLogin("copilot-acp");
    const child = await waitForChild();
    // Not installed in this test environment: the bare name is what gets
    // spawned, and the device flow is forced — the box has no browser.
    expect(spawnArgs[0].bin).toBe("copilot");
    expect(spawnArgs[0].args).toEqual(["login", "--device-code"]);
    expect(spawnArgs[0].env.PATH).toContain(".npm-global/bin");
    // Verbatim from GitHub Copilot CLI 1.0.85 on a box.
    child.stdout.write("To authenticate, visit https://github.com/login/device and enter code 9F2K-QZ7B\nWaiting for authorization...\n");
    const session = await started;
    expect(session.flow).toBe("device_code");
    expect(session.status).toBe("pending");
    expect(session.userCode).toBe("9F2K-QZ7B");
    expect(session.verificationUrl).toBe("https://github.com/login/device");
    child.exitCode = 0;
    child.emit("exit", 0, null);
    expect(lib.readCliLogin(session.id)?.status).toBe("approved");
  });
});

describe("what the panel may drive", () => {
  it("knows the flow for the two drivers and nothing for the rest", () => {
    expect(lib.cliLoginDriverFor("anthropic")).toBe("pkce");
    expect(lib.cliLoginDriverFor("copilot-acp")).toBe("device_code");
    expect(lib.cliLoginDriverFor("qwen-oauth")).toBeNull();
    expect(lib.cliLoginDriverFor("openai-codex")).toBeNull();
  });

  it("reports a driver unavailable when its executable is not on the box", async () => {
    expect(await lib.cliLoginAvailable("copilot-acp")).toBe(false);
    expect(await lib.cliLoginAvailable("anthropic")).toBe(false);
  });
});
