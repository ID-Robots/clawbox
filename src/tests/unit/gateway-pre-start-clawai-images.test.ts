import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAWBOX_AI_IMAGE_MODEL, CLAWBOX_AI_IMAGE_MODEL_ID, CLAWBOX_AI_IMAGE_MODEL_LABEL } from "@/lib/clawbox-ai-models";

// OpenClaw registers `image_generate` only when an image-generation provider is
// configured, and ClawBox provisioning configured none — so every box paired
// before TASK-413 cannot draw a picture despite paying for 5/50/200 a month.
// Those boxes never re-run the configure route, so gateway-pre-start.sh repairs
// them at boot instead.
//
// These run the migration block out of the shipped .sh, not a copy of it, so
// the test fails if the real script drifts. Same approach as
// gateway-pre-start-v4-context.test.ts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** Pull the ClawBox AI image-provider migration out of the .sh verbatim. */
function extractPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("# Migration: ClawBox AI image generation.");
  const end = src.indexOf("if isinstance(ds_models, list):", start);
  if (start < 0 || end < 0) throw new Error("clawai image migration block not found");
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractPolicy() : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "clawai-images-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type OpenAiModelEntry = { id?: string; name?: string; baseUrl?: string; api?: string; [key: string]: unknown };

/**
 * Run the extracted block over a whole openclaw.json.
 *
 * The preamble reproduces the four names the block reads from its surrounding
 * scope, exactly as the real script binds them upstream of this point
 * (`cfg`, `models_providers`, `agents_defaults`, `deepseek_provider`,
 * `changed`) — mock at that boundary and nothing else, so the migration logic
 * under test is 100% the shipped bytes.
 */
function migrate(cfg: Config): { cfg: Config; changed: boolean } {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, sys",
    "cfg = json.load(open(sys.argv[1]))",
    'models_providers = cfg.setdefault("models", {}).setdefault("providers", {})',
    'agents_defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})',
    'deepseek_provider = models_providers.get("deepseek")',
    "changed = False",
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim());
}

/** A box provisioned with ClawBox AI: portal token + proxy on the deepseek entry. */
function pairedBox(overrides: Config = {}): Config {
  return {
    models: {
      providers: {
        deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
      },
    },
    agents: { defaults: {} },
    ...overrides,
  };
}

function openaiProvider(cfg: Config): Record<string, unknown> {
  const models = (cfg.models ?? {}) as { providers?: Record<string, Record<string, unknown>> };
  return models.providers?.openai ?? {};
}

function openaiModels(cfg: Config): OpenAiModelEntry[] {
  return (openaiProvider(cfg).models ?? []) as OpenAiModelEntry[];
}

function imageEntry(cfg: Config): OpenAiModelEntry | undefined {
  return openaiModels(cfg).find((m) => m.id === CLAWBOX_AI_IMAGE_MODEL_ID);
}

function imageGenerationModel(cfg: Config): unknown {
  const agents = (cfg.agents ?? {}) as { defaults?: Record<string, unknown> };
  return agents.defaults?.imageGenerationModel;
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI image migration", () => {
  it("provisions provider, model entry and imageGenerationModel on a paired box", () => {
    const { cfg, changed } = migrate(pairedBox());

    expect(changed).toBe(true);
    expect(openaiProvider(cfg).apiKey).toBe("claw_token123");
    expect(imageEntry(cfg)).toEqual({
      id: CLAWBOX_AI_IMAGE_MODEL_ID,
      name: CLAWBOX_AI_IMAGE_MODEL_LABEL,
      baseUrl: "https://clawbox.com/api/ai",
    });
    // The write that actually makes the tool appear. `imageModel` is a
    // different key (vision) and must not be touched.
    expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    expect((cfg.agents as { defaults: Record<string, unknown> }).defaults.imageModel).toBeUndefined();
  });

  it("keeps the model id in step with CLAWBOX_AI_IMAGE_MODEL_ID", () => {
    // The .sh hardcodes the id because a shell migration cannot import the TS
    // constant. The cloud proxy matches the bare id and answers 400 "Model not
    // allowed" on a miss, so a drift here silently breaks every image request.
    expect(POLICY).toContain(`CLAWBOX_IMAGE_MODEL_ID = "${CLAWBOX_AI_IMAGE_MODEL_ID}"`);
    expect(POLICY).toContain(`CLAWBOX_IMAGE_MODEL_NAME = "${CLAWBOX_AI_IMAGE_MODEL_LABEL}"`);
  });

  it("is idempotent — a second run reports no change", () => {
    const once = migrate(pairedBox());
    expect(once.changed).toBe(true);
    const twice = migrate(once.cfg);
    expect(twice.changed).toBe(false);
    expect(twice.cfg).toEqual(once.cfg);
  });

  it("skips a box with no deepseek apiKey at all", () => {
    const { cfg, changed } = migrate({
      models: { providers: { deepseek: { baseUrl: "https://clawbox.com/api/ai" } } },
      agents: { defaults: {} },
    });

    expect(changed).toBe(false);
    expect(openaiProvider(cfg)).toEqual({});
    expect(imageGenerationModel(cfg)).toBeUndefined();
  });

  it("skips a box with no deepseek provider at all", () => {
    const { cfg, changed } = migrate({ models: { providers: {} }, agents: { defaults: {} } });

    expect(changed).toBe(false);
    expect(imageGenerationModel(cfg)).toBeUndefined();
  });

  it("skips a raw (non claw_) deepseek key — that is the CI/e2e provisioning path", () => {
    // install.sh's CLAWBOX_AI_API_KEY branch writes a raw DeepSeek key pointed
    // at api.deepseek.com. There is no subscription behind it, so there is no
    // image allowance to wire up and clawbox.com would 401 on every request.
    const { cfg, changed } = migrate({
      models: { providers: { deepseek: { apiKey: "sk-deepseek-raw", baseUrl: "https://api.deepseek.com" } } },
      agents: { defaults: {} },
    });

    expect(changed).toBe(false);
    expect(openaiProvider(cfg)).toEqual({});
    expect(imageGenerationModel(cfg)).toBeUndefined();
  });

  it("skips a non-string deepseek apiKey without crashing the boot script", () => {
    const { changed } = migrate({
      models: { providers: { deepseek: { apiKey: 12345 } } },
      agents: { defaults: {} },
    });

    expect(changed).toBe(false);
  });

  it("refuses to overwrite a hand-placed non-ClawBox openai apiKey", () => {
    // ClawBox has never written models.providers.openai.apiKey — the openai
    // setup path uses an auth profile — so anything there is the owner's own
    // credential. Overwriting it to enable a feature nobody asked for is not
    // ours to do, and the whole migration backs off.
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: { apiKey: "sk-proj-users-own-key" },
        },
      },
    }));

    expect(changed).toBe(false);
    expect(openaiProvider(cfg).apiKey).toBe("sk-proj-users-own-key");
    expect(openaiProvider(cfg).models).toBeUndefined();
    expect(imageGenerationModel(cfg)).toBeUndefined();
  });

  it("claims an empty-string openai apiKey — a placeholder is not a credential", () => {
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: { apiKey: "   " },
        },
      },
    }));

    expect(changed).toBe(true);
    expect(openaiProvider(cfg).apiKey).toBe("claw_token123");
  });

  it("refreshes a stale claw_ token it wrote itself on an earlier pairing", () => {
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_new", baseUrl: "https://clawbox.com/api/ai" },
          openai: { apiKey: "claw_old" },
        },
      },
    }));

    expect(changed).toBe(true);
    expect(openaiProvider(cfg).apiKey).toBe("claw_new");
  });

  it("preserves other entries in models.providers.openai.models[]", () => {
    const { cfg } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: { models: [{ id: "gpt-5", name: "GPT-5", api: "openai-completions" }] },
        },
      },
    }));

    expect(openaiModels(cfg)).toHaveLength(2);
    expect(openaiModels(cfg)[0]).toEqual({ id: "gpt-5", name: "GPT-5", api: "openai-completions" });
    expect(imageEntry(cfg)?.baseUrl).toBe("https://clawbox.com/api/ai");
  });

  it("preserves other openai provider settings — it writes leaves, not the provider", () => {
    const { cfg } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: { request: { timeoutMs: 90000 } },
        },
      },
    }));

    expect(openaiProvider(cfg).request).toEqual({ timeoutMs: 90000 });
    expect(openaiProvider(cfg).apiKey).toBe("claw_token123");
  });

  it("strips an `api` field from our entry so the image model stays out of the chat picker", () => {
    // With `api` present, `models list --provider openai --all` offers
    // openai/gpt-image-1-mini as a conversational model that fails on every
    // turn. Only ever ours to remove.
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: {
            apiKey: "claw_token123",
            models: [{
              id: CLAWBOX_AI_IMAGE_MODEL_ID,
              name: CLAWBOX_AI_IMAGE_MODEL_LABEL,
              baseUrl: "https://clawbox.com/api/ai",
              api: "openai-completions",
            }],
          },
        },
      },
      agents: { defaults: { imageGenerationModel: { primary: CLAWBOX_AI_IMAGE_MODEL } } },
    }));

    expect(changed).toBe(true);
    expect(imageEntry(cfg)).not.toHaveProperty("api");
  });

  it("repairs an entry missing its required `name` — the gateway will not boot without one", () => {
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: { apiKey: "claw_token123", models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, baseUrl: "https://clawbox.com/api/ai" }] },
        },
      },
      agents: { defaults: { imageGenerationModel: { primary: CLAWBOX_AI_IMAGE_MODEL } } },
    }));

    expect(changed).toBe(true);
    expect(imageEntry(cfg)?.name).toBe(CLAWBOX_AI_IMAGE_MODEL_LABEL);
  });

  it("takes the image baseUrl off the deepseek entry so a staging proxy stays staging", () => {
    const { cfg } = migrate(pairedBox({
      models: { providers: { deepseek: { apiKey: "claw_token123", baseUrl: "https://staging.clawbox.com/api/ai" } } },
    }));

    expect(imageEntry(cfg)?.baseUrl).toBe("https://staging.clawbox.com/api/ai");
  });

  it("falls back to the production proxy when the deepseek entry carries no baseUrl", () => {
    const { cfg } = migrate(pairedBox({
      models: { providers: { deepseek: { apiKey: "claw_token123" } } },
    }));

    expect(imageEntry(cfg)?.baseUrl).toBe("https://clawbox.com/api/ai");
  });

  it("retargets an entry left pointing at an old proxy", () => {
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: {
            apiKey: "claw_token123",
            models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: "https://openclawhardware.dev/api/ai" }],
          },
        },
      },
      agents: { defaults: { imageGenerationModel: { primary: CLAWBOX_AI_IMAGE_MODEL } } },
    }));

    expect(changed).toBe(true);
    expect(imageEntry(cfg)?.baseUrl).toBe("https://clawbox.com/api/ai");
  });

  it("replaces a models[] that is present but not a list", () => {
    const { cfg } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: { models: "nonsense" },
        },
      },
    }));

    expect(imageEntry(cfg)?.name).toBe(CLAWBOX_AI_IMAGE_MODEL_LABEL);
  });

  it("survives an openai provider that is not an object", () => {
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: "garbage",
        },
      },
    }));

    expect(changed).toBe(true);
    expect(imageEntry(cfg)?.name).toBe(CLAWBOX_AI_IMAGE_MODEL_LABEL);
  });

  describe("does not steal an image model the owner already chose", () => {
    it("leaves an existing primary alone", () => {
      const { cfg } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: { primary: "replicate/flux-pro" } } },
      }));

      expect(imageGenerationModel(cfg)).toEqual({ primary: "replicate/flux-pro" });
    });

    it("leaves a fallbacks-only config alone", () => {
      // The regression this test exists for: `{fallbacks:[...]}` with no
      // `primary` used to have the WHOLE object replaced by
      // `{primary: "openai/gpt-image-1-mini"}`, deleting the owner's fallbacks.
      // OpenClaw's own gate (hasToolModelConfig,
      // dist/model-config.helpers-BS3FWcoO.js:25 on 2026.7.1-2) accepts
      // primary OR a non-empty fallback, so fallbacks-only is a working setup
      // and the migration's stated intent — "a box whose owner pointed image
      // generation at their own provider keeps that choice" — covers it.
      const { cfg } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: { fallbacks: ["replicate/flux-pro"] } } },
      }));

      expect(imageGenerationModel(cfg)).toEqual({ fallbacks: ["replicate/flux-pro"] });
    });

    it("leaves a primary+fallbacks config alone", () => {
      const chosen = { primary: "replicate/flux-pro", fallbacks: ["stability/sd3"] };
      const { cfg } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: chosen } },
      }));

      expect(imageGenerationModel(cfg)).toEqual(chosen);
    });

    it("still provisions the provider block when the slot is taken", () => {
      // The token and model entry are ours regardless; only the slot is not.
      const { cfg, changed } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: { fallbacks: ["replicate/flux-pro"] } } },
      }));

      expect(changed).toBe(true);
      expect(openaiProvider(cfg).apiKey).toBe("claw_token123");
      expect(imageEntry(cfg)?.baseUrl).toBe("https://clawbox.com/api/ai");
    });

    it.each([
      ["an empty object", {}],
      ["a blank primary", { primary: "   " }],
      ["an empty fallbacks list", { fallbacks: [] }],
      ["fallbacks holding only blanks", { fallbacks: ["", "  "] }],
      ["fallbacks that is not a list", { fallbacks: "replicate/flux-pro" }],
      ["a non-string primary", { primary: 42 }],
    ])("claims the slot when it holds %s — OpenClaw would not resolve a model from it", (_label, existing) => {
      const { cfg } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: existing } },
      }));

      expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });

    it("claims the slot when it is not an object at all", () => {
      const { cfg } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: "openai/gpt-image-1-mini" } },
      }));

      expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });
  });
});
