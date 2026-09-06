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
 *
 * The python heredoc'"'"'s exit status IS the stub'"'"'s status — no trailing `exit 0`.
 * A write that raised (an unparseable config, a scalar where an intermediate
 * mapping was expected) leaves the file unwritten, and a stub that reported
 * success over it would let the script treat a write that never landed as
 * applied, which is the one thing these cases exist to catch.
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
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: "flash" });

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
      // The withdrawal cases below assert ABSENCE. Without this, a fixture that
      // silently stopped arming would leave every one of them passing over a
      // box that never had a cloud voice to take away.
      expect(at("tts.openai.api_key")).toBe(TOKEN);
      expect(at("tts.openai.base_url")).toBe(PROXY);
      fs.writeFileSync(hermesLog, "");
    }

    it("takes the endpoint, credential and model back when the plan drops", () => {
      armedBox();
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: "flash" });

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
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: "flash" });

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
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: "flash" });
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
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: "flash" });
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
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: "flash" });
      run();
      fs.writeFileSync(hermesLog, "");
      const before = fs.readFileSync(configPath, "utf-8");

      run();

      expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
      expect(configCalls()).toEqual([]);
    });
  });

  // TASK-744. `clawai_tier` is `mapPortalTier`'s answer, and that function
  // prefers the portal's `deviceTier` STAMP on purpose — it answers "what
  // should this box default to", and a Max subscriber is allowed to run Flash
  // here. `clawbox-ai-portal-tier.ts` states the rule: "Read the first for a
  // default to write; read this one [`mapPortalPlanTier`] before refusing
  // anything." This block both refuses and WITHDRAWS on the device default, so
  // a Max subscriber whose box is stamped `deviceTier: flash` had the cloud
  // voice taken away at every web-server boot.
  describe("the entitlement is the PLAN, and the device stamp only when the plan is unknown (TASK-744)", () => {
    /** Leave the box on the cloud voice, as the arm does. */
    function armedYaml() {
      writeYaml(
        `${BASE_CONFIG}tts:\n  provider: openai\n  openai:\n    base_url: ${PROXY}\n    api_key: ${TOKEN}\n    model: ${CLOUD_MODEL}\n`,
      );
    }

    it("keeps the cloud voice of a Max subscriber whose device is stamped flash", () => {
      armedYaml();
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: ENTITLED_TIER });

      const r = run();

      expect(at("tts.openai.api_key")).toBe(TOKEN);
      expect(at("tts.openai.base_url")).toBe(PROXY);
      expect(configCalls()).toEqual([]);
      expect(r.stdout).toContain("the cloud voice is already armed");
    });

    it("arms one for that box in the first place", () => {
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: ENTITLED_TIER });

      const r = run();

      expect(at("tts.openai.base_url")).toBe(PROXY);
      expect(at("tts.openai.api_key")).toBe(TOKEN);
      expect(at("tts.provider")).toBe("openai");
      expect(r.stdout).toContain("armed the ClawBox AI cloud voice");
    });

    it("still withdraws when the PLAN itself has dropped", () => {
      // The mirror case: the plan is Pro, which the proxy answers 403 to,
      // whatever this box's device stamp says.
      armedYaml();
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER, clawai_plan_tier: "flash" });

      const r = run();

      expect(at("tts.openai.api_key")).toBeUndefined();
      expect(at("tts.openai.base_url")).toBeUndefined();
      expect(r.stdout).toContain("no longer includes it");
    });

    it("withdraws from a CANCELLED subscription", () => {
      // The commoner of the two downgrade paths, and the one no null tier can
      // express: `mapPortalTier` and `mapPortalPlanTier` both answer null for
      // an unpaid account, so `free` is the word that tells a cancellation
      // apart from a box nobody has ever asked about.
      armedYaml();
      writeStore({ clawai_token: TOKEN, clawai_plan_tier: "free" });

      const r = run();

      expect(at("tts.openai.api_key")).toBeUndefined();
      expect(r.stdout).toContain("no longer includes it");
    });

    it("does not withdraw on the device badge alone, however low it reads", () => {
      // The badge may fill in for a missing plan when ARMING and never when
      // destroying: `mapPortalTier` prefers `deviceTier` on purpose, so a Max
      // subscriber running Flash carries exactly this pair until his first
      // status poll, and withdrawing on it is the card's own defect.
      armedYaml();
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash" });

      const r = run();

      expect(at("tts.openai.api_key")).toBe(TOKEN);
      expect(configCalls()).toEqual([]);
      expect(r.stdout).toContain("a badge is not a plan");
    });

    it("falls back to the device stamp when no plan has been recorded", () => {
      // Every box in the field is in this state until the status poll has
      // written the plan once, so the old rule has to keep answering there.
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });

      const r = run();

      expect(at("tts.openai.base_url")).toBe(PROXY);
      expect(r.stdout).toContain("armed the ClawBox AI cloud voice");
    });

    it("ignores a plan stamp that is not a tier we recognise", () => {
      // NOT KNOWING IS NOT AN ANSWER. A junk value is not evidence that the
      // plan has dropped, so it falls through to the stamp rather than
      // withdrawing a working voice over it.
      armedYaml();
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER, clawai_plan_tier: "enterprise" });

      const r = run();

      expect(at("tts.openai.api_key")).toBe(TOKEN);
      expect(configCalls()).toEqual([]);
      expect(r.stdout).toContain("the cloud voice is already armed");
    });

    it("does not withdraw over a plan stamp alone when neither is recognisable", () => {
      armedYaml();
      writeStore({ clawai_token: TOKEN, clawai_plan_tier: "enterprise" });

      const r = run();

      expect(at("tts.openai.api_key")).toBe(TOKEN);
      expect(configCalls()).toEqual([]);
      expect(r.stdout).toContain("no plan has been recorded for this box yet");
    });
  });

  // TASK-745. On Hermes `tts.openai` is the HARNESS's built-in generic OpenAI
  // slot, not a named entry ClawBox created — `BUILTIN_TTS_PROVIDERS` in
  // `tools/tts_tool.py` lists it — so emptying its three keys does not remove
  // the provider the way deleting `messages.tts.providers.openai` does on
  // OpenClaw. With `tts.provider` still naming it, Hermes' own speech path
  // resolves to that built-in and goes to api.openai.com, which is a 401 and a
  // round trip carrying the owner's text to a third party — where before the
  // withdrawal it was a 403 at our own proxy. The withdrawal has to hand the
  // box back to something real.
  describe("standing the box down, not just emptying the slot (TASK-745)", () => {
    /** A box on the cloud voice, as the arm leaves it, with a local engine defined. */
    function armedWithLocalEngine(extra = "") {
      writeYaml(
        `${BASE_CONFIG}tts:\n  provider: openai\n  openai:\n    base_url: ${PROXY}\n`
        + `    api_key: ${TOKEN}\n    model: ${CLOUD_MODEL}\n${extra}`
        + `  providers:\n    clawbox-local:\n      type: command\n      command: /usr/bin/true\n`,
      );
    }

    /** The plan is below the entitlement on beta AND after TASK-744. */
    function downgraded() {
      writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: "flash" });
    }

    it("selects the box's own voice instead of leaving a name over an emptied slot", () => {
      armedWithLocalEngine();
      downgraded();

      const r = run();

      expect(at("tts.openai.api_key")).toBeUndefined();
      // The point of the card: `openai` here is the harness's own built-in, so
      // the selection has to move or every spoken reply goes to api.openai.com.
      expect(at("tts.provider")).toBe("clawbox-local");
      expect(r.stdout).toContain("no longer includes it");
    });

    it("drops the cloud voice name with the rest of the definition", () => {
      // `tts.openai.voice` is written by the Voice tab (`KEYS.cloudVoice`) and
      // was left behind: a voice name for a provider this box may no longer
      // call, which the next arm would then inherit from the previous plan.
      armedWithLocalEngine("    voice: shimmer\n");
      downgraded();

      run();

      expect(at("tts.openai.voice")).toBeUndefined();
    });

    it("leaves an owner's own SELECTION alone while still emptying our slot", () => {
      // The box speaks through something the owner chose; our slot is armed
      // beside it. Emptying the slot is ours to do and the selection is not.
      writeYaml(
        `${BASE_CONFIG}tts:\n  provider: elevenlabs\n  openai:\n    base_url: ${PROXY}\n`
        + `    api_key: ${TOKEN}\n    model: ${CLOUD_MODEL}\n`,
      );
      downgraded();

      run();

      expect(at("tts.openai.api_key")).toBeUndefined();
      expect(at("tts.provider")).toBe("elevenlabs");
    });

    it("does not hand a box with no local engine to Microsoft's cloud", () => {
      // `hermes config unset tts.provider` is NOT a stand-down: `_get_provider`
      // in tools/tts_tool.py falls back to `DEFAULT_PROVIDER = "edge"`, which
      // is Microsoft's cloud — install.sh selects `clawbox-local` on every
      // Hermes box precisely so an engineless board is honestly mute instead.
      writeYaml(
        `${BASE_CONFIG}tts:\n  provider: openai\n  openai:\n    base_url: ${PROXY}\n`
        + `    api_key: ${TOKEN}\n    model: ${CLOUD_MODEL}\n`,
      );
      downgraded();

      const r = run();

      expect(at("tts.openai.api_key")).toBeUndefined();
      expect(configCalls()).not.toContain("config unset tts.provider");
      expect(configCalls()).not.toContain("config set tts.provider edge");
      expect(r.stdout).toContain("no on-device voice to fall back to");
    });
  });

  // TASK-745. `python3 - <<'PY' 2>/dev/null` meant a genuine bug inside the
  // plan step reached the operator as `hold the voice plan could not be
  // computed` and nothing else: it failed in the safe direction, silently, and
  // the boot log could not say why.
  describe("a plan step that crashes says so on the boot log", () => {
    /**
     * A `python3` that fails ONLY for the plan step.
     *
     * `CLAWBOX_KOKORO_STAMP` is set for that one invocation and for no other,
     * so every other `python3` in the script — the token re-read, §4b's
     * seeding — still runs the real interpreter.
     */
    function shadowPython(): string {
      // The REAL interpreter, resolved before the stub shadows it — an `exec
      // python3` inside the stub would find the stub again and fork bomb.
      const real = execFileSync("sh", ["-c", "command -v python3"], { encoding: "utf-8" }).trim();
      const dir = path.join(home, "shadow-bin");
      fs.mkdirSync(dir, { recursive: true });
      const stub = path.join(dir, "python3");
      fs.writeFileSync(stub, `#!/bin/sh
if [ -n "\${CLAWBOX_KOKORO_STAMP:-}" ]; then
  echo "Traceback (most recent call last):" >&2
  echo "ZeroDivisionError: division by zero" >&2
  exit 1
fi
exec ${real} "$@"
`);
      fs.chmodSync(stub, 0o755);
      return dir;
    }

    it("lets the traceback reach the journal instead of /dev/null", () => {
      writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
      const dir = shadowPython();

      const r = run({ PATH: `${dir}:${process.env.PATH ?? ""}` });

      // The script still stands down — a plan it could not compute writes
      // nothing — and now it says what happened.
      expect(r.status).toBe(0);
      expect(configCalls()).toEqual([]);
      expect(r.stdout).toContain("the voice plan could not be computed");
      expect(`${r.stdout}${r.stderr}`).toContain("ZeroDivisionError");
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
    // BOUNDED at §4b. An unbounded slice runs to the end of the file, so a
    // constant deleted from §4a but named anywhere later would still satisfy
    // every assertion below — a pin that cannot fail is not a pin.
    const start = script.indexOf("── 4a. The ClawBox AI cloud voice");
    expect(start).toBeGreaterThan(-1);
    const end = script.indexOf("── 4b. Hermes' own background jobs", start);
    expect(end).toBeGreaterThan(start);
    const block = script.slice(start, end);

    expect(block).toContain(`CLAWBOX_SPEECH_DEVICE_TIER="${tts.CLAWBOX_AI_SPEECH_TIER}"`);
    expect(block).toContain(`CLAWBOX_VOICE_MODEL="${tts.HERMES_CLOUD_TTS_MODEL}"`);
    expect(block).toContain(`LOCAL_PROVIDER = "${tts.HERMES_LOCAL_TTS_PROVIDER}"`);
    expect(block).toContain(`CLOUD_PROVIDER = "${tts.HERMES_CLOUD_TTS_PROVIDER}"`);
    expect(block).toContain(`FACTORY_PROVIDER = "${tts.HERMES_FACTORY_TTS_PROVIDER}"`);
    expect(models.KOKORO_STAMP.endsWith("/.cache/clawbox/kokoro-installed")).toBe(true);
    expect(block).toContain("/.cache/clawbox/kokoro-installed");
    // Every address ClawBox has ever written as its proxy — the set that makes a
    // credential-blind delete safe, and the one the route already shares.
    const { CLAWBOX_AI_PROXY_URLS } = await import("@/lib/clawbox-ai-models");
    for (const url of CLAWBOX_AI_PROXY_URLS) expect(block).toContain(`"${url}"`);
    // And the LIVE endpoint the arm writes, against the binding the rest of the
    // app resolves it through — the retired-host set alone would not notice the
    // current one moving.
    const { CLAWBOX_AI_PROXY_URL } = await import("@/lib/hermes-clawai");
    expect(CLAWBOX_AI_PROXY_URL).toBe(PROXY);
    expect(block).toContain(`CLAWBOX_VOICE_PROXY="\${CLAWBOX_AI_PROXY_URL:-${PROXY}}"`);
    // And the tier constant is the DEVICE tier, not the plan name — the two are
    // off by one on purpose (CLAWBOX_AI_MODEL_BY_TIER).
    expect(tts.CLAWBOX_AI_SPEECH_TIER).toBe(ENTITLED_TIER);
  });

  it("normalises a proxy override so the endpoint compared is the endpoint written", () => {
    // Two normalisations would drift. `CLAWBOX_AI_PROXY_URL` is trimmed and has
    // every trailing slash removed, exactly as `hermes-clawai.ts`'s binding does
    // it, so a staging override with a stray slash cannot make the verdict
    // answer `refresh` on every boot against a value it just wrote.
    writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });

    const first = run({ CLAWBOX_AI_PROXY_URL: " https://staging.example.invalid/api/ai// " });
    expect(first.stdout).toContain("armed the ClawBox AI cloud voice");
    expect(at("tts.openai.base_url")).toBe("https://staging.example.invalid/api/ai");

    fs.writeFileSync(hermesLog, "");
    const second = run({ CLAWBOX_AI_PROXY_URL: " https://staging.example.invalid/api/ai// " });
    expect(second.stdout).toContain("the cloud voice is already armed");
    expect(configCalls()).toEqual([]);
  });

  it.each([
    ["a whitespace-only override", " "],
    ["an override that is only slashes", "///"],
  ])("never withdraws an unset endpoint as ours, given %s", (_label, override) => {
    // An empty "our proxy" is the worst value this binding can take: it makes
    // an owner's slot carrying their key and NO base_url — the canonical way
    // Hermes' generic `openai` slot is used — read as ours.
    writeStore({ clawai_token: TOKEN, clawai_tier: "flash", clawai_plan_tier: "flash" });
    writeYaml(`${BASE_CONFIG}tts:\n  provider: openai\n  openai:\n    api_key: sk-theirs\n`);

    const r = run({ CLAWBOX_AI_PROXY_URL: override });

    expect(at("tts.openai.api_key")).toBe("sk-theirs");
    expect(configCalls()).toEqual([]);
    expect(r.stdout).toContain("not ours to withdraw");
  });

  it.each([
    ["a whitespace-only override", " "],
    ["an override that is only slashes", "///"],
  ])("never ARMS over an unset endpoint either, given %s", (_label, override) => {
    // The other direction, and the one the withdraw cases above cannot reach:
    // an ENTITLED box with the same owner slot. `route_is_ours` would be true
    // over an empty `base_url` if the proxy binding were empty, and the arm
    // would overwrite their credential with ours before any downgrade ever
    // happened. The two guards are separately load-bearing — remove the default
    // restoration and keep `OUR_PROXIES.discard("")` and only this half fails.
    // The selection is left UNSET on purpose, so `route_is_ours` is the ONLY
    // thing standing between their credential and ours — an already-chosen
    // `openai` would be held by the selection test one line earlier and would
    // not exercise this at all.
    writeStore({ clawai_token: TOKEN, clawai_tier: ENTITLED_TIER });
    writeYaml(`${BASE_CONFIG}tts:\n  openai:\n    api_key: sk-theirs\n`);

    const r = run({ CLAWBOX_AI_PROXY_URL: override });

    expect(at("tts.openai.api_key")).toBe("sk-theirs");
    expect(at("tts.openai.base_url")).toBeUndefined();
    expect(at("tts.provider")).toBeUndefined();
    expect(configCalls()).toEqual([]);
    expect(r.stdout).toContain("already names its own speech route");
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
