import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS,
  RETIRED_CLAWBOX_AI_VISION_MODEL_IDS,
} from "@/lib/clawbox-ai-retired-models";
import { CLAWBOX_AI_VISION_FALLBACK_MODEL_ID } from "@/lib/clawbox-ai-models";
import { CLAWBOX_AI_VISION_PROBE_PNG } from "@/lib/clawbox-ai-vision";

// Starts a real process (python3): vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ClawBox AI is ONE model (TASK-2261): `deepseek-v4-flash` for chat, and for
// looking at pictures while the vision check says it can see — the fallback
// (`gpt-5.6-luna`) while it cannot, nothing when neither can. Boxes in the
// field never re-run the configure route, so gateway-pre-start.sh moves
// openclaw.json off the retired ids and re-asks the vision question at every
// gateway start. The verdict is forced through CLAWBOX_VISION_PROBE here, so no
// test touches the network.
//
// These run the migration block out of the shipped .sh, not a copy of it, so
// the test fails if the real script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const FLASH = "deepseek/deepseek-v4-flash";
const PRO = `deepseek/${RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS[0]}`;
const [VISION_EXP] = RETIRED_CLAWBOX_AI_VISION_MODEL_IDS;
const FALLBACK = CLAWBOX_AI_VISION_FALLBACK_MODEL_ID;
const FALLBACK_REF = `deepseek/${FALLBACK}`;

/** Pull the one-model migration out of the .sh verbatim. */
function extractPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("# Migration: ClawBox AI is ONE model (TASK-2261).");
  const end = src.indexOf("# Migration: ClawBox AI image generation.", start);
  if (start < 0 || end < 0) throw new Error("clawai one-model migration block not found");
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractPolicy() : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "clawai-one-model-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type ModelEntry = { id?: string; name?: string; input?: unknown; [key: string]: unknown };

/**
 * Run the extracted block over a whole openclaw.json.
 *
 * The preamble binds only the names the block reads from its surrounding scope,
 * exactly as the real script binds them upstream of this point (`re`,
 * `_agents_block`, `agents_defaults`, `deepseek_provider`, `changed`) — mock at
 * that boundary and nothing else, so the logic under test is shipped bytes.
 */
function migrate(cfg: Config, verdict = "flash"): { cfg: Config; changed: boolean } {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, os, re, sys",
    "cfg = json.load(open(sys.argv[1]))",
    'models_providers = cfg.setdefault("models", {}).setdefault("providers", {})',
    '_agents_block = cfg.setdefault("agents", {})',
    'agents_defaults = _agents_block.setdefault("defaults", {})',
    'deepseek_provider = models_providers.get("deepseek")',
    "changed = False",
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const env = { ...process.env, CLAWBOX_VISION_PROBE: verdict, CLAWBOX_DEVICE_STORE: "", CLAWBOX_AI_VISION_FALLBACK_MODEL_ID: "" };
  const out = execFileSync("python3", ["-c", program, file], { encoding: "utf-8", env }).trim().split("\n");
  return JSON.parse(out[out.length - 1]);
}

/** A box provisioned with ClawBox AI before the one model: both chat rows and a vision row. */
function pairedBox(overrides: { models?: ModelEntry[]; agents?: Config; apiKey?: string; baseUrl?: string } = {}): Config {
  return {
    models: {
      providers: {
        deepseek: {
          apiKey: overrides.apiKey ?? "claw_token123",
          baseUrl: overrides.baseUrl ?? "https://clawbox.com/api/ai",
          models: overrides.models ?? [
            { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text"] },
            { id: RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS[0], name: "ClawBox AI Pro", input: ["text"] },
            { id: VISION_EXP, name: "ClawBox AI Vision", input: ["text", "image"], maxTokens: 128000 },
          ],
        },
      },
    },
    agents: overrides.agents ?? {
      defaults: {
        model: { primary: PRO, fallbacks: [FLASH] },
        imageModel: { primary: `deepseek/${VISION_EXP}` },
      },
    },
  };
}

function dsModels(cfg: Config): ModelEntry[] {
  const models = (cfg.models ?? {}) as { providers?: Record<string, Record<string, unknown>> };
  return (models.providers?.deepseek?.models ?? []) as ModelEntry[];
}

function defaults(cfg: Config): Record<string, unknown> {
  return ((cfg.agents ?? {}) as { defaults?: Record<string, unknown> }).defaults ?? {};
}

const FLASH_ROW_SEES = { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text", "image"] };
const FLASH_ROW_BLIND = { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text"] };
const FALLBACK_ROW = {
  id: FALLBACK,
  name: "ClawBox AI Vision",
  input: ["text", "image"],
  maxTokens: 128000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI one-model migration", () => {
  it("moves a box preset to the Max-plan id and the vision model onto Flash, which sees", () => {
    const { cfg, changed } = migrate(pairedBox(), "flash");

    expect(changed).toBe(true);
    expect(dsModels(cfg)).toEqual([FLASH_ROW_SEES]);
    expect(defaults(cfg).model).toEqual({ primary: FLASH, fallbacks: [FLASH] });
    expect(defaults(cfg).imageModel).toEqual({ primary: FLASH });
  });

  it("sends pictures to the fallback, and keeps Flash text-only, when Flash cannot see", () => {
    const { cfg } = migrate(pairedBox(), "fallback");

    expect(dsModels(cfg)).toEqual([FLASH_ROW_BLIND, FALLBACK_ROW]);
    expect(defaults(cfg).model).toEqual({ primary: FLASH, fallbacks: [FLASH] });
    expect(defaults(cfg).imageModel).toEqual({ primary: FALLBACK_REF });
  });

  it("arms no picture slot when neither can see, and keeps the owner's fallbacks", () => {
    const bare = migrate(pairedBox(), "none").cfg;
    expect(dsModels(bare)).toEqual([FLASH_ROW_BLIND]);
    expect(defaults(bare).imageModel).toBeUndefined();

    const withFallbacks = migrate(pairedBox({
      agents: { defaults: { imageModel: { primary: `deepseek/${VISION_EXP}`, fallbacks: ["google/gemini-2.5-flash"] } } },
    }), "none").cfg;
    expect(defaults(withFallbacks).imageModel).toEqual({ fallbacks: ["google/gemini-2.5-flash"] });
  });

  it("moves back to Flash when it sees again, dropping the fallback row", () => {
    const blind = migrate(pairedBox(), "fallback").cfg;
    const again = migrate(blind, "flash").cfg;
    expect(dsModels(again)).toEqual([FLASH_ROW_SEES]);
    expect(defaults(again).imageModel).toEqual({ primary: FLASH });
  });

  it("keeps what the box has when the question cannot be answered", () => {
    const onFallback = migrate(pairedBox(), "fallback").cfg;
    const unknown = migrate(onFallback, "unknown");
    expect(unknown.changed).toBe(false);
    expect(unknown.cfg).toEqual(onFallback);

    const onFlash = migrate(pairedBox(), "flash").cfg;
    expect(migrate(onFlash, "unknown").cfg).toEqual(onFlash);

    // No picture model is a state too: a boot before the network is up must
    // not hand pictures back to a Flash the last check found blind.
    const onNothing = migrate(pairedBox(), "none").cfg;
    const still = migrate(onNothing, "unknown");
    expect(still.changed).toBe(false);
    expect(still.cfg).toEqual(onNothing);
  });

  it("is idempotent — a second boot with the same answer changes nothing", () => {
    for (const verdict of ["flash", "fallback", "none"]) {
      const first = migrate(pairedBox(), verdict);
      const second = migrate(first.cfg, verdict);
      expect(second.changed, verdict).toBe(false);
      expect(second.cfg, verdict).toEqual(first.cfg);
    }
  });

  it("moves the separate vision model's id, keeping the owner's fallbacks", () => {
    const { cfg } = migrate(pairedBox({
      agents: { defaults: { imageModel: { primary: `deepseek/${VISION_EXP}`, fallbacks: ["google/gemini-2.5-flash"] } } },
    }));
    expect(defaults(cfg).imageModel).toEqual({ primary: FLASH, fallbacks: ["google/gemini-2.5-flash"] });
  });

  it("writes a bare-string imageModel naming our old id back in the object shape", () => {
    const { cfg } = migrate(pairedBox({ agents: { defaults: { imageModel: `deepseek/${VISION_EXP}` } } }));
    expect(defaults(cfg).imageModel).toEqual({ primary: FLASH });
  });

  it("never touches an owner's own vision model, the OpenAI model of the same name included", () => {
    for (const verdict of ["flash", "fallback", "none"]) {
      for (const owner of [{ primary: `openai/${FALLBACK}` }, { primary: "google/gemini-2.5-flash" }, "anthropic/claude-opus-5"]) {
        const { cfg } = migrate(pairedBox({ agents: { defaults: { imageModel: owner } } }), verdict);
        expect(defaults(cfg).imageModel, verdict).toEqual(owner);
      }
    }
  });

  it("claims an EMPTY imageModel for the model that sees, and keeps a fallbacks-only one", () => {
    expect(defaults(migrate(pairedBox({ agents: { defaults: {} } })).cfg).imageModel).toEqual({ primary: FLASH });
    expect(defaults(migrate(pairedBox({ agents: { defaults: {} } }), "fallback").cfg).imageModel)
      .toEqual({ primary: FALLBACK_REF });
    expect(defaults(migrate(pairedBox({ agents: { defaults: {} } }), "none").cfg).imageModel).toBeUndefined();
    expect(defaults(migrate(pairedBox({ agents: { defaults: { imageModel: { primary: "  " } } } })).cfg).imageModel)
      .toEqual({ primary: FLASH });
    const fallbacksOnly = { fallbacks: ["google/gemini-2.5-flash"] };
    expect(defaults(migrate(pairedBox({ agents: { defaults: { imageModel: fallbacksOnly } } })).cfg).imageModel)
      .toEqual(fallbacksOnly);
  });

  it("moves per-agent models, compaction, the policy and the models map, in the same shape", () => {
    const { cfg } = migrate(pairedBox({
      agents: {
        defaults: {
          model: `clawai/${RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS[0]}`,
          compaction: { model: PRO, reserveTokens: 4000 },
          modelPolicy: { allow: [PRO, FLASH, "anthropic/claude-opus-5"] },
          models: { [PRO]: { alias: "max" }, "anthropic/claude-opus-5": {} },
          imageModel: { primary: FLASH },
        },
        list: [
          { id: "main", model: { primary: PRO, fallbacks: [PRO, "anthropic/claude-opus-5"] } },
          { id: "helper", model: "anthropic/claude-opus-5" },
        ],
      },
    }));
    const agents = cfg.agents as { defaults: Record<string, unknown>; list: unknown[] };
    expect(agents.defaults.model).toBe("clawai/deepseek-v4-flash");
    expect(agents.defaults.compaction).toEqual({ model: FLASH, reserveTokens: 4000 });
    expect(agents.defaults.modelPolicy).toEqual({ allow: [FLASH, "anthropic/claude-opus-5"] });
    expect(agents.defaults.models).toEqual({ "anthropic/claude-opus-5": {}, [FLASH]: { alias: "max" } });
    expect(agents.list).toEqual([
      { id: "main", model: { primary: FLASH, fallbacks: [FLASH, "anthropic/claude-opus-5"] } },
      { id: "helper", model: "anthropic/claude-opus-5" },
    ]);
  });

  it("lets a Flash key already in the models map win over a moved one", () => {
    const { cfg } = migrate(pairedBox({
      agents: { defaults: { models: { [PRO]: { alias: "old" }, [FLASH]: { alias: "mine" } } } },
    }));
    expect(defaults(cfg).models).toEqual({ [FLASH]: { alias: "mine" } });
  });

  it("leaves a raw DeepSeek account alone: there the ids are DeepSeek's own", () => {
    // install.sh's CLAWBOX_AI_API_KEY branch points `deepseek` at api.deepseek.com.
    const box = pairedBox({ apiKey: "sk-someone-elses-deepseek-key", baseUrl: "https://api.deepseek.com" });
    const { cfg, changed } = migrate(box);
    expect(changed).toBe(false);
    expect(cfg).toEqual(box);
  });

  it("still moves a `clawai/` ref on a box whose deepseek provider is not ours", () => {
    const { cfg } = migrate(pairedBox({
      apiKey: "sk-raw",
      baseUrl: "https://api.deepseek.com",
      agents: { defaults: { model: { primary: `clawai/${RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS[0]}`, fallbacks: [PRO] } } },
    }));
    expect(defaults(cfg).model).toEqual({ primary: "clawai/deepseek-v4-flash", fallbacks: [PRO] });
  });

  it("keeps everything else on the Flash row", () => {
    const { cfg } = migrate(pairedBox({
      models: [{ id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text"], contextWindow: 1000000 }],
      agents: { defaults: { imageModel: { primary: FLASH } } },
    }));
    expect(dsModels(cfg)).toEqual([
      { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text", "image"], contextWindow: 1000000 },
    ]);
  });

  it("keeps the ids and the probe picture in step with the TypeScript side", () => {
    // The .sh hardcodes them because a shell migration cannot import a TS
    // constant; src/lib/clawbox-ai-retired-models.ts, clawbox-ai-models.ts and
    // clawbox-ai-vision.ts are the other half.
    const py = (ids: readonly string[]) => `(${ids.map((id) => `"${id}"`).join(", ")}${ids.length === 1 ? "," : ""})`;
    expect(POLICY).toContain(`CLAWBOX_AI_RETIRED_CHAT_IDS = ${py(RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS)}`);
    expect(POLICY).toContain(`CLAWBOX_AI_RETIRED_VISION_IDS = ${py(RETIRED_CLAWBOX_AI_VISION_MODEL_IDS)}`);
    expect(POLICY).toContain('CLAWBOX_AI_FLASH_ID = "deepseek-v4-flash"');
    expect(POLICY).toContain(`or "${FALLBACK}"`);
    expect(POLICY).toContain(`CLAWBOX_AI_VISION_PROBE_PNG = "${CLAWBOX_AI_VISION_PROBE_PNG}"`);
  });

  it("asks the box's own ClawBox AI endpoint, or the lab override in the device store", () => {
    expect(POLICY).toContain('_store.get("clawai_vision_probe_url")');
    expect(POLICY).toMatch(/return _one_model_base if isinstance\(_one_model_base, str\)/);
  });
});

/**
 * The probe itself, over HTTP, against a stub that plays the proxy: what Flash
 * and the fallback each do with the probe picture decides the verdict. The
 * stub is reached through the lab override in the device store, exactly as a
 * lab board points the check at one.
 */
describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI vision probe", () => {
  type Answer = { status: number; body: unknown };
  let server: Server;
  /** One answer per model, or a list answered in turn (the last one repeats). */
  let answers: Record<string, Answer | Answer[]>;
  let asked: { model: string; hasImage: boolean; auth: string }[];

  beforeEach(async () => {
    asked = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { model: string; messages: { content: { type: string }[] }[] };
        const hasImage = body.messages?.[0]?.content?.some?.((part) => part.type === "image_url") ?? false;
        const turn = asked.filter((a) => a.model === body.model).length;
        asked.push({ model: body.model, hasImage, auth: String(req.headers.authorization ?? "") });
        const given = answers[body.model];
        const answer = (Array.isArray(given) ? given[Math.min(turn, given.length - 1)] : given) ?? { status: 500, body: {} };
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const said = (text: string): Answer => ({ status: 200, body: { choices: [{ message: { content: text } }] } });
  const refusesPictures: Answer = {
    status: 400,
    body: { error: { message: "Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text`" } },
  };

  async function probe(): Promise<{ cfg: Config; out: string }> {
    const file = path.join(dir, "config.json");
    const store = path.join(dir, "device.json");
    writeFileSync(file, JSON.stringify(pairedBox()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai`;
    writeFileSync(store, JSON.stringify({ clawai_vision_probe_url: url }));
    const program = [
      "import json, os, re, sys",
      "cfg = json.load(open(sys.argv[1]))",
      'models_providers = cfg.setdefault("models", {}).setdefault("providers", {})',
      '_agents_block = cfg.setdefault("agents", {})',
      'agents_defaults = _agents_block.setdefault("defaults", {})',
      'deepseek_provider = models_providers.get("deepseek")',
      "changed = False",
      POLICY,
      "print(json.dumps({'cfg': cfg}))",
    ].join("\n");
    const env = { ...process.env, CLAWBOX_VISION_PROBE: "", CLAWBOX_DEVICE_STORE: store, CLAWBOX_AI_VISION_FALLBACK_MODEL_ID: "" };
    const { stdout } = await promisify(execFile)("python3", ["-c", program, file], { encoding: "utf-8", env });
    const lines = stdout.trim().split("\n");
    return { cfg: JSON.parse(lines[lines.length - 1]).cfg, out: stdout };
  }

  it("keeps pictures on Flash when it reads the probe", async () => {
    answers = { "deepseek-v4-flash": said("Red.") };
    const { cfg, out } = await probe();
    expect(out).toContain("vision check: flash");
    expect(defaults(cfg).imageModel).toEqual({ primary: FLASH });
    expect(asked).toEqual([{ model: "deepseek-v4-flash", hasImage: true, auth: "Bearer claw_token123" }]);
  });

  it("falls back when the proxy refuses Flash a picture", async () => {
    answers = { "deepseek-v4-flash": refusesPictures, [FALLBACK]: said("Red") };
    const { cfg, out } = await probe();
    expect(out).toContain("vision check: fallback");
    expect(dsModels(cfg)).toEqual([FLASH_ROW_BLIND, FALLBACK_ROW]);
    expect(defaults(cfg).imageModel).toEqual({ primary: FALLBACK_REF });
  });

  it("falls back when Flash answers without having seen the picture", async () => {
    answers = { "deepseek-v4-flash": said("I cannot see any image."), [FALLBACK]: said("red") };
    expect((await probe()).out).toContain("vision check: fallback");
  });

  it("does not take a colour named in a refusal as a sighting", async () => {
    answers = { "deepseek-v4-flash": said("Not red - I cannot see images."), [FALLBACK]: said("Red") };
    expect((await probe()).out).toContain("vision check: fallback");
  });

  it("needs two blinds: a blind and an empty answer are no answer, in either order", async () => {
    for (const turns of [[refusesPictures, said("")], [said(""), refusesPictures]]) {
      asked = [];
      answers = { "deepseek-v4-flash": turns, [FALLBACK]: said("Red") };
      const { out } = await probe();
      expect(out).toContain("vision check: unknown");
      expect(asked.map((a) => a.model)).toEqual(["deepseek-v4-flash", "deepseek-v4-flash"]);
    }
  });

  it("arms nothing when neither model can see", async () => {
    answers = { "deepseek-v4-flash": refusesPictures, [FALLBACK]: { status: 400, body: { error: { message: "Model not allowed" } } } };
    const { cfg, out } = await probe();
    expect(out).toContain("vision check: none");
    expect(dsModels(cfg)).toEqual([FLASH_ROW_BLIND]);
    expect(defaults(cfg).imageModel).toBeUndefined();
  });

  it("does not move pictures off a Flash it could not ask", async () => {
    answers = { "deepseek-v4-flash": { status: 503, body: {} }, [FALLBACK]: said("red") };
    const { cfg, out } = await probe();
    expect(out).toContain("vision check: unknown");
    expect(asked.map((a) => a.model)).toEqual(["deepseek-v4-flash"]);
    // An old vision id with no answer goes to Flash, the model measured to see.
    expect(dsModels(cfg)).toEqual([FLASH_ROW_SEES]);
    expect(defaults(cfg).imageModel).toEqual({ primary: FLASH });
  });

  it("keeps the box as it is when the question fails", async () => {
    answers = {};
    const { out } = await probe();
    expect(out).toContain("vision check: unknown");
  });
});
