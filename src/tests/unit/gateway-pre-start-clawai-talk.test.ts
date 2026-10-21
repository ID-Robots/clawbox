import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";
import {
  CLAWAI_REALTIME_MODE,
  CLAWAI_REALTIME_MODEL_ID,
  CLAWAI_REALTIME_PROVIDER_ID,
  CLAWAI_REALTIME_TALK_KEY,
  clawaiRealtimeTalkEntitled,
  clawaiRealtimeTalkWithdrawable,
} from "@/lib/clawai-plan-tier";

// Starts a real process (python3): vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Realtime Talk on Max through the ClawBox AI proxy.
//
// OpenClaw's Talk mode reads `talk.realtime`, and on the pinned core every
// built-in realtime provider mints its session secret from an OpenAI Platform
// key the box itself holds (`talk.realtime.providers.*.apiKey`). A ClawBox
// never holds one. So the box selects ClawBox's own realtime provider — the
// `clawbox-realtime-voice` plugin — whose bridge asks the proxy for a
// short-lived OpenAI client secret with the box's `claw_` token. The proxy keeps
// the provider key, checks the Max plan and the weekly minute cap, and the box
// never sees anything but the ephemeral secret.
//
// Like the cloud-voice migration next door, these run the block out of the
// shipped .sh rather than a copy, so the test fails if the real script drifts.
// It is the SAME slice the cloud-voice test runs: the Talk block shares that
// block's plan gate, so they are run together — which is also why `changed` is
// asserted only where the cloud-voice half has nothing to do (a Max box with
// no speech entry gets one written in the same pass).

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const PLUGIN_DIR = path.resolve(process.cwd(), "scripts/openclaw-plugins/clawbox-realtime-voice");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const PROXY = "https://clawbox.com/api/ai";
const TOKEN = "claw_test_token";
/** ClawBox's realtime voice provider id, registered by the clawbox-realtime-voice plugin. */
const PROVIDER = "clawbox";
/** Android Talk takes the Gateway relay only when the mode says realtime. */
const MODE = "realtime";
const TRANSPORT = "gateway-relay";
const MODEL = "gpt-realtime-2.1-mini";
/** The device-store off switch. On (the plan decides) unless it is the boolean false. */
const FLAG = "clawai_realtime_talk_enabled";
/** The plan tier of the MAX plan. The two names are off by one on purpose. */
const MAX = "pro";
/** The plan tier of the PRO plan. */
const PRO = "flash";

function slice(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`block not found: ${from}`);
  return src.slice(start, end);
}

const PROXY_HOSTS = hasPython3 ? slice("from urllib.parse import urlsplit", "def _is_our_image_row(_row):") : "";
const SAME_ENDPOINT = hasPython3 ? slice("def _same_endpoint(_a, _b):", "if _clawai_openai_route_is_ours:") : "";
const POLICY = hasPython3
  ? slice("# Migration: ClawBox AI cloud voice (text to speech).", "if isinstance(ds_models, list):")
  : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "clawai-talk-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type Realtime = {
  provider?: unknown;
  transport?: unknown;
  model?: unknown;
  providers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

interface Options {
  /** What the image migration decided about the ClawBox AI proxy on this box. */
  routeIsOurs?: boolean;
  /** The device store, verbatim; `null` writes none at all. */
  store?: Record<string, unknown> | null;
  /** A device store that is not JSON. */
  storeBody?: string;
  /** The token on the ClawBox AI provider entry. */
  token?: string;
  v2?: boolean;
}

/** The same preamble the cloud-voice test binds: only what the real script binds upstream. */
function migrate(cfg: Config, opts: Options = {}): { cfg: Config; changed: boolean; log: string } {
  const { routeIsOurs = true, store = { clawai_plan_tier: MAX }, storeBody, token = TOKEN, v2 = false } = opts;
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const storePath = path.join(dir, "device-store.json");
  if (storeBody !== undefined) writeFileSync(storePath, storeBody);
  else if (store !== null) writeFileSync(storePath, JSON.stringify(store));
  const program = [
    "import json, os, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    `_clawai_openai_route_is_ours = ${routeIsOurs ? "True" : "False"}`,
    `_clawai_proxy_base_url = ${JSON.stringify(routeIsOurs ? PROXY : "")}`,
    `_clawai_token = ${JSON.stringify(token)}`,
    `deepseek_provider = {"baseUrl": ${JSON.stringify(PROXY)}}`,
    PROXY_HOSTS,
    SAME_ENDPOINT,
    ...(v2 ? ["CLAWBOX_OPENCLAW_V2 = True"] : []),
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const lines = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    env: { ...process.env, CLAWBOX_DEVICE_STORE: storePath },
  }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

function talk(cfg: Config): { realtime?: Realtime; [key: string]: unknown } | undefined {
  return cfg.talk as { realtime?: Realtime } | undefined;
}

const ARMED: Realtime = {
  provider: PROVIDER,
  mode: MODE,
  transport: TRANSPORT,
  model: MODEL,
  providers: { [PROVIDER]: { baseUrl: PROXY, apiKey: TOKEN, clawboxManaged: true } },
};

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI realtime Talk", () => {
  it("selects ClawBox's realtime provider on a Max box, with no OpenAI key anywhere in talk", () => {
    const { cfg, changed } = migrate({}, { store: { clawai_plan_tier: MAX } });

    expect(changed).toBe(true);
    expect(cfg.talk && talk(cfg)?.realtime?.provider).toBe(PROVIDER);
    expect(talk(cfg)?.realtime).toEqual(ARMED);
    // The provider key stays on the proxy. What the box carries is its own
    // `claw_` token, which the proxy trades for a short-lived client secret.
    expect(JSON.stringify(cfg.talk)).not.toMatch(/sk-/);
    expect(JSON.stringify(cfg)).not.toMatch(/sk-/);
  });

  it("gives a Pro box no realtime Talk, so it keeps hold-to-talk", () => {
    const { cfg, changed } = migrate({}, { store: { clawai_plan_tier: PRO } });

    expect(changed).toBe(false);
    expect(talk(cfg)?.realtime).toBeUndefined();
  });

  it("asks for the realtime mode and the Gateway relay, the pair Android Talk needs", () => {
    const { cfg } = migrate({});

    expect(talk(cfg)?.realtime?.mode).toBe("realtime");
    expect(talk(cfg)?.realtime?.transport).toBe("gateway-relay");
  });

  it("gives a Max box that is switched off nothing", () => {
    const { cfg, log } = migrate({}, { store: { clawai_plan_tier: MAX, [FLAG]: false } });

    expect(cfg.talk).toBeUndefined();
    expect(log).not.toContain("realtime Talk");
  });

  it("only the boolean false switches it off", () => {
    for (const value of ["false", 0, "off", null, true]) {
      const { cfg } = migrate({}, { store: { clawai_plan_tier: MAX, [FLAG]: value } });
      expect(talk(cfg)?.realtime, JSON.stringify(value)).toEqual(ARMED);
    }
  });

  it("arms on the device badge while the plan has never been answered", () => {
    const { cfg } = migrate({}, { store: { clawai_tier: MAX } });

    expect(talk(cfg)?.realtime).toEqual(ARMED);
  });

  it("gives a box not linked to ClawBox AI nothing", () => {
    const { cfg, changed } = migrate({}, { routeIsOurs: false });

    expect(changed).toBe(false);
    expect(cfg.talk).toBeUndefined();
  });

  it("is idempotent — a second start rewrites nothing", () => {
    const first = migrate({});
    const second = migrate(first.cfg);

    expect(second.changed).toBe(false);
    expect(talk(second.cfg)?.realtime).toEqual(ARMED);
  });

  it("writes the same block on an OpenClaw 2 core (talk is top-level on both)", () => {
    const { cfg } = migrate({}, { v2: true });

    expect(talk(cfg)?.realtime).toEqual(ARMED);
  });

  it("re-points a box whose token was rotated", () => {
    const stale = { ...ARMED, providers: { [PROVIDER]: { baseUrl: PROXY, apiKey: "claw_stale", clawboxManaged: true } } };
    const { cfg, changed } = migrate({ talk: { realtime: stale } });

    expect(changed).toBe(true);
    expect(talk(cfg)?.realtime?.providers?.[PROVIDER]?.apiKey).toBe(TOKEN);
  });

  it("keeps the owner's other Talk settings and a chosen voice", () => {
    const { cfg } = migrate({
      talk: {
        speechLocale: "bg-BG",
        realtime: { instructions: "Keep it short.", providers: { [PROVIDER]: { speakerVoice: "cedar" } } },
      },
    });

    expect(talk(cfg)?.speechLocale).toBe("bg-BG");
    expect(talk(cfg)?.realtime?.instructions).toBe("Keep it short.");
    expect(talk(cfg)?.realtime?.providers?.[PROVIDER]).toEqual({
      speakerVoice: "cedar",
      baseUrl: PROXY,
      apiKey: TOKEN,
      clawboxManaged: true,
    });
  });

  it("leaves the owner's own realtime provider alone", () => {
    const own = { provider: "openai", providers: { openai: { apiKey: "sk-owner", model: "gpt-realtime-2.1" } } };
    const { cfg, log } = migrate({ talk: { realtime: own } });

    expect(talk(cfg)?.realtime).toEqual(own);
    expect(log).toContain("already names its own realtime provider");
  });

  it("leaves a sole provider the owner configured without naming it alone", () => {
    // Talk's single-provider rule selects a sole configured provider, so this
    // is a working setup of the owner's even with `provider` unset.
    const own = { providers: { google: { apiKey: "AIza-owner" } } };
    const { cfg } = migrate({ talk: { realtime: own } });

    expect(talk(cfg)?.realtime).toEqual(own);
  });

  it("leaves a clawbox entry the owner re-aimed at their own server alone", () => {
    const reaimed = {
      provider: PROVIDER,
      transport: TRANSPORT,
      providers: { [PROVIDER]: { baseUrl: "https://voice.example.net/api", apiKey: "claw_x", clawboxManaged: true } },
    };
    const { cfg } = migrate({ talk: { realtime: reaimed } });

    expect(talk(cfg)?.realtime).toEqual(reaimed);
  });

  describe("takes realtime Talk back", () => {
    it("when the plan drops below Max", () => {
      const { cfg, changed, log } = migrate(
        { talk: { speechLocale: "bg-BG", realtime: ARMED } },
        { store: { clawai_plan_tier: PRO } },
      );

      expect(changed).toBe(true);
      expect(talk(cfg)?.realtime).toBeUndefined();
      expect(talk(cfg)?.speechLocale).toBe("bg-BG");
      expect(log).toContain("Removed ClawBox AI realtime Talk");
    });

    it("when the subscription is cancelled", () => {
      const { cfg } = migrate({ talk: { realtime: ARMED } }, { store: { clawai_plan_tier: "free" } });

      expect(cfg.talk).toBeUndefined();
    });

    it("when the box is switched off, on Max too", () => {
      const { cfg, log } = migrate({ talk: { realtime: ARMED } }, { store: { clawai_plan_tier: MAX, [FLAG]: false } });

      expect(cfg.talk).toBeUndefined();
      expect(log).toContain("it is switched off on this box");
    });

    it("but keeps the owner's own realtime settings beside ours", () => {
      const withTheirs = { ...ARMED, instructions: "Keep it short.", speakerVoice: "cedar" };
      const { cfg } = migrate({ talk: { realtime: withTheirs } }, { store: { clawai_plan_tier: PRO } });

      expect(talk(cfg)?.realtime).toEqual({ instructions: "Keep it short.", speakerVoice: "cedar" });
    });

    it("but keeps a mode or transport the owner changed", () => {
      const changedByOwner = { ...ARMED, mode: "stt-tts", transport: "webrtc" };
      const { cfg } = migrate({ talk: { realtime: changedByOwner } }, { store: { clawai_plan_tier: PRO } });

      expect(talk(cfg)?.realtime).toEqual({ mode: "stt-tts", transport: "webrtc" });
    });

    it("but not over a plan nobody has answered for: the badge alone is a default, not a downgrade", () => {
      const { cfg, changed } = migrate({ talk: { realtime: ARMED } }, { store: { clawai_tier: PRO } });

      expect(changed).toBe(false);
      expect(talk(cfg)?.realtime).toEqual(ARMED);
    });

    it("but not when the store cannot be read: not knowing is not a downgrade", () => {
      const { cfg, changed } = migrate({ talk: { realtime: ARMED } }, { storeBody: "{not json" });

      expect(changed).toBe(false);
      expect(talk(cfg)?.realtime).toEqual(ARMED);
    });

    it("but never an unstamped clawbox entry, which is somebody's hand-written config", () => {
      const unstamped = { ...ARMED, providers: { [PROVIDER]: { baseUrl: PROXY, apiKey: TOKEN } } };
      const { cfg, changed } = migrate({ talk: { realtime: unstamped } }, { store: { clawai_plan_tier: PRO } });

      expect(changed).toBe(false);
      expect(talk(cfg)?.realtime).toEqual(unstamped);
    });

    it("but never the owner's own provider", () => {
      const own = { provider: "openai", providers: { openai: { apiKey: "sk-owner" } } };
      const { cfg, changed } = migrate({ talk: { realtime: own } }, { store: { clawai_plan_tier: PRO } });

      expect(changed).toBe(false);
      expect(talk(cfg)?.realtime).toEqual(own);
    });
  });

  it("gives the TypeScript side the same answer for every plan, badge and switch", () => {
    // `clawaiRealtimeTalkEntitled` / `clawaiRealtimeTalkWithdrawable` are this
    // gate transcribed; run the same stores through both and compare what the
    // box ends up with, rather than comparing source text.
    const plans = [null, MAX, PRO, "free"];
    const badges = [null, MAX, PRO];
    const switches: Array<boolean | undefined> = [false, undefined, true];
    for (const plan of plans) {
      for (const badge of badges) {
        for (const on of switches) {
          const store = {
            ...(plan === null ? {} : { clawai_plan_tier: plan }),
            ...(badge === null ? {} : { clawai_tier: badge }),
            ...(on === undefined ? {} : { [FLAG]: on }),
          };
          const entitled = clawaiRealtimeTalkEntitled(plan, badge, on, MAX);
          const withdrawable = clawaiRealtimeTalkWithdrawable(plan, on, MAX);
          const label = JSON.stringify(store);

          const fresh = talk(migrate({}, { store }).cfg)?.realtime;
          expect(fresh === undefined ? "none" : "armed", label).toBe(entitled ? "armed" : "none");

          const kept = talk(migrate({ talk: { realtime: ARMED } }, { store }).cfg)?.realtime;
          expect(kept === undefined ? "removed" : "kept", label).toBe(!entitled && withdrawable ? "removed" : "kept");
        }
      }
    }
  });

  it("names the provider the shipped plugin registers", () => {
    // The shell writes the id and the plugin registers it; a mismatch is a
    // Talk config naming a provider nothing provides.
    const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "openclaw.plugin.json"), "utf-8"));
    expect(manifest.contracts?.realtimeVoiceProviders?.[0]).toBe(PROVIDER);
    expect(POLICY).toContain(`CLAWBOX_TALK_PROVIDER_ID = "${PROVIDER}"`);
    expect(POLICY).toContain(`CLAWBOX_TALK_MODE = "${MODE}"`);
    expect(POLICY).toContain(`CLAWBOX_TALK_MODEL_ID = "${MODEL}"`);
    expect(POLICY).toContain(`CLAWBOX_TALK_FLAG_KEY = "${FLAG}"`);
    expect([CLAWAI_REALTIME_PROVIDER_ID, CLAWAI_REALTIME_MODE, CLAWAI_REALTIME_MODEL_ID, CLAWAI_REALTIME_TALK_KEY]).toEqual([
      PROVIDER,
      MODE,
      MODEL,
      FLAG,
    ]);
  });

  it("is the only writer of talk.*: install.sh never sets it", () => {
    // install.sh's `step_openclaw_tts` writes the speech home on install and
    // update; a talk write there would race this boot-owned block.
    const install = readFileSync(path.resolve(process.cwd(), "install.sh"), "utf-8");
    expect(install).not.toMatch(/config(?:_set)?\s+(?:set\s+)?["']?talk[.\s"']/);
  });
});

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const PLUGIN_ID = "clawbox-realtime-voice";
const PLUGIN_FILES = ["index.mjs", "openclaw.plugin.json", "package.json", "realtime-bridge.mjs"];

/** The shipped installer, and the realtime plugin's own section of the script. */
function installBlock(): string {
  const installer = slice("# ── Installing a ClawBox hook plugin into ~/.openclaw/extensions ", "# ── The protected-path deny hook ");
  const section = slice("# ── The realtime Talk provider plugin ", "# ── Field cleanup: the retired clawbox-web-taint plugin ");
  return `${installer}\n${section}`;
}

describe.skipIf(!hasPython3 || !hasBash)("gateway-pre-start.sh — the realtime Talk provider plugin", () => {
  let root: string;
  let home: string;
  let configPath: string;

  beforeEach(() => {
    root = path.join(dir, "clawbox");
    home = path.join(dir, ".openclaw");
    configPath = path.join(home, "openclaw.json");
    cpSync(PLUGIN_DIR, path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID), { recursive: true });
    mkdirSync(home, { recursive: true });
  });

  function run(): { status: number; stdout: string; stderr: string } {
    const program = [
      "set -euo pipefail",
      `CLAWBOX_ROOT=${JSON.stringify(root)}`,
      `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
      `OPENCLAW_HOME_DIR=${JSON.stringify(home)}`,
      installBlock(),
    ].join("\n");
    const r = spawnSync("bash", ["-c", program], {
      encoding: "utf-8",
      env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
      timeout: 60_000,
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  const installed = () => {
    const target = path.join(home, "extensions", PLUGIN_ID);
    return existsSync(target) ? readdirSync(target).sort() : [];
  };
  const entry = () => JSON.parse(readFileSync(configPath, "utf-8")).plugins?.entries?.[PLUGIN_ID];

  it("installs, enables and exercises the plugin on a box whose Talk uses it", () => {
    writeFileSync(configPath, JSON.stringify({ talk: { realtime: ARMED } }));
    const r = run();

    expect(r.status).toBe(0);
    expect(installed()).toEqual(PLUGIN_FILES);
    expect(entry()).toEqual({ enabled: true });
    // The installed copy was imported and registered the provider Talk names.
    expect(r.stderr).not.toContain("WARNING");
  });

  it("writes nothing at all on a box that never had it", () => {
    const body = JSON.stringify({ talk: { speechLocale: "bg-BG" }, plugins: { entries: {} } });
    writeFileSync(configPath, body);
    const r = run();

    expect(r.status).toBe(0);
    expect(installed()).toEqual([]);
    expect(readFileSync(configPath, "utf-8")).toBe(body);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("disables, but keeps, a copy left from when the box was armed", () => {
    writeFileSync(configPath, JSON.stringify({ talk: { realtime: ARMED } }));
    run();
    writeFileSync(configPath, JSON.stringify({ plugins: { entries: { [PLUGIN_ID]: { enabled: true } } } }));
    const r = run();

    expect(r.status).toBe(0);
    expect(installed()).toEqual(PLUGIN_FILES);
    expect(entry()).toEqual({ enabled: false });
  });

  it("touches nothing when openclaw.json cannot be read", () => {
    writeFileSync(configPath, "{not json");
    const r = run();

    expect(r.status).toBe(0);
    expect(installed()).toEqual([]);
    expect(readFileSync(configPath, "utf-8")).toBe("{not json");
  });

  it("never stops the gateway over a missing plugin file", () => {
    writeFileSync(configPath, JSON.stringify({ talk: { realtime: ARMED } }));
    rmSync(path.join(root, "scripts", "openclaw-plugins", PLUGIN_ID, "realtime-bridge.mjs"));
    const r = run();

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("hold-to-talk");
    expect(installed()).toEqual([]);
    expect(entry()).toBeUndefined();
  });
});
