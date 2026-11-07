import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS,
  RETIRED_CLAWBOX_AI_VISION_MODEL_IDS,
} from "@/lib/clawbox-ai-retired-models";

// Starts a real process (python3): vitest's 5 s test and 10 s hook defaults are
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ClawBox AI is ONE model (TASK-2261): `deepseek-v4-flash`, for chat and for
// looking at pictures. Boxes in the field never re-run the configure route, so
// gateway-pre-start.sh moves openclaw.json off the retired ids at every gateway
// start: the former Max-plan chat id and the separate vision model.
//
// These run the migration block out of the shipped .sh, not a copy of it, so
// the test fails if the real script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const FLASH = "deepseek/deepseek-v4-flash";
const PRO = `deepseek/${RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS[0]}`;
const [VISION_EXP, LEGACY_VISION] = RETIRED_CLAWBOX_AI_VISION_MODEL_IDS;

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
function migrate(cfg: Config): { cfg: Config; changed: boolean } {
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
  const out = execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim().split("\n");
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

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI one-model migration", () => {
  it("moves a box preset to the Max-plan id and the vision model onto Flash", () => {
    const { cfg, changed } = migrate(pairedBox());

    expect(changed).toBe(true);
    expect(dsModels(cfg)).toEqual([
      { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text", "image"] },
    ]);
    expect(defaults(cfg).model).toEqual({ primary: FLASH, fallbacks: [FLASH] });
    expect(defaults(cfg).imageModel).toEqual({ primary: FLASH });
  });

  it("is idempotent — a second boot changes nothing", () => {
    const first = migrate(pairedBox());
    const second = migrate(first.cfg);
    expect(second.changed).toBe(false);
    expect(second.cfg).toEqual(first.cfg);
  });

  it("moves every id the vision model ever had, keeping the owner's fallbacks", () => {
    for (const id of RETIRED_CLAWBOX_AI_VISION_MODEL_IDS) {
      const { cfg } = migrate(pairedBox({
        agents: { defaults: { imageModel: { primary: `deepseek/${id}`, fallbacks: ["google/gemini-2.5-flash"] } } },
      }));
      expect(defaults(cfg).imageModel).toEqual({ primary: FLASH, fallbacks: ["google/gemini-2.5-flash"] });
    }
  });

  it("writes a bare-string imageModel naming our old id back in the object shape", () => {
    const { cfg } = migrate(pairedBox({ agents: { defaults: { imageModel: `deepseek/${LEGACY_VISION}` } } }));
    expect(defaults(cfg).imageModel).toEqual({ primary: FLASH });
  });

  it("never touches an owner's own vision model, the OpenAI one of the same name included", () => {
    for (const owner of [{ primary: `openai/${LEGACY_VISION}` }, { primary: "google/gemini-2.5-flash" }, "anthropic/claude-opus-5"]) {
      const { cfg } = migrate(pairedBox({ agents: { defaults: { imageModel: owner } } }));
      expect(defaults(cfg).imageModel).toEqual(owner);
    }
  });

  it("claims an EMPTY imageModel for Flash, and keeps a fallbacks-only one", () => {
    expect(defaults(migrate(pairedBox({ agents: { defaults: {} } })).cfg).imageModel).toEqual({ primary: FLASH });
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

  it("adds `image` to a Flash row that lacks it and keeps everything else on the row", () => {
    const { cfg } = migrate(pairedBox({
      models: [{ id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text"], contextWindow: 1000000 }],
      agents: { defaults: { imageModel: { primary: FLASH } } },
    }));
    expect(dsModels(cfg)).toEqual([
      { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text", "image"], contextWindow: 1000000 },
    ]);
  });

  it("keeps the retired ids and the Flash id in step with the TypeScript migration", () => {
    // The .sh hardcodes them because a shell migration cannot import a TS
    // constant; src/lib/clawbox-ai-retired-models.ts is the other half.
    const py = (ids: readonly string[]) => `(${ids.map((id) => `"${id}"`).join(", ")}${ids.length === 1 ? "," : ""})`;
    expect(POLICY).toContain(`CLAWBOX_AI_RETIRED_CHAT_IDS = ${py(RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS)}`);
    expect(POLICY).toContain(`CLAWBOX_AI_RETIRED_VISION_IDS = ${py(RETIRED_CLAWBOX_AI_VISION_MODEL_IDS)}`);
    expect(POLICY).toContain('CLAWBOX_AI_FLASH_ID = "deepseek-v4-flash"');
  });

  it("no longer probes the proxy for a vision model", () => {
    expect(POLICY).not.toMatch(/urlopen|_clawbox_vision_probe|CLAWBOX_VISION_PROBE/);
  });
});
