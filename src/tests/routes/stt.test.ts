import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /setup-api/stt — which engine hears this box first.
 *
 * Beyond reporting, the route's job is to keep openclaw.json's audio chain in
 * step with the owner's preference WITHOUT spending a CLI cold start and a
 * gateway restart on a selection that changes nothing, and to keep the agent
 * — which holds a credential middleware accepts — from making the choice.
 */

import { tokenFingerprint } from "@/lib/anthropic-gateway-auth";

const readConfigMock = vi.fn();
const batchMock = vi.fn();
const unsetMock = vi.fn();
const restartMock = vi.fn();
const boundProfileMock = vi.fn();
const openaiAuthMock = vi.fn();
const openclawAbsentMock = vi.fn();
const ownerSessionMock = vi.fn();
const localInstalledMock = vi.fn();
const tokenMock = vi.fn();
const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: (...a: unknown[]) => readConfigMock(...a),
  readConfigStrict: (...a: unknown[]) => readConfigMock(...a),
  runOpenclawConfigSetBatch: (...a: unknown[]) => batchMock(...a),
  runOpenclawConfigUnset: (...a: unknown[]) => unsetMock(...a),
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
  hasPersonSession: (...a: unknown[]) => ownerSessionMock(...a),
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
// The gateway's credential store, which decides whether the cloud row is
// written at all (stt-channel.ts). Mocked so no test reads a real one.
vi.mock("@/lib/openclaw-auth-store", () => ({
  readGatewayAuthProfile: (...a: unknown[]) => boundProfileMock(...a),
  readGatewayProviderAuth: (...a: unknown[]) => openaiAuthMock(...a),
}));

const PROXY = "https://clawbox.com/api/ai";
/** `deepseek:default` holding this box's ClawBox AI token as an API key: what backs the cloud row. */
const BACKED = {
  kind: "present",
  store: "shared",
  type: "api_key",
  fingerprint: tokenFingerprint("claw_token"),
  refreshFingerprint: null,
  expires: null,
  fenced: false,
  fence: null,
  storeUpdatedAtMs: null,
};
const NO_OPENAI_PROFILES = { kind: "present", profiles: [], order: null, failures: {} };
/** The owner signed in with ChatGPT: an OAuth profile of the openai provider. */
const CHATGPT_SIGNED_IN = {
  kind: "present",
  profiles: [{ ...BACKED, type: "oauth", fingerprint: "f00dfeedf00dfeed", profileId: "openai:chatgpt" }],
  order: null,
  failures: {},
};
// The cloud row names the ClawBox AI auth profile: the transcription credential
// no longer rides on the openai provider entry (it shadowed the ChatGPT sign-in).
const CLOUD = { provider: "openai", model: "gpt-4o-mini-transcribe", profile: "deepseek:default", capabilities: ["audio"] };
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

/** What every ClawBox AI sign-in records in openclaw.json beside the token: the profile, as a key. */
const LINKED_AUTH = { auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } } };

beforeEach(() => {
  vi.resetModules();
  store.clear();
  readConfigMock.mockReset().mockResolvedValue({ ...LINKED_AUTH });
  batchMock.mockReset().mockResolvedValue(undefined);
  unsetMock.mockReset().mockResolvedValue(undefined);
  restartMock.mockReset().mockResolvedValue(undefined);
  boundProfileMock.mockReset().mockReturnValue(BACKED);
  openaiAuthMock.mockReset().mockReturnValue(NO_OPENAI_PROFILES);
  openclawAbsentMock.mockReset().mockReturnValue(false);
  ownerSessionMock.mockReset().mockResolvedValue(true);
  localInstalledMock.mockReset().mockResolvedValue(INSTALLED);
  tokenMock.mockReset().mockResolvedValue("claw_token");
});

describe("GET /setup-api/stt", () => {
  it("reports both engines, the chain, and never caches", async () => {
    store.set("stt_primary", "cloud");
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
      channels: { supportedOnEdition: true, chain: ["cloud", "local"], cloudUnavailable: null },
    });
  });

  it("puts the box's own engine first when nothing is stored", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.primary).toBe("local");
    expect(body.chain).toEqual(["local", "cloud"]);
    expect(body.channels.chain).toEqual(["local", "cloud"]);
  });

  /**
   * The real box: a ClawBox AI token still on it, the owner signed in with
   * ChatGPT. The microphone sends the token to the proxy itself and keeps the
   * cloud; a channel voice note goes through the gateway, which refuses the
   * proxy endpoint for an OAuth credential — so the channel chain is the box's
   * engine alone, and says why.
   */
  it("reports what a channel voice note tries apart from the microphone, and why the cloud is not in it", async () => {
    store.set("stt_primary", "cloud");
    openaiAuthMock.mockReturnValue(CHATGPT_SIGNED_IN);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.chain).toEqual(["cloud", "local"]);
    expect(body.channels).toEqual({ supportedOnEdition: true, chain: ["local"], cloudUnavailable: "openai_oauth" });
  });

  /**
   * A ClawBox AI sign-in left over as an OAuth profile is refused by BOTH
   * surfaces (`cloudTranscribeProblem`): the microphone uploads nothing to the
   * proxy and the channel row is left out, so neither chain may list the cloud.
   */
  it("leaves the cloud out of both chains for a ClawBox AI sign-in left over as an OAuth profile", async () => {
    store.set("stt_primary", "cloud");
    readConfigMock.mockResolvedValue({
      models: { providers: { deepseek: { apiKey: "claw_token" } } },
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "oauth" } } },
    });
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.chain).toEqual(["local"]);
    expect(body.channels).toEqual({ supportedOnEdition: true, chain: ["local"], cloudUnavailable: "profile_not_api_key" });
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

  /**
   * TASK-860. The engine named as primary has to be one this box could actually
   * use. An unlinked box answered `primary: "cloud"` beside
   * `engines.cloud.configured: false` — and `/setup-api/ai-cloud-defaults`, the
   * card built on the same rule, said the target for that box was the engine on
   * the box with reason `not_linked`. Two routes, one box, two answers.
   */
  it("names the box itself as primary while there is no cloud credential", async () => {
    tokenMock.mockResolvedValue(null);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.primary).toBe("local");
    expect(body.chain).toEqual(["local"]);
  });

  it("does not report a stored cloud pick as primary once the credential is gone", async () => {
    tokenMock.mockResolvedValue(null);
    store.set("stt_primary", "cloud");
    const { GET } = await route();
    expect((await (await GET()).json()).primary).toBe("local");
  });

  it("shows a missing on-box engine as such and leaves it out of the chain", async () => {
    localInstalledMock.mockResolvedValue(MISSING);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.engines.local).toEqual({ installed: false, label: "On this box", detail: MISSING.detail });
    expect(body.chain).toEqual(["cloud"]);
  });

  it("still puts the cloud first with nothing stored when the box has no engine of its own", async () => {
    localInstalledMock.mockResolvedValue(MISSING);
    const { GET } = await route();
    expect((await (await GET()).json()).primary).toBe("cloud");
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
    store.set("stt_primary", "cloud");
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

  /**
   * The owner being SIGNED IN is not the owner ASKING. The session cookie is
   * `SameSite=Lax`, which stops the ordinary cross-site POST but not a page
   * served from another ORIGIN of the same site — and this route decides where
   * the owner's recordings are sent. Same second guard the ClawKeep mutation
   * routes take.
   */
  it("refuses a signed-in request that came from another origin", async () => {
    const { POST } = await route();
    const res = await POST(
      new Request("http://box/setup-api/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ primary: "cloud" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(store.size).toBe(0);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("admits the box's own page, and a caller that sends no browser headers at all", async () => {
    const { POST } = await route();
    const sameOrigin = await POST(
      new Request("http://box/setup-api/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "http://box" },
        body: JSON.stringify({ primary: "cloud" }),
      }),
    );
    expect(sameOrigin.status).toBe(200);
    // curl and the MCP server send neither header; their credential is what the
    // owner gate above decides on, and this guard is not about them.
    expect((await POST(post({ primary: "cloud" }))).status).toBe(200);
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

  /**
   * TASK-860. "Use as fallback" posts `{primary:"cloud"}` — it hands the
   * capability back to the automatic default rather than naming an engine. On a
   * box with no subscription that default is the engine on the box, so the
   * channel list has to be written in THAT order: writing the cloud row first
   * would make every voice note pay a refused round trip before the engine that
   * can answer, and would disagree with the primary the same response reports.
   */
  it("writes the on-box row alone when the cloud is handed back on an unlinked box", async () => {
    tokenMock.mockResolvedValue(null);
    const { POST } = await route();
    const res = await POST(post({ primary: "cloud" }));
    expect(res.status).toBe(200);
    // No credential, no cloud row: one that is written anyway is not a
    // fallback but a refused attempt on every voice note.
    expect(batchMock.mock.calls[0][0]).toEqual([["tools.media.models", expect.any(String), "--json"]]);
    const models = JSON.parse(batchMock.mock.calls[0][0][0][1]);
    expect(models).toHaveLength(1);
    expect(models[0].type).toBe("cli");
    expect((await res.json()).primary).toBe("local");
  });

  /**
   * The box this was found on: Settings had written the cloud row bound to
   * `deepseek:default` with our endpoint, and the owner then signed in with
   * ChatGPT. Every Telegram voice note was refused ("OpenAI OAuth audio
   * transcription requires the official endpoint without custom request
   * overrides") while Whisper sat installed beside it.
   */
  it("never writes the openai row with our endpoint once the openai credential is a ChatGPT sign-in", async () => {
    openaiAuthMock.mockReturnValue(CHATGPT_SIGNED_IN);
    readConfigMock.mockResolvedValue({ ...LINKED_AUTH, tools: { media: { audio: { baseUrl: PROXY }, models: [CLOUD] } } });
    const { POST } = await route();
    const res = await POST(post({ primary: "cloud" }));
    expect(res.status).toBe(200);
    const written = batchMock.mock.calls.flatMap(([ops]) => ops as string[][]);
    expect(written.map(([key]) => key)).toEqual(["tools.media.models"]);
    expect(JSON.parse(written[0][1])).toEqual([expect.objectContaining({ type: "cli" })]);
    // And the endpoint goes with the row: it would also apply to a provider
    // the core picked by itself.
    expect(unsetMock).toHaveBeenCalledWith("tools.media.audio.baseUrl");
  });

  it("drops the cloud row once the profile it names is gone from the gateway's store", async () => {
    boundProfileMock.mockReturnValue({ kind: "absent", store: "shared" });
    readConfigMock.mockResolvedValue({ tools: { media: { audio: { baseUrl: PROXY }, models: [CLOUD] } } });
    const { POST } = await route();
    await POST(post({ primary: "local" }));
    const models = JSON.parse(batchMock.mock.calls[0][0][0][1]);
    expect(models.some((row: { provider?: string }) => row.provider === "openai")).toBe(false);
    expect(unsetMock).toHaveBeenCalledWith("tools.media.audio.baseUrl");
  });

  /**
   * The box this card was found on: a ClawBox AI sign-in from a release that
   * signed in by subscription left `deepseek:default` recorded as OAuth, the
   * core took the row's bearer for an OAuth credential, and every Telegram
   * voice note was refused while Whisper sat installed beside it.
   */
  it("drops the cloud row for a ClawBox AI sign-in left over as an OAuth profile, whatever the store holds", async () => {
    readConfigMock.mockResolvedValue({
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "oauth" } } },
      tools: { media: { audio: { baseUrl: PROXY }, models: [CLOUD] } },
    });
    const { POST } = await route();
    const res = await POST(post({ primary: "cloud" }));
    expect(res.status).toBe(200);
    const written = batchMock.mock.calls.flatMap(([ops]) => ops as string[][]);
    expect(written.map(([key]) => key)).toEqual(["tools.media.models"]);
    expect(JSON.parse(written[0][1])).toEqual([expect.objectContaining({ type: "cli" })]);
    expect(unsetMock).toHaveBeenCalledWith("tools.media.audio.baseUrl");
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
      ...LINKED_AUTH,
      tools: {
        media: {
          audio: { baseUrl: PROXY },
          // OpenClaw 2's shared list, beside audio rather than under it.
          models: [
            { model: "gpt-4o-mini-transcribe", provider: "openai", profile: "deepseek:default", capabilities: ["audio"] },
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
    expect(store.get("stt_primary")).toBeUndefined();
    // The owner PIN is the one thing that does survive, and on purpose — see
    // the ordering test below. A pin over an engine that did not move tells the
    // cloud default to leave this box alone, which is the harmless direction;
    // the engine itself is unchanged and the answer says so.
    expect(store.get("stt_choice_source")).toBe("owner");
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

  /**
   * WHO DECIDED, and in which order it is written.
   *
   * A person pinning the engine on the box is the only thing that stops the
   * ClawBox AI cloud default from moving it back at the next boot. The pin used
   * to be written AFTER the engine, so on a box whose `stt_choice_source`
   * already read `auto` — anyone who has ever picked the cloud here — a
   * successful engine write followed by a failed pin left `auto` standing,
   * `ownerChoiceFrom("auto", true)` answered false, and the next boot promoted
   * the box straight back off the engine the owner had just chosen.
   */
  it("records the owner's pin before it touches the engine", async () => {
    // The box has been on the automatic default until now, which is the case
    // the stored-`local` grandfather rule does NOT cover.
    store.set("stt_choice_source", "auto");
    const order: string[] = [];
    batchMock.mockImplementation(async () => {
      order.push(`pin=${String(store.get("stt_choice_source"))}`);
    });
    const { POST } = await route();
    expect((await POST(post({ primary: "local" }))).status).toBe(200);
    // The engine write saw the pin already on record, not after it.
    expect(order).toEqual(["pin=owner"]);
    expect(store.get("stt_choice_source")).toBe("owner");
  });

  it("hands the capability back to the default only once the cloud write has landed", async () => {
    store.set("stt_choice_source", "owner");
    const seen: unknown[] = [];
    batchMock.mockImplementation(async () => {
      seen.push(store.get("stt_choice_source"));
    });
    const { POST } = await route();
    expect((await POST(post({ primary: "cloud" }))).status).toBe(200);
    // Releasing is the direction that LOSES a decision if it lands over a write
    // that did not, so it stays behind the write.
    expect(seen).toEqual(["owner"]);
    expect(store.get("stt_choice_source")).toBe("auto");
  });

  it("leaves the owner's pin alone when the cloud write failed", async () => {
    store.set("stt_choice_source", "owner");
    batchMock.mockRejectedValue(new Error("ConfigMutationConflictError"));
    const { POST } = await route();
    expect((await POST(post({ primary: "cloud" }))).status).toBe(500);
    expect(store.get("stt_choice_source")).toBe("owner");
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
