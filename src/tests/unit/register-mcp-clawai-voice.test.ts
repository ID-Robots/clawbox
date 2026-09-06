import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * TASK-717 (arm) and TASK-718 (withdraw), on the Hermes edition.
 *
 * `applyClawaiToHermes` is the only thing on this edition that ever points
 * `tts.provider` at the ClawBox AI proxy, and its three callers are all
 * explicit (re-)links. So a box linked BEFORE the cloud-voice wiring existed
 * never gets it — nothing re-runs the link, and Settings already says ClawBox
 * AI is connected — and a box that WAS entitled and drops to a lower plan keeps
 * `tts.openai.*` pointing at an endpoint the proxy now answers 403 to, paying a
 * refused round trip on every spoken reply.
 *
 * The OpenClaw edition has had both arms since TASK-459 (`gateway-pre-start.sh`
 * gates on `_clawai_speech_entitled` and has the `elif` that takes its own entry
 * back). `register-mcp.sh` is this repo's Hermes counterpart of that pre-start —
 * `production-server.js` fire-and-forgets it on every web-server boot on
 * hermes|dual — and it already holds `${HERMES_CONFIG}.lock` while it
 * read-modify-writes the same file, which is why the pair belongs here rather
 * than in a second, unlocked writer.
 *
 * The whole real script is run, with stubs, exactly as
 * register-mcp-background-optouts.test.ts runs it. The `hermes` stub RECORDS its
 * argv and APPLIES `config set`/`config unset` to the YAML, so the cases assert
 * both the native commands issued and the state they leave.
 */

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");

const PROXY = "https://clawbox.com/api/ai";
const TOKEN = "claw_token123";
const CLOUD_MODEL = "gpt-4o-mini-tts";
/** The DEVICE tier of the MAX plan — the two names are off by one on purpose. */
const ENTITLED_TIER = "pro";

function have(bin: string, args: string[]): boolean {
  return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

const CAN_RUN =
  process.platform !== "win32"
  && have("bash", ["-c", "true"])
  && have("python3", ["-c", "import yaml"]);

const d = CAN_RUN ? describe : describe.skip;

let home: string;
let root: string;
let configPath: string;
let storePath: string;
let lockPath: string;
let hermesLog: string;

/**
 * A `hermes` that behaves like the real one for the two verbs this block uses:
 * it records the argv and applies the write to config.yaml. A stub that only
 * exited 0 would let every case pass over a script that wrote nothing.
 */
function writeHermesStub(exitCode = 0) {
  const stub = path.join(home, "fake-hermes");
  fs.writeFileSync(stub, `#!/bin/sh
printf '%s\\n' "$*" >> "${hermesLog}"
if [ "$1" != "config" ]; then exit 0; fi
if [ ${exitCode} -ne 0 ]; then exit ${exitCode}; fi
CLAWBOX_TEST_CFG="${configPath}" CLAWBOX_TEST_OP="$2" CLAWBOX_TEST_KEY="$3" CLAWBOX_TEST_VALUE="$4" python3 - <<'EOPY'
import os, yaml
cfg = yaml.safe_load(open(os.environ["CLAWBOX_TEST_CFG"])) or {}
parts = os.environ["CLAWBOX_TEST_KEY"].split(".")
if os.environ["CLAWBOX_TEST_OP"] == "set":
    node = cfg
    for p in parts[:-1]:
        node = node.setdefault(p, {})
    node[parts[-1]] = os.environ["CLAWBOX_TEST_VALUE"]
else:
    node = cfg
    for p in parts[:-1]:
        node = node.get(p) if isinstance(node, dict) else None
        if node is None:
            break
    if isinstance(node, dict):
        node.pop(parts[-1], None)
with open(os.environ["CLAWBOX_TEST_CFG"], "w") as fh:
    yaml.safe_dump(cfg, fh, sort_keys=False)
EOPY
exit 0
`);
  fs.chmodSync(stub, 0o755);
}

function run(env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAWBOX_ROOT: root,
      HERMES_CONFIG: configPath,
      HERMES_BIN: path.join(home, "fake-hermes"),
      BUN_BIN: path.join(home, "fake-bun"),
      CLAWBOX_EDITION_FILE: lockPath,
      ...env,
    }),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readConfig(): Record<string, unknown> {
  const out = execFileSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath],
    { encoding: "utf-8" },
  );
  return JSON.parse(out);
}

function at(dotted: string): unknown {
  let node: unknown = readConfig();
  for (const part of dotted.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Every `hermes` invocation the script made, in order. */
function hermesCalls(): string[] {
  try {
    return fs.readFileSync(hermesLog, "utf-8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function configCalls(): string[] {
  return hermesCalls().filter((line) => line.startsWith("config "));
}

/** The device store `/setup-api/ai-models/status` stamps the portal tier into. */
function writeStore(entries: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(entries));
}

function writeYaml(body: string) {
  fs.writeFileSync(configPath, body);
}

/**
 * The stamp `localTtsEngineInstalled` reads — `stamped AND the unit is present`,
 * so an ABSENT stamp settles "no engine" on its own, with no systemd bus.
 */
function installKokoroStamp() {
  const stamp = path.join(home, ".cache", "clawbox", "kokoro-installed");
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, "");
}

const BASE_CONFIG = "model:\n  default: deepseek-v4-pro\n";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-voice-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-voice-root-"));
  configPath = path.join(home, ".hermes", "config.yaml");
  storePath = path.join(root, "data", "config.json");
  lockPath = path.join(home, "edition.env");
  hermesLog = path.join(home, "hermes-calls.log");

  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
  fs.writeFileSync(path.join(home, "fake-bun"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(home, "fake-bun"), 0o755);
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  writeYaml(BASE_CONFIG);
  fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
  writeHermesStub();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

d("register-mcp.sh — the ClawBox AI cloud voice at boot", () => {
  describe("the arm (TASK-717)", () => {
    it("points an entitled, unvoiced box at the proxy and selects it", () => {
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });

      const r = run();

      expect(r.status).toBe(0);
      expect(at("tts.openai.base_url")).toBe(PROXY);
      expect(at("tts.openai.api_key")).toBe(TOKEN);
      expect(at("tts.openai.model")).toBe(CLOUD_MODEL);
      expect(at("tts.provider")).toBe("openai");
      expect(r.stdout).toContain("armed the ClawBox AI cloud voice");
    });

    it("writes the definition BEFORE it selects the provider", () => {
      // A selected provider with nowhere to send a request is strictly worse
      // than an unchanged one — the ordering `selectHermesEngine` keeps.
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });

      run();

      const calls = configCalls();
      expect(calls.indexOf("config set tts.provider openai")).toBe(calls.length - 1);
      expect(calls).toContain(`config set tts.openai.base_url ${PROXY}`);
    });

    it("adopts Hermes' factory `edge` selection, which is nobody's choice", () => {
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
      writeYaml(`${BASE_CONFIG}tts:\n  provider: edge\n`);

      run();

      expect(at("tts.provider")).toBe("openai");
    });

    it.each([
      ["an unset selection", ""],
      ["Hermes' factory `edge`", "edge"],
      ["`clawbox-local`", "clawbox-local"],
    ])("leaves a box with a working engine alone, whatever %s says", (_label, provider) => {
      // The engine question is asked in EVERY unchosen state, not only over
      // `clawbox-local`. `step_openclaw_tts` has one arm that leaves the key
      // UNSET — a `hermes config get` that did not answer, i.e. one OOM-killed
      // Python start on a loaded Jetson — and this script runs on every
      // web-server boot, so it would fire before anything could correct it. A
      // box that can speak entirely on-device must not be moved off its own
      // voice by a boot script, and the move is effectively permanent.
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
      writeYaml(provider ? `${BASE_CONFIG}tts:\n  provider: ${provider}\n` : BASE_CONFIG);
      installKokoroStamp();

      const r = run();

      expect(at("tts.openai")).toBeUndefined();
      expect(at("tts.provider")).toBe(provider || undefined);
      expect(r.stdout).toContain("this box speaks for itself");
    });

    it("gives an engineless box on `clawbox-local` the voice its plan includes", () => {
      // THE box this card is about. `install.sh` selects `clawbox-local` on
      // every install and every update WHATEVER the engine answered — an
      // absent `tts.provider` resolves to Microsoft's Edge cloud on Hermes, so
      // an engineless box is left honestly mute rather than speaking through a
      // third party. Which is why "no TTS engine" reads as a chosen local
      // voice, and why the unset/`edge` cases above do not reach it.
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
      writeYaml(`${BASE_CONFIG}tts:\n  provider: clawbox-local\n`);

      const r = run();

      expect(at("tts.provider")).toBe("openai");
      expect(at("tts.openai.api_key")).toBe(TOKEN);
      expect(r.stdout).toContain("armed the ClawBox AI cloud voice");
    });

    it("leaves a voice the owner chose", () => {
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
      writeYaml(`${BASE_CONFIG}tts:\n  provider: elevenlabs\n`);

      run();

      expect(at("tts.provider")).toBe("elevenlabs");
      expect(configCalls()).toEqual([]);
    });

    it("leaves an owner's own OpenAI-compatible speech server alone", () => {
      // On Hermes `tts.openai` is the GENERIC slot, not ClawBox's.
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
      writeYaml(
        `${BASE_CONFIG}tts:\n  openai:\n    base_url: https://speech.home.lan/v1\n    api_key: sk-theirs\n`,
      );

      const r = run();

      expect(at("tts.openai.base_url")).toBe("https://speech.home.lan/v1");
      expect(at("tts.openai.api_key")).toBe("sk-theirs");
      expect(at("tts.provider")).toBeUndefined();
      expect(r.stdout).toContain("already names its own speech route");
    });

    it("does not arm a box whose plan does not include the cloud voice", () => {
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash" });

      run();

      expect(at("tts.openai")).toBeUndefined();
      expect(configCalls()).toEqual([]);
    });

    it("does not arm a box the portal has told us nothing about", () => {
      // Not knowing is not an entitlement.
      writeStore({ clawai_token: TOKEN });

      run();

      expect(at("tts.openai")).toBeUndefined();
    });

    it("costs no config write at all once the voice is armed", () => {
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
      run();
      fs.writeFileSync(hermesLog, "");
      const before = fs.readFileSync(configPath, "utf-8");

      const r = run();

      expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
      expect(configCalls()).toEqual([]);
      expect(r.stdout).toContain("the cloud voice is already armed");
    });

    it("refreshes a rotated token rather than leaving a 401 in the slot", () => {
      // The portal rotates the token on a re-link, and this script is the only
      // thing on the boot path that would notice. An unrefreshed key is a 401
      // on every utterance while every panel — which asks only that the two
      // keys are non-empty — calls the voice configured.
      writeStore({ clawai_token: "claw_OLD", clawai_tier: ENTITLED_TIER });
      run();
      writeStore({ clawai_token: "claw_NEW", clawai_tier: ENTITLED_TIER });
      fs.writeFileSync(hermesLog, "");

      const r = run();

      expect(at("tts.openai.api_key")).toBe("claw_NEW");
      // The SELECTION is already ours and is not rewritten: one writer of
      // `tts.provider`, and re-selecting buys a fourth CLI spawn for nothing.
      expect(configCalls()).not.toContain("config set tts.provider openai");
      expect(r.stdout).toContain("refreshed the ClawBox AI speech credential");
    });
  });

  describe("the withdrawal (TASK-718)", () => {
    /** A box that WAS on the cloud voice, as the arm above leaves it. */
    function armedBox() {
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
      run();
      fs.writeFileSync(hermesLog, "");
    }

    it("takes the endpoint, credential and model back when the plan drops", () => {
      armedBox();
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash" });

      const r = run();

      expect(at("tts.openai.base_url")).toBeUndefined();
      expect(at("tts.openai.api_key")).toBeUndefined();
      expect(at("tts.openai.model")).toBeUndefined();
      expect(r.stdout).toContain("no longer includes it");
    });

    it("leaves the owner's SELECTION where it is", () => {
      // The same ruling the OpenClaw arm records: the panel's job is to show
      // that the choice is no longer available, and silently rewriting it would
      // hide the downgrade.
      armedBox();
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash" });

      run();

      expect(at("tts.provider")).toBe("openai");
    });

    it.each([
      ["their key", "sk-theirs"],
      // THE case, and the one the OpenClaw arm's ruling names outright: an owner
      // can point OUR OWN token at an endpoint of their choosing, and that entry
      // is theirs. A `claw_` credential is enough to REFRESH an entry — the worst
      // that does is rewrite our fields to our values — and it is never enough to
      // DELETE one.
      ["OUR key at THEIR address", TOKEN],
    ])("never touches an owner's own speech server, even with %s in it", (_label, key) => {
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash" });
      writeYaml(
        `${BASE_CONFIG}tts:\n  provider: openai\n  openai:\n    base_url: https://speech.home.lan/v1\n    api_key: ${key}\n    model: my-own-voice\n`,
      );

      const r = run();

      expect(at("tts.openai.api_key")).toBe(key);
      expect(at("tts.openai.base_url")).toBe("https://speech.home.lan/v1");
      expect(at("tts.openai.model")).toBe("my-own-voice");
      expect(configCalls()).toEqual([]);
      expect(r.stdout).toContain("not ours to withdraw");
    });

    it("withdraws an entry left on a proxy address we have since moved off", () => {
      // The retired hosts are in the ownership set precisely so a box linked
      // under a previous address is still recognisably ours. No `claw_` token
      // here on purpose: the ADDRESS has to be what authorises the delete, or
      // this case would pass for the reason the one above forbids.
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash" });
      writeYaml(
        `${BASE_CONFIG}tts:\n  provider: openai\n  openai:\n    base_url: https://openclawhardware.dev/api/ai\n    api_key: sk-someone-elses\n`,
      );

      const r = run();

      expect(at("tts.openai.api_key")).toBeUndefined();
      expect(r.stdout).toContain("no longer includes it");
    });

    it("does not withdraw over a tier nobody has told us", () => {
      armedBox();
      writeStore({ clawai_token: TOKEN });

      run();

      expect(at("tts.openai.api_key")).toBe(TOKEN);
      expect(configCalls()).toEqual([]);
    });

    it("is idempotent — a second unentitled boot writes nothing", () => {
      armedBox();
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash" });
      run();
      fs.writeFileSync(hermesLog, "");
      const before = fs.readFileSync(configPath, "utf-8");

      run();

      expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
      expect(configCalls()).toEqual([]);
    });
  });

  describe("not knowing is not an answer", () => {
    it("holds, and says why, when there is no device store at all", () => {
      const r = run();

      expect(r.status).toBe(0);
      expect(r.stdout).toContain("no ClawBox AI link on record");
      expect(configCalls()).toEqual([]);
    });

    it("holds over a device store that is not JSON", () => {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, "{");

      const r = run();

      expect(r.status).toBe(0);
      expect(r.stdout).toContain("the device store could not be read");
      expect(configCalls()).toEqual([]);
    });

    it("reports a refused write rather than claiming the voice was armed", () => {
      // False success is the class this whole block is written against: a
      // `hermes config set` that did not land must not be reported as a voice.
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
      writeHermesStub(3);

      const r = run();

      expect(r.stdout).not.toContain("armed the ClawBox AI cloud voice");
      // THE NUMBER, not just the sentence. `$?` captured after `fi` is the `if`
      // statement's own 0, so every failure line would read "(exit 0)" — which
      // both misreports the cause and reads as a contradiction. §4's twenty-line
      // comment on `tools disable` explains why 3, 124, 125 and 127 are four
      // different facts to whoever is reading the journal.
      expect(r.stdout).toContain("could not write tts.openai.base_url (exit 3)");
      expect(at("tts.provider")).toBeUndefined();
    });

    it("never prints the device token", () => {
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });

      const r = run();

      expect(r.stdout).not.toContain(TOKEN);
      expect(r.stderr).not.toContain(TOKEN);
    });
  });

  it("keeps every constant in step with the TypeScript that owns it", async () => {
    // A shell block cannot import a TS constant, so the two copies are pinned
    // against each other here instead. Each of these is a wire value a
    // divergence would break silently: the tier gate, the one speech model the
    // proxy serves, the three provider names, and the engine stamp.
    const tts = await import("@/lib/hermes-tts");
    const models = await import("@/lib/local-models");
    const script = fs.readFileSync(SCRIPT, "utf-8");
    const block = script.slice(script.indexOf("── 4a. The ClawBox AI cloud voice"));

    expect(block).toContain(`CLAWBOX_SPEECH_DEVICE_TIER="${tts.CLAWBOX_AI_SPEECH_TIER}"`);
    expect(block).toContain(`CLOUD_MODEL = "${tts.HERMES_CLOUD_TTS_MODEL}"`);
    expect(block).toContain(`LOCAL_PROVIDER = "${tts.HERMES_LOCAL_TTS_PROVIDER}"`);
    expect(block).toContain(`CLOUD_PROVIDER = "${tts.HERMES_CLOUD_TTS_PROVIDER}"`);
    expect(block).toContain(`FACTORY_PROVIDER = "${tts.HERMES_FACTORY_TTS_PROVIDER}"`);
    expect(models.KOKORO_STAMP.endsWith("/.cache/clawbox/kokoro-installed")).toBe(true);
    expect(block).toContain("/.cache/clawbox/kokoro-installed");
    // Every address ClawBox has ever written as its proxy — the set that makes a
    // credential-blind delete safe, and the one the route already shares.
    const { CLAWBOX_AI_PROXY_URLS } = await import("@/lib/clawbox-ai-models");
    for (const url of CLAWBOX_AI_PROXY_URLS) expect(block).toContain(`"${url}"`);
    // And the tier constant is the DEVICE tier, not the plan name — the two are
    // off by one on purpose (CLAWBOX_AI_MODEL_BY_TIER).
    expect(tts.CLAWBOX_AI_SPEECH_TIER).toBe(ENTITLED_TIER);
  });

  it("arms a dual box, and writes nothing into ~/.openclaw", () => {
    // Edition-gated, not harness-gated, and consistent with §4b: the web server
    // is not restarted when the owner switches harness, so a block that asked
    // which harness was active at boot would leave a switched-over box unvoiced.
    // Dual is the one SKU where both editions' arms coexist — the OpenClaw half
    // lives in gateway-pre-start.sh and this must not reach it.
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=dual\n");
    const openclawConfig = path.join(home, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(openclawConfig), { recursive: true });
    fs.writeFileSync(openclawConfig, JSON.stringify({ agents: { defaults: {} } }));
    writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });

    const r = run();

    expect(r.status).toBe(0);
    expect(at("tts.provider")).toBe("openai");
    expect(JSON.parse(fs.readFileSync(openclawConfig, "utf-8"))).toEqual({ agents: { defaults: {} } });
  });

  it("does nothing at all on an OpenClaw-only device", () => {
    // That edition has both arms in gateway-pre-start.sh already.
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=openclaw\n");
    writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });

    const r = run();

    expect(r.status).toBe(0);
    expect(at("tts")).toBeUndefined();
    expect(configCalls()).toEqual([]);
  });
});
