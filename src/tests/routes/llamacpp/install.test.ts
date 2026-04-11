import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { NextResponse } from "next/server";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";

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
    mockFs.stat.mockImplementation(async (target: string) => {
      const normalized = String(target);
      if (
        normalized === "/usr/local/bin/llama-server"
        || normalized.endsWith("gemma-4-e2b-it-edited-q4_0.gguf")
      ) {
        return { size: 1 } as never;
      }
      throw new Error("ENOENT");
    });
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
        "gguf-org/gemma-4-e2b-it-gguf",
        "gemma-4-e2b-it-edited-q4_0.gguf",
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
    mockFs.readFile.mockImplementation(async (target: string) => {
      if (String(target).endsWith("server.pid")) {
        pidReadCount += 1;
        if (pidReadCount === 1) {
          throw new Error("ENOENT");
        }
        return "12345\n";
      }
      throw new Error("ENOENT");
    });
    mockFs.stat.mockImplementation(async (target: string) => {
      if (
        String(target) === "/usr/local/bin/llama-server"
        || String(target).endsWith("gemma-4-e2b-it-edited-q4_0.gguf")
      ) {
        return { size: 1 } as never;
      }
      if (String(target).endsWith("server.log")) {
        return { size: Buffer.byteLength(runtimeError) } as never;
      }
      throw new Error("ENOENT");
    });
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
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      ["/usr/bin/systemctl", "start", "clawbox-root-update@llamacpp_install.service"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    killSpy.mockRestore();
  });
});
