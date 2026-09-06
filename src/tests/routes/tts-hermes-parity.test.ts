import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settings → Voice on the Hermes edition.
 *
 * The panel was dark on this SKU because the ROUTE refused the whole feature
 * whenever the `openclaw` binary was missing. That gate was written for the two
 * writes that genuinely need the CLI (`config set tts.provider`, `…providers.
 * <cloud>.voice`), but it also took down everything around them — and none of
 * that needs OpenClaw at all:
 *
 *   - the ENGINE list is read off this box's own disk (Kokoro's stamp and unit);
 *   - the cloud engine is a ClawBox AI credential, which `harness/credentials`
 *     already resolves on either edition (the same fix voice INPUT got);
 *   - the language and the on-device voice are ClawBox's own state files.
 *
 * So this is the /setup-api/stt split, applied to the other direction of
 * speech: the CHANNEL half is OpenClaw's and says so, and the panel half works
 * on every edition. `stt/route.ts` already claims "Same shape /setup-api/tts
 * answers with" — this is the change that makes that sentence true.
 */

const readConfigMock = vi.fn();
const configSetMock = vi.fn();
const hermesCliMock = vi.fn();
/** What `hermes config get <key>` answers. Mutated per test. */
let hermesConfig: Record<string, string> = {};
const ttsInventoryMock = vi.fn();
const accessMock = vi.fn();
/** `access` decides which paths this fake box HAS; `stat` only says what kind
 *  they are, because `executable()` refuses a directory that answers X_OK. */
const statMock = vi.fn();
const readStateMock = vi.fn();
const writeStateMock = vi.fn();
const writeLocalVoiceMock = vi.fn();
const tokenMock = vi.fn();

vi.mock("@/lib/openclaw-config", () => ({
  readConfig: (...a: unknown[]) => readConfigMock(...a),
  runOpenclawConfigSet: (...a: unknown[]) => configSetMock(...a),
  // The Hermes SKU: no binary to spawn, for every test in this file.
  openclawIsAbsent: () => true,
}));

// The box runs Hermes, so Hermes is what speaks and what gets written.
vi.mock("@/lib/harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/harness")>();
  return { ...actual, getActiveHarness: async () => "hermes" as const };
});

// Mocked at the CLI seam, not at hermes-tts, so the projection from Hermes'
// own `tts.*` keys into the shared status view is really exercised.
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGetMany: async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, hermesConfig[k] ?? ""])),
  // Every key in this fixture ANSWERED: `readHermesVoice` reports which of its
  // own reads did not, and an unread key is not an unset one.
  hermesConfigReadPending: () => false,
}));

vi.mock("@/lib/hermes-cli", () => ({
  runHermesCli: (...a: unknown[]) => hermesCliMock(...a),
}));

vi.mock("@/lib/harness/credentials", () => ({
  resolveClawaiToken: (...a: unknown[]) => tokenMock(...a),
  CLAWBOX_AI_PROXY_URL: "https://clawbox.test/api/ai",
}));

vi.mock("@/lib/local-models", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local-models")>();
  return { ...actual, buildTtsInventory: (...a: unknown[]) => ttsInventoryMock(...a) };
});

vi.mock("@/lib/voice-output-store", () => ({
  readVoiceState: (...a: unknown[]) => readStateMock(...a),
  writeVoiceState: (...a: unknown[]) => writeStateMock(...a),
  readLocalVoice: async () => null,
  writeLocalVoice: (...a: unknown[]) => writeLocalVoiceMock(...a),
}));

/** `pref:ui_language` and `clawai_tier`; the box is on the plan that has a voice. */
let storeValues: Record<string, unknown> = {};
// Partial: the route now reaches the store through the owner gate (auth.ts
// reads DATA_DIR at import) and the spoken-replies switch; only the reads
// this suite scripts are overridden.
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: async (key: string) => storeValues[key] ?? null,
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      access: (...a: unknown[]) => accessMock(...a),
      stat: (...a: unknown[]) => statMock(...a),
    },
  };
});

const kokoroInstalled = [{
  id: "kokoro", name: "Kokoro", kind: "tts", runtime: "Voice on this box",
  installed: true, enabled: true, running: "running", diskBytes: 1, memoryBytes: null,
  control: "user-unit", detail: "Speaking from this box.",
}];

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
  vi.clearAllMocks();
  // A Hermes box has no openclaw.json at all — the reader throws, which is
  // exactly the case `resolveClawaiToken` exists to cover.
  readConfigMock.mockRejectedValue(new Error("ENOENT ~/.openclaw/openclaw.json"));
  ttsInventoryMock.mockResolvedValue(kokoroInstalled);
  accessMock.mockResolvedValue(undefined);
  statMock.mockReset().mockResolvedValue({ isFile: () => true });
  readStateMock.mockResolvedValue({ choice: "auto" });
  writeStateMock.mockResolvedValue(undefined);
  writeLocalVoiceMock.mockResolvedValue(undefined);
  tokenMock.mockResolvedValue("claw_a_linked_hermes_box");
  storeValues = { clawai_tier: "pro" };
  hermesCliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  // EXACTLY what install.sh writes on a freshly provisioned Hermes box, and
  // nothing else. Seeding `tts.openai.base_url` here — the key only the cloud
  // SELECTION writes — is what hid a deadlock: the cloud option was refused
  // until that key existed, and nothing could write it until the option was
  // accepted, so the whole cloud arm was unreachable on every real box.
  // The `command` is the whole COMMAND LINE install.sh writes, placeholders
  // included — not the bare path this fixture used to carry. That shortcut was
  // the one shape no installer ever writes, and it hid the panel stat'ing the
  // line whole; see the last describe in this file.
  hermesConfig = {
    "tts.provider": "clawbox-local",
    "tts.providers.clawbox-local.type": "command",
    "tts.providers.clawbox-local.command": "/opt/clawbox-tts.sh --text-file={input_path} -- {output_path}",
  };
});

describe("GET /setup-api/tts on a linked Hermes box", () => {
  it("answers a voice status, not a refusal to have the feature", async () => {
    const { GET } = await route();
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    // The whole point: a Hermes box with a working ClawBox cloud voice was
    // being told the feature is not part of its edition.
    expect(body.supportedOnEdition).not.toBe(false);
    expect(Array.isArray(body.engines)).toBe(true);
    expect(typeof body.choice).toBe("string");
    expect(typeof body.language).toBe("string");
    expect(body.voice).toEqual(expect.objectContaining({ local: expect.any(String), cloud: expect.any(String) }));
  });

  it("reports the cloud voice as configured from the credential this edition keeps", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();

    const cloud = body.engines.find((e: { id: string }) => e.id === "cloud");
    expect(cloud.configured).toBe(true);
    // Read through the edition-agnostic resolver, never openclaw.json.
    expect(tokenMock).toHaveBeenCalled();
  });

  it("reports the on-device voice from the box's own disk", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();

    const local = body.engines.find((e: { id: string }) => e.id === "local");
    expect(local.configured).toBe(true);
  });

  /**
   * The regression that made the cloud half dead code.
   *
   * `tts.openai.base_url` is written ONLY by the cloud selection, and the
   * cloud selection was refused until that key existed — so on every box that
   * had not somehow already been pointed at the proxy (i.e. all of them:
   * install.sh writes only the local provider) the option was rendered
   * disabled for ever. The endpoint is a derived constant on a ClawBox, not a
   * fact to discover, so holding a `claw_` token IS being able to point there.
   */
  it("offers the cloud voice on a box that has only ever run install.sh", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();

    expect(Object.keys(hermesConfig)).not.toContain("tts.openai.base_url");
    const cloud = body.engines.find((e: { id: string }) => e.id === "cloud");
    expect(cloud.configured).toBe(true);
  });

  it("lets that box actually select the cloud voice", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "cloud" }));

    // 409 here was the deadlock: refused for want of the very key this call is
    // what writes.
    expect(res.status).toBe(200);
    const keys = hermesCliMock.mock.calls.map((c) => (c[0] as string[])[2]);
    expect(keys).toContain("tts.openai.base_url");
  });

  it("keeps the edition fact for the half that really is OpenClaw's", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();

    // Spoken replies in WhatsApp/Telegram/Discord are the gateway's own doing,
    // and a Hermes box has no gateway. Same shape /setup-api/stt answers with.
    expect(body.channels.supportedOnEdition).toBe(false);
  });
});

describe("POST /setup-api/tts on a Hermes box", () => {
  it("saves a language pick — it is ClawBox's own state, not OpenClaw's", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "language", language: "de" }));

    expect(res.status).toBe(200);
    expect(writeStateMock).toHaveBeenCalledWith(expect.objectContaining({ language: "de" }));
  });

  it("saves the on-device voice — the local script reads it, not the gateway", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "voice", engine: "local", voice: "af_bella" }));

    expect(res.status).toBe(200);
    expect(writeLocalVoiceMock).toHaveBeenCalledWith("af_bella");
  });

  it("saves a selection without spawning a CLI this edition does not have", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));

    expect(res.status).toBe(200);
    expect(writeStateMock).toHaveBeenCalledWith(expect.objectContaining({ choice: "local" }));
    // The openclaw write is what the gate was protecting. It must be SKIPPED
    // here, not attempted and swallowed.
    expect(configSetMock).not.toHaveBeenCalled();
  });

  it("writes the cloud endpoint and credential BEFORE selecting the provider", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "cloud" }));

    expect(res.status).toBe(200);
    const keys = hermesCliMock.mock.calls.map((c) => (c[0] as string[])[2]);
    // A box left pointing at a provider whose credential never landed answers
    // every utterance with a 401, which reads as a broken voice rather than an
    // unconfigured one. Same order install.sh and the OpenClaw arm both use.
    expect(keys).toContain("tts.openai.base_url");
    expect(keys).toContain("tts.openai.api_key");
    expect(keys.indexOf("tts.provider")).toBeGreaterThan(keys.indexOf("tts.openai.api_key"));
    expect(hermesCliMock).toHaveBeenCalledWith(
      ["config", "set", "tts.provider", "openai"],
      expect.anything(),
    );
  });

  it("does not select the cloud provider when the credential write fails", async () => {
    hermesCliMock.mockImplementation(async (args: string[]) =>
      args[2] === "tts.openai.api_key"
        ? { code: 1, stdout: "", stderr: "denied" }
        : { code: 0, stdout: "", stderr: "" });
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "cloud" }));

    expect(res.status).toBe(409);
    const selected = hermesCliMock.mock.calls.some((c) => (c[0] as string[])[2] === "tts.provider");
    expect(selected).toBe(false);
  });

  it("refuses the cloud voice on a box with no ClawBox AI credential", async () => {
    tokenMock.mockResolvedValue(null);
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "cloud" }));

    // Not a 500, and not a silent success: the box said no.
    expect([409, 400]).toContain(res.status);
    const selected = hermesCliMock.mock.calls.some((c) => (c[0] as string[])[2] === "tts.provider");
    expect(selected).toBe(false);
  });

  it("still refuses an unknown action rather than swallowing the contract", async () => {
    const { POST } = await route();
    expect((await POST(post({ action: "nonsense" }))).status).toBe(400);
  });
});

/**
 * Hermes ships `tts.provider: edge` — Microsoft's free cloud voice. A ClawBox
 * must never speak through it: the Voice tab's privacy line either says
 * nothing leaves the box or names the cloud the words go to, and Edge is a
 * third cloud the customer never chose and the panel never mentions. So Edge
 * reads as FACTORY-unset (replaceable), and it is never offered as a source.
 */
describe("a factory Hermes box still on Edge", () => {
  beforeEach(() => {
    hermesConfig["tts.provider"] = "edge";
  });

  it("does not report Edge as one of the box's engines", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();

    expect(body.engines.map((e: { id: string }) => e.id).sort()).toEqual(["cloud", "local"]);
    expect(JSON.stringify(body.engines)).not.toMatch(/edge/i);
  });

  it("does not present Edge as the active engine", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();

    // `edge` is neither of our two engines, so nothing of ours may claim to be
    // active — saying "ClawBox cloud" over a box speaking through Microsoft
    // would be the panel describing a different box.
    expect(body.activeEngine).toBeNull();
  });

  it("replaces Edge on the first selection instead of preserving it", async () => {
    const { POST } = await route();
    const res = await POST(post({ action: "select", choice: "local" }));

    expect(res.status).toBe(200);
    expect(hermesCliMock).toHaveBeenCalledWith(
      ["config", "set", "tts.provider", "clawbox-local"],
      expect.anything(),
    );
  });
});

/**
 * On Hermes `openai` is the GENERIC OpenAI-compatible slot. An owner may have
 * aimed it at their own speech server with their own key — `install.sh` lists
 * it among the values it preserves as their choice — and the panel must say so
 * for the same reason it drops `edge`: the privacy line either says nothing
 * leaves the box or NAMES the cloud the words go to, and a third party's
 * endpoint reported as "ClawBox cloud, with your device token" names the wrong
 * one. It also made the fix worse than the bug: re-selecting what looked
 * already active is the one write that overwrites their endpoint, key and
 * model.
 */
describe("a Hermes box whose openai slot is the owner's own", () => {
  beforeEach(() => {
    hermesConfig["tts.provider"] = "openai";
    hermesConfig["tts.openai.base_url"] = "https://speech.example.internal/v1";
    hermesConfig["tts.openai.api_key"] = "sk-owners-own-key";
  });

  it("does not present the owner's own speech server as the active ClawBox engine", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();

    expect(body.activeEngine).toBeNull();
  });

  it("does not hand the owner's endpoint back as ClawBox's own", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();

    expect(JSON.stringify(body)).not.toContain("speech.example.internal");
  });

  it("still offers the cloud voice as the explicit choice it would be", async () => {
    // Dropping the SELECTION must not drop the OPTION: this box holds a
    // `claw_` token and is entitled, so switching to ClawBox cloud has to stay
    // one deliberate click away.
    const { GET } = await route();
    const body = await (await GET()).json();

    expect(body.engines.map((e: { id: string }) => e.id)).toContain("cloud");
  });
});

/**
 * The same slot, holding a route WE wrote under a proxy address that has since
 * moved. `CLAWBOX_AI_PROXY_URL` is env-overridable and changes in a release, so
 * matching it exactly is not what makes a route ours — the `claw_` credential
 * beside it is.
 */
describe("a Hermes box we linked before the proxy address moved", () => {
  beforeEach(() => {
    hermesConfig["tts.provider"] = "openai";
    hermesConfig["tts.openai.base_url"] = "https://clawbox.test/api/ai-retired";
    hermesConfig["tts.openai.api_key"] = "claw_test_token";
  });

  it("still calls it the ClawBox cloud voice", async () => {
    const { GET } = await route();
    const body = await (await GET()).json();

    expect(body.activeEngine).toBe("cloud");
  });
});

describe("a Hermes box whose plan has no cloud voice", () => {
  it("drops a PERSISTED cloud endpoint when the plan no longer covers it", async () => {
    // The box was entitled once, so `tts.openai.*` is still on disk. Reading
    // it back would keep the panel reporting a configured cloud voice whose
    // every utterance the proxy now answers 403.
    storeValues = { clawai_tier: "flash" };
    hermesConfig["tts.openai.base_url"] = "https://clawbox.test/api/ai";
    hermesConfig["tts.openai.api_key"] = "claw_a_linked_hermes_box";
    const { GET } = await route();
    const body = await (await GET()).json();

    const cloud = body.engines.find((e: { id: string }) => e.id === "cloud");
    expect(cloud.configured).toBe(false);
    expect(cloud.detail).toMatch(/Max/i);
  });

  // TASK-744. `clawai_tier` is the DEVICE default and a Max subscriber is
  // allowed to have it set to Flash; `clawai_plan_tier` is what the account
  // pays for, and it is the only one an entitlement may be read from. The panel
  // has to answer this the same way both boot scripts do, or a box whose cloud
  // voice `register-mcp.sh` has just armed is told its plan does not include it.
  it("offers the cloud voice to a Max plan whose device is stamped flash", async () => {
    storeValues = { clawai_tier: "flash", clawai_plan_tier: "pro" };
    hermesConfig["tts.openai.base_url"] = "https://clawbox.test/api/ai";
    hermesConfig["tts.openai.api_key"] = "claw_a_linked_hermes_box";
    const { GET } = await route();
    const body = await (await GET()).json();

    const cloud = body.engines.find((e: { id: string }) => e.id === "cloud");
    expect(cloud.configured).toBe(true);
  });

  it("still withholds it when the PLAN itself is below the entitlement", async () => {
    storeValues = { clawai_tier: "pro", clawai_plan_tier: "flash" };
    hermesConfig["tts.openai.base_url"] = "https://clawbox.test/api/ai";
    hermesConfig["tts.openai.api_key"] = "claw_a_linked_hermes_box";
    const { GET } = await route();
    const body = await (await GET()).json();

    const cloud = body.engines.find((e: { id: string }) => e.id === "cloud");
    expect(cloud.configured).toBe(false);
    expect(cloud.detail).toMatch(/Max/i);
  });

  it("does not offer the cloud voice it would only be refused for", async () => {
    // The proxy serves speech to `pro` and answers 403 below it —
    // gateway-pre-start.sh gates the OpenClaw side on the same tier, and its
    // comment says why: pointing an unentitled box at that route would have
    // the panel call the cloud voice configured while every spoken reply paid
    // a failed round trip.
    storeValues = { clawai_tier: "flash" };
    const { GET } = await route();
    const body = await (await GET()).json();

    const cloud = body.engines.find((e: { id: string }) => e.id === "cloud");
    expect(cloud.configured).toBe(false);
    // And it says the plan, not "no cloud voice is set up" — the box HAS a
    // credential; what it lacks is the plan behind it.
    expect(cloud.detail).toMatch(/Max/i);
  });
});

describe("an unlinked Hermes box", () => {
  it("says the cloud voice is not set up, rather than that the edition has none", async () => {
    tokenMock.mockResolvedValue(null);
    const { GET } = await route();
    const body = await (await GET()).json();

    expect(body.supportedOnEdition).not.toBe(false);
    const cloud = body.engines.find((e: { id: string }) => e.id === "cloud");
    expect(cloud.configured).toBe(false);
  });
});

describe("the command line install.sh really registers", () => {
  /**
   * The provider's `command` is not a path on this edition.
   *
   * install.sh writes `<script> --text-file={input_path} -- {output_path}` for
   * Hermes (a command LINE, because Hermes substitutes its own placeholders),
   * where the OpenClaw arm writes a bare `command` plus a separate `args`
   * array. The panel stat'ed the string whole, which is not a file on any box
   * — so every correctly provisioned Hermes box read as "a voice is installed
   * but the box is not wired to use it", and the fixture that hid it was a
   * bare path no installer ever writes.
   */
  const SCRIPT = "/opt/clawbox-tts.sh";
  const COMMAND_LINE = `${SCRIPT} --text-file={input_path} -- {output_path}`;

  it("reads the on-device voice off the SCRIPT the command line names", async () => {
    hermesConfig["tts.providers.clawbox-local.command"] = COMMAND_LINE;
    // A filesystem that knows the script and nothing else, which is every
    // provisioned box.
    accessMock.mockImplementation((p: string) =>
      p === SCRIPT ? Promise.resolve(undefined) : Promise.reject(new Error("ENOENT")),
    );
    const { GET } = await route();
    const body = await (await GET()).json();

    const local = body.engines.find((e: { id: string }) => e.id === "local");
    expect(local.configured).toBe(true);
    expect(local.detail).not.toMatch(/not wired/i);
  });

  it("still reports it unconfigured when that script cannot be run", async () => {
    // The other half of the same fact, and the one the chat's capability is
    // pinned on: present is not runnable. Both surfaces ask it through one
    // helper so they cannot answer differently about one box.
    hermesConfig["tts.providers.clawbox-local.command"] = COMMAND_LINE;
    accessMock.mockImplementation((p: string, mode?: number) =>
      p === SCRIPT && mode === undefined
        ? Promise.resolve(undefined)
        : Promise.reject(new Error("EACCES")),
    );
    const { GET } = await route();
    const body = await (await GET()).json();

    const local = body.engines.find((e: { id: string }) => e.id === "local");
    expect(local.configured).toBe(false);
  });
});
