import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Video understanding on a paired box, without a new provider: the gateway's
// own media-understanding surface runs a `type: "cli"` row tagged
// capabilities: ["video"], and that row samples frames with ffmpeg and asks the
// ClawBox AI vision model the box already has. The row is written by the boot
// migration, behind CLAWBOX_AI_VIDEO_UNDERSTANDING (off unless set) and the Max
// plan, and taken back by the same migration when either goes away.
//
// Like the audio and image migrations, these run the block out of the shipped
// .sh rather than a copy, so the test fails if the real script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const HELPER_NAME = "clawai-video-describe.py";
const SHIPPED_HELPER = path.resolve(process.cwd(), "scripts/openclaw", HELPER_NAME);
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
/** The interpreter the block runs under, which is the one it names as the row's command. */
const PYTHON = hasPython3
  ? execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" }).trim()
  : "";

const PROXY = "https://clawbox.com/api/ai";
const TOKEN = "claw_test_0000000000000000000000000000";
const FLAG = "CLAWBOX_AI_VIDEO_UNDERSTANDING";
const VISION_ID = "deepseek-v4-flash-vision-exp";

/** The block between two markers, or "" when the shipped script has no such block. */
function slice(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  const end = start < 0 ? -1 : src.indexOf(to, start);
  return start < 0 || end < 0 ? "" : src.slice(start, end);
}

/** How a row is recognised as ours. It lives in the speech-to-text block, which asks it too. */
const VIDEO_ROW_RULE = hasPython3
  ? slice("# The ClawBox AI video row, recognised here", "def _is_clawbox_audio_model(_entry):")
  : "";
/** The video migration, verbatim. */
const MIGRATION = hasPython3
  ? slice("# Migration: ClawBox AI video understanding", "# Every migration above has run")
  : "";

let dir: string;
let root: string;
let bin: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawai-video-"));
  root = path.join(dir, "clawbox");
  mkdirSync(path.join(root, "scripts", "openclaw"), { recursive: true });
  // The migration only asks whether the helper is installed; what it does is
  // clawai-video-describe.test.ts's business.
  writeFileSync(path.join(root, "scripts", "openclaw", HELPER_NAME), "# helper\n");
  bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "ffmpeg"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "ffmpeg"), 0o755);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type Row = Record<string, unknown>;

interface Box {
  /** Value of the flag in the gateway's environment; null leaves it unset. */
  flag?: string | null;
  /** Lines of $CLAWBOX_ROOT/.env. */
  dotenv?: string;
  /** `clawai_plan_tier` / `clawai_tier` as the cloud-voice block reads them. */
  plan?: string | null;
  device?: string | null;
  v2?: boolean;
  ffmpeg?: boolean;
}

/**
 * Run the extracted block over a whole openclaw.json.
 *
 * The preamble binds only what the real script binds upstream of this point:
 * `cfg`, `changed`, `deepseek_provider` (read the way line ~2383 reads it),
 * `_clawbox_root`, and the two tier stamps the cloud-voice block reads out of
 * the device store. The default box is paired, on Max, with the flag on.
 */
function migrate(cfg: Config, box: Box = {}): { cfg: Config; changed: boolean; log: string } {
  const { flag = "1", dotenv, plan = "pro", device = "pro", v2 = true, ffmpeg = true } = box;
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  if (dotenv !== undefined) writeFileSync(path.join(root, ".env"), dotenv);
  if (!ffmpeg) rmSync(path.join(bin, "ffmpeg"), { force: true });
  const program = [
    "import json, os, shutil, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    `_clawbox_root = ${JSON.stringify(root)}`,
    `_clawai_plan_tier = ${plan === null ? "None" : JSON.stringify(plan)}`,
    `_clawai_device_tier = ${device === null ? "None" : JSON.stringify(device)}`,
    `CLAWBOX_OPENCLAW_V2 = ${v2 ? "True" : "False"}`,
    "deepseek_provider = (",
    "    cfg.get('models', {}).get('providers', {}).get('deepseek')",
    "    if isinstance(cfg.get('models'), dict) else None",
    ")",
    VIDEO_ROW_RULE,
    MIGRATION,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: bin, HOME: dir, LANG: "C.UTF-8" };
  if (flag !== null) env[FLAG] = flag;
  const lines = execFileSync(PYTHON, ["-c", program, file], { encoding: "utf-8", env }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

/** A box paired to ClawBox AI, with the vision model the vision migration writes. */
function paired(extra: Config = {}): Config {
  return {
    models: {
      providers: {
        deepseek: {
          baseUrl: PROXY,
          apiKey: TOKEN,
          api: "openai-completions",
          models: [
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", input: ["text"] },
            { id: VISION_ID, name: "ClawBox AI Vision", input: ["text", "image"] },
          ],
        },
      },
    },
    agents: { defaults: { imageModel: { primary: `deepseek/${VISION_ID}` } } },
    ...extra,
  };
}

function videoRow(): Row {
  return {
    type: "cli",
    command: PYTHON,
    args: [
      path.join(root, "scripts", "openclaw", HELPER_NAME),
      "--max-chars",
      "{{MaxChars}}",
      "--prompt",
      "{{Prompt}}",
      "{{AttachmentPath}}",
    ],
    capabilities: ["video"],
  };
}

/** The cloud transcription row the speech-to-text migration seeds on OpenClaw 2. */
const AUDIO_ROW = {
  provider: "openai",
  model: "gpt-4o-mini-transcribe",
  profile: "deepseek:default",
  capabilities: ["audio"],
};

function media(cfg: Config): Record<string, unknown> | undefined {
  return (cfg.tools as { media?: Record<string, unknown> } | undefined)?.media;
}

function withMedia(m: Record<string, unknown>): Config {
  return paired({ tools: { media: m } });
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI video understanding migration", () => {
  it("ships the frames helper the row names", () => {
    expect(existsSync(SHIPPED_HELPER)).toBe(true);
  });

  it("gives a paired Max box a video row that runs the frames helper on its vision model", () => {
    const { cfg, changed, log } = migrate(paired());

    expect(changed).toBe(true);
    expect(media(cfg)?.models).toEqual([videoRow()]);
    // No endpoint of its own: the frames go to the vision model the box
    // already has, through the deepseek provider entry that carries the proxy
    // and the token. Nothing is written under tools.media.video.
    expect(media(cfg)?.video).toBeUndefined();
    expect(log).toContain("ClawBox AI video understanding");
  });

  it("adds the row after the rows already in the shared list, leaving them as they are", () => {
    const { cfg, changed } = migrate(withMedia({ audio: { baseUrl: PROXY }, models: [AUDIO_ROW] }));

    expect(changed).toBe(true);
    expect(media(cfg)?.models).toEqual([AUDIO_ROW, videoRow()]);
    expect(media(cfg)?.audio).toEqual({ baseUrl: PROXY });
  });

  it("is idempotent — a second boot writes nothing", () => {
    const once = migrate(paired());
    const twice = migrate(once.cfg);

    expect(twice.changed).toBe(false);
    expect(twice.cfg).toEqual(once.cfg);
  });

  it("reads the flag from $CLAWBOX_ROOT/.env too", () => {
    const { cfg } = migrate(paired(), { flag: null, dotenv: `# operator switches\nexport ${FLAG}="true"\n` });

    expect(media(cfg)?.models).toEqual([videoRow()]);
  });

  it("refreshes our own row in place when the helper moved, keeping its position", () => {
    const stale = { ...videoRow(), args: ["/old/root/scripts/openclaw/" + HELPER_NAME, "{{MediaPath}}"] };
    const { cfg, changed } = migrate(withMedia({ models: [stale, AUDIO_ROW] }));

    expect(changed).toBe(true);
    expect(media(cfg)?.models).toEqual([videoRow(), AUDIO_ROW]);
  });

  describe("the flag is the switch, and it is off unless set", () => {
    it("writes nothing on a box without the flag", () => {
      const { cfg, changed } = migrate(paired(), { flag: null });

      expect(changed).toBe(false);
      expect(cfg.tools).toBeUndefined();
    });

    it("reads anything but an explicit yes as off", () => {
      for (const value of ["0", "false", "off", "", "maybe"]) {
        const { changed } = migrate(paired(), { flag: value });
        expect(changed, value).toBe(false);
      }
    });

    it("takes its own row back when the flag goes off, and only its own", () => {
      const armed = migrate(withMedia({ models: [AUDIO_ROW] })).cfg;
      const { cfg, changed, log } = migrate(armed, { flag: null });

      expect(changed).toBe(true);
      expect(media(cfg)?.models).toEqual([AUDIO_ROW]);
      expect(log).toContain("Removed the ClawBox AI video row");
    });

    it("leaves no empty list behind when its row was the only one", () => {
      // `models: []` reads as a deliberate "no models here" to the
      // speech-to-text block, so an emptied list would stand it down for good.
      const armed = migrate(paired()).cfg;
      const { cfg, changed } = migrate(armed, { flag: "0" });

      expect(changed).toBe(true);
      expect(media(cfg)).toEqual({});
    });
  });

  describe("the plan", () => {
    it("does not arm on a Pro plan", () => {
      // "pro" is the tier of the MAX plan; "flash" is Pro (see the cloud-voice block).
      const { cfg, changed } = migrate(paired(), { plan: "flash", device: "flash" });

      expect(changed).toBe(false);
      expect(cfg.tools).toBeUndefined();
    });

    it("arms on the badge while the portal has not answered for the plan yet", () => {
      const { cfg } = migrate(paired(), { plan: null, device: "pro" });

      expect(media(cfg)?.models).toEqual([videoRow()]);
    });

    it("withdraws on a plan that is on record and is not Max", () => {
      const armed = migrate(paired()).cfg;
      const { cfg, changed } = migrate(armed, { plan: "free", device: null });

      expect(changed).toBe(true);
      expect(media(cfg)?.models).toBeUndefined();
    });

    it("holds on the badge alone — a Max subscriber may default to Flash", () => {
      const armed = migrate(paired()).cfg;
      const { cfg, changed } = migrate(armed, { plan: null, device: "flash" });

      expect(changed).toBe(false);
      expect(media(cfg)?.models).toEqual([videoRow()]);
    });
  });

  describe("what the row needs to work", () => {
    it("does nothing on a box that is not paired to ClawBox AI", () => {
      const cfg = paired();
      ((cfg.models as Config).providers as Record<string, Row>).deepseek.apiKey = "sk-owner-own-deepseek-key";
      const out = migrate(cfg);

      expect(out.changed).toBe(false);
      expect(out.cfg.tools).toBeUndefined();
    });

    it("takes the row back from a box that has left ClawBox AI", () => {
      const armed = migrate(withMedia({ models: [AUDIO_ROW] })).cfg;
      ((armed.models as Config).providers as Record<string, Row>).deepseek.apiKey = "sk-owner-own-deepseek-key";
      const { cfg, changed } = migrate(armed);

      expect(changed).toBe(true);
      expect(media(cfg)?.models).toEqual([AUDIO_ROW]);
    });

    it("does nothing without a vision model to send the frames to", () => {
      const cfg = paired();
      const ds = ((cfg.models as Config).providers as Record<string, Row>).deepseek;
      ds.models = (ds.models as Row[]).filter((m) => m.id !== VISION_ID);
      const out = migrate(cfg);

      expect(out.changed).toBe(false);
      expect(out.cfg.tools).toBeUndefined();
    });

    it("does not arm without ffmpeg, and says why", () => {
      const { cfg, changed, log } = migrate(paired(), { ffmpeg: false });

      expect(changed).toBe(false);
      expect(cfg.tools).toBeUndefined();
      expect(log).toContain("ffmpeg");
    });

    it("does not arm when the helper is not installed", () => {
      rmSync(path.join(root, "scripts", "openclaw", HELPER_NAME));
      const { cfg, changed } = migrate(paired());

      expect(changed).toBe(false);
      expect(cfg.tools).toBeUndefined();
    });
  });

  describe("the owner's own configuration", () => {
    it("stands down beside a video route of the owner's", () => {
      const owner = { provider: "google", model: "gemini-3-flash-preview", capabilities: ["image", "video"] };
      const { cfg, changed, log } = migrate(withMedia({ models: [owner] }));

      expect(changed).toBe(false);
      expect(media(cfg)?.models).toEqual([owner]);
      expect(log).toContain("Skipped ClawBox AI video understanding");
    });

    it("stands down when the owner turned video understanding off", () => {
      const { cfg, changed } = migrate(withMedia({ video: { enabled: false } }));

      expect(changed).toBe(false);
      expect(media(cfg)).toEqual({ video: { enabled: false } });
    });

    it("leaves an empty shared list alone rather than claiming it", () => {
      const { cfg, changed } = migrate(withMedia({ models: [] }));

      expect(changed).toBe(false);
      expect(media(cfg)).toEqual({ models: [] });
    });

    it("treats a CLI row running some other script as the owner's", () => {
      const owner = { type: "cli", command: "/usr/local/bin/describe", args: ["{{AttachmentPath}}"], capabilities: ["video"] };
      const { cfg, changed } = migrate(withMedia({ models: [owner] }));

      expect(changed).toBe(false);
      expect(media(cfg)?.models).toEqual([owner]);
    });
  });

  describe("the list's home", () => {
    it("writes tools.media.video.models on an OpenClaw 1 home", () => {
      const { cfg, changed } = migrate(paired(), { v2: false });

      expect(changed).toBe(true);
      expect(media(cfg)?.models).toBeUndefined();
      expect(media(cfg)?.video).toEqual({ models: [videoRow()] });
    });

    it("does not seed the shared list beside a legacy video.models key the core has not moved yet", () => {
      const legacy = { video: { models: null } };
      const { cfg, changed } = migrate(withMedia(legacy));

      expect(changed).toBe(false);
      expect(media(cfg)).toEqual(legacy);
    });
  });
});
