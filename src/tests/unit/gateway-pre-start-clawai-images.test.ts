import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// `CLAWBOX_AI_IMAGE_MODEL_ID` resolves `process.env.CLAWBOX_AI_IMAGE_MODEL_ID`
// at module load, and the .sh hardcodes the default because a shell migration
// cannot import a TS constant. Read the constants through a plain `import` and
// a developer or CI job that happens to export that variable fails this file
// while both sides are perfectly correct. Load the module with the override
// cleared instead: what the migration has to match is the documented default,
// not whatever the ambient environment is pointed at today.
const {
  CLAWBOX_AI_IMAGE_MODEL,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_IMAGE_MODEL_LABEL,
  CLAWBOX_AI_PROXY_URLS,
} =
  await (async () => {
    const override = process.env.CLAWBOX_AI_IMAGE_MODEL_ID;
    delete process.env.CLAWBOX_AI_IMAGE_MODEL_ID;
    vi.resetModules();
    try {
      return await import("@/lib/clawbox-ai-models");
    } finally {
      if (override !== undefined) process.env.CLAWBOX_AI_IMAGE_MODEL_ID = override;
      vi.resetModules();
    }
  })();

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
  // Ends where the speech-to-text migration begins: the two blocks are
  // independent and each is exercised by its own file
  // (gateway-pre-start-clawai-audio.test.ts).
  const end = src.indexOf("# Migration: ClawBox AI speech to text.", start);
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
function migrate(cfg: Config, v2 = false, store?: DeviceStore): { cfg: Config; changed: boolean; log: string } {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const program = [
    "import json, os, sys",
    "cfg = json.load(open(sys.argv[1]))",
    'models_providers = cfg.setdefault("models", {}).setdefault("providers", {})',
    'agents_defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})',
    'deepseek_provider = models_providers.get("deepseek")',
    "changed = False",
    ...(v2 ? ["CLAWBOX_OPENCLAW_V2 = True"] : []),
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  // The block prints progress lines of its own (the real script's stdout is the
  // boot log), so the result is the LAST line and everything before it is what
  // the operator would read. Both are asserted on below.
  const lines = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    env: { ...process.env, CLAWBOX_DEVICE_STORE: deviceStorePath(store) },
  }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

/**
 * The device store `CLAWBOX_DEVICE_STORE` points at, as this block reads it.
 *
 * `undefined` writes no file at all — a box whose Next app has never saved a
 * setting, which is the state every case above this one runs in and the state
 * the migration has always been exercised against.
 */
type DeviceStore = { body: string } | { bytes: Buffer } | Record<string, unknown>;

function deviceStorePath(store?: DeviceStore): string {
  const file = path.join(dir, "device-store.json");
  // Removed rather than skipped: a test that migrates twice in one `dir` would
  // otherwise keep whatever the FIRST call wrote, and "no store" would silently
  // mean "the previous store".
  if (store === undefined) { rmSync(file, { force: true }); return file; }
  const bytes = (store as { bytes?: unknown }).bytes;
  if (Buffer.isBuffer(bytes)) writeFileSync(file, bytes);
  else if (typeof (store as { body?: unknown }).body === "string") writeFileSync(file, (store as { body: string }).body);
  else writeFileSync(file, JSON.stringify(store));
  return file;
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
    // image provider to wire up and clawbox.com would 401 on every request.
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
    // A sibling row that stays on the ClawBox AI proxy: nothing leaves our
    // infrastructure, so the migration runs and the row survives it. A sibling
    // pointing anywhere else is the back-off case below.
    const sibling = { id: "house-model", name: "House model", api: "openai-completions", baseUrl: "https://clawbox.com/api/ai" };
    const { cfg } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: { models: [sibling] },
        },
      },
    }));

    expect(openaiModels(cfg)).toHaveLength(2);
    expect(openaiModels(cfg)[0]).toEqual(sibling);
    expect(imageEntry(cfg)?.baseUrl).toBe("https://clawbox.com/api/ai");
  });

  describe("will not make the portal token the credential for someone else's endpoint", () => {
    // models.providers.openai.apiKey is provider-wide. getApiKeyForModel
    // (dist/model-auth-CJEm9SNp.js:753 on OpenClaw 2026.7.1-2) falls back to it
    // for any `openai/*` model once per-entry bindings, auth profiles and
    // OPENAI_API_KEY come up empty — which on a ClawBox they always do. So a
    // configured route we did not build would start carrying the subscription
    // token, and the whole migration backs off instead.
    function backedOff(cfg: Config) {
      const result = migrate(cfg);
      expect(result.changed).toBe(false);
      expect(openaiProvider(result.cfg).apiKey).toBeUndefined();
      expect(imageEntry(result.cfg)).toBeUndefined();
      expect(imageGenerationModel(result.cfg)).toBeUndefined();
      return result;
    }

    function boxWithOpenai(openai: Record<string, unknown>): Config {
      return pairedBox({
        models: {
          providers: {
            deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
            openai,
          },
        },
      });
    }

    it("backs off on a sibling row that resolves to api.openai.com", () => {
      // CodeRabbit's case: `api` makes it a live chat row and the absent baseUrl
      // means OpenClaw resolves it to api.openai.com, where our claw_ token
      // would be sent as the bearer.
      const { log } = backedOff(boxWithOpenai({ models: [{ id: "gpt-5", name: "GPT-5", api: "openai-completions" }] }));

      expect(log).toContain("Skipped ClawBox AI image provider");
      expect(log).toContain("api.openai.com");
    });

    it("backs off on a sibling row pointing at a third-party host", () => {
      backedOff(boxWithOpenai({
        models: [{ id: "local-gpt", name: "Local GPT", api: "openai-completions", baseUrl: "https://someone-elses-proxy.example/v1" }],
      }));
    });

    it("backs off on a provider-level baseUrl that is not ours", () => {
      // Every row without a baseUrl of its own inherits this one — including
      // OpenClaw's bundled openai catalog rows.
      const { log } = backedOff(boxWithOpenai({ baseUrl: "https://someone-elses-proxy.example/v1" }));

      expect(log).toContain("someone-elses-proxy.example");
    });

    it("backs off on a baseUrl it cannot parse", () => {
      // We cannot say where "not-a-url" points, and guessing permissively is
      // the wrong direction to be wrong in.
      backedOff(boxWithOpenai({ models: [{ id: "mystery", name: "Mystery", baseUrl: "not-a-url" }] }));
    });

    it("leaves an owner's own row of OUR id on their private proxy alone", () => {
      // `gpt-image-1-mini` is a real OpenAI model id, and Azure OpenAI /
      // LiteLLM / vLLM / any self-hosted OpenAI-compatible gateway is where a
      // power user's row of that id actually lives. Claiming it by id repointed
      // their route at our proxy, overwrote their `api`, and wrote the portal
      // token as the provider-wide credential for a route we do not own.
      const theirs = {
        id: CLAWBOX_AI_IMAGE_MODEL_ID,
        name: "My Azure image model",
        api: "azure-images",
        baseUrl: "https://my-azure.example/openai/v1",
      };
      const { cfg, changed, log } = migrate(boxWithOpenai({ models: [{ ...theirs }] }));

      // Their row marks the route foreign, so the whole migration backs off.
      expect(changed).toBe(false);
      expect(openaiModels(cfg)).toEqual([theirs]);
      expect(openaiProvider(cfg).apiKey).toBeUndefined();
      expect(log).toContain("my-azure.example");
    });

    it("leaves an owner's row of OUR id with no baseUrl alone", () => {
      // ClawBox has always written a baseUrl on its own row, so a row without
      // one is the owner's, inheriting whatever the provider block says.
      const theirs = { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "gpt-image-1-mini", api: "openai-completions" };
      const { cfg, changed } = migrate(boxWithOpenai({ models: [{ ...theirs }] }));

      expect(changed).toBe(false);
      expect(openaiModels(cfg)).toEqual([theirs]);
    });

    it("proceeds when a sibling row points at a RETIRED ClawBox proxy host", () => {
      // The foreignness test asks "would our token leave the building?", so it
      // has to know every host ClawBox has ever written, exactly as the
      // ownership test does — and exactly as its TypeScript mirror now does.
      // On the single-host form this backed the whole migration off, which
      // also gates the speech-to-text migration after it, so the same config
      // produced two different box states depending on which writer ran last.
      const { cfg, changed } = migrate(boxWithOpenai({
        models: [{ id: "house-model", name: "House model", api: "openai-completions", baseUrl: "https://openclawhardware.dev/api/ai" }],
      }));

      expect(changed).toBe(true);
      expect(openaiProvider(cfg).apiKey).toBe("claw_token123");
      expect(imageEntry(cfg)).toBeDefined();
    });

    it("proceeds when a sibling row points at the same proxy we do", () => {
      const { cfg, changed } = migrate(boxWithOpenai({
        models: [{ id: "house-model", name: "House model", api: "openai-completions", baseUrl: "https://clawbox.com/api/ai" }],
      }));

      expect(changed).toBe(true);
      expect(openaiProvider(cfg).apiKey).toBe("claw_token123");
    });

    it("proceeds on a box whose only openai row is ours", () => {
      // Re-running the migration must not back off on its own previous output.
      const { cfg, changed } = migrate(boxWithOpenai({
        apiKey: "claw_old",
        models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: "https://clawbox.com/api/ai" }],
      }));

      expect(changed).toBe(true);
      expect(openaiProvider(cfg).apiKey).toBe("claw_token123");
    });

    it("stays quiet about a box it was never going to touch", () => {
      // The hand-placed-key branch already backs off; it should not also print
      // a routing complaint about a config it is leaving alone.
      const { log } = migrate(boxWithOpenai({
        apiKey: "sk-proj-users-own-key",
        models: [{ id: "gpt-5", name: "GPT-5", api: "openai-completions" }],
      }));

      expect(log).toBe("");
    });
  });

  it("normalises a default port away, exactly as `new URL(u).host` does", () => {
    // The docstring on `_url_host` claims it matches the TypeScript side so
    // the two guards agree on one string. `urlsplit` KEEPS an explicit :443
    // and `URL.host` drops it, so a row naming the default port explicitly was
    // ours to the route and foreign to this script — which then backed the
    // whole image migration off on a box the route had just repaired.
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: {
            apiKey: "claw_token123",
            models: [{
              id: CLAWBOX_AI_IMAGE_MODEL_ID,
              name: CLAWBOX_AI_IMAGE_MODEL_LABEL,
              baseUrl: "https://clawbox.com:443/api/ai",
            }],
          },
        },
      },
      agents: { defaults: { imageGenerationModel: { primary: CLAWBOX_AI_IMAGE_MODEL } } },
    }));

    // Recognised as ours: retargeted in place, not treated as a foreign route.
    expect(changed).toBe(true);
    expect(openaiModels(cfg)).toHaveLength(1);
    expect(imageEntry(cfg)?.baseUrl).toBe("https://clawbox.com/api/ai");
  });

  it("still recognises our own row on a RETIRED proxy host as ours", () => {
    // The ownership set carries every host ClawBox has ever written, so the
    // documented retarget of an entry left on an old proxy still finds it —
    // one row repaired in place, not a second one appended beside it.
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: {
            apiKey: "claw_token123",
            models: [{
              id: CLAWBOX_AI_IMAGE_MODEL_ID,
              name: CLAWBOX_AI_IMAGE_MODEL_LABEL,
              baseUrl: "https://www.openclawhardware.dev/api/ai",
            }],
          },
        },
      },
      agents: { defaults: { imageGenerationModel: { primary: CLAWBOX_AI_IMAGE_MODEL } } },
    }));

    expect(changed).toBe(true);
    expect(openaiModels(cfg)).toHaveLength(1);
    expect(imageEntry(cfg)?.baseUrl).toBe("https://clawbox.com/api/ai");
  });

  it("strips a stray `api` from every duplicate of our entry, not just the first", () => {
    // A stale copy left by an older upsert is offered by the same pickers as
    // the live one, so the `api` strip has to reach all of them.
    const { cfg, changed } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: {
            apiKey: "claw_token123",
            models: [
              { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: "https://clawbox.com/api/ai", api: "openai-completions" },
              { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: CLAWBOX_AI_IMAGE_MODEL_LABEL, baseUrl: "https://clawbox.com/api/ai", api: "openai-completions" },
            ],
          },
        },
      },
      agents: { defaults: { imageGenerationModel: { primary: CLAWBOX_AI_IMAGE_MODEL } } },
    }));

    expect(changed).toBe(true);
    expect(openaiModels(cfg)).toHaveLength(2);
    for (const row of openaiModels(cfg)) expect(row).not.toHaveProperty("api");
  });

  it("keeps its ownership host list identical to the route's", () => {
    // The two writers decide "is this row ours?" from separate literal lists,
    // in two languages. If they ever diverge one writer claims a row the other
    // calls foreign — and the route's back-off is total, so the box silently
    // stops getting its image provider. Pinned here rather than left to
    // convention.
    const shellHosts = Array.from(POLICY.matchAll(/"(https:\/\/[^"]+)"/g))
      .map((match) => match[1])
      .filter((url) => url.includes("/api/ai"));
    // Against the list the ROUTE actually uses, not a copy written here: a
    // fourth host added to CLAWBOX_AI_PROXY_URLS alone must fail this, or the
    // test pins the shell to itself and the two writers can still drift.
    expect(new Set(shellHosts)).toEqual(new Set(CLAWBOX_AI_PROXY_URLS));
  });

  it("prints only the host of the route it refuses to claim, never its credentials", () => {
    // The TypeScript sibling redacts this to host-only because an
    // owner-configured URL can carry user-info or query credentials and the
    // journal keeps what is logged. This block writes to that same journal.
    const { log } = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: {
            models: [{
              id: "their-model",
              name: "Theirs",
              api: "openai-completions",
              baseUrl: "https://hunter2:s3cret@their-host.example/v1?token=abc",
            }],
          },
        },
      },
    }));

    expect(log).toContain("their-host.example");
    expect(log).not.toContain("hunter2");
    expect(log).not.toContain("s3cret");
    expect(log).not.toContain("token=abc");
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
    // The stale host on the IMAGE entry is the point of this fixture: deepseek
    // already carries the current proxy, and the migration has to drag the
    // model entry onto it. Renaming that literal to the current domain makes
    // the test assert that migrating an already-correct entry reports a change.
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

// OpenClaw 2's home for the image-generation pick is
// agents.defaults.mediaModels.image; the legacy imageGenerationModel key
// fails config validation there. Same block, other home — picked from
// CLAWBOX_OPENCLAW_V2, bound via globals() so this preamble can set it.
describe.skipIf(!hasPython3)("the image-generation home on OpenClaw 2", () => {
  function mediaImage(cfg: Config): unknown {
    const agents = (cfg.agents ?? {}) as { defaults?: { mediaModels?: { image?: unknown } } };
    return agents.defaults?.mediaModels?.image;
  }

  it("claims mediaModels.image on a paired box, and never writes the legacy key", () => {
    const { cfg, changed } = migrate(pairedBox(), true);
    expect(changed).toBe(true);
    expect(mediaImage(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    expect(imageGenerationModel(cfg)).toBeUndefined();
  });

  it("is idempotent in the v2 home too", () => {
    const once = migrate(pairedBox(), true);
    const twice = migrate(once.cfg, true);
    expect(twice.changed).toBe(false);
    expect(twice.cfg).toEqual(once.cfg);
  });

  it("leaves an owner's mediaModels.image alone", () => {
    const { cfg } = migrate(
      pairedBox({ agents: { defaults: { mediaModels: { image: { primary: "openai/their-pick" } } } } }),
      true,
    );
    expect(mediaImage(cfg)).toEqual({ primary: "openai/their-pick" });
  });
});

/**
 * TASK-727, second half: the agent's own image path.
 *
 * The pinned core has no back-off and no disable-on-refusal for image
 * generation — measured against openclaw@2026.8.1 on a box: the `openai`
 * extension declares `contracts.imageGenerationProviders` with nothing beside
 * it but `imageGenerationProviderMetadata.openai.authSignals`, and that is a
 * static AVAILABILITY gate (`toolMetadataPasses` asks whether a credential is
 * configured, never what a response said); the request itself is the bundled
 * OpenAI SDK's, whose `shouldRetry` covers 408/409/429/5xx and returns false
 * for 401 and 403. So nothing downstream of this script ever stops asking, and
 * the only lever the harness gives us is the one this block pulls: whether the
 * image path is declared at all.
 *
 * Which made this migration's one-wayness the whole defect. It armed
 * `models.providers.openai` and the image slot on any `claw_`-prefixed token,
 * every boot, forever — with no arm in the other direction, unlike the cloud
 * voice forty lines below it. A box whose credential the proxy has PERMANENTLY
 * refused therefore had the picture path re-declared at every gateway start,
 * and the agent went on spending refused calls on it (6,554 in twelve hours
 * from one box, ~34/min at the peak).
 */
describe.skipIf(!hasPython3)("standing down when the credential has been refused", () => {
  const REFUSED = { clawai_credential_refused_at: 1_788_000_000_000 };

  /** The box as this migration leaves an entitled one: our row, our slot. */
  function armedBox(v2 = false): Config {
    return migrate(pairedBox(), v2).cfg;
  }

  function mediaImage(cfg: Config): unknown {
    const agents = (cfg.agents ?? {}) as { defaults?: { mediaModels?: { image?: unknown } } };
    return agents.defaults?.mediaModels?.image;
  }

  it("does not arm the image path on a box whose credential the proxy has refused", () => {
    const { cfg, changed } = migrate(pairedBox(), false, REFUSED);

    expect(imageGenerationModel(cfg)).toBeUndefined();
    expect(imageEntry(cfg)).toBeUndefined();
    // `changed` is still true: the credential refresh onto
    // models.providers.openai.apiKey happens either way, because that field is
    // the bearer for channel audio and the cloud voice, not just for pictures.
    expect(changed).toBe(true);
  });

  it("takes back the row and the slot it wrote itself", () => {
    const { cfg, changed, log } = migrate(armedBox(), false, REFUSED);

    expect(imageGenerationModel(cfg)).toBeUndefined();
    expect(imageEntry(cfg)).toBeUndefined();
    expect(changed).toBe(true);
    expect(log).toContain("Removed the ClawBox AI image model");
  });

  it("takes back the v2 home too", () => {
    const { cfg, changed } = migrate(armedBox(true), true, REFUSED);

    expect(mediaImage(cfg)).toBeUndefined();
    expect(imageEntry(cfg)).toBeUndefined();
    expect(changed).toBe(true);
  });

  it("re-arms once the refusal is cleared — a re-linked box gets its pictures back", () => {
    const stoodDown = migrate(armedBox(), false, REFUSED).cfg;
    const { cfg, changed } = migrate(stoodDown);

    expect(changed).toBe(true);
    expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    expect(imageEntry(cfg)?.baseUrl).toBe("https://clawbox.com/api/ai");
  });

  it("is idempotent — a second refused boot reports no change", () => {
    const once = migrate(armedBox(), false, REFUSED);
    const twice = migrate(once.cfg, false, REFUSED);

    expect(twice.changed).toBe(false);
    expect(twice.cfg).toEqual(once.cfg);
  });

  it("leaves the provider apiKey alone — the channel-audio surface reads the same slot", () => {
    // `tools.media.audio` takes its bearer from models.providers.openai.apiKey
    // (the migration below this one relies on it). Taking the picture path back
    // must not silently take voice transcription with it.
    const { cfg } = migrate(armedBox(), false, REFUSED);

    expect(openaiProvider(cfg).apiKey).toBe("claw_token123");
  });

  it("leaves an image model the owner chose", () => {
    const { cfg } = migrate(
      pairedBox({ agents: { defaults: { imageGenerationModel: { primary: "openai/their-pick" } } } }),
      false,
      REFUSED,
    );

    expect(imageGenerationModel(cfg)).toEqual({ primary: "openai/their-pick" });
    expect(imageEntry(cfg)).toBeUndefined();
  });

  it("leaves our primary alone once the owner has added fallbacks to it", () => {
    // We only ever wrote `{primary: <our ref>}` into an EMPTY slot. Anything
    // else in the object is theirs, and deleting the key would take it with us.
    const owned = { primary: CLAWBOX_AI_IMAGE_MODEL, fallbacks: ["openai/their-backup"] };
    const { cfg } = migrate(
      pairedBox({ agents: { defaults: { imageGenerationModel: owned } } }),
      false,
      REFUSED,
    );

    expect(imageGenerationModel(cfg)).toEqual(owned);
  });

  it("leaves an owner's own gpt-image-1-mini row on their own endpoint", () => {
    const theirs = { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "Mine", baseUrl: "https://llm.home.lan/v1" };
    const { cfg, changed } = migrate(
      pairedBox({
        models: {
          providers: {
            deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
            openai: { apiKey: "claw_token123", models: [theirs] },
          },
        },
      }),
      false,
      REFUSED,
    );

    expect(openaiModels(cfg)).toEqual([theirs]);
    expect(changed).toBe(false);
  });

  it.each([
    ["a store that is not there at all", undefined],
    ["a store that is not JSON", { body: "{" } as DeviceStore],
    ["a store that is not an object", { body: "[]" } as DeviceStore],
    ["a store with no refusal recorded", {} as DeviceStore],
    ["a refusal stamp that is not a number", { clawai_credential_refused_at: "yes" } as DeviceStore],
    // A byte that is not valid UTF-8 — a torn write after a power cut. It
    // raises `UnicodeDecodeError`, which is neither `OSError` nor
    // `json.JSONDecodeError`, and this block sits in the ONE python heredoc in
    // the script that is invoked bare under `set -euo pipefail`: an escape here
    // aborts the ExecStartPre and the box gets no gateway at all.
    ["a store that is not decodable at all", { bytes: Buffer.from([0x7b, 0xff]) } as DeviceStore],
    // Python's `json` accepts these where `JSON.parse` does not, and the
    // TypeScript writer rejects them with `Number.isFinite`. The two readers of
    // this key have to agree on every value either can meet.
    ["a non-finite stamp", { body: '{"clawai_credential_refused_at": Infinity}' } as DeviceStore],
    ["a NaN stamp", { body: '{"clawai_credential_refused_at": NaN}' } as DeviceStore],
  ])("arms as before over %s — not knowing is not a refusal", (_label, store) => {
    const { cfg } = migrate(pairedBox(), false, store);

    expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    expect(imageEntry(cfg)?.id).toBe(CLAWBOX_AI_IMAGE_MODEL_ID);
  });

  it("takes back BOTH homes on a v2 box that carries both", () => {
    // Neither home may be left naming a row the other arm has just removed: the
    // core's loader migration re-creates `mediaModels.image` from the legacy
    // key, so a stand-down that cleared only one would be undone on the next
    // load and left pointing at a model that is gone.
    const both = migrate(armedBox(true), true, REFUSED).cfg;
    const withLegacy = JSON.parse(JSON.stringify(armedBox(true))) as Config;
    ((withLegacy.agents as { defaults: Record<string, unknown> }).defaults)
      .imageGenerationModel = { primary: CLAWBOX_AI_IMAGE_MODEL };

    const { cfg } = migrate(withLegacy, true, REFUSED);
    const defaults = (cfg.agents as { defaults: Record<string, unknown> }).defaults;

    expect(defaults.imageGenerationModel).toBeUndefined();
    expect(mediaImage(cfg)).toBeUndefined();
    expect(imageEntry(cfg)).toBeUndefined();
    expect(both).toBeTruthy();
  });

  it("removes the models list it created rather than leaving an empty one", () => {
    // An explicitly empty `models` is not the same statement to the core as an
    // absent one — a configured provider overrides the plugin catalog entirely.
    const { cfg } = migrate(armedBox(), false, REFUSED);

    expect("models" in openaiProvider(cfg)).toBe(false);
  });

  it("keeps the other rows when ours was not the only one", () => {
    const theirs = { id: "gpt-5", name: "Theirs", baseUrl: "https://clawbox.com/api/ai" };
    const armed = migrate(pairedBox({
      models: {
        providers: {
          deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
          openai: { models: [theirs] },
        },
      },
    })).cfg;

    const { cfg } = migrate(armed, false, REFUSED);

    expect(openaiModels(cfg)).toEqual([theirs]);
  });
});
