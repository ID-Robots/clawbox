import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A child that cannot be STARTED is not a turn that failed — and its errno
 * message is not fit for a chat bubble.
 *
 * Node formats every spawn failure the same way, with the full binary path in
 * the text:
 *
 *   spawn /home/clawbox/.local/bin/hermes ENOENT
 *   spawn /home/clawbox/.local/bin/hermes EACCES
 *   spawn /home/clawbox/.local/bin/hermes EAGAIN
 *
 * The route special-cased ENOENT into "Hermes is not installed on this device"
 * PRECISELY so that path would not reach the client, then fell through to the
 * raw error for every other errno. EACCES (a lost execute bit after a partial
 * update) and EAGAIN (fork refused under memory pressure — a realistic state on
 * a loaded Jetson) therefore leaked the install layout into the bubble, into
 * the durable transcript, and into the 502 body. None of #515's cleaning
 * applies to these: they never pass through `usefulLines`.
 */
vi.mock("child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("@/lib/harness", () => ({ HERMES_BIN: "/home/clawbox/.local/bin/hermes" }));
vi.mock("@/lib/hermes-model-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-model-options")>();
  return { ...actual, getModelOptions: vi.fn() };
});
vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/tmp/clawbox-chat-spawn-errno-test",
  get: vi.fn(),
}));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: vi.fn(async () => {}) }));

import { spawn } from "child_process";
import { getModelOptions } from "@/lib/hermes-model-options";
import { appendTranscript } from "@/lib/harness/transcript-store";

const mockSpawn = vi.mocked(spawn);
const mockGetModelOptions = vi.mocked(getModelOptions);
const mockAppendTranscript = vi.mocked(appendTranscript);

/** A child that never starts: the `error` event fires and nothing else does. */
function unstartableHermes(code: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    const e = new Error(`spawn /home/clawbox/.local/bin/hermes ${code}`) as NodeJS.ErrnoException;
    e.code = code;
    e.syscall = "spawn /home/clawbox/.local/bin/hermes";
    child.emit("error", e);
  });
  return child;
}

function payload(provider: string, model: string) {
  return {
    providers: [{ id: provider, name: provider, authenticated: true, models: [{ id: model }], total: 1, source: "live", isUserDefined: false }],
    current: { provider, model },
    reasoning: "medium",
    fetchedAt: Date.now(),
    source: "live",
    stale: false,
  };
}

async function turn(): Promise<{ status: number; error: string }> {
  const { POST } = await import("@/app/setup-api/hermes/chat/route");
  const res = await POST(new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi", provider: "anthropic", model: "anthropic/claude-opus-5" }),
  }));
  const body = await res.json().catch(() => ({}));
  return { status: res.status, error: String((body as { error?: unknown }).error ?? "") };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockGetModelOptions.mockResolvedValue(payload("anthropic", "anthropic/claude-opus-5") as never);
});

describe("/setup-api/hermes/chat — a child that cannot be started", () => {
  it.each([
    ["ENOENT", /not installed/i],
    ["EACCES", /permission/i],
    ["EPERM", /permission/i],
    ["EAGAIN", /resources/i],
    ["ENOMEM", /resources/i],
    ["EMFILE", /could not be started/i],
    ["ELIBBAD", /could not be started/i],
  ])("reports %s without the binary path", async (code, expected) => {
    mockSpawn.mockImplementation(() => unstartableHermes(code) as never);

    const { status, error } = await turn();

    expect(status).toBe(502);
    expect(error).not.toContain("/home/");
    expect(error).not.toContain("spawn ");
    expect(error).toMatch(expected);
  });

  it("writes the same clean text into the durable transcript", async () => {
    mockSpawn.mockImplementation(() => unstartableHermes("EACCES") as never);

    await turn();

    const written = mockAppendTranscript.mock.calls
      .map((c) => String((c[0] as { text?: unknown })?.text ?? ""))
      .join("\n");
    expect(written).toMatch(/Error:/);
    expect(written).not.toContain("/home/");
  });
});
