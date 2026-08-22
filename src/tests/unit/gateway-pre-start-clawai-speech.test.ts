import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Cloud TTS shipped to production on 2026-08-22 (clawbox-website PR #523) and
// the device was never told. `messages.tts.providers` on a paired box carried
// only the local CLI entry, so voice-output.ts read a claw_ token with no
// speech endpoint behind it and every box printed "ClawBox AI does not serve
// the voice yet" — a confident statement about the product that had stopped
// being true. Reproduced on both loop boxes on beta ddd168e; see TASK-490.
//
// Like the image and transcription migrations next door, these run the block
// out of the shipped .sh rather than a copy, so the test fails if the real
// script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const PROXY = "https://clawbox.com/api/ai";
const SPEECH_MODEL = "gpt-4o-mini-tts";
/** The stamp that says we wrote this entry, and the only licence to remove it. */
const MANAGED = { clawboxManaged: true };
const TOKEN = "claw_test_token";
/** The device tier stamp of the MAX plan. The two names are off by one on purpose. */
const MAX_DEVICE_TIER = "pro";
/** The device tier stamp of the PRO plan, which the proxy answers 403 for. */
const PRO_DEVICE_TIER = "flash";

function slice(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`block not found: ${from}`);
  return src.slice(start, end);
}

/**
 * The cloud-voice migration, verbatim, plus the shared endpoint comparison it
 * comes with. `_same_endpoint` is defined at module level in the transcription
 * block precisely so both migrations answer that question the same way, so
 * this test takes it from there rather than restating the rule.
 */
const SAME_ENDPOINT = hasPython3 ? slice("def _same_endpoint(_a, _b):", "if _clawai_openai_route_is_ours:") : "";
const POLICY = hasPython3
  ? slice("# Migration: ClawBox AI cloud voice (text to speech).", "if isinstance(ds_models, list):")
  : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "clawai-speech-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type SpeechEntry = { baseUrl?: unknown; model?: unknown; apiKey?: unknown; [key: string]: unknown };

interface Options {
  /** What the image migration decided about the `openai` provider slot. */
  routeIsOurs?: boolean;
  /** `clawai_tier` in the device store, or `null` for a store without one. */
  deviceTier?: string | null;
  /** `false` writes no device store at all — a box the Next app has never run on. */
  storeExists?: boolean;
  /** A device store that is not an object, or not JSON. */
  storeBody?: string;
}

/**
 * Run the extracted block over a whole openclaw.json.
 *
 * The preamble binds only what the real script binds upstream of this point:
 * `cfg`, `changed`, the two names the image migration hands over once it has
 * decided the `openai` slot is ours, and the token it took from the ClawBox AI
 * provider entry. `CLAWBOX_DEVICE_STORE` is the env var the shell exports.
 */
function migrate(cfg: Config, opts: Options = {}): { cfg: Config; changed: boolean; log: string } {
  const { routeIsOurs = true, deviceTier = MAX_DEVICE_TIER, storeExists = true, storeBody } = opts;
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const store = path.join(dir, "device-store.json");
  if (storeExists) {
    writeFileSync(store, storeBody ?? JSON.stringify(deviceTier === null ? {} : { clawai_tier: deviceTier }));
  }
  const program = [
    "import json, os, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    `_clawai_openai_route_is_ours = ${routeIsOurs ? "True" : "False"}`,
    `_clawai_proxy_base_url = ${JSON.stringify(PROXY)}`,
    `_clawai_token = ${JSON.stringify(TOKEN)}`,
    SAME_ENDPOINT,
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const lines = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    env: { ...process.env, CLAWBOX_DEVICE_STORE: store },
  }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

function speech(cfg: Config): SpeechEntry | undefined {
  const messages = cfg.messages as { tts?: { providers?: Record<string, SpeechEntry> } } | undefined;
  return messages?.tts?.providers?.openai;
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI cloud voice migration", () => {
  it("points the cloud voice at the proxy, pins the model and carries the token", () => {
    const { cfg, changed } = migrate({});

    expect(changed).toBe(true);
    // All three are load-bearing, measured on .65 on 2026-08-22: without the
    // baseUrl the call goes to api.openai.com and 401s on a claw_ token;
    // without the model pin the proxy answers 400 because it serves exactly
    // one speech model; and the documented apiKey fallback for OpenAI TTS is
    // the OPENAI_API_KEY environment variable, which a ClawBox does not set.
    expect(speech(cfg)).toEqual({ baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
  });

  it("leaves the on-device voice and the customer's chosen primary untouched", () => {
    const local = { command: "/home/clawbox/clawbox/scripts/openclaw/clawbox-tts.sh", outputFormat: "wav" };
    const { cfg } = migrate({
      messages: { tts: { provider: "tts-local-cli", providers: { "tts-local-cli": local } } },
    });

    const tts = (cfg.messages as { tts: { provider: string; providers: Record<string, unknown> } }).tts;
    // Which engine speaks is the customer's choice and the panel's write. A
    // migration that also moved the primary would silently switch a box that
    // had deliberately picked its own voice.
    expect(tts.provider).toBe("tts-local-cli");
    expect(tts.providers["tts-local-cli"]).toEqual(local);
    expect(speech(cfg)).toEqual({ baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
  });

  it("is idempotent — a second start rewrites nothing", () => {
    const first = migrate({});
    const second = migrate(first.cfg);

    expect(second.changed).toBe(false);
    expect(speech(second.cfg)).toEqual({ baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
  });

  it("adopts and stamps an unmarked entry that already points at us", () => {
    // A hand repair, or one written before the stamp existed. Writing is
    // recoverable and deleting is not, which is why only the removal path
    // insists on the stamp.
    const { cfg, changed } = migrate({
      messages: { tts: { providers: { openai: { baseUrl: PROXY, model: "stale-model" } } } },
    });

    expect(changed).toBe(true);
    expect(speech(cfg)).toEqual({ baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
  });

  it("re-points a box whose token was rotated", () => {
    const { cfg, changed } = migrate({
      messages: { tts: { providers: { openai: { baseUrl: PROXY, model: SPEECH_MODEL, apiKey: "claw_stale", ...MANAGED } } } },
    });

    expect(changed).toBe(true);
    expect(speech(cfg)?.apiKey).toBe(TOKEN);
  });

  it("keeps any other key the entry already carries, such as a chosen voice", () => {
    const { cfg } = migrate({
      messages: { tts: { providers: { openai: { speakerVoice: "cedar" } } } },
    });

    // Only the three fields this migration owns, plus its stamp, are written.
    // A customer who picked a voice keeps it.
    expect(speech(cfg)).toEqual({ speakerVoice: "cedar", baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
  });

  describe("takes the cloud voice back when the box stops being entitled", () => {
    // Without this the migration is one-way: a box that was Max and is not any
    // more keeps an entry pointing at an endpoint that now answers 403, so
    // every spoken reply buys a refused round trip before falling back, and the
    // panel calls the cloud voice configured while it does it.
    const ours = { baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED };

    it("removes the entry it wrote when the plan drops to Pro", () => {
      const { cfg, changed, log } = migrate(
        { messages: { tts: { providers: { openai: ours } } } },
        { deviceTier: PRO_DEVICE_TIER },
      );

      expect(changed).toBe(true);
      expect(speech(cfg)).toBeUndefined();
      expect(log).toContain("no longer includes it");
    });

    it("leaves the customer's chosen primary alone so the downgrade is visible", () => {
      const { cfg } = migrate(
        {
          messages: {
            tts: {
              provider: "openai",
              providers: { openai: ours, "tts-local-cli": { command: "/x" } },
            },
          },
        },
        { deviceTier: PRO_DEVICE_TIER },
      );

      const tts = (cfg.messages as { tts: { provider: string; providers: Record<string, unknown> } }).tts;
      // Rewriting their pick would hide the downgrade. The panel's job is to
      // show that the chosen voice is gone and the box is speaking locally.
      expect(tts.provider).toBe("openai");
      expect(tts.providers.openai).toBeUndefined();
      expect(tts.providers["tts-local-cli"]).toEqual({ command: "/x" });
    });

    it("leaves an unstamped entry on our own host alone", () => {
      // Ownership of models.providers.openai is decided upstream and says
      // nothing about who wrote this. An entry pointing here that we did not
      // stamp is somebody's hand-written config, and deleting it is the one
      // irreversible thing this migration can do.
      const unstamped = { baseUrl: PROXY, model: "some-other-tts", apiKey: "claw_theirs" };
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: unstamped } } } },
        { deviceTier: PRO_DEVICE_TIER },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(unstamped);
    });

    it("does not take an owner's own cloud voice away with it", () => {
      const own = { baseUrl: "https://api.openai.com/v1", model: "tts-1-hd", apiKey: "sk-owner" };
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: own } } } },
        { deviceTier: PRO_DEVICE_TIER },
      );

      // Their voice is theirs whatever their ClawBox AI plan says.
      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
    });

    it("does nothing on an unentitled box that never had one", () => {
      const { cfg, changed } = migrate({}, { deviceTier: PRO_DEVICE_TIER });
      expect(changed).toBe(false);
      expect(speech(cfg)).toBeUndefined();
    });

    it("stays out of a box whose openai slot belongs to its owner", () => {
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: ours } } } },
        { deviceTier: PRO_DEVICE_TIER, routeIsOurs: false },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(ours);
    });
  });

  describe("does not touch a box that is not entitled to the cloud voice", () => {
    // The proxy gates speech to Max (SPEECH_MODEL_TIERS) and answers 403 to
    // everyone else. Pointing a Pro box at it would make the panel call the
    // cloud voice configured, move Auto onto it, and buy a failed round trip
    // before every spoken reply.
    it("leaves a Pro box alone", () => {
      const { cfg, changed } = migrate({}, { deviceTier: PRO_DEVICE_TIER });
      expect(changed).toBe(false);
      expect(speech(cfg)).toBeUndefined();
    });

    it("leaves a box whose plan nobody has confirmed alone", () => {
      const { cfg, changed } = migrate({}, { deviceTier: null });
      expect(changed).toBe(false);
      expect(speech(cfg)).toBeUndefined();
    });

    it("leaves a box with no device store alone", () => {
      const { cfg, changed } = migrate({}, { storeExists: false });
      expect(changed).toBe(false);
      expect(speech(cfg)).toBeUndefined();
    });

    it("treats an unreadable device store as not-entitled rather than crashing", () => {
      const { cfg, changed } = migrate({}, { storeBody: "not json at all" });
      expect(changed).toBe(false);
      expect(speech(cfg)).toBeUndefined();
    });

    it("treats a device store that is not an object as not-entitled", () => {
      const { cfg, changed } = migrate({}, { storeBody: '["pro"]' });
      expect(changed).toBe(false);
      expect(speech(cfg)).toBeUndefined();
    });
  });

  it("does not touch a box whose openai slot belongs to its owner", () => {
    // Same handover the transcription migration uses: when the image migration
    // decided the slot is not ours, our token must not be written anywhere
    // near it.
    const { cfg, changed } = migrate({}, { routeIsOurs: false });
    expect(changed).toBe(false);
    expect(speech(cfg)).toBeUndefined();
  });

  describe("an owner's own cloud voice", () => {
    it("is left alone, and says so", () => {
      const own = { baseUrl: "https://api.openai.com/v1", model: "tts-1-hd", apiKey: "sk-owner" };
      const { cfg, changed, log } = migrate({ messages: { tts: { providers: { openai: own } } } });

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
      expect(log).toContain("already names its own speech route");
    });

    it("is left alone even when it is a different route on our own host", () => {
      // A host-only match would stamp over a deliberate path. Same rule the
      // transcription migration applies, from the same helper.
      const own = { baseUrl: "https://clawbox.com/their-own-route", model: "tts-1" };
      const { cfg, changed } = migrate({ messages: { tts: { providers: { openai: own } } } });

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
    });

    it("still recognises our own route written with a trailing slash", () => {
      const { cfg, changed } = migrate({
        messages: { tts: { providers: { openai: { baseUrl: `${PROXY}/`, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED } } } },
      });

      // One trailing slash is the only difference that means nothing, so this
      // is ours and gets normalised rather than skipped.
      expect(changed).toBe(true);
      expect(speech(cfg)?.baseUrl).toBe(PROXY);
    });

    it("leaves a deliberate double-slash route alone", () => {
      const own = { baseUrl: `${PROXY}//`, model: "tts-1" };
      const { cfg, changed } = migrate({ messages: { tts: { providers: { openai: own } } } });

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
    });
  });

  it("replaces config the gateway could not read at all", () => {
    // A non-dict at any of these paths is not a customer's choice, it is
    // config the gateway cannot load — the same call the migrations around it
    // make, for the same reason.
    const { cfg, changed } = migrate({ messages: { tts: { providers: "nonsense" } } });

    expect(changed).toBe(true);
    expect(speech(cfg)).toEqual({ baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
  });

  it("honours a staging proxy rather than dragging the box to production", () => {
    const staging = "https://staging.clawbox.com/api/ai";
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({}));
    const store = path.join(dir, "device-store.json");
    writeFileSync(store, JSON.stringify({ clawai_tier: MAX_DEVICE_TIER }));
    const program = [
      "import json, os, sys",
      "cfg = json.load(open(sys.argv[1]))",
      "changed = False",
      "_clawai_openai_route_is_ours = True",
      `_clawai_proxy_base_url = ${JSON.stringify(staging)}`,
      `_clawai_token = ${JSON.stringify(TOKEN)}`,
      SAME_ENDPOINT,
      POLICY,
      "print(json.dumps({'cfg': cfg, 'changed': changed}))",
    ].join("\n");
    const out = execFileSync("python3", ["-c", program, file], {
      encoding: "utf-8",
      env: { ...process.env, CLAWBOX_DEVICE_STORE: store },
    }).trim().split("\n");
    const { cfg } = JSON.parse(out[out.length - 1]);

    expect(speech(cfg)?.baseUrl).toBe(staging);
  });
});
