import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /setup-api/stt — which engine hears this box first.
 *
 * Beyond reporting, the route's job is to keep openclaw.json's audio chain in
 * step with the owner's preference WITHOUT spending a CLI cold start and a
 * gateway restart on a selection that changes nothing, and to keep the agent
 * — which holds a credential middleware accepts — from making the choice.
 */

const readConfigMock = vi.fn();
const batchMock = vi.fn();
const restartMock = vi.fn();
const openclawAbsentMock = vi.fn();
const ownerSessionMock = vi.fn();
const localInstalledMock = vi.fn();
const tokenMock = vi.fn();
const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: (...a: unknown[]) => readConfigMock(...a),
  runOpenclawConfigSetBatch: (...a: unknown[]) => batchMock(...a),
  restartGateway: (...a: unknown[]) => restartMock(...a),
  openclawIsAbsent: () => openclawAbsentMock(),
  // A REAL class: the route narrows on `instanceof GatewayNotReadyError` to
  // tell a gateway that is still coming back from one that refused, and
  // `instanceof undefined` throws a TypeError the first time it rejects.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
}));
vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: (...a: unknown[]) => ownerSessionMock(...a),
}));
vi.mock("@/lib/stt-local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stt-local")>();
  return { ...actual, localSttInstalled: (...a: unknown[]) => localInstalledMock(...a) };
});
vi.mock("@/lib/harness/credentials", () => ({
  CLAWBOX_AI_PROXY_URL: "https://clawbox.com/api/ai",
  resolveClawaiToken: (...a: unknown[]) => tokenMock(...a),
}));
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => { store.set(key, value); },
}));

const PROXY = "https://clawbox.com/api/ai";
const CLOUD = { provider: "openai", model: "gpt-4o-mini-transcribe", capabilities: ["audio"] };
const INSTALLED = { installed: true, detail: "faster-whisper, kept warm by whisper-server." };
const MISSING = { installed: false, detail: "The on-box transcriber is not installed." };

async function route() {
  return await import("@/app/setup-api/stt/route");
}

function post(body: unknown) {
  return new Request("http://box/setup-api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The CLI row the route writes for this box, read back from what it wrote. */
function localRow(): Record<string, unknown> {
  const models = JSON.parse(batchMock.mock.calls[0][0][1][1]) as Record<string, unknown>[];
  return models.find((m) => m.type === "cli")!;
}

beforeEach(() => {
  vi.resetModules();
  store.clear();
  readConfigMock.mockReset().mockResolvedValue({});
  batchMock.mockReset().mockResolvedValue(undefined);
  restartMock.mockReset().mockResolvedValue(undefined);
  openclawAbsentMock.mockReset().mockReturnValue(false);
  ownerSessionMock.mockReset().mockResolvedValue(true);
  localInstalledMock.mockReset().mockResolvedValue(INSTALLED);
  tokenMock.mockReset().mockResolvedValue("claw_token");
});

describe("GET /setup-api/stt", () => {
  it("reports both engines, the chain, and never caches", async () => {
    const { GET } = await route();
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      primary: "cloud",
      engines: {
        cloud: { configured: true, label: "ClawBox cloud" },
        local: { installed: true, label: "On this box", detail: INSTALLED.detail },
      },
      chain: ["cloud", "local"],
      channels: { supportedOnEdition: true },
    });
  });

  it("never spawns the openclaw CLI or bounces the gateway just to render the panel", async () => {
    const { GET } = await route();
    await GET();
    expect(batchMock).not.toHaveBeenCalled();
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("shows an unlinked cloud as unconfigured and leaves it out of the chain", async () => {
    tokenMock.mockResolvedValue(null);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.engines.cloud.configured).toBe(false);
    expect(body.chain).toEqual(["local"]);
  });

  it("shows a missing on-box engine as such and leaves it out of the chain", async () => {
    localInstalledMock.mockResolvedValue(MISSING);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.engines.local).toEqual({ installed: false, label: "On this box", detail: MISSING.detail });
    expect(body.chain).toEqual(["cloud"]);
  });

  it("follows the stored preference", async () => {
    store.set("stt_primary", "local");
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.primary).toBe("local");
    expect(body.chain).toEqual(["local", "cloud"]);
  });

  it("still answers on the Hermes edition, with only the channel half marked unsupported", async () => {
    // The chat microphone works on every edition; only channel voice notes go
    // through a gateway this SKU does not have.
    openclawAbsentMock.mockReturnValue(true);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.primary).toBe("cloud");
    expect(body.chain).toEqual(["cloud", "local"]);
    expect(body.channels.supportedOnEdition).toBe(false);
    expect(body.channels.error).toMatch(/not part of this edition/i);
  });
});

describe("POST /setup-api/stt — who may", () => {
  it("refuses without an owner browser session, whatever else the caller holds", async () => {
    ownerSessionMock.mockResolvedValue(false);
    const { POST } = await route();
    const res = await POST(post({ primary: "local" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(store.size).toBe(0);
    expect(batchMock).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/stt — validation", () => {
  it("rejects an invented engine and a body it cannot read", async () => {
    const { POST } = await route();
    expect((await POST(post({ primary: "cheapest" }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post("not json"))).status).toBe(400);
    expect(store.size).toBe(0);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("refuses to put an engine first that is not installed, and changes nothing", async () => {
    localInstalledMock.mockResolvedValue(MISSING);
    const { POST } = await route();
    const res = await POST(post({ primary: "local" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(MISSING.detail);
    expect(store.size).toBe(0);
    expect(batchMock).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/stt — the write", () => {
  it("writes the endpoint and the models in the chosen order in one batch, restarts, and answers the status", async () => {
    const { POST } = await route();
    const res = await POST(post({ primary: "local" }));
    expect(res.status).toBe(200);

    expect(batchMock).toHaveBeenCalledTimes(1);
    const [ops] = batchMock.mock.calls[0];
    expect(ops[0]).toEqual(["tools.media.audio.baseUrl", JSON.stringify(PROXY), "--json"]);
    expect(ops[1][0]).toBe("tools.media.models");
    expect(ops[1][2]).toBe("--json");
    const models = JSON.parse(ops[1][1]);
    expect(models).toHaveLength(2);
    expect(models[0].type).toBe("cli");
    expect(models[1]).toEqual(CLOUD);
    expect(localRow()).toMatchObject({
      command: "/usr/bin/python3",
      timeoutSeconds: 120,
      capabilities: ["audio"],
    });
    expect((localRow().args as string[])[0]).toMatch(/stt-client\.py$/);
    expect((localRow().args as string[])[1]).toBe("{{MediaPath}}");

    expect(restartMock).toHaveBeenCalledTimes(1);
    expect(store.get("stt_primary")).toBe("local");
    const body = await res.json();
    expect(body.primary).toBe("local");
    expect(body.chain).toEqual(["local", "cloud"]);
  });

  it("puts the cloud row first when the cloud is primary", async () => {
    store.set("stt_primary", "local");
    const { POST } = await route();
    await POST(post({ primary: "cloud" }));
    const models = JSON.parse(batchMock.mock.calls[0][0][1][1]);
    expect(models[0]).toEqual(CLOUD);
    expect(models[1].type).toBe("cli");
  });

  it("leaves the on-box row out when that engine is not installed", async () => {
    localInstalledMock.mockResolvedValue(MISSING);
    const { POST } = await route();
    await POST(post({ primary: "cloud" }));
    expect(JSON.parse(batchMock.mock.calls[0][0][1][1])).toEqual([CLOUD]);
  });

  it("does not rewrite, and does not restart, when the file already says exactly this", async () => {
    // Key order differs from what the route would write; the comparison is
    // by content, because the CLI is free to serialise the file as it likes.
    readConfigMock.mockResolvedValue({
      tools: {
        media: {
          audio: { baseUrl: PROXY },
          // OpenClaw 2's shared list, beside audio rather than under it.
          models: [
            { model: "gpt-4o-mini-transcribe", provider: "openai", capabilities: ["audio"] },
            {
              capabilities: ["audio"],
              timeoutSeconds: 120,
              args: [`${process.env.HOME || "/home/clawbox"}/.openclaw/workspace/scripts/stt-client.py`, "{{MediaPath}}"],
              command: "/usr/bin/python3",
              type: "cli",
            },
          ],
        },
      },
    });
    const { POST } = await route();
    const res = await POST(post({ primary: "cloud" }));
    expect(res.status).toBe(200);
    expect(batchMock).not.toHaveBeenCalled();
    expect(restartMock).not.toHaveBeenCalled();
    // The preference is still recorded: the file said it, the store now does too.
    expect(store.get("stt_primary")).toBe("cloud");
  });

  it("rewrites when only the order differs", async () => {
    readConfigMock.mockResolvedValue({
      tools: { media: { audio: { baseUrl: PROXY }, models: [CLOUD, { type: "cli", command: "/usr/bin/python3", args: ["/x/stt-client.py", "{{MediaPath}}"] }] } },
    });
    const { POST } = await route();
    await POST(post({ primary: "local" }));
    expect(batchMock).toHaveBeenCalledTimes(1);
  });

  it("stores the preference and skips the gateway on the Hermes edition", async () => {
    openclawAbsentMock.mockReturnValue(true);
    const { POST } = await route();
    const res = await POST(post({ primary: "local" }));
    expect(res.status).toBe(200);
    expect(store.get("stt_primary")).toBe("local");
    expect(readConfigMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
    expect(restartMock).not.toHaveBeenCalled();
    expect((await res.json()).channels.supportedOnEdition).toBe(false);
  });

  it("keeps the preference out of the store when the config write failed", async () => {
    batchMock.mockRejectedValue(new Error("ConfigMutationConflictError"));
    const { POST } = await route();
    const res = await POST(post({ primary: "local" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not change the transcription engine on this box." });
    expect(store.size).toBe(0);
    expect(restartMock).not.toHaveBeenCalled();
  });

  /**
   * TASK-608. A gateway that has not finished coming back is not a failed
   * engine change: the media-understanding order and the stored preference are
   * both already on disk, and the only client of this route
   * (`LocalAiPanel.runAction`) discards the body on `!res.ok` — so a 502 here
   * paints the panel's red "couldn't change that" over a change that landed
   * AND skips `applySnapshot`, leaving the row showing the old engine. The
   * owner clicks again and pays a second gateway restart.
   *
   * On beta this branch could only fire if `systemctl restart` itself failed.
   * The readiness wait widened it to "the port did not open inside 30 s", which
   * is the ordinary cold-box case, so the answer has to distinguish the two.
   */
  it("reports a landed engine change whose gateway is still coming back as saved", async () => {
    const { GatewayNotReadyError } = await import("@/lib/openclaw-config");
    restartMock.mockRejectedValue(new GatewayNotReadyError("gateway did not come back"));
    const { POST } = await route();
    const res = await POST(post({ primary: "local" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Still honest about the gateway, and still carrying the snapshot the panel
    // needs to repaint the row.
    expect(body.restarted).toBe(false);
    expect(body.warning).toMatch(/gateway/i);
    expect(body.primary).toBe("local");
    expect(store.get("stt_primary")).toBe("local");
  });

  it("says so when the write landed but the gateway would not restart", async () => {
    restartMock.mockRejectedValue(new Error("systemctl: job failed"));
    const { POST } = await route();
    const res = await POST(post({ primary: "local" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.restarted).toBe(false);
    expect(body.warning).toMatch(/restart/i);
    // Both halves are saved; only the switch-over of channel voice notes waits.
    expect(body.primary).toBe("local");
    expect(store.get("stt_primary")).toBe("local");
  });
});
