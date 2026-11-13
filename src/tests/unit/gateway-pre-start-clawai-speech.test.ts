import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
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
/**
 * The hosts ClawBox has ever written as its AI proxy — the live one plus the
 * retired ones — and the URL normaliser that builds them, taken from the
 * shipped script rather than restated here. `_clawai_host_is_ours` is the arm
 * that decides whether a route the owner did not key is theirs, and a second
 * copy of that list would let the two answers drift.
 */
const PROXY_HOSTS = hasPython3 ? slice("from urllib.parse import urlsplit", "def _is_our_image_row(_row):") : "";
const SAME_ENDPOINT = hasPython3 ? slice("def _same_endpoint(_a, _b):", "if _clawai_openai_route_is_ours:") : "";
const POLICY = hasPython3
  ? slice("# Migration: ClawBox AI cloud voice (text to speech).", "if isinstance(ds_models, list):")
  : "";
/** The local-only AI lock's reader (TASK-2501), which the speech-to-text block defines first. */
const LOCK_READER = hasPython3 ? slice("def _clawbox_cloud_ai_locked():", "# end of the local-only AI lock reader") : "";

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
  /**
   * `clawai_plan_tier` in the device store — the portal's PLAN, or `null` for a
   * box whose plan the portal has never answered for.
   */
  planTier?: string | null;
  /** `false` writes no device store at all — a box the Next app has never run on. */
  storeExists?: boolean;
  /** A device store that is not an object, or not JSON. */
  storeBody?: string;
  /** Run the block in its OpenClaw 2 mode (top-level tts home). */
  v2?: boolean;
  /** More device-store keys — the local-only AI lock (TASK-2501). */
  extraStore?: Record<string, unknown>;
}

/**
 * Run the extracted block over a whole openclaw.json.
 *
 * The preamble binds only what the real script binds upstream of this point:
 * `cfg`, `changed`, the two names the image migration hands over once it has
 * decided the `openai` slot is ours, and the token it took from the ClawBox AI
 * provider entry. `CLAWBOX_DEVICE_STORE` is the env var the shell exports.
 */
function migrate(cfg: Config, opts: Options = {}): { cfg: Config; changed: boolean; log: string; heldToRemove: string | null; lockApplied: boolean } {
  const {
    routeIsOurs = true,
    deviceTier = MAX_DEVICE_TIER,
    planTier = null,
    storeExists = true,
    storeBody,
    v2 = false,
    extraStore = {},
  } = opts;
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const store = path.join(dir, "device-store.json");
  if (storeExists) {
    writeFileSync(
      store,
      storeBody ?? JSON.stringify({
        ...(deviceTier === null ? {} : { clawai_tier: deviceTier }),
        ...(planTier === null ? {} : { clawai_plan_tier: planTier }),
        ...extraStore,
      }),
    );
  }
  const program = [
    "import json, os, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    `_clawai_openai_route_is_ours = ${routeIsOurs ? "True" : "False"}`,
    `_clawai_proxy_base_url = ${JSON.stringify(PROXY)}`,
    `_clawai_token = ${JSON.stringify(TOKEN)}`,
    // The ClawBox AI provider entry the image migration read the live proxy
    // off; the only binding the host set above needs.
    `deepseek_provider = {"baseUrl": ${JSON.stringify(PROXY)}}`,
    PROXY_HOSTS,
    SAME_ENDPOINT,
    LOCK_READER,
    ...(v2 ? ["CLAWBOX_OPENCLAW_V2 = True"] : []),
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed, 'heldToRemove': globals().get('_clawbox_tts_held_to_remove'), 'lockApplied': globals().get('_clawbox_tts_lock_applied', False)}))",
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
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
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
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
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
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(unstamped);
    });

    it("does not take an owner's own cloud voice away with it", () => {
      const own = { baseUrl: "https://api.openai.com/v1", model: "tts-1-hd", apiKey: "sk-owner" };
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: own } } } },
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
      );

      // Their voice is theirs whatever their ClawBox AI plan says.
      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(own);
    });

    it("does nothing on an unentitled box that never had one", () => {
      const { cfg, changed } = migrate({}, { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER });
      expect(changed).toBe(false);
      expect(speech(cfg)).toBeUndefined();
    });

    it("stays out of a box whose openai slot belongs to its owner", () => {
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: ours } } } },
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER, routeIsOurs: false },
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
      const { cfg, changed } = migrate({}, { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER });
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

  // TASK-744. `clawai_tier` is `mapPortalTier`'s answer, and that function
  // prefers the portal's `deviceTier` STAMP on purpose — it answers "what
  // should this box default to", and a Max subscriber is allowed to run Flash
  // here. `clawbox-ai-portal-tier.ts` says the rule outright: "Read the first
  // for a default to write; read this one [`mapPortalPlanTier`] before refusing
  // anything." This block both refuses and DELETES on the device default, so a
  // Max subscriber whose box is stamped `deviceTier: flash` had his cloud voice
  // removed at every gateway start.
  describe("the entitlement is the PLAN, and the device stamp only when the plan is unknown", () => {
    const ours = { baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED };

    it("keeps the cloud voice of a Max subscriber whose device is stamped flash", () => {
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: ours } } } },
        { deviceTier: PRO_DEVICE_TIER, planTier: MAX_DEVICE_TIER },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(ours);
    });

    it("arms one for that box in the first place", () => {
      const { cfg, changed } = migrate({}, { deviceTier: PRO_DEVICE_TIER, planTier: MAX_DEVICE_TIER });

      expect(changed).toBe(true);
      expect(speech(cfg)).toEqual(ours);
    });

    it("still takes the voice back when the PLAN itself has dropped", () => {
      // The mirror case, and the one the withdrawal exists for: the plan is Pro,
      // which the proxy answers 403 to, whatever this box's stamp says.
      const { cfg, changed, log } = migrate(
        { messages: { tts: { providers: { openai: ours } } } },
        { deviceTier: MAX_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
      );

      expect(changed).toBe(true);
      expect(speech(cfg)).toBeUndefined();
      expect(log).toContain("no longer includes it");
    });

    it("does not arm a Pro plan whose device stamp says otherwise", () => {
      const { cfg, changed } = migrate({}, { deviceTier: MAX_DEVICE_TIER, planTier: PRO_DEVICE_TIER });

      expect(changed).toBe(false);
      expect(speech(cfg)).toBeUndefined();
    });

    it("takes the voice back from a CANCELLED subscription", () => {
      // H1 of the review, and the commoner of the two downgrade paths. The
      // portal answers "no paid plan" and BOTH `mapPortalTier` and
      // `mapPortalPlanTier` map that to null, so without a positive word for it
      // a cancellation is indistinguishable from a box nobody has asked about
      // and the entry stays, 403-ing, for good. `free` is that word.
      const { cfg, changed, log } = migrate(
        { messages: { tts: { providers: { openai: ours } } } },
        { deviceTier: null, planTier: "free" },
      );

      expect(changed).toBe(true);
      expect(speech(cfg)).toBeUndefined();
      expect(log).toContain("no longer includes it");
    });

    it("does not arm a cancelled subscription either", () => {
      const { cfg, changed } = migrate({}, { deviceTier: MAX_DEVICE_TIER, planTier: "free" });

      expect(changed).toBe(false);
      expect(speech(cfg)).toBeUndefined();
    });

    it("falls back to the device stamp when no plan has been recorded", () => {
      // Every box in the field is in this state until the status poll has
      // written the plan once, so the old rule has to keep answering there.
      const { cfg, changed } = migrate({}, { deviceTier: MAX_DEVICE_TIER, planTier: null });

      expect(changed).toBe(true);
      expect(speech(cfg)).toEqual(ours);
    });

    it("ignores a plan stamp that is not a tier we recognise", () => {
      // NOT KNOWING IS NOT AN ANSWER. A junk value is not evidence that the
      // plan has dropped, so it falls through to the stamp rather than
      // withdrawing a working voice over it.
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: ours } } } },
        { deviceTier: MAX_DEVICE_TIER, planTier: "enterprise" },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(ours);
    });

    it("does not withdraw over a plan stamp alone when neither is recognisable", () => {
      const { cfg, changed } = migrate(
        { messages: { tts: { providers: { openai: ours } } } },
        { deviceTier: null, planTier: "enterprise" },
      );

      expect(changed).toBe(false);
      expect(speech(cfg)).toEqual(ours);
    });

    // NOT KNOWING IS NOT AN ANSWER, in the destructive direction too. On beta
    // this edition's `elif` carried no tier test at all, so every reading that
    // was not a positive "pro" — an absent store, an unreadable one, a store
    // with no stamp yet — deleted a working cloud voice. The Hermes arm has
    // required a tier it was actually TOLD since it was written; this is that
    // rule, on the edition that shipped first.
    describe("and a reading we could not make is never one of them", () => {
      it("does not withdraw a working voice over a store with no tier in it", () => {
        const { cfg, changed } = migrate(
          { messages: { tts: { providers: { openai: ours } } } },
          { deviceTier: null },
        );

        expect(changed).toBe(false);
        expect(speech(cfg)).toEqual(ours);
      });

      // A store that cannot be read says nothing about the PLAN, but it may
      // hold the local-only AI lock (TASK-2501), which is read failing closed:
      // not known to be unlocked is locked. Withdrawing is recoverable — the
      // first boot over a readable store arms the voice again (the lock suite
      // at the end pins that) — while speaking through the cloud on a box that
      // may be locked is not.
      it("withdraws the voice over a device store it cannot read, because the lock may be on", () => {
        const { cfg, changed } = migrate(
          { messages: { tts: { providers: { openai: ours } } } },
          { storeBody: "not json at all" },
        );

        expect(changed).toBe(true);
        expect(speech(cfg)).toBeUndefined();
      });

      it("does not withdraw a working voice over a box with no device store", () => {
        const { cfg, changed } = migrate(
          { messages: { tts: { providers: { openai: ours } } } },
          { storeExists: false },
        );

        expect(changed).toBe(false);
        expect(speech(cfg)).toEqual(ours);
      });

      // H2 of the review: the badge may fill in for a missing plan when ARMING
      // and never when DESTROYING. `mapPortalTier` prefers `deviceTier` on
      // purpose, so a Max subscriber running Flash on this box carries exactly
      // this pair — and until his first status poll there is no plan to correct
      // it with. Deleting on the badge is TASK-744 with his configuration gone.
      it("does not withdraw on the device badge alone, however low it reads", () => {
        const { cfg, changed } = migrate(
          { messages: { tts: { providers: { openai: ours } } } },
          { deviceTier: PRO_DEVICE_TIER },
        );

        expect(changed).toBe(false);
        expect(speech(cfg)).toEqual(ours);
      });

      it("does not withdraw over a device stamp that is not a tier we recognise", () => {
        // `normalizeClawboxAiTier` admits `flash` and `pro` and nothing else, so
        // every writer of these stamps produces one of the two. A third string
        // is a store somebody edited or a build we have not seen, and reading it
        // as "below the entitlement" would delete a working voice over a value
        // we cannot interpret.
        const { cfg, changed } = migrate(
          { messages: { tts: { providers: { openai: ours } } } },
          { deviceTier: "free" },
        );

        expect(changed).toBe(false);
        expect(speech(cfg)).toEqual(ours);
      });
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
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
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
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
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
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
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
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
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
        { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER },
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
    const { cfg, changed } = migrate(seeded, { v2: true, deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER });
    expect(changed).toBe(true);
    const tts = cfg.tts as { providers?: Record<string, SpeechEntry> };
    expect(tts.providers?.openai).toBeUndefined();
  });

  it("leaves an owner's own entry in the v2 home alone on a downgrade", () => {
    const seeded = { tts: { providers: { openai: { baseUrl: "https://their.own/voice", model: "x" } } } };
    const { cfg, changed } = migrate(seeded, { v2: true, deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER });
    expect(changed).toBe(false);
    const tts = cfg.tts as { providers?: Record<string, SpeechEntry> };
    expect(tts.providers?.openai).toEqual({ baseUrl: "https://their.own/voice", model: "x" });
  });

  /**
   * TASK-739. The stand-down over a legacy `messages.tts` block says in its own
   * comment that writing the v2 home beside it "would leave two speech configs
   * racing the migration" — and then did exactly that: `_tts = _legacy_tts`
   * binds the SAME dict object as `cfg["messages"]["tts"]`, and the body below
   * it went on to mutate that dict and alias it at `cfg["tts"]`.
   *
   * The written config then carries the block under BOTH homes, which is the
   * `messages: Unrecognized key: "tts"` OpenClaw 2026.8 refuses with exit 78 —
   * one of the four keys that kept a customer box dark for 25 hours
   * (TASK-737). Latent on the healthy path now that the pre-start migrates
   * before this block runs, and one owner action that re-enters this block
   * puts the legacy key straight back.
   */
  it("stands down over a legacy messages.tts block instead of writing it under BOTH homes", () => {
    const local = { command: "/home/clawbox/clawbox/scripts/openclaw/clawbox-tts.sh", outputFormat: "wav" };
    const legacy = { provider: "tts-local-cli", providers: { "tts-local-cli": local } };

    const { cfg, changed } = migrate({ messages: { tts: legacy } }, { v2: true });

    // Nothing written: the core's own migration has not moved this block yet,
    // and the next boot reads the migrated home.
    expect(changed).toBe(false);
    // The key 2026.8 refuses. Present at all is the defect — aliased to the
    // same object as `messages.tts` is how it got there.
    expect(cfg).not.toHaveProperty("tts");
    // …and the owner's legacy block is left exactly as it was. This block is
    // not the migrator; standing down must not edit what it stood down over.
    expect((cfg.messages as { tts: unknown }).tts).toEqual(legacy);
  });

  it("stands down on the KEY, whatever the legacy block holds", () => {
    // The core refuses `messages.tts` for EXISTING, not for its contents:
    // measured against 2026.8.1, `{}`, `{"provider": …}` and `{"providers": {}}`
    // each give `messages: Unrecognized key: "tts"` with exit 1. A
    // contents-based discriminator went on writing the v2 home beside the three
    // shapes that carry no providers map — and `{"provider": "tts-local-cli"}`,
    // the selection written and the map never wired, is a state install.sh
    // already has an error message for.
    //
    // Not a Max box left without a voice, either: the block at the top of this
    // script runs the core's own `doctor --fix` over a config the core refuses
    // BEFORE this program, so the next boot sees the key moved and writes the
    // cloud voice then.
    for (const legacy of [{}, { provider: "tts-local-cli" }, { providers: {} }]) {
      const { cfg, changed } = migrate({ messages: { tts: legacy } }, { v2: true });

      expect(changed).toBe(false);
      expect(cfg).not.toHaveProperty("tts");
      expect((cfg.messages as { tts: unknown }).tts).toEqual(legacy);
    }
  });

  it("writes the v2 home when there is no legacy key at all", () => {
    // The other side of the same guard: standing down on a key that is not
    // there would leave every entitled box without a cloud voice.
    const { cfg, changed } = migrate({ messages: { provider: "telegram" } }, { v2: true });

    expect(changed).toBe(true);
    const tts = cfg.tts as { providers?: Record<string, SpeechEntry> } | undefined;
    expect(tts?.providers?.openai).toEqual({ baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED });
  });

  /**
   * TASK-743 — the DOWNGRADE half only ever looked in the v2 home, and the box
   * it was written for is exactly the one whose entry is not there.
   *
   * A box that was Max under a 2026.7 core wrote its stamped entry into
   * `messages.tts.providers.openai`. Upgrade the core and drop the plan to Pro
   * before the loader migration has moved that block — which is the ordinary
   * order, and is guaranteed on a box whose `doctor --fix` aborts before its
   * state migrations, the same thing that strands the legacy image key one
   * migration earlier in this file — and this arm read `cfg["tts"]`, found
   * nothing, and left our own dead entry in place: every spoken reply buying a
   * 403 round trip while the Voice panel calls the cloud voice configured.
   *
   * Deleting from the legacy home is safe where WRITING to it is not: a
   * removal cannot create the dual-home shape the arming half stands down
   * over, and it leaves the core's own migration less to move rather than more.
   */
  describe("taking the cloud voice back from wherever the entry actually is", () => {
    // The withdrawal reads the PLAN and never the device badge (TASK-744): the
    // badge is `mapPortalTier`'s answer and prefers the portal's `deviceTier`
    // stamp on purpose, so a Max subscriber running Flash carries a low badge
    // and must not lose his voice over it. "A box that was Max and is not any
    // more" — which is what every case here is about — is therefore a box whose
    // PLAN is below the entitlement, and that is what these fixtures record.
    const OURS = { baseUrl: PROXY, model: SPEECH_MODEL, apiKey: TOKEN, ...MANAGED };

    it("takes back a stamped entry stranded in the legacy home", () => {
      const seeded = { messages: { tts: { providers: { openai: { ...OURS } } } } };

      const { cfg, changed } = migrate(seeded, { v2: true, deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER });

      expect(changed).toBe(true);
      const messages = cfg.messages as { tts: { providers: Record<string, SpeechEntry> } };
      expect(messages.tts.providers.openai).toBeUndefined();
      // The rest of the legacy block is untouched — this arm removes one entry,
      // it does not migrate or tidy the home it found it in.
      expect(messages.tts.providers).toEqual({});
    });

    it("takes back an entry in EITHER home when a box carries both", () => {
      const seeded = {
        tts: { providers: { openai: { ...OURS } } },
        messages: { tts: { providers: { openai: { ...OURS } } } },
      };

      const { cfg, changed } = migrate(seeded, { v2: true, deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER });

      expect(changed).toBe(true);
      expect((cfg.tts as { providers: Record<string, SpeechEntry> }).providers.openai).toBeUndefined();
      const messages = cfg.messages as { tts: { providers: Record<string, SpeechEntry> } };
      expect(messages.tts.providers.openai).toBeUndefined();
    });

    it("leaves an owner's own entry in the legacy home alone", () => {
      // The extra home widens WHERE this arm looks, never WHAT it may delete:
      // the stamp is still the only thing that opens the door, and this is the
      // one place in the file that destroys configuration.
      const theirs = { baseUrl: "https://their.own/voice", model: "x" };
      const seeded = { messages: { tts: { providers: { openai: { ...theirs } } } } };

      const { cfg, changed } = migrate(seeded, { v2: true, deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER });

      expect(changed).toBe(false);
      const messages = cfg.messages as { tts: { providers: Record<string, SpeechEntry> } };
      expect(messages.tts.providers.openai).toEqual(theirs);
    });

    it("still reads only the legacy home on a v1 core", () => {
      // `cfg["tts"]` is not a home a 2026.7 core has, and reading it there
      // would be this arm inventing one.
      const seeded = {
        tts: { providers: { openai: { ...OURS } } },
        messages: { tts: { providers: { openai: { ...OURS } } } },
      };

      const { cfg } = migrate(seeded, { deviceTier: PRO_DEVICE_TIER, planTier: PRO_DEVICE_TIER });

      expect((cfg.tts as { providers: Record<string, SpeechEntry> }).providers.openai).toEqual(OURS);
      const messages = cfg.messages as { tts: { providers: Record<string, SpeechEntry> } };
      expect(messages.tts.providers.openai).toBeUndefined();
    });
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

  // TASK-744. The rule is "the PLAN, and the device stamp only when the plan is
  // unknown", written once in TypeScript and transcribed into two shells that
  // cannot import it. These pin the key name and the preference order in all
  // three, so a rename or a reordering fails here rather than on a customer's
  // box six weeks later.
  it("both boot scripts read the plan key and the unpaid word the module names", async () => {
    const { CLAWAI_PLAN_TIER_KEY, CLAWAI_PLAN_UNPAID } = await import("@/lib/clawai-plan-tier");
    const pre = readFileSync(SCRIPT, "utf-8");
    const hermes = readFileSync(path.resolve(process.cwd(), "scripts/register-mcp.sh"), "utf-8");

    expect(pre).toContain(`_one("${CLAWAI_PLAN_TIER_KEY}"`);
    expect(hermes).toContain(`stamped_tier("${CLAWAI_PLAN_TIER_KEY}"`);
    // The third plan value, without which a CANCELLED subscription cannot be
    // told apart from a box nobody has ever asked about.
    expect(pre).toContain(`CLAWBOX_PLAN_UNPAID = "${CLAWAI_PLAN_UNPAID}"`);
    expect(hermes).toContain(`PLAN_UNPAID = "${CLAWAI_PLAN_UNPAID}"`);
  });

  it("both boot scripts arm on the pair and withdraw on the plan alone", async () => {
    // The whole of the card, and the half a key-name check would not catch: the
    // badge may fill in for a missing plan when ARMING, and never when the
    // question is whether to destroy an owner's configuration.
    const pre = readFileSync(SCRIPT, "utf-8");
    const hermes = readFileSync(path.resolve(process.cwd(), "scripts/register-mcp.sh"), "utf-8");

    expect(pre).toContain("_clawai_plan_tier or _clawai_device_tier");
    expect(pre).toContain(
      "_clawai_plan_tier and _clawai_plan_tier != CLAWBOX_SPEECH_DEVICE_TIER",
    );
    expect(hermes).toContain("arm_tier = plan_tier or device_tier");
    expect(hermes).toContain("if plan_tier and plan_tier != ENTITLED_TIER:");
  });

  it("the TypeScript arm rule prefers the plan and falls back to the badge", async () => {
    const { clawaiEntitlementTier } = await import("@/lib/clawai-plan-tier");

    expect(clawaiEntitlementTier("pro", "flash")).toBe("pro");
    expect(clawaiEntitlementTier("flash", "pro")).toBe("flash");
    expect(clawaiEntitlementTier("free", "pro")).toBe("free");
    // Unknown is not an answer, in either slot: it falls through rather than
    // deciding, and two unknowns decide nothing at all.
    expect(clawaiEntitlementTier(null, "pro")).toBe("pro");
    expect(clawaiEntitlementTier("enterprise", "pro")).toBe("pro");
    expect(clawaiEntitlementTier(undefined, undefined)).toBeNull();
    expect(clawaiEntitlementTier("enterprise", "enterprise")).toBeNull();
  });

  it("the TypeScript withdrawal rule reads the plan and NEVER the badge", async () => {
    const { clawaiSpeechWithdrawable } = await import("@/lib/clawai-plan-tier");
    const { CLAWBOX_AI_SPEECH_TIER } = await import("@/lib/hermes-tts");

    // A plan below the entitlement, cancellation included, withdraws.
    expect(clawaiSpeechWithdrawable("flash", CLAWBOX_AI_SPEECH_TIER)).toBe(true);
    expect(clawaiSpeechWithdrawable("free", CLAWBOX_AI_SPEECH_TIER)).toBe(true);
    // The entitled plan, and every shape of not-knowing, do not.
    expect(clawaiSpeechWithdrawable("pro", CLAWBOX_AI_SPEECH_TIER)).toBe(false);
    expect(clawaiSpeechWithdrawable(null, CLAWBOX_AI_SPEECH_TIER)).toBe(false);
    expect(clawaiSpeechWithdrawable(undefined, CLAWBOX_AI_SPEECH_TIER)).toBe(false);
    expect(clawaiSpeechWithdrawable("enterprise", CLAWBOX_AI_SPEECH_TIER)).toBe(false);
    // And it takes ONE argument's worth of evidence: there is no device stamp
    // in this signature to fall back to, which is the point.
    expect(clawaiSpeechWithdrawable.length).toBe(2);
  });
});

// TASK-2501 PR-D: under the local-only AI lock the box speaks with Kokoro only.
describe.skipIf(!hasPython3)("the cloud voice under the local-only AI lock", () => {
  it("never arms an entitled box", () => {
    const { cfg, changed } = migrate({}, { extraStore: { ai_cloud_lock: true } });
    expect(changed).toBe(false);
    expect(speech(cfg)).toBeUndefined();
  });

  it("withdraws the voice ClawBox stamped, and says why", () => {
    const armed = migrate({});
    expect(speech(armed.cfg)).toBeDefined();
    const { cfg, changed, log } = migrate(armed.cfg, { extraStore: { ai_cloud_lock: "pinned" } });
    expect(changed).toBe(true);
    expect(speech(cfg)).toBeUndefined();
    expect(log).toMatch(/local-only AI is on/);
  });

  it("reads an unreadable store as locked", () => {
    const armed = migrate({});
    const { cfg } = migrate(armed.cfg, { storeBody: "{ torn" });
    expect(speech(cfg)).toBeUndefined();
  });

  it("arms the box again once the lock is lifted", () => {
    const locked = migrate(migrate({}).cfg, { extraStore: { ai_cloud_lock: true } });
    const { cfg } = migrate(locked.cfg, { extraStore: { ai_cloud_lock: false } });
    expect(speech(cfg)).toMatchObject({ baseUrl: PROXY, apiKey: TOKEN });
  });

  it("holds an owner's own cloud voices aside, points the gateway at the box's voice, and gives everything back unlocked", () => {
    const local = { command: "/home/clawbox/clawbox/scripts/openclaw/clawbox-tts.sh", outputFormat: "wav" };
    const own = {
      messages: {
        tts: {
          provider: "elevenlabs",
          providers: {
            "tts-local-cli": local,
            openai: { baseUrl: "http://192.168.1.9:8880/v1", apiKey: "sk-own" }, // public-hygiene: allow a private-range address the test needs to exercise the local-only rule
            elevenlabs: { apiKey: "el-own" },
            microsoft: { enabled: true },
          },
        },
      },
    };
    const locked = migrate(own, { routeIsOurs: false, extraStore: { ai_cloud_lock: true } });
    expect(locked.changed).toBe(true);
    const tts = (locked.cfg.messages as { tts: Record<string, unknown> }).tts;
    expect(tts.provider).toBe("tts-local-cli");
    expect(tts.providers).toEqual({ "tts-local-cli": local, microsoft: { enabled: false } });
    const heldFile = path.join(dir, ".tts-local-only-held.json");
    expect(statSync(heldFile).mode & 0o777).toBe(0o600);
    expect(locked.log).toMatch(/own voice only/);

    const unlocked = migrate(locked.cfg, { routeIsOurs: false, extraStore: { ai_cloud_lock: false } });
    expect(unlocked.cfg).toEqual(own);
    // Removed only once the config they went back into is written (the
    // gateway config write, after this pass), never before.
    expect(existsSync(heldFile)).toBe(true);
    expect(unlocked.heldToRemove).toBe(heldFile);
  });

  it("removes the held file only after the gateway config write has landed", () => {
    const script = readFileSync(SCRIPT, "utf-8");
    const write = script.indexOf('os.replace(tmp_path, cfg_path)\n        print("  Updated gateway config")');
    const unlink = script.indexOf('os.unlink(globals()["_clawbox_tts_held_to_remove"])');
    expect(write).toBeGreaterThan(0);
    expect(unlink).toBeGreaterThan(write);
    expect(script.slice(write, unlink)).not.toMatch(/except/);
    // The pass itself no longer removes it.
    expect(POLICY).not.toMatch(/os\.unlink\(_held_path\)/);
  });

  it("does not start the gateway on the old config when the locked rewrite cannot be written either", () => {
    // The real write block, run against a config file in a directory that
    // cannot take the temp file (a full disk, a read-only home): both writes
    // failed. After a locked hold it must stop the start; otherwise it carries
    // on as it always has.
    const block = slice("if changed:\n    # Atomic write", "    # It changes nothing in the config, so it needs no write to land first.");
    const ro = path.join(dir, "ro");
    mkdirSync(ro);
    const cfgPath = path.join(ro, "openclaw.json");
    writeFileSync(cfgPath, "{}");
    chmodSync(ro, 0o500);
    try {
      const run = (applied: boolean) => spawnSync("python3", ["-c", [
        "import json, os, sys, tempfile",
        "cfg = {'messages': {}}",
        "changed = True",
        `cfg_path = ${JSON.stringify(cfgPath)}`,
        "_clawbox_tts_held_to_remove = None",
        `_clawbox_tts_lock_applied = ${applied ? "True" : "False"}`,
        "def _record_memory_rebuild(_x): pass",
        "def _record_keyword_only_rebuild(): pass",
        "_memory_index_changes = None",
        block,
        "print('STARTS')",
      ].join("\n")], { encoding: "utf-8" });
      const locked = run(true);
      expect(locked.status).toBe(1);
      expect(locked.stdout).not.toContain("STARTS");
      expect(locked.stderr).toMatch(/not started on the old config/);
      const unlocked = run(false);
      expect(unlocked.status).toBe(0);
      expect(unlocked.stdout).toContain("STARTS");
      expect(unlocked.stderr).toMatch(/starts on the config already on disk/);
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  it("marks the start as needing its write when the lock held voices aside, and not otherwise", () => {
    const own = { messages: { tts: { provider: "openai", providers: { "tts-local-cli": { command: "/x" }, openai: { apiKey: "sk-own" } } } } };
    expect(POLICY).toContain("_clawbox_tts_lock_applied = True");
    const locked = migrate(own, { routeIsOurs: false, extraStore: { ai_cloud_lock: true } });
    expect(locked.lockApplied).toBe(true);
    expect(migrate(locked.cfg, { routeIsOurs: false, extraStore: { ai_cloud_lock: true } }).lockApplied).toBe(false);
  });

  it("fails closed when the held file cannot be written: the cloud voices are held in place, nothing lost", () => {
    const own = {
      messages: {
        tts: {
          provider: "elevenlabs",
          providers: { "tts-local-cli": { command: "/x" }, elevenlabs: { apiKey: "el-own" }, microsoft: { enabled: true } },
        },
      },
    };
    mkdirSync(path.join(dir, ".tts-local-only-held.json.tmp"));
    const locked = migrate(own, { routeIsOurs: false, extraStore: { ai_cloud_lock: true } });
    const tts = (locked.cfg.messages as { tts: { provider: string; providers: Record<string, unknown> } }).tts;
    expect(tts.provider).toBe("tts-local-cli");
    // Out of the chain: no speech plugin is registered under a held key.
    expect(tts.providers.elevenlabs).toBeUndefined();
    expect(tts.providers["clawbox-held--elevenlabs"]).toEqual({ apiKey: "el-own" });
    expect(tts.providers.microsoft).toEqual({ enabled: false });
    expect(locked.log).toMatch(/held in place/);
    // Asked again under the lock, nothing moves twice.
    const again = migrate(locked.cfg, { routeIsOurs: false, extraStore: { ai_cloud_lock: true } });
    expect(again.cfg).toEqual(locked.cfg);

    const unlocked = migrate(locked.cfg, { routeIsOurs: false, extraStore: { ai_cloud_lock: false } });
    expect(unlocked.cfg).toEqual(own);
  });

  it("fails closed on a held file it cannot read, and never writes over it", () => {
    const heldFile = path.join(dir, ".tts-local-only-held.json");
    writeFileSync(heldFile, "{ torn");
    const own = { messages: { tts: { provider: "openai", providers: { "tts-local-cli": { command: "/x" }, openai: { apiKey: "sk-own" } } } } };
    const locked = migrate(own, { routeIsOurs: false, extraStore: { ai_cloud_lock: true } });
    const tts = (locked.cfg.messages as { tts: { provider: string; providers: Record<string, unknown> } }).tts;
    expect(tts.provider).toBe("tts-local-cli");
    expect(tts.providers.openai).toBeUndefined();
    expect(tts.providers["clawbox-held--openai"]).toEqual({ apiKey: "sk-own" });
    expect(readFileSync(heldFile, "utf-8")).toBe("{ torn");
    expect(locked.log).toMatch(/could not be read/);
  });

  it("never writes over a held file it did not write, and holds in place instead", () => {
    const heldFile = path.join(dir, ".tts-local-only-held.json");
    writeFileSync(heldFile, JSON.stringify({ someone: "else" }));
    const own = { messages: { tts: { provider: "openai", providers: { "tts-local-cli": { command: "/x" }, openai: { apiKey: "sk-own" } } } } };
    const locked = migrate(own, { routeIsOurs: false, extraStore: { ai_cloud_lock: true } });
    const tts = (locked.cfg.messages as { tts: { provider: string; providers: Record<string, unknown> } }).tts;
    expect(tts.provider).toBe("tts-local-cli");
    expect(tts.providers["clawbox-held--openai"]).toEqual({ apiKey: "sk-own" });
    expect(JSON.parse(readFileSync(heldFile, "utf-8"))).toEqual({ someone: "else" });
    expect(locked.log).toMatch(/not one ClawBox wrote/);
    expect(migrate(locked.cfg, { routeIsOurs: false, extraStore: { ai_cloud_lock: false } }).cfg).toEqual(own);
  });

  it("gives the owner's selection back only over the voice the lock chose", () => {
    const own = {
      messages: {
        tts: { provider: "openai", providers: { "tts-local-cli": { command: "/x" }, "piper-local": { command: "/p" }, openai: { apiKey: "sk-own" } } },
      },
    };
    const locked = migrate(own, { routeIsOurs: false, extraStore: { ai_cloud_lock: true } });
    // While locked, the owner picks the other voice on the box.
    const picked = JSON.parse(JSON.stringify(locked.cfg)) as { messages: { tts: { provider: string } } };
    picked.messages.tts.provider = "piper-local";
    const unlocked = migrate(picked, { routeIsOurs: false, extraStore: { ai_cloud_lock: false } });
    const tts = (unlocked.cfg.messages as { tts: { provider: string; providers: Record<string, unknown> } }).tts;
    expect(tts.provider).toBe("piper-local");
    expect(tts.providers.openai).toEqual({ apiKey: "sk-own" });
    // Left on the voice the lock chose, the owner's own selection comes back.
    rmSync(path.join(dir, ".tts-local-only-held.json"), { force: true });
    const relocked = migrate(own, { routeIsOurs: false, extraStore: { ai_cloud_lock: true } });
    expect((migrate(relocked.cfg, { routeIsOurs: false, extraStore: { ai_cloud_lock: false } }).cfg.messages as { tts: { provider: string } }).tts.provider).toBe("openai");
  });
});
