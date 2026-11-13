import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermes under the local-only AI lock (TASK-2501): ClawBox AI is not linked in
 * as Hermes' provider and no cloud provider key is added while the lock is on.
 * The pick itself (`/setup-api/hermes/models`) is pinned beside its background
 * save in models-background-save.test.ts.
 */

const lockState = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/ai-cloud-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-cloud-lock")>()),
  isCloudAiLocked: async () => lockState.on,
}));

const runHermesCli = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli }));
const applyClawaiToHermes = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-clawai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-clawai")>()),
  applyClawaiToHermes,
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
// What Hermes' config.yaml says `tts.provider` is, and the dashboard that speaks.
const voice = vi.hoisted(() => ({ provider: "", localRegistered: true, command: "/opt/clawbox-tts.sh --text-file={input_path} -- {output_path}" }));
vi.mock("@/lib/hermes-config-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-config-cache")>()),
  hermesConfigGet: vi.fn(async () => ""),
  hermesConfigGetMany: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k,
    k === "tts.provider" ? voice.provider
      : k === "tts.providers.clawbox-local.type" ? (voice.localRegistered ? "command" : "")
        : k === "tts.providers.clawbox-local.command" ? (voice.localRegistered ? voice.command : "")
          : ""]))),
  hermesConfigReadPending: () => false,
  invalidateHermesConfigCache: vi.fn(),
}));
const dashboardFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-dashboard-auth", () => ({ dashboardFetch }));
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: async (key: string) => store.get(key),
  getKnown: async (key: string) => ({ value: store.get(key), known: true }),
  set: async (key: string, value: unknown) => { store.set(key, value); },
  setMany: vi.fn(async () => undefined),
  resolveConfigRoot: () => "/tmp",
}));

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  lockState.on = false;
  store.clear();
  store.set("clawai_token", "claw_device_token");
  runHermesCli.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  applyClawaiToHermes.mockReset();
  voice.provider = "";
  voice.localRegistered = true;
  voice.command = "/opt/clawbox-tts.sh --text-file={input_path} -- {output_path}";
  dashboardFetch.mockReset().mockResolvedValue(new Response("{}", { status: 500 }));
});

describe("POST /setup-api/hermes/clawai", () => {
  it("does not make ClawBox AI Hermes' provider while the lock is on", async () => {
    lockState.on = true;
    const { POST } = await import("@/app/setup-api/hermes/clawai/route");
    const res = await POST(post("/setup-api/hermes/clawai", { tier: "flash" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "cloud_ai_locked" });
    expect(applyClawaiToHermes).not.toHaveBeenCalled();
    expect(runHermesCli).not.toHaveBeenCalled();
  });

  it("keeps the lock's code when the lock goes on while the link is being written", async () => {
    const { CloudAiLockedError } = await import("@/lib/ai-cloud-lock");
    applyClawaiToHermes.mockRejectedValue(new CloudAiLockedError());
    const { POST } = await import("@/app/setup-api/hermes/clawai/route");
    const res = await POST(post("/setup-api/hermes/clawai", { tier: "flash" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "cloud_ai_locked" });
  });

  it("refuses the background link the same way, before any task starts", async () => {
    lockState.on = true;
    const { POST } = await import("@/app/setup-api/hermes/clawai/route");
    const res = await POST(post("/setup-api/hermes/clawai", { background: true }));
    expect(res.status).toBe(409);
    expect(applyClawaiToHermes).not.toHaveBeenCalled();
  });

  it("links ClawBox AI into Hermes as before once the lock is off", async () => {
    applyClawaiToHermes.mockResolvedValue({ provider: "clawai", model: "deepseek-v4-flash", tier: "flash", explicitPickKept: false });
    const { POST } = await import("@/app/setup-api/hermes/clawai/route");
    await POST(post("/setup-api/hermes/clawai", { tier: "flash" }));
    expect(applyClawaiToHermes).toHaveBeenCalledWith("claw_device_token", "flash", expect.anything());
  });
});

describe("POST /setup-api/hermes/provider-key", () => {
  it("adds no cloud provider key while the lock is on", async () => {
    lockState.on = true;
    const { POST } = await import("@/app/setup-api/hermes/provider-key/route");
    const res = await POST(post("/setup-api/hermes/provider-key", { provider: "anthropic", apiKey: "sk-ant-0123456789" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "cloud_ai_locked" });
    expect(runHermesCli).not.toHaveBeenCalled();
  });

  it("hands the key to Hermes as before once the lock is off", async () => {
    const { POST } = await import("@/app/setup-api/hermes/provider-key/route");
    await POST(post("/setup-api/hermes/provider-key", { provider: "anthropic", apiKey: "sk-ant-0123456789" }));
    expect(runHermesCli).toHaveBeenCalled();
    expect(JSON.stringify(runHermesCli.mock.calls[0])).toContain("anthropic");
  });
});

describe("Hermes' spoken replies", () => {
  it("never selects the cloud voice while the lock is on", async () => {
    lockState.on = true;
    const { selectHermesEngine, HermesTtsWriteError } = await import("@/lib/hermes-tts");
    await expect(selectHermesEngine("cloud", "claw_device_token")).rejects.toBeInstanceOf(HermesTtsWriteError);
    expect(runHermesCli).not.toHaveBeenCalled();
  });

  it("sends no reply to a cloud voice Hermes is still set to", async () => {
    lockState.on = true;
    voice.provider = "openai";
    const { speakWithHermes } = await import("@/lib/hermes-tts");
    expect(await speakWithHermes("Good morning.")).toMatchObject({ ok: false, code: "cloud_ai_locked", status: 409 });
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("fails closed when Hermes' voice cannot be read", async () => {
    lockState.on = true;
    voice.provider = "";
    const { speakWithHermes } = await import("@/lib/hermes-tts");
    expect(await speakWithHermes("Good morning.")).toMatchObject({ ok: false, code: "cloud_ai_locked" });
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("still speaks with the box's own voice", async () => {
    lockState.on = true;
    voice.provider = "clawbox-local";
    const { speakWithHermes } = await import("@/lib/hermes-tts");
    await speakWithHermes("Good morning.");
    expect(dashboardFetch).toHaveBeenCalledWith("/api/audio/speak", expect.objectContaining({ method: "POST" }));
  });

  it("does not take a `clawbox-local` with no command behind it for the box's voice", async () => {
    lockState.on = true;
    voice.provider = "clawbox-local";
    voice.localRegistered = false;
    const { speakWithHermes } = await import("@/lib/hermes-tts");
    expect(await speakWithHermes("Good morning.")).toMatchObject({ ok: false, code: "cloud_ai_locked" });
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("does not take a `clawbox-local` of type command whose command is empty", async () => {
    lockState.on = true;
    voice.provider = "clawbox-local";
    voice.command = "";
    const { speakWithHermes } = await import("@/lib/hermes-tts");
    expect(await speakWithHermes("Good morning.")).toMatchObject({ ok: false, code: "cloud_ai_locked" });
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("does not take a name that merely looks local for the box's voice", async () => {
    lockState.on = true;
    for (const name of ["not-local", "piper-local", "kokoro"]) {
      voice.provider = name;
      const { speakWithHermes } = await import("@/lib/hermes-tts");
      expect(await speakWithHermes("Good morning."), name).toMatchObject({ ok: false, code: "cloud_ai_locked" });
    }
    expect(dashboardFetch).not.toHaveBeenCalled();
  });

  it("asks Hermes as before once the lock is off", async () => {
    voice.provider = "openai";
    const { speakWithHermes } = await import("@/lib/hermes-tts");
    await speakWithHermes("Good morning.");
    expect(dashboardFetch).toHaveBeenCalledTimes(1);
  });
});
