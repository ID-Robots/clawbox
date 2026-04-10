import { beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { NextResponse } from "next/server";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock("@/app/setup-api/ai-models/configure/route", () => ({
  POST: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const mockFs = vi.mocked(fsp);
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

describe("POST /setup-api/llamacpp/install", () => {
  let installPost: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const configureMod = await import("@/app/setup-api/ai-models/configure/route");
    mockConfigureAiModel = vi.mocked(configureMod.POST);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue();
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    mockFs.stat.mockRejectedValue(new Error("ENOENT"));
    mockConfigureAiModel.mockResolvedValue(
      NextResponse.json({ success: true })
    );
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
    expect(text).toContain("Starting llama.cpp");
    expect(text).toContain("installed, running, and configured");
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
});
