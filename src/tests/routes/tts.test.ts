import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-434 — /setup-api/tts.
 *
 * The route's job beyond reporting is to REFUSE. A ClawBox carries a `claw_`
 * portal token in `models.providers.openai` and ClawBox AI serves no speech, so
 * "ClawBox cloud" is an option the box cannot honour today; writing it into
 * `messages.tts.provider` anyway would leave a customer with a voice setting
 * that silently never speaks. That has to hold at the API, not only in the UI.
 */

const readConfigMock = vi.fn();
const configSetMock = vi.fn();
const ttsInventoryMock = vi.fn();
const spawnMock = vi.fn();
const accessMock = vi.fn();
const readStateMock = vi.fn();
const writeStateMock = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: (...a: unknown[]) => readConfigMock(...a),
  runOpenclawConfigSet: (...a: unknown[]) => configSetMock(...a),
  findOpenclawBin: () => "/usr/local/bin/openclaw",
  openclawIsAbsent: () => false,
}));

vi.mock("@/lib/local-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-models")>();
  return { ...actual, buildTtsInventory: (...a: unknown[]) => ttsInventoryMock(...a) };
});

vi.mock("@/lib/voice-output-store", () => ({
  readVoiceState: (...a: unknown[]) => readStateMock(...a),
  writeVoiceState: (...a: unknown[]) => writeStateMock(...a),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: (...a: unknown[]) => spawnMock(...a) };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    promises: { ...actual.promises, access: (...a: unknown[]) => accessMock(...a), unlink: async () => {} },
  };
});

const LOCAL = "tts-local-cli";

function config(over: Record<string, unknown> = {}) {
  return {
    messages: { tts: { provider: LOCAL, providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" } } } },
    models: { providers: { openai: { apiKey: "claw_84d065b" } } },
    ...over,
  };
}

const piperInstalled = [{
  id: "piper", name: "Piper", kind: "tts", runtime: "On-demand binary",
  installed: true, enabled: null, running: "on-demand", diskBytes: 1, memoryBytes: null,
  control: "none", detail: "Speaks on demand.",
}];

/** A fake `openclaw capability tts convert --json` that prints `stdout` and exits `code`. */
function cliEmits(stdout: string, code = 0) {
  return () => {
    const handlers: Record<string, ((arg: unknown) => void)[]> = {};
    const stream = (chunk: string) => ({
      on: (_e: string, cb: (b: Buffer) => void) => { if (chunk) setTimeout(() => cb(Buffer.from(chunk)), 0); },
    });
    setTimeout(() => (handlers.close ?? []).forEach(cb => cb(code)), 5);
    return {
      stdout: stream(stdout),
      stderr: stream(""),
      kill: () => {},
      on: (event: string, cb: (arg: unknown) => void) => {
        (handlers[event] ??= []).push(cb);
      },
    };
  };
}

async function route() {
  return await import("@/app/setup-api/tts/route");
}

function post(body: unknown) {
  return new Request("http://box/setup-api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  readConfigMock.mockReset().mockResolvedValue(config());
  configSetMock.mockReset().mockResolvedValue(undefined);
  ttsInventoryMock.mockReset().mockResolvedValue(piperInstalled);
  spawnMock.mockReset();
  accessMock.mockReset().mockResolvedValue(undefined);
  readStateMock.mockReset().mockResolvedValue({ choice: "auto", engineChecks: {}, lastCheck: null });
  writeStateMock.mockReset().mockResolvedValue(undefined);
});

// Fake timers installed by one test must not survive a failing assertion: the
// tests after it drive `cliEmits`, whose close event is a setTimeout, and would
// hang and report a second, misleading failure.
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /setup-api/tts", () => {
  it("reports the engines and never caches them", async () => {
    const { GET } = await route();
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.engines.map((e: { id: string }) => e.id)).toEqual(["local", "cloud"]);
    expect(body.activeProviderId).toBe(LOCAL);
  });

  it("never spawns the openclaw CLI just to render the panel", async () => {
    const { GET } = await route();
    await GET();
    // The CLI costs 8-12s of cold start on an Orin. A panel that pays it on
    // open reads as a broken box.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("calls the local voice unusable when its command is gone, however healthy the voices look", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT"));
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.engines.find((e: { id: string }) => e.id === "local").usable).toBe(false);
  });
});

describe("POST /setup-api/tts — select", () => {
  it("writes the provider the choice resolves to", async () => {
    readConfigMock.mockResolvedValue(config({
      messages: { tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" } } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["messages.tts.provider", LOCAL]);
    expect(writeStateMock.mock.calls[0][0].choice).toBe("local");
  });

  it("refuses a cloud voice the box cannot use, and changes nothing", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "cloud" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "That voice is not available on this box." });
    expect(configSetMock).not.toHaveBeenCalled();
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("selects the cloud voice once the box really has one", async () => {
    readConfigMock.mockResolvedValue(config({
      models: { providers: { openai: { apiKey: "sk-live-abc" } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "cloud" }));
    expect(res.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["messages.tts.provider", "openai"]);
  });

  it("does not rewrite the config when the box is already on that provider", async () => {
    const { POST } = await route();
    await POST(post({ action: "select", choice: "local" }));
    expect(configSetMock).not.toHaveBeenCalled();
    expect(writeStateMock.mock.calls[0][0].choice).toBe("local");
  });

  it("keeps the customer's choice out of the file when the config write failed", async () => {
    configSetMock.mockRejectedValue(new Error("ConfigMutationConflictError"));
    readConfigMock.mockResolvedValue(config({
      messages: { tts: { provider: "openai", providers: { [LOCAL]: { command: "/opt/clawbox-tts.sh" } } } },
    }));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(500);
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("rejects an invented choice", async () => {
    const { POST } = await route();
    expect((await POST(post({ action: "select", choice: "cheapest" }))).status).toBe(400);
    expect((await POST(post({ action: "teleport" }))).status).toBe(400);
  });
});

describe("POST /setup-api/tts — check", () => {
  it("records which voice actually spoke", async () => {
    spawnMock.mockImplementation(cliEmits(JSON.stringify({
      ok: true,
      provider: LOCAL,
      attempts: [{ provider: LOCAL, outcome: "success", latencyMs: 14893 }],
    })));
    const { POST } = await route();
    const body = await (await POST(post({ action: "check" }))).json();
    // The answer carries the run that just happened, rather than a status
    // re-read from disk that would cost the box a third probe.
    expect(body.lastCheck.servedEngine).toBe("local");
    expect(body.engines.find((e: { id: string }) => e.id === "local").proven).toBe(true);
    const saved = writeStateMock.mock.calls[0][0];
    expect(saved.lastCheck.ok).toBe(true);
    expect(saved.lastCheck.servedEngine).toBe("local");
    expect(saved.engineChecks.local.ok).toBe(true);
  });

  it("records the failed cloud attempt and the local voice that spoke after it", async () => {
    spawnMock.mockImplementation(cliEmits(JSON.stringify({
      ok: true,
      provider: LOCAL,
      attempts: [
        { provider: "openai", outcome: "error", error: "rejected by the voice service" },
        { provider: LOCAL, outcome: "success", latencyMs: 1200 },
      ],
    })));
    const { POST } = await route();
    await POST(post({ action: "check" }));
    const saved = writeStateMock.mock.calls[0][0];
    expect(saved.engineChecks.cloud.ok).toBe(false);
    expect(saved.engineChecks.local.ok).toBe(true);
  });

  it("records a failure when the CLI produced no usable output at all", async () => {
    spawnMock.mockImplementation(cliEmits("Error: TTS conversion failed", 1));
    const { POST } = await route();
    const res = await POST(post({ action: "check" }));
    expect(res.status).toBe(200);
    expect(writeStateMock.mock.calls[0][0].lastCheck.ok).toBe(false);
  });


  it("records a failure when the openclaw binary cannot be started at all", async () => {
    spawnMock.mockImplementation(() => {
      const handlers: Record<string, ((arg: unknown) => void)[]> = {};
      setTimeout(() => (handlers.error ?? []).forEach(cb => cb(new Error("spawn ENOENT"))), 0);
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        kill: () => {},
        on: (event: string, cb: (arg: unknown) => void) => { (handlers[event] ??= []).push(cb); },
      };
    });
    const { POST } = await route();
    const res = await POST(post({ action: "check" }));
    // A box with no CLI must record "no voice could speak", not throw a 500 out
    // of the handler and leave the panel with the previous success on screen.
    expect(res.status).toBe(200);
    expect(writeStateMock.mock.calls[0][0].lastCheck.ok).toBe(false);
  });

  it("kills a conversion that never finishes and records that", async () => {
    vi.useFakeTimers();
    let killed = false;
    spawnMock.mockImplementation(() => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      kill: () => { killed = true; },
      on: () => {},                       // never closes, never errors
    }));
    const { POST } = await route();
    const pending = POST(post({ action: "check" }));
    await vi.advanceTimersByTimeAsync(121_000);
    const res = await pending;
    expect(killed).toBe(true);
    expect(res.status).toBe(200);
    const saved = writeStateMock.mock.calls[0][0].lastCheck;
    expect(saved.ok).toBe(false);
    expect(saved.message).toContain("took too long");
  });

  it("joins a check already in flight instead of starting a second synthesis", async () => {
    // Two of these at once means two engines competing for the same GPU on an
    // 8 GB board, and the client-side busy flag cannot stop a second tab.
    spawnMock.mockImplementation(cliEmits(JSON.stringify({
      ok: true, provider: LOCAL, attempts: [{ provider: LOCAL, outcome: "success", latencyMs: 900 }],
    })));
    const { POST } = await route();
    const [a, b] = await Promise.all([POST(post({ action: "check" })), POST(post({ action: "check" }))]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("reads the state after the run, so a choice made during it survives", async () => {
    // The handler must not hold a snapshot across its own 90 seconds: a
    // customer who picks a different voice while the check runs would
    // otherwise have that choice written back over by the stale copy.
    const order: string[] = [];
    spawnMock.mockImplementation((...args: unknown[]) => {
      order.push("spawn");
      return cliEmits(JSON.stringify({
        ok: true, provider: LOCAL, attempts: [{ provider: LOCAL, outcome: "success", latencyMs: 900 }],
      }))(...(args as []));
    });
    readStateMock.mockImplementation(async () => {
      order.push("read");
      // What the customer picked mid-run.
      return { choice: "local", engineChecks: {}, lastCheck: null };
    });
    const { POST } = await route();
    await POST(post({ action: "check" }));
    expect(order.indexOf("spawn")).toBeLessThan(order.indexOf("read"));
    expect(writeStateMock.mock.calls[0][0].choice).toBe("local");
  });

  it("asks the CLI for the real chain rather than pinning one provider", async () => {
    spawnMock.mockImplementation(cliEmits(JSON.stringify({ ok: true, attempts: [{ provider: LOCAL, outcome: "success" }] })));
    const { POST } = await route();
    await POST(post({ action: "check" }));
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.slice(0, 3)).toEqual(["capability", "tts", "convert"]);
    // No --model: the question is what happens when THIS box speaks, and the
    // answer includes the fallback.
    expect(args).not.toContain("--model");
    expect(args).toContain("--json");
  });
});

describe("POST /setup-api/tts — failure boundary", () => {
  it("answers with a message the panel can show when the box cannot be written to", async () => {
    // A read-only data dir or a full disk must not surface as a framework error
    // page: the panel would fall back to its own generic line and the box would
    // log nothing worth reading.
    writeStateMock.mockRejectedValue(new Error("EROFS: read-only file system"));
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not change the voice on this box." });
  });

  it("lets the customer ask again for an engine whose last check failed", async () => {
    readConfigMock.mockResolvedValue(config({
      models: { providers: { openai: { apiKey: "sk-live-abc" } } },
    }));
    readStateMock.mockResolvedValue({
      choice: "auto",
      engineChecks: { cloud: { providerId: "openai", engine: "cloud", ok: false, message: "rejected", latencyMs: null, at: 1 } },
      lastCheck: null,
    });
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "cloud" }));
    expect(res.status).toBe(200);
    expect(configSetMock).toHaveBeenCalledWith(["messages.tts.provider", "openai"]);
    // And the box stops reporting the old failure about a choice just re-made.
    expect(writeStateMock.mock.calls[0][0].engineChecks.cloud).toBeUndefined();
  });
});
