import fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The memory embedder (clawbox-embed.service) is woken by the local-AI proxy
 * and put to sleep by the idle timer, through the same sudo-then-unprivileged
 * systemctl path ollama uses. This pins the argv (sudoers matches it exactly),
 * the "already healthy → touch nothing" short-circuit, the memory guard that
 * refuses a wake on a full box, and the boot-time re-arm of the idle stop for
 * a unit that outlived the web server.
 */

const execFileMock = vi.hoisted(() => vi.fn());
// The memory guard reads /proc/meminfo; the log tail reads the unit's log.
// Both go through fs/promises, stubbed so no case depends on the host kernel
// — a runner without /proc would skip the guard, start the unit, and poll
// real timers for the whole 20-minute provisioning budget.
const readFileMock = vi.hoisted(() => vi.fn(async (): Promise<string> => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }));
vi.mock("fs/promises", () => ({ default: { readFile: readFileMock } }));
const embed = vi.hoisted(() => ({
  isEmbedHealthy: vi.fn(),
  getEmbedProvisioningStatus: vi.fn(async () => ({
    binPath: "/usr/local/bin/llama-server",
    modelPath: "/data/embed/models/x.gguf",
    binaryAvailable: true,
    modelAvailable: true,
    installed: true,
    modelBytes: 639_000_000,
  })),
}));

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
vi.mock("@/lib/embed-server", () => ({
  EMBED_UNIT: "clawbox-embed.service",
  getEmbedBaseUrl: () => "http://127.0.0.1:8081/v1",
  getEmbedProxyBaseUrl: () => "http://127.0.0.1/setup-api/local-ai/embed/v1",
  getEmbedLaunchSpec: () => ({
    alias: "qwen3-embedding-0.6b",
    baseUrl: "http://127.0.0.1:8081/v1",
    healthUrl: "http://127.0.0.1:8081/health",
    logPath: "/nonexistent/embed/server.log",
    startupTimeoutMs: 1_200_000,
  }),
  getEmbedProvisioningStatus: embed.getEmbedProvisioningStatus,
  isEmbedHealthy: embed.isEmbedHealthy,
  isLlamaServerExecutable: (argv0: string) => /(^|\/)llama-server$/.test(argv0),
  isEmbeddingServerArgv: (argv: string[]) => argv.includes("--embedding"),
}));

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
  embed.isEmbedHealthy.mockReset();
  // The guard reads the real /proc/meminfo; a CI runner's free memory must not
  // decide these tests. The guard has its own case below.
  process.env.EMBED_WAKE_MIN_AVAILABLE_MB = "0";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.EMBED_WAKE_MIN_AVAILABLE_MB;
  delete process.env.LOCAL_AI_IDLE_TIMEOUT_MS;
});

describe("waking the memory embedder for a proxied request", () => {
  it("starts the unit through sudo when it is not answering, then waits for /health", async () => {
    embed.isEmbedHealthy.mockResolvedValueOnce(false).mockResolvedValue(true);
    execSucceeds(/sudo -n \/usr\/bin\/systemctl start clawbox-embed\.service/);
    const { ensureLocalAiReady } = await import("@/lib/local-ai-runtime");

    await ensureLocalAiReady("embed");

    expect(argvLines()).toEqual(["/usr/bin/sudo -n /usr/bin/systemctl start clawbox-embed.service"]);
    // Pre-check, then the readiness poll that succeeded.
    expect(embed.isEmbedHealthy).toHaveBeenCalledTimes(2);
  });

  it("touches nothing when the server is already healthy", async () => {
    embed.isEmbedHealthy.mockResolvedValue(true);
    execSucceeds();
    const { ensureLocalAiReady } = await import("@/lib/local-ai-runtime");

    await ensureLocalAiReady("embed");

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("falls back to an unprivileged systemctl when sudo refuses", async () => {
    embed.isEmbedHealthy.mockResolvedValueOnce(false).mockResolvedValue(true);
    execSucceeds(/^\/usr\/bin\/systemctl start clawbox-embed\.service$/);
    const { ensureLocalAiReady } = await import("@/lib/local-ai-runtime");

    await ensureLocalAiReady("embed");

    expect(argvLines()).toEqual([
      "/usr/bin/sudo -n /usr/bin/systemctl start clawbox-embed.service",
      "/usr/bin/systemctl start clawbox-embed.service",
    ]);
  });

  it("refuses the wake when the box is short of memory, before touching systemctl", async () => {
    // 512 MB reported free against the shipped 2,300 MB floor: the guard must
    // fire and the unit stay down, on any host.
    process.env.EMBED_WAKE_MIN_AVAILABLE_MB = "2300";
    readFileMock.mockResolvedValueOnce("MemTotal:       7789948 kB\nMemAvailable:    524288 kB\n");
    embed.isEmbedHealthy.mockResolvedValue(false);
    execSucceeds(/.*/);
    const { ensureLocalAiReady } = await import("@/lib/local-ai-runtime");

    await expect(ensureLocalAiReady("embed")).rejects.toThrow(/Not enough free memory to wake the memory embedder \(512 MB available, 2300 MB needed\)/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("wakes when the box has the room, reading the same file", async () => {
    process.env.EMBED_WAKE_MIN_AVAILABLE_MB = "2300";
    readFileMock.mockResolvedValueOnce("MemAvailable:    4653056 kB\n");
    embed.isEmbedHealthy.mockResolvedValueOnce(false).mockResolvedValue(true);
    execSucceeds(/sudo -n \/usr\/bin\/systemctl start clawbox-embed\.service/);
    const { ensureLocalAiReady } = await import("@/lib/local-ai-runtime");

    await ensureLocalAiReady("embed");

    expect(argvLines()).toEqual(["/usr/bin/sudo -n /usr/bin/systemctl start clawbox-embed.service"]);
  });

  it("fails rather than reporting an embedder that never came up", async () => {
    embed.isEmbedHealthy.mockResolvedValue(false);
    execSucceeds();
    const { ensureLocalAiReady } = await import("@/lib/local-ai-runtime");

    await expect(ensureLocalAiReady("embed")).rejects.toThrow(/refused/);
  });
});

describe("putting the memory embedder to sleep", () => {
  it("stops the unit through sudo, and never disables it", async () => {
    execSucceeds(/sudo -n \/usr\/bin\/systemctl stop clawbox-embed\.service/);
    const { stopLocalAiProvider } = await import("@/lib/local-ai-runtime");

    await stopLocalAiProvider("embed");

    expect(argvLines()).toEqual(["/usr/bin/sudo -n /usr/bin/systemctl stop clawbox-embed.service"]);
    expect(argvLines().join("\n")).not.toMatch(/disable/);
  });

  it("never matches the Gemma llama-server when it falls back to signalling", async () => {
    // Same binary, same path: only the flag the embedder alone carries may
    // select it — the defect class that once killed a live chat turn through
    // the ollama pkill.
    execSucceeds(); // both sudo and the plain systemctl refuse
    const { terminateByArgv } = await import("@/lib/process-match");
    const { stopLocalAiProvider } = await import("@/lib/local-ai-runtime");

    await stopLocalAiProvider("embed");

    expect(terminateByArgv).toHaveBeenCalledTimes(1);
    const accepts = vi.mocked(terminateByArgv).mock.calls[0][0] as (argv: string[]) => boolean;
    expect(accepts(["/usr/local/bin/llama-server", "--embedding", "--port", "8081"])).toBe(true);
    expect(accepts(["/usr/local/bin/llama-server", "--port", "8080"])).toBe(false);
    expect(accepts(["/usr/bin/node", "--embedding"])).toBe(false);
  });

  it("re-arms the idle stop at boot for a unit that outlived the web server", async () => {
    vi.useFakeTimers();
    process.env.LOCAL_AI_IDLE_TIMEOUT_MS = "1000";
    embed.isEmbedHealthy.mockResolvedValue(true);
    execSucceeds(/stop clawbox-embed\.service/);
    const { armIdleStopIfRunning } = await import("@/lib/local-ai-runtime");

    await expect(armIdleStopIfRunning("embed")).resolves.toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(argvLines()).toEqual(["/usr/bin/sudo -n /usr/bin/systemctl stop clawbox-embed.service"]);
  });

  it("arms nothing for a unit that is not up", async () => {
    embed.isEmbedHealthy.mockResolvedValue(false);
    const { armIdleStopIfRunning } = await import("@/lib/local-ai-runtime");

    await expect(armIdleStopIfRunning("embed")).resolves.toBe(false);
  });
});

describe("the embedder's addresses", () => {
  it("is reached at its /v1 mount, with no extra version suffix for OpenAI clients", async () => {
    const { getLocalAiOpenAiBaseUrl, getLocalAiProxyBaseUrl, getLocalAiRuntimeSnapshot } = await import(
      "@/lib/local-ai-runtime"
    );
    expect(getLocalAiProxyBaseUrl("embed")).toBe("http://127.0.0.1/setup-api/local-ai/embed/v1");
    expect(getLocalAiOpenAiBaseUrl("embed")).toBe("http://127.0.0.1/setup-api/local-ai/embed/v1");
    expect(getLocalAiRuntimeSnapshot("embed").upstreamBaseUrl).toBe("http://127.0.0.1:8081/v1");
  });

  it("issues the exact argv config/clawbox-sudoers grants", () => {
    // sudoers Cmnd_Spec matching is argument-exact, and a grant that does not
    // match means a password prompt no web request can answer.
    const sudoers = fs.readFileSync(new URL("../../../config/clawbox-sudoers", import.meta.url), "utf-8");
    const granted = sudoers
      .split("\n")
      .filter((l) => l.trim().startsWith("clawbox ") && l.includes("/usr/bin/systemctl"))
      .map((l) => l.slice(l.indexOf("/usr/bin/systemctl")).replace(/\s+/g, " ").trim());

    for (const argv of [
      "/usr/bin/systemctl start clawbox-embed.service",
      "/usr/bin/systemctl stop clawbox-embed.service",
    ]) {
      expect(granted, `${argv} is not granted in config/clawbox-sudoers`).toContain(argv);
    }
  });
});
