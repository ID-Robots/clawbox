import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
  /** Run the block in its OpenClaw 2 mode (top-level tts home). */
  v2?: boolean;
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
  const { routeIsOurs = true, deviceTier = MAX_DEVICE_TIER, storeExists = true, storeBody, v2 = false } = opts;
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
    ...(v2 ? ["CLAWBOX_OPENCLAW_V2 = True"] : []),
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

  describe("a box we linked under a previous proxy address (TASK-726)", () => {
    // CLAWBOX_AI_PROXY_URL is env-overridable and moves between releases, so
    // an entry WE wrote can name an endpoint that has since been retired. The
    // rule used to be equality with the CURRENT url, which reads our own entry
    // as the owner's own speech server: the box was skipped and left on a dead
    // route for the life of that address, while the chat provider and the
    // image row were repaired in the same boot.
    const RETIRED = "https://clawbox.com/api/ai-2025";

    it("re-points our own stamped entry at the address that serves today", () => {
      const { cfg, changed, log } = migrate({
        messages: { tts: { providers: { openai: { baseUrl: RETIRED, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED } } } },
      });

      expect(changed).toBe(true);
      expect(speech(cfg)).toEqual({ baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
      expect(log).not.toContain("already names its own speech route");
    });

    it("recognises one by its claw_ token even without the stamp", () => {
      // What a box carries when it was written before the stamp existed. The
      // portal token is ours whatever address it was pointed at.
      const { cfg, changed } = migrate({
        messages: { tts: { providers: { openai: { baseUrl: RETIRED, model: "gpt-4o-mini-tts", apiKey: TOKEN } } } },
      });

      expect(changed).toBe(true);
      expect(speech(cfg)?.baseUrl).toBe(PROXY);
      expect(speech(cfg)).toMatchObject(MANAGED);
    });

    it("takes its own entry back on a downgrade even though the address moved", () => {
      // The mirror image, and the worse half: a box that was Max and is not
      // any more kept OUR dead entry for good, so every spoken reply bought a
      // refused round trip and the panel called the cloud voice configured
      // while it did.
      const { cfg, changed, log } = migrate(
        { messages: { tts: { providers: { openai: { baseUrl: RETIRED, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED } } } } },
        { deviceTier: "free" },
      );

      expect(changed).toBe(true);
      expect(speech(cfg)).toBeUndefined();
      expect(log).toContain("no longer includes it");
    });

    it("leaves a pre-stamp entry alone on a downgrade, narrower than the adopt path on purpose", () => {
      // A `claw_` token is enough to REFRESH an entry — the worst case is our
      // own fields rewritten to our own values — and deliberately not enough to
      // DELETE one: an owner can point our own token at our own proxy with a
      // model of their choosing, and the case above pins that entry as theirs.
      // The narrow residue is a box written before the stamp existed that is
      // ALSO downgraded; it keeps a dead entry, as it did before this change.
      const preStamp = { baseUrl: RETIRED, model: SPEECH_MODEL, apiKey: TOKEN };
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: preStamp } } } },
        { deviceTier: "free" },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(preStamp);
    });

    it("still refuses to take an UNSTAMPED entry on a moved address", () => {
      // The destructive path keeps its positive evidence: the stamp is the
      // authorisation, and an entry we did not write is somebody's own.
      const own = { baseUrl: RETIRED, model: "tts-1", apiKey: "sk-owner" };
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: own } } } },
        { deviceTier: "free" },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
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

    it("is left alone when the owner has repointed OUR OWN stamped entry at their server", () => {
      // `messages.tts.providers.openai` is the only generic OpenAI-compatible
      // speech slot OpenClaw has, so an owner who runs their own has to edit
      // the entry we wrote — and `openclaw config set` edits in place, leaving
      // our `clawboxManaged` key behind on a route that is now theirs.
      const own = {
        baseUrl: "https://kokoro.local/v1",
        model: "kokoro",
        apiKey: "sk-owner",
        voice: "af",
        clawboxManaged: true,
      };
      const { cfg, changed, log } = migrate({ messages: { tts: { providers: { openai: own } } } });

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
      expect(log).toContain("already names its own speech route");
    });

    it("does not delete that entry on a downgrade either", () => {
      // The one irreversible action in the file, and a stale stamp must not be
      // enough to fire it over live owner configuration.
      const own = { baseUrl: "https://kokoro.local/v1", model: "kokoro", apiKey: "sk-owner", clawboxManaged: true };
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: own } } } },
        { deviceTier: "free" },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
    });

    it("is left alone when the owner has repointed it at a KEYLESS server of their own", () => {
      // The keyed case above is the easy one. A local speech server — Kokoro,
      // Piper — needs NO credential, so the address is the only thing that
      // speaks for it. `openclaw config set` edits in place, which is why our
      // `clawboxManaged` stamp is still sitting on an entry that has been
      // theirs since the day they pointed it at their box.
      const own = { baseUrl: "https://kokoro.local/v1", model: "kokoro", clawboxManaged: true };
      const { cfg, changed, log } = migrate({ messages: { tts: { providers: { openai: own } } } });

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
      expect(log).toContain("already names its own speech route");
    });

    it("does not delete that KEYLESS entry on a downgrade either", () => {
      // The one irreversible action in the file. A stamp on an address that
      // was never ours is not a licence to destroy the owner's configuration —
      // and this is the case the keyed pair above cannot see.
      const own = { baseUrl: "https://kokoro.local/v1", model: "kokoro", clawboxManaged: true };
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: own } } } },
        { deviceTier: "free" },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
    });

    it("still repairs our own stamped entry left on a RETIRED proxy address", () => {
      // The reason the rule stopped being an equality test against the current
      // URL: a box linked under a previous address carries an entry WE wrote,
      // pointing at an endpoint that no longer answers. That address is still
      // one of ours, so it is still ours to repair.
      const own = { baseUrl: "https://openclawhardware.dev/api/ai", model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED };
      const { cfg, changed } = migrate({ messages: { tts: { providers: { openai: own } } } });

      expect(changed).toBe(true);
      expect(speech(cfg)).toEqual({ baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
    });

    it("is left alone when it carries the owner's own key on a route of ours that has moved", () => {
      // The credential is what decides after the stamp, and `sk-` is not ours
      // however the endpoint reads.
      const own = { baseUrl: "https://clawbox.com/api/ai-2025", model: "tts-1", apiKey: "sk-owner" };
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

// OpenClaw 2 moved the whole speech block from messages.tts to a top-level
// tts object, inner shape unchanged. Same block, other home — picked from
// CLAWBOX_OPENCLAW_V2, bound via globals() so this preamble can set it.
describe.skipIf(!hasPython3)("the same migration on OpenClaw 2's top-level tts home", () => {
  it("writes the cloud voice under tts.providers and leaves messages alone", () => {
    const { cfg, changed } = migrate({}, { v2: true });
    expect(changed).toBe(true);
    const tts = cfg.tts as { providers?: Record<string, SpeechEntry> } | undefined;
    expect(tts?.providers?.openai).toEqual({ baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
    expect(cfg.messages).toBeUndefined();
  });

  it("takes back only its own stamped entry from the v2 home on a downgrade", () => {
    const seeded = {
      tts: { providers: { openai: { baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED } } },
    };
    const { cfg, changed } = migrate(seeded, { v2: true, deviceTier: PRO_DEVICE_TIER });
    expect(changed).toBe(true);
    const tts = cfg.tts as { providers?: Record<string, SpeechEntry> };
    expect(tts.providers?.openai).toBeUndefined();
  });

  it("leaves an owner's own entry in the v2 home alone on a downgrade", () => {
    const seeded = { tts: { providers: { openai: { baseUrl: "https://their.own/voice", model: "x" } } } };
    const { cfg, changed } = migrate(seeded, { v2: true, deviceTier: PRO_DEVICE_TIER });
    expect(changed).toBe(false);
    const tts = cfg.tts as { providers?: Record<string, SpeechEntry> };
    expect(tts.providers?.openai).toEqual({ baseUrl: "https://their.own/voice", model: "x" });
  });
});

/**
 * The two editions gate cloud speech on the same device tier. They do it from
 * two constants — this script's `CLAWBOX_SPEECH_DEVICE_TIER` and
 * `hermes-tts.ts`'s `CLAWBOX_AI_SPEECH_TIER` — in two languages, because
 * neither runtime can import the other's. Nothing but this case stops them
 * drifting into disagreeing about which boxes have a cloud voice.
 */
describe("both editions gate cloud speech on the same tier", () => {
  it("the shell constant and the TypeScript one are the same value", async () => {
    const { CLAWBOX_AI_SPEECH_TIER } = await import("@/lib/hermes-tts");
    const src = readFileSync(SCRIPT, "utf-8");
    const m = src.match(/^CLAWBOX_SPEECH_DEVICE_TIER\s*=\s*"([^"]+)"/m);
    expect(m, "gateway-pre-start.sh no longer names CLAWBOX_SPEECH_DEVICE_TIER").not.toBeNull();
    expect(m?.[1]).toBe(CLAWBOX_AI_SPEECH_TIER);
  });
});
