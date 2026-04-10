import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  setMany: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  inferConfiguredLocalModel: vi.fn(),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
}));

vi.mock("@/lib/llamacpp-server", () => ({
  clearLlamaCppPid: vi.fn(),
  getLlamaCppLaunchSpec: vi.fn().mockReturnValue({ pidPath: "/tmp/llamacpp.pid" }),
  readLlamaCppPid: vi.fn(),
}));

import { setMany } from "@/lib/config-store";
import { clearLlamaCppPid, getLlamaCppLaunchSpec, readLlamaCppPid } from "@/lib/llamacpp-server";
import { inferConfiguredLocalModel, readConfig, restartGateway } from "@/lib/openclaw-config";

const mockExecFile = vi.mocked(childProcess.execFile);
const mockSetMany = vi.mocked(setMany);
const mockClearLlamaCppPid = vi.mocked(clearLlamaCppPid);
const mockGetLlamaCppLaunchSpec = vi.mocked(getLlamaCppLaunchSpec);
const mockReadLlamaCppPid = vi.mocked(readLlamaCppPid);
const mockInferConfiguredLocalModel = vi.mocked(inferConfiguredLocalModel);
const mockReadConfig = vi.mocked(readConfig);
const mockRestartGateway = vi.mocked(restartGateway);

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/local-ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setupExecFileMock() {
  mockExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
    callback?.(null, { stdout: "", stderr: "" });
    return {
      then: (resolve: (value: { stdout: string; stderr: string }) => void) => {
        resolve({ stdout: "", stderr: "" });
        return {
          catch: () => ({})
        };
      },
      catch: () => ({}),
    } as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("POST /setup-api/local-ai", () => {
  let localAiPost: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSetMany.mockResolvedValue();
    mockReadConfig.mockResolvedValue({});
    mockInferConfiguredLocalModel.mockReturnValue({ provider: "llamacpp", model: "llamacpp/gemma4-e2b-it-q4_0" });
    mockRestartGateway.mockResolvedValue();
    mockGetLlamaCppLaunchSpec.mockReturnValue({ pidPath: "/tmp/llamacpp.pid" } as never);
    mockReadLlamaCppPid.mockResolvedValue(12345);
    mockClearLlamaCppPid.mockResolvedValue();
    setupExecFileMock();

    const mod = await import("@/app/setup-api/local-ai/route");
    localAiPost = mod.POST;
  });

  it("disables llama.cpp local AI and clears stored setup flags", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const res = await localAiPost(jsonRequest({ action: "disable" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockReadLlamaCppPid).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(mockClearLlamaCppPid).toHaveBeenCalledWith("/tmp/llamacpp.pid");
    expect(mockRestartGateway).toHaveBeenCalled();
    expect(mockSetMany).toHaveBeenCalledWith({
      local_ai_configured: false,
      local_ai_provider: undefined,
      local_ai_model: undefined,
      local_ai_configured_at: undefined,
    });

    killSpy.mockRestore();
  });
});
