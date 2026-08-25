// The two base URLs the local-AI proxy hands out, asserted against the REAL
// builders rather than a mock.
//
// This file exists because the mock is where the bug lived. `hermes-local-ai`'s
// suite stubbed `getLocalAiProxyBaseUrl` as `.../local-ai/<provider>/v1` for
// BOTH providers, so it happily proved that Hermes was pointed at
// `.../local-ai/ollama/v1` — while the real builder returned the bare
// `.../local-ai/ollama`, and every Ollama-backed chat turn on a Hermes box
// 404'd upstream (TASK-448). A green suite over a fabricated URL is worse than
// no suite, so the shape of these strings is pinned here where nothing is
// stubbed.
//
// Measured on the bench device (Ollama 0.32.9):
//   POST /chat/completions      → 404 "404 page not found"
//   POST /v1/chat/completions   → OpenAI error shape (reached the API)
//   GET  /models → 404          GET /v1/models → 200

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// local-ai-runtime pulls the server lifecycle in at import time; none of it is
// exercised here, and spawning it in a unit test would be absurd.
vi.mock("@/instrumentation-node", () => ({
  startLlamaCppServer: vi.fn(),
  stopLlamaCppServer: vi.fn(),
}));
vi.mock("@/lib/process-match", () => ({ terminateByArgv: vi.fn() }));
vi.mock("child_process", () => ({ execFile: vi.fn() }));

import { getLocalAiOpenAiBaseUrl, getLocalAiProxyBaseUrl } from "@/lib/local-ai-runtime";

describe("local AI base URLs", () => {
  const savedRoot = process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL;

  beforeEach(() => {
    delete process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL;
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL;
    else process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL = savedRoot;
  });

  it("gives OpenClaw the bare Ollama proxy root for the NATIVE api", () => {
    // OpenClaw registers Ollama with `api: "ollama"` and speaks /api/chat from
    // this root. Appending /v1 here would break that adapter instead.
    expect(getLocalAiProxyBaseUrl("ollama")).toBe("http://127.0.0.1/setup-api/local-ai/ollama");
  });

  it("gives an OpenAI-compatible client the /v1 Ollama root", () => {
    expect(getLocalAiOpenAiBaseUrl("ollama")).toBe("http://127.0.0.1/setup-api/local-ai/ollama/v1");
  });

  it("keeps llama.cpp on one URL — its proxy route already mounts /v1", () => {
    const proxy = getLocalAiProxyBaseUrl("llamacpp");
    expect(proxy).toBe("http://127.0.0.1/setup-api/local-ai/llamacpp/v1");
    expect(getLocalAiOpenAiBaseUrl("llamacpp")).toBe(proxy);
  });

  it("never doubles the version segment", () => {
    for (const provider of ["llamacpp", "ollama"] as const) {
      expect(getLocalAiOpenAiBaseUrl(provider)).not.toContain("/v1/v1");
      expect(getLocalAiOpenAiBaseUrl(provider).endsWith("/v1")).toBe(true);
    }
  });

  it("honours a relocated proxy root", () => {
    process.env.CLAWBOX_LOCAL_AI_PROXY_BASE_URL = "http://10.42.0.1:8080/";
    expect(getLocalAiOpenAiBaseUrl("ollama")).toBe(
      "http://10.42.0.1:8080/setup-api/local-ai/ollama/v1",
    );
  });
});
