import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { NextResponse } from "next/server";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
// Imported rather than spelled out so a GGUF swap cannot leave this suite
// asserting a filename the app no longer asks for.
import { DEFAULT_LLAMACPP_HF_FILE, DEFAULT_LLAMACPP_HF_REPO } from "@/lib/llamacpp";
import { startRootStep } from "@/lib/root-step-runner";

vi.mock("@/lib/root-step-runner", () => ({
  ROOT_STEP_LAUNCHER: "/usr/local/libexec/clawbox/clawbox-run-root-step.sh",
  startRootStep: vi.fn(async () => {}),
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    open: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock("@/app/setup-api/ai-models/configure/route", () => ({
  POST: vi.fn(),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  stopLocalAiProvider: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockFs = vi.mocked(fsp);
const mockStopLocalAiProvider = vi.mocked(stopLocalAiProvider);
let mockConfigureAiModel: ReturnType<typeof vi.fn>;

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createSpawnedProcess(pid = 12345): ChildProcess {
  return {
    pid,
    unref: vi.fn(),
  } as unknown as ChildProcess;
}

async function readStream(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  if (!reader) return text;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

function setupExecFileMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
    const key = `${cmd} ${args.join(" ")}`;

    let result = results[key];
    if (!result) {
      for (const candidate of Object.keys(results)) {
        if (key.includes(candidate) || candidate.includes(cmd)) {
          result = results[candidate];
          break;
        }
      }
    }

    if (callback) {
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else if (result) {
        callback(null, result);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }

    return {} as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("POST /setup-api/llamacpp/install", () => {
  let installPost: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const configureMod = await import("@/app/setup-api/ai-models/configure/route");
    mockConfigureAiModel = vi.mocked(configureMod.POST);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.open.mockRejectedValue(new Error("ENOENT"));
    mockFs.writeFile.mockResolvedValue();
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockFs.stat.mockImplementation((async (target: unknown) => {
      const normalized = String(target);
      if (
        normalized === "/usr/local/bin/llama-server"
        || normalized.endsWith(DEFAULT_LLAMACPP_HF_FILE)
      ) {
        return { size: 1 } as never;
      }
      throw new Error("ENOENT");
    }) as typeof fsp.stat);
    setupExecFileMock({
      systemctl: { stdout: "", stderr: "" },
      journalctl: { stdout: "", stderr: "" },
    });
    mockConfigureAiModel.mockResolvedValue(
      NextResponse.json({ success: true })
    );
    mockStopLocalAiProvider.mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn());

    const mod = await import("@/app/setup-api/llamacpp/install/route");
    installPost = mod.POST;
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    const res = await installPost(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("configures immediately when llama.cpp is already serving the alias", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [{ id: "gemma4-e2b-it-q4_0" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await installPost(jsonRequest({ model: "gemma4-e2b-it-q4_0" }));
    const text = await readStream(res);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockConfigureAiModel).toHaveBeenCalled();
    expect(text).toContain("already running");
    expect(text).toContain("\"success\":true");
  });

  /**
   * TASK-682 — the alias is a WIRE LABEL, not a choice of weights.
   *
   * `getLlamaCppLaunchSpec(alias)` resolves `modelPath` from
   * `getDefaultLlamaCppFile()` whatever the alias is, and start-llamacpp.sh
   * passes it as `--model` while the alias goes to `--alias`. So every alias on
   * a box is the SAME GGUF, and `models.includes(alias)` asks a question about
   * a label rather than about the runtime.
   *
   * Two other readers already know this — `waitForLlamaCppReady` and
   * `isLlamaCppUp` (src/lib/local-ai-runtime.ts) both accept a non-empty
   * `/v1/models` — and this route was the one that did not. With a warm runtime
   * under a different label (the install route itself accepts any MODEL_ID_RE
   * string, and a Settings model change never stops the old server), the pid
   * file is live so nothing restarts, the alias never appears, and the wizard
   * sat in a streamed HTTP handler for the FULL startupTimeoutMs — 20 minutes —
   * before reporting a timeout for a runtime that was up and answering.
   */
  it("configures against a runtime that is already up under another alias, instead of polling to the timeout", async () => {
    // A live pid: this is what stops the loop from restarting anything.
    mockFs.readFile.mockImplementation((async (target: unknown) =>
      String(target).endsWith("server.pid")
        ? `${process.pid}\n`
        : Promise.reject(new Error("ENOENT"))) as typeof fsp.readFile);
    // The runtime answers — under the label the install route was given last time.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: "gemma-4-e2b" }] }),
    }));
    // Without this the RED case would take the real 20 minutes to fail.
    vi.stubEnv("LLAMACPP_STARTUP_TIMEOUT_MS", "1");

    const res = await installPost(jsonRequest({ model: "gemma4-e2b-it-q4_0" }));
    const text = await readStream(res);

    vi.unstubAllEnvs();

    expect(text).not.toContain("Timed out");
    expect(text).toContain("already running");
    expect(text).toContain("\"success\":true");
    expect(mockConfigureAiModel).toHaveBeenCalled();
    // And it must not race the live server for the one port.
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("starts llama-server and configures after the model becomes ready", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "gemma4-e2b-it-q4_0" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);
    mockSpawn.mockReturnValue(createSpawnedProcess());

    const res = await installPost(jsonRequest({ model: "gemma4-e2b-it-q4_0" }));
    const text = await readStream(res);

    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([
        expect.stringContaining("scripts/start-llamacpp.sh"),
        DEFAULT_LLAMACPP_HF_REPO,
        DEFAULT_LLAMACPP_HF_FILE,
        "gemma4-e2b-it-q4_0",
      ]),
      expect.objectContaining({
        detached: true,
      })
    );
    // The trailing "0" is the ctx-size argument, which tells llama-server
    // to load the full trained context window from the model metadata.
    expect(mockSpawn.mock.calls[0]?.[1]?.at(-1)).toBe("0");
    expect(mockConfigureAiModel).toHaveBeenCalled();
    expect(text).toContain("Starting preinstalled Gemma 4");
    expect(text).toContain("Returning it to standby");
    expect(text).toContain("will wake automatically");
    expect(mockStopLocalAiProvider).toHaveBeenCalledWith("llamacpp");
  });

  it("forwards local scope to the configure route during llama.cpp install", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "gemma4-e2b-it-q4_0" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);
    mockSpawn.mockReturnValue(createSpawnedProcess());

    const res = await installPost(jsonRequest({ model: "gemma4-e2b-it-q4_0", scope: "local" }));
    await readStream(res);

    expect(mockConfigureAiModel).toHaveBeenCalledTimes(1);
    const configureRequest = mockConfigureAiModel.mock.calls[0]?.[0] as Request;
    expect(configureRequest).toBeDefined();
    const payload = await configureRequest.json();
    expect(payload.scope).toBe("local");
    expect(payload.provider).toBe("llamacpp");
  });

  // Provisioning on a cold box builds llama.cpp from source with CUDA and
  // downloads a multi-GB GGUF — tens of minutes. It used to run as one
  // blocking `systemctl start` that emitted nothing, so the wizard showed a
  // bare spinner on "Provisioning offline Gemma 4" and a real hang was
  // indistinguishable from normal progress.
  it("streams install progress while the provisioning unit runs", async () => {
    let installComplete = false;
    let showCalls = 0;

    mockFs.stat.mockImplementation((async (target: unknown) => {
      const normalized = String(target);
      const isRuntimeArtifact = normalized === "/usr/local/bin/llama-server"
        || normalized.endsWith(DEFAULT_LLAMACPP_HF_FILE);
      if (isRuntimeArtifact && installComplete) return { size: 1 } as never;
      throw new Error("ENOENT");
    }) as typeof fsp.stat);

    mockExecFile.mockImplementation(((
      cmd: string,
      args: string[],
      optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
      maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
      const key = `${cmd} ${args.join(" ")}`;
      let stdout = "";
      if (key.includes("systemctl show")) {
        showCalls += 1;
        // First poll: still building. Second: finished cleanly.
        stdout = showCalls <= 1
          ? "ActiveState=activating\nResult=success\n"
          : "ActiveState=inactive\nResult=success\n";
        if (showCalls >= 2) installComplete = true;
      } else if (key.includes("journalctl")) {
        stdout = "Installing llama.cpp server (CUDA=ON)...\n";
      }
      callback?.(null, { stdout, stderr: "" });
      return {} as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile);

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: [] }) })
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [{ id: "gemma4-e2b-it-q4_0" }] }) });
    vi.stubGlobal("fetch", mockFetch);
    mockSpawn.mockReturnValue(createSpawnedProcess(12345));

    const res = await installPost(jsonRequest({ model: "gemma4-e2b-it-q4_0" }));
    const text = await readStream(res);

    // Phase-stable prefix keeps the wizard on the provisioning step; the tail
    // is the live build line the user reads while waiting.
    expect(text).toContain("Installing Gemma 4 for offline use — Installing llama.cpp server (CUDA=ON)...");
    expect(text).toContain("\"success\":true");
  });

  it("fails fast with the journal line when the provisioning unit fails", async () => {
    mockFs.stat.mockImplementation((async () => {
      throw new Error("ENOENT");
    }) as typeof fsp.stat);

    mockExecFile.mockImplementation(((
      cmd: string,
      args: string[],
      optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
      maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
      const key = `${cmd} ${args.join(" ")}`;
      let stdout = "";
      if (key.includes("systemctl show")) {
        stdout = "ActiveState=failed\nResult=timeout\n";
      } else if (key.includes("journalctl")) {
        stdout = "Error: failed to download Gemma 4 for offline startup\n";
      }
      callback?.(null, { stdout, stderr: "" });
      return {} as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    }));

    const res = await installPost(jsonRequest({ model: "gemma4-e2b-it-q4_0" }));
    const text = await readStream(res);

    expect(text).toContain("failed to download Gemma 4 for offline startup");
    // No point starting llama-server against a runtime that never installed.
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("repairs the llama.cpp runtime and retries when hf is missing", async () => {
    const runtimeError = "[llamacpp] Missing Hugging Face CLI at /home/clawbox/.local/bin/hf. Run the llama.cpp install step to repair the local runtime.\n";
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: "gemma4-e2b-it-q4_0" }] }),
      });
    vi.stubGlobal("fetch", mockFetch);

    mockSpawn.mockReturnValue(createSpawnedProcess(12345));
    let pidReadCount = 0;
    mockFs.readFile.mockImplementation((async (target: unknown) => {
      if (String(target).endsWith("server.pid")) {
        pidReadCount += 1;
        if (pidReadCount === 1) {
          throw new Error("ENOENT");
        }
        return "12345\n";
      }
      throw new Error("ENOENT");
    }) as typeof fsp.readFile);
    mockFs.stat.mockImplementation((async (target: unknown) => {
      if (
        String(target) === "/usr/local/bin/llama-server"
        || String(target).endsWith(DEFAULT_LLAMACPP_HF_FILE)
      ) {
        return { size: 1 } as never;
      }
      if (String(target).endsWith("server.log")) {
        return { size: Buffer.byteLength(runtimeError) } as never;
      }
      throw new Error("ENOENT");
    }) as typeof fsp.stat);
    mockFs.open.mockResolvedValue({
      stat: vi.fn().mockResolvedValue({ size: Buffer.byteLength(runtimeError) }),
      read: vi.fn().mockImplementation(async (buffer: Buffer) => {
        buffer.write(runtimeError);
        return { bytesRead: buffer.length, buffer };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    const killSpy = vi.spyOn(process, "kill")
      .mockImplementationOnce(() => {
        throw new Error("ESRCH");
      })
      .mockImplementation(() => true);

    const res = await installPost(jsonRequest({ model: "gemma4-e2b-it-q4_0" }));
    const text = await readStream(res);

    expect(text).toContain("Repairing the llama.cpp runtime");
    expect(text).toContain("runtime repaired");
    expect(text).toContain("\"success\":true");
    // --no-block: we poll systemd ourselves so the wizard can stream progress
    // instead of sitting silent for the whole install. Through the root-owned
    // launcher, which also clears a previous failure itself. TASK-539.
    expect(vi.mocked(startRootStep)).toHaveBeenCalledWith(
      "llamacpp_install",
      expect.objectContaining({ noBlock: true }),
    );
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    killSpy.mockRestore();
  });
});
