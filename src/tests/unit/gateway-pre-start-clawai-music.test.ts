import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAWBOX_AI_MEDIA_PATH,
  CLAWBOX_AI_MUSIC_MODEL,
  CLAWBOX_AI_MUSIC_PROVIDER,
  CLAWBOX_AI_MUSIC_TIER,
} from "@/lib/clawbox-ai-models";
import {
  CLAWAI_MEDIA_FLAGS_KEY,
  CLAWAI_MEDIA_FLAG_WORDS,
  parseClawaiMediaFlags,
} from "@/lib/clawai-media-flags";

// Starts a real process (python3): vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The boot half of the ClawBox AI music provider: boxes in the field never
// re-run the configure route, so arming on an upgrade and taking back on a
// downgrade or a flag switched off both happen here, at gateway start. Like the
// image and voice migrations next door, this runs the block out of the shipped
// .sh rather than a copy, so the test fails if the real script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const PROXY = "https://clawbox.com/api/ai";
const MEDIA_BASE_URL = `${PROXY}/media`;
const TOKEN = "claw_test_token";
const MUSIC_REF = "fal/google/lyria-3-pro-preview";
const MAX = "pro";
const PRO = "flash";
const FREE = "free";

function source(): string {
  return readFileSync(SCRIPT, "utf-8");
}

function slice(from: string, to: string): string {
  const src = source();
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`block not found: ${from}`);
  return src.slice(start, end);
}

/** The URL normaliser and the proxy host set, from the image migration. */
const PROXY_HOSTS = hasPython3 ? slice("from urllib.parse import urlsplit", "def _is_our_image_row(_row):") : "";
/** The refusal reader, from the same place. */
const REFUSED = hasPython3
  ? slice("CLAWBOX_CREDENTIAL_REFUSED_KEY = ", "# Only boxes that actually have ClawBox AI get an image provider")
  : "";
const MUSIC = hasPython3
  ? slice("# Migration: ClawBox AI music generation.", "if isinstance(ds_models, list):")
  : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "clawai-music-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;

interface Options {
  /** `clawai_media_flags` in the device store; `undefined` writes none. */
  flags?: unknown;
  /** The normalised plan stamp the cloud-voice block hands over, or null. */
  plan?: string | null;
  /** The normalised badge stamp, or null. */
  badge?: string | null;
  /** `clawai_credential_refused_at` in the device store. */
  refusedAt?: number;
  /** A device store body that is not JSON at all. */
  storeBody?: string;
  /** The token the image migration read off the deepseek entry. */
  token?: string | null;
  /** The live proxy URL on the deepseek entry. */
  proxy?: string;
  /** OpenClaw 2 (the default) or 1. */
  v2?: boolean;
}

/**
 * Run the extracted block over a whole openclaw.json.
 *
 * The preamble binds only what the real script binds upstream of this point:
 * `cfg`, `changed`, the two config blocks every migration writes through, the
 * deepseek entry and the token read off it, the core generation, and the two
 * tier stamps the cloud-voice block has already read.
 */
function migrate(cfg: Config, opts: Options = {}): { cfg: Config; changed: boolean; log: string } {
  const { plan = MAX, badge = null, token = TOKEN, proxy = PROXY, v2 = true } = opts;
  const flags = Object.hasOwn(opts, "flags") ? opts.flags : ["music"];
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const store = path.join(dir, "device-store.json");
  writeFileSync(
    store,
    opts.storeBody ?? JSON.stringify({
      ...(flags === undefined ? {} : { clawai_media_flags: flags }),
      ...(opts.refusedAt === undefined ? {} : { clawai_credential_refused_at: opts.refusedAt }),
    }),
  );
  const program = [
    "import json, os, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    "agents_defaults = cfg.setdefault('agents', {}).setdefault('defaults', {})",
    "models_providers = cfg.setdefault('models', {}).setdefault('providers', {})",
    `deepseek_provider = {"baseUrl": ${JSON.stringify(proxy)}, "apiKey": ${py(token)}}`,
    `_clawai_token = ${py(token)}`,
    `_clawai_plan_tier = ${py(plan)}`,
    `_clawai_device_tier = ${py(badge)}`,
    `_clawbox_v2 = ${v2 ? "True" : "False"}`,
    PROXY_HOSTS,
    REFUSED,
    MUSIC,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const lines = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    env: { ...process.env, CLAWBOX_DEVICE_STORE: store },
  }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

/** A python literal for a string or a missing value. */
function py(value: string | null): string {
  return value === null ? "None" : JSON.stringify(value);
}

function musicSlot(cfg: Config): unknown {
  const agents = cfg.agents as { defaults?: { mediaModels?: { music?: unknown } } } | undefined;
  return agents?.defaults?.mediaModels?.music;
}

function falEntry(cfg: Config): Record<string, unknown> | undefined {
  const models = cfg.models as { providers?: Record<string, Record<string, unknown>> } | undefined;
  return models?.providers?.fal;
}

/** Exactly what an armed box carries. */
function armed(extraFal: Record<string, unknown> = {}): Config {
  return {
    models: { providers: { fal: { apiKey: TOKEN, baseUrl: MEDIA_BASE_URL, ...extraFal } } },
    agents: { defaults: { mediaModels: { music: { primary: MUSIC_REF } } } },
  };
}

describe("gateway-pre-start.sh music constants", () => {
  // A shell migration cannot import TypeScript, so every value the two writers
  // must agree on is transcribed — and pinned here.
  function pythonConstant(name: string): string {
    const match = new RegExp(`^${name} = (.+)$`, "m").exec(source());
    if (!match) throw new Error(`${name} not found in the boot script`);
    return match[1].trim();
  }

  it("names the same provider, model, tier and media path as the route", () => {
    expect(JSON.parse(pythonConstant("CLAWBOX_MUSIC_PROVIDER"))).toBe(CLAWBOX_AI_MUSIC_PROVIDER);
    expect(JSON.parse(pythonConstant("CLAWBOX_MUSIC_MODEL_REF"))).toBe(CLAWBOX_AI_MUSIC_MODEL);
    expect(JSON.parse(pythonConstant("CLAWBOX_MUSIC_TIER"))).toBe(CLAWBOX_AI_MUSIC_TIER);
    expect(JSON.parse(pythonConstant("CLAWBOX_MEDIA_PATH"))).toBe(CLAWBOX_AI_MEDIA_PATH);
  });

  it("reads the same store key and knows the same flag words", () => {
    expect(JSON.parse(pythonConstant("CLAWBOX_MEDIA_FLAGS_KEY"))).toBe(CLAWAI_MEDIA_FLAGS_KEY);
    const words = pythonConstant("CLAWBOX_MEDIA_FLAG_WORDS").replace(/^\(|\)$/g, "");
    expect(JSON.parse(`[${words}]`)).toEqual([...CLAWAI_MEDIA_FLAG_WORDS]);
  });
});

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI music migration", () => {
  describe("arming", () => {
    it("arms the fal entry and the music slot on a Max box with the flag on", () => {
      const { cfg, changed } = migrate({});

      expect(changed).toBe(true);
      expect(falEntry(cfg)).toEqual({ apiKey: TOKEN, baseUrl: MEDIA_BASE_URL });
      expect(musicSlot(cfg)).toEqual({ primary: MUSIC_REF });
    });

    it("is idempotent — a second start rewrites nothing", () => {
      const first = migrate({});
      const second = migrate(first.cfg);

      expect(second.changed).toBe(false);
      expect(second.cfg).toEqual(first.cfg);
    });

    it("keeps the music slot beside an image slot already there", () => {
      const { cfg } = migrate({ agents: { defaults: { mediaModels: { image: { primary: "litellm/gpt-image-1-mini" } } } } });

      const media = (cfg.agents as { defaults: { mediaModels: Record<string, unknown> } }).defaults.mediaModels;
      expect(media.image).toEqual({ primary: "litellm/gpt-image-1-mini" });
      expect(media.music).toEqual({ primary: MUSIC_REF });
    });

    it("follows a staging proxy the box was provisioned against", () => {
      const staging = "https://staging.example.com/api/ai";
      const { cfg } = migrate({}, { proxy: `${staging}/` });

      expect(falEntry(cfg)?.baseUrl).toBe(`${staging}/media`);
    });

    it("arms on the badge while the plan has never been recorded", () => {
      const { cfg } = migrate({}, { plan: null, badge: MAX });

      expect(musicSlot(cfg)).toEqual({ primary: MUSIC_REF });
    });

    it("accepts a comma-list flag", () => {
      const { cfg } = migrate({}, { flags: " Video_Frames , MUSIC " });

      expect(musicSlot(cfg)).toEqual({ primary: MUSIC_REF });
    });

    it("moves a bare-string slot of ours to the object form", () => {
      const { cfg, changed } = migrate({
        models: { providers: { fal: { apiKey: TOKEN, baseUrl: MEDIA_BASE_URL } } },
        agents: { defaults: { mediaModels: { music: MUSIC_REF } } },
      });

      expect(changed).toBe(true);
      expect(musicSlot(cfg)).toEqual({ primary: MUSIC_REF });
    });
  });

  describe("not armed", () => {
    it.each([
      ["Free", FREE],
      ["Pro", PRO],
    ])("writes nothing on a %s plan", (_label, plan) => {
      const { cfg, changed } = migrate({}, { plan });

      expect(changed).toBe(false);
      expect(falEntry(cfg)).toBeUndefined();
      expect(musicSlot(cfg)).toBeUndefined();
    });

    it("writes nothing while the flag is off — the default", () => {
      const { cfg, changed } = migrate({}, { flags: undefined });

      expect(changed).toBe(false);
      expect(falEntry(cfg)).toBeUndefined();
    });

    it("ignores flag words it does not know", () => {
      const { changed } = migrate({}, { flags: ["musik", 7, null] });

      expect(changed).toBe(false);
    });

    it("lets a recorded Pro plan outrank a Max badge", () => {
      const { changed } = migrate({}, { plan: PRO, badge: MAX });

      expect(changed).toBe(false);
    });

    it("does nothing on a box with no ClawBox AI token", () => {
      const { cfg, changed } = migrate(armed(), { token: null });

      expect(changed).toBe(false);
      expect(musicSlot(cfg)).toEqual({ primary: MUSIC_REF });
    });

    it("writes nothing on an OpenClaw 1 core", () => {
      const { changed, log } = migrate({}, { v2: false });

      expect(changed).toBe(false);
      expect(log).toContain("no music slot");
    });

    it("leaves a music model the owner chose alone", () => {
      const theirs = { agents: { defaults: { mediaModels: { music: { primary: "minimax/music-2.6" } } } } };
      const { cfg, changed } = migrate(theirs);

      expect(changed).toBe(false);
      expect(musicSlot(cfg)).toEqual({ primary: "minimax/music-2.6" });
      expect(falEntry(cfg)).toBeUndefined();
    });

    it("never overwrites an owner's own fal key", () => {
      const { cfg, changed } = migrate({ models: { providers: { fal: { apiKey: "fal-own-key" } } } });

      expect(changed).toBe(false);
      expect(falEntry(cfg)).toEqual({ apiKey: "fal-own-key" });
    });

    it("never sends the token to a fal route the owner points elsewhere", () => {
      const { changed } = migrate({ models: { providers: { fal: { baseUrl: "https://fal.run" } } } });

      expect(changed).toBe(false);
    });

    it("treats a fal row with no baseUrl of its own as fal's default host, not ours", () => {
      const { changed } = migrate({ models: { providers: { fal: { models: [{ id: "x" }] } } } });

      expect(changed).toBe(false);
    });

    it("stands down on the owner's own fal sign-in or FAL_KEY", () => {
      expect(migrate({ auth: { profiles: { "fal:default": { provider: "fal", mode: "api_key" } } } }).changed).toBe(false);
      expect(migrate({ env: { vars: { FAL_KEY: "fal-own-key" } } }).changed).toBe(false);
      expect(migrate({ env: { vars: { FAL_API_KEY: "fal-own-key" } } }).changed).toBe(false);
    });

    it("does not arm a box whose credential the proxy has refused", () => {
      const { changed } = migrate({}, { refusedAt: 1_760_000_000_000 });

      expect(changed).toBe(false);
    });
  });

  describe("withdrawing", () => {
    it("takes the slot and the whole fal entry back once the plan is recorded below Max", () => {
      const { cfg, changed, log } = migrate(armed(), { plan: PRO });

      expect(changed).toBe(true);
      expect(musicSlot(cfg)).toBeUndefined();
      expect(falEntry(cfg)).toBeUndefined();
      expect(log).toContain("plan no longer includes it");
    });

    it("takes them back when the flag is switched off — the rollback", () => {
      const { cfg, log } = migrate(armed(), { flags: undefined });

      expect(musicSlot(cfg)).toBeUndefined();
      expect(falEntry(cfg)).toBeUndefined();
      expect(log).toContain("music flag is off");
    });

    it("takes them back when the proxy has refused the credential", () => {
      const { cfg, log } = migrate(armed(), { refusedAt: 1_760_000_000_000 });

      expect(musicSlot(cfg)).toBeUndefined();
      expect(falEntry(cfg)).toBeUndefined();
      expect(log).toContain("refused");
    });

    it("withdraws nothing on the badge alone while the plan is unknown", () => {
      const { cfg, changed } = migrate(armed(), { plan: null, badge: PRO });

      expect(changed).toBe(false);
      expect(musicSlot(cfg)).toEqual({ primary: MUSIC_REF });
    });

    it("keeps the owner's own settings on the entry and removes only our two leaves", () => {
      const { cfg } = migrate(armed({ headers: { "X-Team": "house" } }), { plan: FREE });

      expect(falEntry(cfg)).toEqual({ headers: { "X-Team": "house" } });
    });

    it("recognises an entry on a retired proxy host as ours", () => {
      const cfg = armed();
      (cfg.models as { providers: { fal: Record<string, unknown> } }).providers.fal.baseUrl =
        "https://www.openclawhardware.dev/api/ai/media";

      expect(falEntry(migrate(cfg, { plan: FREE }).cfg)).toBeUndefined();
    });

    it("never takes an entry carrying the owner's own key", () => {
      const cfg = armed();
      (cfg.models as { providers: { fal: Record<string, unknown> } }).providers.fal.apiKey = "fal-own-key";

      expect(falEntry(migrate(cfg, { plan: FREE }).cfg)).toEqual({ apiKey: "fal-own-key", baseUrl: MEDIA_BASE_URL });
    });

    it("never takes a slot the owner added fallbacks to", () => {
      const slot = { primary: MUSIC_REF, fallbacks: ["minimax/music-2.6"] };
      const { cfg } = migrate({ agents: { defaults: { mediaModels: { music: slot } } } }, { plan: FREE });

      expect(musicSlot(cfg)).toEqual(slot);
    });

    it("reads an unparseable store as no flag, and fails safe by withdrawing only ours", () => {
      const { cfg } = migrate(armed(), { storeBody: "{not json" });

      expect(musicSlot(cfg)).toBeUndefined();
    });
  });

  describe("flag parsing agrees with the TypeScript reader", () => {
    it.each([
      [["music"]],
      ["music"],
      [" MUSIC , video_frames "],
      [["video_frames", "Music", "music"]],
      [["musik"]],
      [[1, null, "music"]],
      [""],
      [42],
      [{ music: true }],
    ])("store value %j", (value) => {
      const file = path.join(dir, "store.json");
      writeFileSync(file, JSON.stringify({ clawai_media_flags: value }));
      const reader = slice("def _clawai_media_flags():", "def _music_ref_is_ours(_ref):");
      const program = [
        "import json, os",
        `CLAWBOX_MEDIA_FLAGS_KEY = ${JSON.stringify(CLAWAI_MEDIA_FLAGS_KEY)}`,
        `CLAWBOX_MEDIA_FLAG_WORDS = (${CLAWAI_MEDIA_FLAG_WORDS.map((word) => JSON.stringify(word)).join(", ")})`,
        reader,
        "print(json.dumps(sorted(_clawai_media_flags())))",
      ].join("\n");
      const python = JSON.parse(execFileSync("python3", ["-c", program], {
        encoding: "utf-8",
        env: { ...process.env, CLAWBOX_DEVICE_STORE: file },
      }).trim());

      expect(python).toEqual([...parseClawaiMediaFlags(value)].sort());
    });
  });
});
