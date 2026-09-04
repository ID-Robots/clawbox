import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Same env-override dance as gateway-pre-start-clawai-images.test.ts:
// `CLAWBOX_AI_VISION_MODEL_ID` resolves an env var at module load and the .sh
// hardcodes the default, so a developer who happens to export that variable
// would fail this file while both sides are perfectly correct. What the
// migration must match is the documented default.
const {
  CLAWBOX_AI_VISION_MODEL,
  CLAWBOX_AI_VISION_MODEL_ID,
  CLAWBOX_AI_LEGACY_VISION_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL_LABEL,
  CLAWBOX_AI_VISION_MAX_TOKENS,
} = await (async () => {
  const override = process.env.CLAWBOX_AI_VISION_MODEL_ID;
  delete process.env.CLAWBOX_AI_VISION_MODEL_ID;
  vi.resetModules();
  try {
    return await import("@/lib/clawbox-ai-models");
  } finally {
    if (override !== undefined) process.env.CLAWBOX_AI_VISION_MODEL_ID = override;
    vi.resetModules();
  }
})();

// A ClawBox accepts an image attachment and then answers that it cannot see it:
// both ClawBox AI chat models are text-only, so OpenClaw hands the turn a media
// path and the `image` tool has to describe it — and that tool resolves its
// model from `agents.defaults.imageModel`, which provisioning never wrote.
// Boxes in the field never re-run the configure route, so gateway-pre-start.sh
// repairs them at boot (TASK-417).
//
// These run the migration block out of the shipped .sh, not a copy of it, so
// the test fails if the real script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** Pull the ClawBox AI vision migration out of the .sh verbatim. */
function extractPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("# Migration: ClawBox AI vision (image understanding).");
  const end = src.indexOf("# Migration: ClawBox AI image generation.", start);
  if (start < 0 || end < 0) throw new Error("clawai vision migration block not found");
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractPolicy() : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "clawai-vision-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type ModelEntry = { id?: string; name?: string; input?: unknown; maxTokens?: unknown; [key: string]: unknown };

/**
 * Run the extracted block over a whole openclaw.json.
 *
 * The preamble reproduces only the names the block reads from its surrounding
 * scope, exactly as the real script binds them upstream of this point
 * (`deepseek_provider`, `agents_defaults`, `changed`) — mock at that boundary
 * and nothing else, so the logic under test is 100% shipped bytes.
 */
function migrate(cfg: Config, env: Record<string, string> = {}): { cfg: Config; changed: boolean } {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, os, sys",
    "cfg = json.load(open(sys.argv[1]))",
    'models_providers = cfg.setdefault("models", {}).setdefault("providers", {})',
    'agents_defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})',
    'deepseek_provider = models_providers.get("deepseek")',
    "changed = False",
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    // The probe is forced so no test touches the network, and a developer's
    // own CLAWBOX_AI_VISION_MODEL_ID cannot leak into the block under test.
    env: { ...process.env, CLAWBOX_AI_VISION_MODEL_ID: "", CLAWBOX_VISION_PROBE: "allowed", ...env },
  }).trim().split("\n");
  return JSON.parse(out[out.length - 1]);
}

/** A box provisioned with ClawBox AI: portal token, proxy, the two chat tiers. */
function pairedBox(overrides: { models?: ModelEntry[]; defaults?: Config; apiKey?: string } = {}): Config {
  return {
    models: {
      providers: {
        deepseek: {
          apiKey: overrides.apiKey ?? "claw_token123",
          baseUrl: "https://clawbox.com/api/ai",
          models: overrides.models ?? [
            { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text"] },
            { id: "deepseek-v4-pro", name: "ClawBox AI Pro", input: ["text"] },
          ],
        },
      },
    },
    agents: { defaults: overrides.defaults ?? {} },
  };
}

function dsModels(cfg: Config): ModelEntry[] {
  const models = (cfg.models ?? {}) as { providers?: Record<string, Record<string, unknown>> };
  return (models.providers?.deepseek?.models ?? []) as ModelEntry[];
}

function visionEntry(cfg: Config): ModelEntry | undefined {
  return dsModels(cfg).find((m) => m.id === CLAWBOX_AI_VISION_MODEL_ID);
}

function imageModel(cfg: Config): unknown {
  const agents = (cfg.agents ?? {}) as { defaults?: Record<string, unknown> };
  return agents.defaults?.imageModel;
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI vision migration", () => {
  it("adds the vision entry and claims imageModel on a paired box", () => {
    const { cfg, changed } = migrate(pairedBox());

    expect(changed).toBe(true);
    expect(visionEntry(cfg)).toEqual({
      id: CLAWBOX_AI_VISION_MODEL_ID,
      name: CLAWBOX_AI_VISION_MODEL_LABEL,
      input: ["text", "image"],
      maxTokens: CLAWBOX_AI_VISION_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(imageModel(cfg)).toEqual({ primary: CLAWBOX_AI_VISION_MODEL });
  });

  it("leaves the two chat tiers untouched", () => {
    const { cfg } = migrate(pairedBox());
    const chat = dsModels(cfg).filter((m) => m.id !== CLAWBOX_AI_VISION_MODEL_ID);
    expect(chat).toEqual([
      { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text"] },
      { id: "deepseek-v4-pro", name: "ClawBox AI Pro", input: ["text"] },
    ]);
  });

  it("does not touch imageGenerationModel", () => {
    // Two independent keys. Images-out is provisioned by its own migration and
    // a vision repair must not disturb it.
    const { cfg } = migrate(pairedBox({ defaults: { imageGenerationModel: { primary: "openai/gpt-image-1-mini" } } }));
    const defaults = (cfg.agents as { defaults: Record<string, unknown> }).defaults;
    expect(defaults.imageGenerationModel).toEqual({ primary: "openai/gpt-image-1-mini" });
    expect(defaults.imageModel).toEqual({ primary: CLAWBOX_AI_VISION_MODEL });
  });

  it("is idempotent — a second boot changes nothing", () => {
    const first = migrate(pairedBox());
    const second = migrate(first.cfg);
    expect(second.changed).toBe(false);
    expect(second.cfg).toEqual(first.cfg);
  });

  it("skips a box with no ClawBox AI token", () => {
    // The token is the entitlement: an unpaired box gets no proxy-backed model.
    const { cfg, changed } = migrate(pairedBox({ apiKey: "" }));
    expect(changed).toBe(false);
    expect(visionEntry(cfg)).toBeUndefined();
    expect(imageModel(cfg)).toBeUndefined();
  });

  it("skips a box whose deepseek key is somebody else's, not a claw_ token", () => {
    const { cfg, changed } = migrate(pairedBox({ apiKey: "sk-someone-elses-deepseek-key" }));
    expect(changed).toBe(false);
    expect(visionEntry(cfg)).toBeUndefined();
  });

  it("keeps an imageModel the owner already chose", () => {
    const { cfg, changed } = migrate(pairedBox({ defaults: { imageModel: { primary: "google/gemini-2.5-flash" } } }));
    expect(imageModel(cfg)).toEqual({ primary: "google/gemini-2.5-flash" });
    // The entry is still added — having the model available is not the same as
    // making it the default — so this boot is still a change.
    expect(changed).toBe(true);
    expect(visionEntry(cfg)).toBeDefined();
  });

  it("treats a fallbacks-only imageModel as already configured", () => {
    // hasToolModelConfig counts fallbacks, and the write replaces the whole
    // object — claiming the slot here would delete the owner's fallbacks.
    const owner = { fallbacks: ["google/gemini-2.5-flash"] };
    const { cfg } = migrate(pairedBox({ defaults: { imageModel: owner } }));
    expect(imageModel(cfg)).toEqual(owner);
  });

  it("ignores an imageModel that is empty in OpenClaw's sense", () => {
    const { cfg } = migrate(pairedBox({ defaults: { imageModel: { primary: "   ", fallbacks: ["", "  "] } } }));
    expect(imageModel(cfg)).toEqual({ primary: CLAWBOX_AI_VISION_MODEL });
  });

  it("repairs an existing entry that cannot accept images", () => {
    // The failure this migration exists to fix: without "image" in `input`,
    // resolveImageRuntime refuses the model outright.
    const { cfg, changed } = migrate(pairedBox({
      models: [
        { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text"] },
        { id: CLAWBOX_AI_VISION_MODEL_ID, name: CLAWBOX_AI_VISION_MODEL_LABEL, input: ["text"], maxTokens: 128000 },
      ],
    }));
    expect(changed).toBe(true);
    expect(visionEntry(cfg)?.input).toEqual(["text", "image"]);
  });

  it("repairs a missing name, which would stop the gateway booting", () => {
    const { cfg, changed } = migrate(pairedBox({
      models: [{ id: CLAWBOX_AI_VISION_MODEL_ID, name: "  ", input: ["text", "image"], maxTokens: 128000 }],
    }));
    expect(changed).toBe(true);
    expect(visionEntry(cfg)?.name).toBe(CLAWBOX_AI_VISION_MODEL_LABEL);
  });

  it("fills an absent maxTokens but keeps a number someone else chose", () => {
    const filled = migrate(pairedBox({
      models: [{ id: CLAWBOX_AI_VISION_MODEL_ID, name: CLAWBOX_AI_VISION_MODEL_LABEL, input: ["text", "image"] }],
    }));
    expect(visionEntry(filled.cfg)?.maxTokens).toBe(CLAWBOX_AI_VISION_MAX_TOKENS);

    const chosen = migrate(pairedBox({
      models: [{ id: CLAWBOX_AI_VISION_MODEL_ID, name: CLAWBOX_AI_VISION_MODEL_LABEL, input: ["text", "image"], maxTokens: 4096 }],
    }));
    expect(visionEntry(chosen.cfg)?.maxTokens).toBe(4096);
  });

  it("follows CLAWBOX_AI_VISION_MODEL_ID when a staging proxy sets it", () => {
    // The route resolves the slug from the environment; a migration that always
    // wrote the production default would drag a staging box back to a model its
    // proxy may not allow at the next boot.
    const { cfg } = migrate(pairedBox(), { CLAWBOX_AI_VISION_MODEL_ID: "vision-staging-1" });
    expect(dsModels(cfg).some((m) => m.id === "vision-staging-1")).toBe(true);
    expect(imageModel(cfg)).toEqual({ primary: "deepseek/vision-staging-1" });
  });

  it("keeps the model ids, label and ceiling in step with the TS constants", () => {
    // The .sh hardcodes them because a shell migration cannot import a TS
    // constant. The proxy matches the BARE id against its allowlist, so a drift
    // here silently breaks every vision request.
    expect(POLICY).toContain(`CLAWBOX_VISION_PREFERRED_ID = "${CLAWBOX_AI_VISION_MODEL_ID}"`);
    expect(POLICY).toContain(`CLAWBOX_VISION_LEGACY_ID = "${CLAWBOX_AI_LEGACY_VISION_MODEL_ID}"`);
    expect(POLICY).toContain(`CLAWBOX_VISION_MODEL_NAME = "${CLAWBOX_AI_VISION_MODEL_LABEL}"`);
    expect(POLICY).toContain(`CLAWBOX_VISION_MAX_TOKENS = ${CLAWBOX_AI_VISION_MAX_TOKENS}`);
    expect(CLAWBOX_AI_VISION_MODEL).toBe(`deepseek/${CLAWBOX_AI_VISION_MODEL_ID}`);
  });

  // ── The DeepSeek switch: resolved against the proxy, never assumed ──────

  it("stays on the previous vision model while the proxy refuses the new id", () => {
    const { cfg, changed } = migrate(pairedBox(), { CLAWBOX_VISION_PROBE: "not-allowed" });
    expect(changed).toBe(true);
    expect(dsModels(cfg).some((m) => m.id === CLAWBOX_AI_LEGACY_VISION_MODEL_ID)).toBe(true);
    expect(dsModels(cfg).some((m) => m.id === CLAWBOX_AI_VISION_MODEL_ID)).toBe(false);
    expect(imageModel(cfg)).toEqual({ primary: `deepseek/${CLAWBOX_AI_LEGACY_VISION_MODEL_ID}` });
  });

  it("retargets a field box's legacy entry and slot the first boot the proxy says yes", () => {
    const fieldBox = pairedBox({
      models: [
        { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text"] },
        { id: CLAWBOX_AI_LEGACY_VISION_MODEL_ID, name: CLAWBOX_AI_VISION_MODEL_LABEL, input: ["text", "image"], maxTokens: 128000 },
      ],
      defaults: { imageModel: { primary: `deepseek/${CLAWBOX_AI_LEGACY_VISION_MODEL_ID}` } },
    });
    const { cfg, changed } = migrate(fieldBox);
    expect(changed).toBe(true);
    // Retargeted in place — one vision entry, not two stacked.
    expect(dsModels(cfg).filter((m) => m.id === CLAWBOX_AI_VISION_MODEL_ID)).toHaveLength(1);
    expect(dsModels(cfg).some((m) => m.id === CLAWBOX_AI_LEGACY_VISION_MODEL_ID)).toBe(false);
    expect(imageModel(cfg)).toEqual({ primary: CLAWBOX_AI_VISION_MODEL });
  });

  it("a managed move changes only primary — owner fallbacks ride along", () => {
    const { cfg } = migrate(pairedBox({
      models: [
        { id: CLAWBOX_AI_LEGACY_VISION_MODEL_ID, name: CLAWBOX_AI_VISION_MODEL_LABEL, input: ["text", "image"], maxTokens: 128000 },
      ],
      defaults: { imageModel: { primary: `deepseek/${CLAWBOX_AI_LEGACY_VISION_MODEL_ID}`, fallbacks: ["google/gemini-2.5-flash"] } },
    }));
    expect(imageModel(cfg)).toEqual({ primary: CLAWBOX_AI_VISION_MODEL, fallbacks: ["google/gemini-2.5-flash"] });
  });

  it("moves only OUR slot value — an owner's model is never retargeted", () => {
    const { cfg } = migrate(pairedBox({
      defaults: { imageModel: { primary: "google/gemini-2.5-flash" } },
    }));
    expect(imageModel(cfg)).toEqual({ primary: "google/gemini-2.5-flash" });
  });

  it("keeps whatever the box already names when the probe cannot answer", () => {
    const legacyBox = pairedBox({
      models: [
        { id: "deepseek-v4-flash", name: "ClawBox AI Flash", input: ["text"] },
        { id: CLAWBOX_AI_LEGACY_VISION_MODEL_ID, name: CLAWBOX_AI_VISION_MODEL_LABEL, input: ["text", "image"], maxTokens: 128000 },
      ],
      defaults: { imageModel: { primary: `deepseek/${CLAWBOX_AI_LEGACY_VISION_MODEL_ID}` } },
    });
    const { cfg, changed } = migrate(legacyBox, { CLAWBOX_VISION_PROBE: "unknown" });
    // A bad network moment must not flap the config in either direction.
    expect(changed).toBe(false);
    expect(imageModel(cfg)).toEqual({ primary: `deepseek/${CLAWBOX_AI_LEGACY_VISION_MODEL_ID}` });

    const upgradedBox = pairedBox({
      models: [
        { id: CLAWBOX_AI_VISION_MODEL_ID, name: CLAWBOX_AI_VISION_MODEL_LABEL, input: ["text", "image"], maxTokens: 128000 },
      ],
      defaults: { imageModel: { primary: CLAWBOX_AI_VISION_MODEL } },
    });
    const kept = migrate(upgradedBox, { CLAWBOX_VISION_PROBE: "unknown" });
    expect(kept.changed).toBe(false);
    expect(imageModel(kept.cfg)).toEqual({ primary: CLAWBOX_AI_VISION_MODEL });
  });
});
