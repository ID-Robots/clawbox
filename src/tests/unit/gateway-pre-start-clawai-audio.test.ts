import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// A voice note that arrives over a chat channel is transcribed through
// OpenClaw's media-understanding surface, which is not a models[] row and
// never reads one: it takes its endpoint from `tools.media.audio.baseUrl` and
// its bearer from `models.providers.openai.apiKey`. ClawBox writes that key
// and, before TASK-502, no audio config at all — so every Telegram voice note
// sent the claw_ subscription token to api.openai.com and came back 401.
// Reproduced on both loop boxes on beta 02249c1.
//
// Like the image migration next door, these run the block out of the shipped
// .sh rather than a copy, so the test fails if the real script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const PROXY = "https://clawbox.com/api/ai";
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const CLOUD = { provider: "openai", model: TRANSCRIBE_MODEL };
const OURS = [CLOUD];
/** The on-box row Settings adds (src/lib/stt-preference.ts builds it). */
const LOCAL_CLI = {
  type: "cli",
  command: "/usr/bin/python3",
  args: ["/home/clawbox/.openclaw/workspace/scripts/stt-client.py", "{{MediaPath}}"],
  timeoutSeconds: 120,
  capabilities: ["audio"],
};

function slice(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`block not found: ${from}`);
  return src.slice(start, end);
}

/** The speech-to-text migration, verbatim. */
const POLICY = hasPython3
  // Ends at the cloud-voice migration that now follows it, not at the DeepSeek
  // block further down: the two speech migrations are adjacent, and slicing
  // past this one would run the text-to-speech writes inside these fixtures.
  ? slice("# Migration: ClawBox AI speech to text.", "# Migration: ClawBox AI cloud voice")
  : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "clawai-audio-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type AudioConfig = { baseUrl?: unknown; models?: unknown; [key: string]: unknown };

/**
 * Run the extracted block over a whole openclaw.json.
 *
 * The preamble binds only what the real script binds upstream of this point:
 * `cfg`, `changed`, and the two names the image migration hands over once it
 * has decided the `openai` provider slot is ours
 * (`_clawai_openai_route_is_ours`, `_clawai_proxy_base_url`).
 * `routeIsOurs: false` is the real script's starting value, i.e. a box whose openai slot belongs to its
 * owner or that has no ClawBox AI token at all.
 */
function migrate(cfg: Config, routeIsOurs = true, v2 = false): { cfg: Config; changed: boolean; log: string } {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    `_clawai_openai_route_is_ours = ${routeIsOurs ? "True" : "False"}`,
    `_clawai_proxy_base_url = ${JSON.stringify(PROXY)}`,
    ...(v2 ? ["CLAWBOX_OPENCLAW_V2 = True"] : []),
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const lines = execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

function audio(cfg: Config): AudioConfig | undefined {
  const tools = cfg.tools as { media?: { audio?: AudioConfig } } | undefined;
  return tools?.media?.audio;
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI speech-to-text migration", () => {
  it("points channel audio at the proxy and pins the model production serves", () => {
    const { cfg, changed } = migrate({});

    expect(changed).toBe(true);
    // Both halves are load-bearing against the live proxy: the baseUrl alone
    // gets 400 (OpenClaw's default openai audio model is gpt-4o-transcribe,
    // which the proxy does not serve) and the pin alone still goes to OpenAI.
    expect(audio(cfg)).toEqual({ baseUrl: PROXY, models: OURS });
  });

  it("keeps whatever else already sits under tools.media", () => {
    const { cfg } = migrate({
      tools: {
        media: {
          image: { enabled: true },
          audio: { enabled: true, language: "bg", maxBytes: 1024 },
        },
        other: { keep: "me" },
      },
    });

    expect(audio(cfg)).toEqual({
      enabled: true,
      language: "bg",
      maxBytes: 1024,
      baseUrl: PROXY,
      models: OURS,
    });
    const tools = cfg.tools as { media: Record<string, unknown>; other: unknown };
    expect(tools.media.image).toEqual({ enabled: true });
    expect(tools.other).toEqual({ keep: "me" });
  });

  it("is idempotent — a second boot writes nothing", () => {
    const once = migrate({});
    const twice = migrate(once.cfg);

    expect(twice.changed).toBe(false);
    expect(twice.cfg).toEqual(once.cfg);
  });

  it("does nothing at all when the openai slot is not ours", () => {
    // The image migration refused the slot, so the key on it is the owner's
    // OpenAI credential. Pointing audio at our proxy would post THEIR key to
    // clawbox.com — the mirror image of the leak this fixes.
    const { cfg, changed } = migrate({}, false);

    expect(changed).toBe(false);
    expect(cfg.tools).toBeUndefined();
  });

  it("leaves a foreign transcription endpoint alone and says so", () => {
    const owner = { baseUrl: "https://whisper.lan/v1", models: [{ provider: "openai", model: "whisper-1" }] };
    const { cfg, changed, log } = migrate({ tools: { media: { audio: { ...owner } } } });

    expect(changed).toBe(false);
    expect(audio(cfg)).toEqual(owner);
    expect(log).toContain("Skipped ClawBox AI speech to text");
  });

  it("leaves a different model on our own proxy alone", () => {
    // Same host, deliberate choice of model — still the owner's configuration.
    const owner = { baseUrl: PROXY, models: [{ provider: "openai", model: "gpt-4o-transcribe" }] };
    const { cfg, changed } = migrate({ tools: { media: { audio: { ...owner } } } });

    expect(changed).toBe(false);
    expect(audio(cfg)).toEqual(owner);
  });

  it("leaves another route on our own host alone", () => {
    // Same host, different path: the owner pointed transcription somewhere
    // specific and a host-only comparison would have stamped over it.
    const owner = { baseUrl: "https://clawbox.com/custom-transcribe", models: OURS };
    const { cfg, changed } = migrate({ tools: { media: { audio: { ...owner } } } });

    expect(changed).toBe(false);
    expect(audio(cfg)).toEqual(owner);
  });

  it("normalizes one harmless trailing slash on our managed endpoint", () => {
    const { cfg, changed } = migrate({
      tools: { media: { audio: { baseUrl: `${PROXY}/`, models: OURS } } },
    });

    expect(changed).toBe(true);
    expect(audio(cfg)).toEqual({ baseUrl: PROXY, models: OURS });
  });

  it("leaves repeated trailing slashes alone as a distinct owner route", () => {
    // Removing every trailing slash would turn this into PROXY and overwrite a
    // route the owner explicitly entered. Only one optional slash is syntax.
    const owner = { baseUrl: `${PROXY}//`, models: OURS };
    const { cfg, changed } = migrate({ tools: { media: { audio: { ...owner } } } });

    expect(changed).toBe(false);
    expect(audio(cfg)).toEqual(owner);
  });

  it("keeps an endpoint it cannot make sense of", () => {
    // We cannot say where it points, so we cannot say our token is safe there.
    const owner = { baseUrl: "not a url" };
    const { cfg, changed } = migrate({ tools: { media: { audio: { ...owner } } } });

    expect(changed).toBe(false);
    expect(audio(cfg)).toEqual(owner);
  });

  it("leaves an empty models list alone rather than claiming it", () => {
    // `models: []` is a deliberate "no provider models here", not an absence.
    const { cfg, changed } = migrate({ tools: { media: { audio: { models: [] } } } });

    expect(changed).toBe(false);
    expect(audio(cfg)).toEqual({ models: [] });
  });

  it("repairs a half-written config from an interrupted boot", () => {
    // Our own baseUrl to the character, our pin missing: the transcription would resolve to
    // gpt-4o-transcribe and 400 on every voice note.
    const { cfg, changed } = migrate({ tools: { media: { audio: { baseUrl: PROXY } } } });

    expect(changed).toBe(true);
    expect(audio(cfg)).toEqual({ baseUrl: PROXY, models: OURS });
  });

  it("replaces a non-dict at tools.media.audio rather than booting broken", () => {
    const { cfg, changed } = migrate({ tools: { media: { audio: "yes" } } });

    expect(changed).toBe(true);
    expect(audio(cfg)).toEqual({ baseUrl: PROXY, models: OURS });
  });

  it("follows a staging box to its own proxy", () => {
    // The proxy base url is taken from the deepseek entry upstream, so a box
    // provisioned against staging keeps talking to staging for audio too.
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({}));
    const staging = "https://staging.clawbox.com/api/ai";
    const program = [
      "import json, sys",
      "cfg = json.load(open(sys.argv[1]))",
      "changed = False",
      "_clawai_openai_route_is_ours = True",
      `_clawai_proxy_base_url = ${JSON.stringify(staging)}`,
      POLICY,
      "print(json.dumps({'cfg': cfg, 'changed': changed}))",
    ].join("\n");
    const out = execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim().split("\n");
    const { cfg } = JSON.parse(out[out.length - 1]) as { cfg: Config };

    expect(audio(cfg)).toEqual({ baseUrl: staging, models: OURS });
  });

  it("pins the model the transcribe route uses, so both paths bill the same thing", () => {
    // The constant moved next to the audio-config builder so the chat mic and
    // the gateway read one definition; the shell copy has to match it.
    const preference = readFileSync(
      path.resolve(process.cwd(), "src/lib/stt-preference.ts"),
      "utf-8",
    );

    expect(preference).toContain(`"${TRANSCRIBE_MODEL}"`);
    expect(POLICY).toContain(`CLAWBOX_TRANSCRIBE_MODEL_ID = "${TRANSCRIBE_MODEL}"`);
  });

  describe("an engine order saved from Settings", () => {
    // /setup-api/stt writes the on-box CLI row into the same list, in the
    // order the owner chose. Before this the migration knew exactly one shape
    // and called everything else the owner's own route — which would have
    // been right about the words and wrong about the effect: a preference
    // saved from Settings was ours, and a boot must not undo it.

    it("leaves [cloud, on-box] alone", () => {
      const saved = { baseUrl: PROXY, models: [CLOUD, LOCAL_CLI] };
      const { cfg, changed, log } = migrate({ tools: { media: { audio: { ...saved } } } });

      expect(changed).toBe(false);
      expect(audio(cfg)).toEqual(saved);
      expect(log).not.toContain("Skipped");
    });

    it("leaves [on-box, cloud] alone — the order IS the preference", () => {
      const saved = { baseUrl: PROXY, models: [LOCAL_CLI, CLOUD] };
      const { cfg, changed } = migrate({ tools: { media: { audio: { ...saved } } } });

      expect(changed).toBe(false);
      expect(audio(cfg)).toEqual(saved);
    });

    it("repairs the endpoint's trailing slash without touching a saved order", () => {
      const { cfg, changed } = migrate({
        tools: { media: { audio: { baseUrl: `${PROXY}/`, models: [LOCAL_CLI, CLOUD] } } },
      });

      expect(changed).toBe(true);
      expect(audio(cfg)).toEqual({ baseUrl: PROXY, models: [LOCAL_CLI, CLOUD] });
    });

    it("recognises the on-box row wherever the workspace lives", () => {
      // Matched on the script's name, not its full path: HOME is the script's
      // to resolve, and a moved workspace is still ours.
      const moved = { ...LOCAL_CLI, args: ["/srv/openclaw/workspace/scripts/stt-client.py", "{{MediaPath}}"] };
      const { changed } = migrate({ tools: { media: { audio: { baseUrl: PROXY, models: [CLOUD, moved] } } } });

      expect(changed).toBe(false);
    });

    it("treats a CLI row running some other script as the owner's own route", () => {
      const owner = {
        baseUrl: PROXY,
        models: [{ type: "cli", command: "/usr/local/bin/whisper-cpp", args: ["{{MediaPath}}"] }],
      };
      const { cfg, changed, log } = migrate({ tools: { media: { audio: { ...owner } } } });

      expect(changed).toBe(false);
      expect(audio(cfg)).toEqual(owner);
      expect(log).toContain("Skipped ClawBox AI speech to text");
    });

    it("seeds the cloud row alone on a fresh box; the on-box row is Settings' to add", () => {
      // Only the route knows whether faster-whisper is installed here, and a
      // CLI row pointing at nothing would cost every voice note its timeout.
      const { cfg } = migrate({});
      expect(audio(cfg)!.models).toEqual(OURS);
    });
  });
});

// OpenClaw 2 (>= 2026.8) keeps the endpoint under tools.media.audio but the
// model list moved to the shared tools.media.models, every row tagged with
// capabilities: ["audio"]. The block picks the home from CLAWBOX_OPENCLAW_V2
// (bound via globals() precisely so this file can set it in the preamble).
describe.skipIf(!hasPython3)("the same migration on OpenClaw 2 homes", () => {
  it("seeds the shared tools.media.models list, tagged for audio, and leaves audio.models alone", () => {
    const { cfg, changed } = migrate({}, true, true);
    expect(changed).toBe(true);
    const media = (cfg.tools as { media?: { models?: unknown; audio?: AudioConfig } } | undefined)?.media;
    expect(media?.audio).toEqual({ baseUrl: PROXY });
    expect(media?.models).toEqual([{ ...CLOUD, capabilities: ["audio"] }]);
  });

  it("leaves a Settings-written order in the shared list untouched — capabilities and all", () => {
    const existing = [LOCAL_CLI, { ...CLOUD, capabilities: ["audio"] }];
    const { cfg, changed } = migrate(
      { tools: { media: { audio: { baseUrl: PROXY }, models: existing } } },
      true,
      true,
    );
    expect(changed).toBe(false);
    expect((cfg.tools as { media?: { models?: unknown } }).media?.models).toEqual(existing);
  });

  it("treats a foreign row in the shared list as the owner's own transcription route", () => {
    const foreign = [{ provider: "deepgram", model: "nova" }];
    const { cfg, changed } = migrate({ tools: { media: { models: foreign } } }, true, true);
    expect(changed).toBe(false);
    const media = (cfg.tools as { media?: { models?: unknown; audio?: AudioConfig } }).media;
    expect(media?.models).toEqual(foreign);
    expect(media?.audio).toBeUndefined();
  });

  /**
   * TASK-743 — the in-flight guard here read the KEY's contents, and a JSON
   * `null` slipped past it.
   *
   * `tools.media.audio.models: null` is PRESENT and is refused by the core
   * (`tools.media.audio: Unrecognized key: "models"`, measured on 2026.8.1),
   * but `_audio.get("models") is not None` reads it as absent — so the block
   * seeded `tools.media.models` beside the surviving legacy key, which is the
   * dual-home write the image guard in the same file stands down over. The
   * test on the sibling image key is what found this one.
   */
  it("does not seed the shared list beside a legacy audio.models key holding null", () => {
    const { cfg } = migrate({ tools: { media: { audio: { models: null } } } }, true, true);

    const media = (cfg.tools as { media?: { models?: unknown; audio?: AudioConfig } }).media;
    expect(media?.models).toBeUndefined();
    // The legacy key is left exactly as it was — this block is not the migrator.
    expect((media?.audio as { models?: unknown } | undefined)?.models).toBeNull();
    // `baseUrl` lives at the same address in both generations and is still
    // written, which is what the in-flight comment says.
    expect((media?.audio as { baseUrl?: unknown } | undefined)?.baseUrl).toBe(PROXY);
  });
});
