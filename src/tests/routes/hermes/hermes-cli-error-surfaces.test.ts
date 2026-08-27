import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * A `hermes` CLI crash must never render as CPython source in a customer panel.
 *
 * PR #515 removed the traceback frames from the CHAT bubble, but the chat route
 * is not the only surface that renders `hermes` stderr at a person. The AI
 * provider panel in Settings has two more, one call apart:
 *
 *   POST /setup-api/hermes/provider-key  → `hermes auth add`
 *   POST /setup-api/hermes/models        → `hermes config set`
 *
 * Both echoed `r.stderr` verbatim into their JSON `error`, and
 * HermesProviderConfig drops that string straight into the save banner. So the
 * exact input #515 exists to clean — a traceback naming `/home/clawbox/.hermes`
 * — reached the screen through the sibling routes untouched.
 *
 * Captured shape (the crash is real; the paths are the on-device ones):
 *
 *   Traceback (most recent call last):
 *     File "/home/clawbox/.hermes/config.py", line 118, in set_key
 *       raise RuntimeError("config store is locked by another writer")
 *   RuntimeError: config store is locked by another writer
 *
 * The summary line is what a person can act on. Everything above it is noise
 * that also leaks the install layout.
 */

const TRACEBACK = [
  "session_id: 20260827_101500_ab12cd",
  "Traceback (most recent call last):",
  '  File "/home/clawbox/.hermes/config.py", line 118, in set_key',
  '    raise RuntimeError("config store is locked by another writer")',
  '  File "/home/clawbox/.local/lib/python3.11/site-packages/hermes/cli.py", line 42, in main',
  "    return _dispatch(argv)",
  "RuntimeError: config store is locked by another writer",
].join("\n");

/** Nothing on any of these surfaces may carry Python internals or a device path. */
function expectNoPythonInternals(message: string) {
  expect(message).not.toMatch(/Traceback/);
  expect(message).not.toMatch(/File "/);
  expect(message).not.toMatch(/\.hermes\//);
  expect(message).not.toMatch(/\/home\//);
  expect(message).not.toMatch(/raise RuntimeError/);
  expect(message).not.toMatch(/site-packages/);
}

const runHermesCliMock = vi.fn();
const getModelOptionsMock = vi.fn();

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));

vi.mock("@/lib/hermes-model-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-model-options")>();
  return { ...actual, getModelOptions: getModelOptionsMock, invalidateModelOptions: vi.fn() };
});

vi.mock("@/lib/hermes-local-ai", () => ({
  reconcileLocalAiWithHermes: vi.fn(async () => {}),
}));

const PAYLOAD = {
  providers: [{
    id: "anthropic",
    name: "Anthropic",
    authenticated: true,
    verified: null,
    isUserDefined: false,
    source: "dashboard",
    total: 2,
    models: [
      { id: "anthropic/claude-opus-5", description: "" },
      { id: "anthropic/claude-fable-5", description: "" },
    ],
  }],
  current: { provider: "anthropic", model: "anthropic/claude-opus-5" },
  reasoning: "medium",
  fetchedAt: Date.now(),
  source: "dashboard" as const,
  stale: false,
};

let errorLog: MockInstance<typeof console.error>;

beforeEach(() => {
  runHermesCliMock.mockReset();
  getModelOptionsMock.mockReset();
  getModelOptionsMock.mockResolvedValue(structuredClone(PAYLOAD));
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  errorLog.mockRestore();
});

describe("POST /setup-api/hermes/models — a crashing `hermes config set`", () => {
  async function save(): Promise<{ status: number; error: string }> {
    const { POST } = await import("@/app/setup-api/hermes/models/route");
    const res = await POST(new Request("http://localhost/setup-api/hermes/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "anthropic/claude-fable-5" }),
    }));
    const body = await res.json();
    return { status: res.status, error: String(body.error ?? "") };
  }

  it("does not put the traceback in the save banner", async () => {
    runHermesCliMock.mockResolvedValue({ code: 1, stdout: "", stderr: TRACEBACK });

    const { status, error } = await save();

    expect(status).toBe(502);
    expectNoPythonInternals(error);
  });

  it("still names the cause the exception summary gives", async () => {
    runHermesCliMock.mockResolvedValue({ code: 1, stdout: "", stderr: TRACEBACK });

    const { error } = await save();

    expect(error).toBe("RuntimeError: config store is locked by another writer");
  });

  it("keeps the raw stderr for the journal, where a path is a diagnosis", async () => {
    runHermesCliMock.mockResolvedValue({ code: 1, stdout: "", stderr: TRACEBACK });

    await save();

    expect(errorLog).toHaveBeenCalled();
    const logged = errorLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/config\.py/);
  });

  it("falls back to fixed text when stderr carries nothing usable", async () => {
    runHermesCliMock.mockResolvedValue({ code: 1, stdout: "", stderr: "session_id: 20260827_101500_ab12cd" });

    const { error } = await save();

    expect(error).toBe("Failed to set model.default");
  });
});

describe("POST /setup-api/hermes/provider-key — a crashing `hermes auth add`", () => {
  const API_KEY = "sk-or-v1-0123456789abcdef";

  async function saveKey(stderr: string): Promise<{ status: number; error: string }> {
    runHermesCliMock.mockResolvedValue({ code: 1, stdout: "", stderr });
    const { POST } = await import("@/app/setup-api/hermes/provider-key/route");
    const res = await POST(new Request("http://localhost/setup-api/hermes/provider-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", apiKey: API_KEY }),
    }));
    const body = await res.json();
    return { status: res.status, error: String(body.error ?? "") };
  }

  it("does not put the traceback in the save banner", async () => {
    const { status, error } = await saveKey(TRACEBACK);

    expect(status).toBe(502);
    expectNoPythonInternals(error);
    expect(error).toBe("RuntimeError: config store is locked by another writer");
  });

  it("never echoes the pasted key back, even when the CLI does", async () => {
    // argparse prints the offending argv on a usage error, and that argv holds
    // the secret. The route's own comment already promised this; nothing
    // enforced it.
    const { error } = await saveKey(
      `hermes auth add: error: unrecognized arguments: --api-key ${API_KEY}`,
    );

    expect(error).not.toContain(API_KEY);
  });

  it("falls back to fixed text when stderr carries nothing usable", async () => {
    const { error } = await saveKey("");

    expect(error).toBe("Failed to save API key");
  });
});
