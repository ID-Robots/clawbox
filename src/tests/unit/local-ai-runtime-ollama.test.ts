import fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Toggling Local AI off and then on left ollama.service stopped (revalidation
 * §17). Two faults in one: nothing on the enable path started the service, and
 * the start it WOULD have issued — an unprivileged `systemctl start ollama` —
 * cannot work on a box running the shipped sudoers, because the web server runs
 * as `clawbox` and the unit is a system one.
 */

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile: execFileMock }));
vi.mock("@/instrumentation-node", () => ({
  startLlamaCppServer: vi.fn(),
  stopLlamaCppServer: vi.fn(),
}));
vi.mock("@/lib/process-match", () => ({ terminateByArgv: vi.fn() }));
vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: () => "gemma4-e2b-it-q4_0",
  getLlamaCppBaseUrl: () => "http://127.0.0.1:8080",
  getLlamaCppProxyBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
}));
vi.mock("@/lib/llamacpp-server", () => ({
  getLlamaCppLaunchSpec: () => ({ baseUrl: "http://127.0.0.1:8080", startupTimeoutMs: 1_200_000 }),
  getLlamaCppProvisioningStatus: vi.fn(async () => ({ modelAvailable: false })),
  queryLlamaCppModels: vi.fn(async () => []),
  resolveConfiguredLlamaCppAlias: vi.fn(async () => "gemma4-e2b-it-q4_0"),
}));

/** execFile is promisified, so the mock has to answer through its callback. */
type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function execSucceeds(...matchers: RegExp[]) {
  execFileMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
    const line = [cmd, ...args].join(" ");
    if (matchers.some((m) => m.test(line))) cb(null, { stdout: "", stderr: "" });
    else cb(Object.assign(new Error(`refused: ${line}`), { code: 1 }));
  });
}

function argvLines(): string[] {
  return execFileMock.mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(" "));
}

beforeEach(() => {
  vi.resetModules();
  execFileMock.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bringing Ollama up for a deliberate Local AI enable", () => {
  it("enables AND starts the unit, through sudo, so the choice survives a reboot", async () => {
    execSucceeds(/sudo -n \/usr\/bin\/systemctl enable --now ollama\.service/);
    const { activateLocalAiProvider } = await import("@/lib/local-ai-runtime");

    await activateLocalAiProvider("ollama");

    expect(argvLines()[0]).toBe("/usr/bin/sudo -n /usr/bin/systemctl enable --now ollama.service");
  });

  it("issues the exact argv config/clawbox-sudoers grants", () => {
    // sudoers Cmnd_Spec matching is argument-exact: `ollama` and
    // `ollama.service` are different strings to sudo, and a grant that does not
    // match means a password prompt no web request can answer.
    const sudoers = fs.readFileSync(new URL("../../../config/clawbox-sudoers", import.meta.url), "utf-8");
    const granted = sudoers
      .split("\n")
      .filter((l) => l.trim().startsWith("clawbox ") && l.includes("/usr/bin/systemctl"))
      .map((l) => l.slice(l.indexOf("/usr/bin/systemctl")).replace(/\s+/g, " ").trim());

    for (const argv of [
      "/usr/bin/systemctl enable --now ollama.service",
      "/usr/bin/systemctl start ollama.service",
      "/usr/bin/systemctl stop ollama.service",
    ]) {
      expect(granted, `no NOPASSWD grant for ${argv}`).toContain(argv);
    }
  });

  it("falls back to the unprivileged call where sudo is not configured", async () => {
    // Dev shells and boxes with a permissive polkit. The fallback is why this
    // change cannot regress a working install.
    execSucceeds(/^\/usr\/bin\/systemctl enable --now ollama\.service/);
    const { activateLocalAiProvider } = await import("@/lib/local-ai-runtime");

    await activateLocalAiProvider("ollama");

    expect(argvLines()).toEqual([
      "/usr/bin/sudo -n /usr/bin/systemctl enable --now ollama.service",
      "/usr/bin/systemctl enable --now ollama.service",
    ]);
  });

  it("fails rather than reporting a model that is not there", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _o: unknown, cb: ExecCallback) =>
      cb(new Error("Interactive authentication required")),
    );
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const { activateLocalAiProvider } = await import("@/lib/local-ai-runtime");

    // The enable path calls this BEFORE registering the model with Hermes, so a
    // throw here is what stops a device from reporting "configured" over a dead
    // service.
    await expect(activateLocalAiProvider("ollama")).rejects.toThrow(/authentication|Ollama/i);
  });
});

describe("the standby path", () => {
  it("starts without enabling, so a wake cannot undo the owner's boot preference", async () => {
    // Settings → Local Models owns the enabled-state switch.
    execSucceeds(/sudo -n \/usr\/bin\/systemctl start ollama\.service/);
    // Down for the reachability probe, up for the readiness poll that follows.
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    }));
    const { startOllamaService } = await import("@/lib/local-ai-runtime");

    await startOllamaService();

    expect(argvLines()).toEqual(["/usr/bin/sudo -n /usr/bin/systemctl start ollama.service"]);
  });

  it("does nothing at all when Ollama is already answering", async () => {
    const { startOllamaService } = await import("@/lib/local-ai-runtime");
    await startOllamaService();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("stops without disabling, so an idle model still comes back after a reboot", async () => {
    execSucceeds(/sudo -n \/usr\/bin\/systemctl stop ollama\.service/);
    const { stopLocalAiProvider } = await import("@/lib/local-ai-runtime");

    await stopLocalAiProvider("ollama");

    expect(argvLines()).toEqual(["/usr/bin/sudo -n /usr/bin/systemctl stop ollama.service"]);
    expect(argvLines().join(" ")).not.toMatch(/disable/);
  });
});

describe("llama.cpp on the enable path", () => {
  it("is not pre-woken when its weights still have to be downloaded", async () => {
    // The launcher's provisioning budget is 20 minutes. The caller is an HTTP
    // handler.
    const { activateLocalAiProvider } = await import("@/lib/local-ai-runtime");
    await activateLocalAiProvider("llamacpp");
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
