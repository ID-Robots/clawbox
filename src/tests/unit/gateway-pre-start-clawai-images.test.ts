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
  CLAWBOX_AI_LEGACY_IMAGE_MODEL,
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

/**
 * A box as every build before this one provisioned it: the image credential and
 * our image row on `models.providers.openai`, the slot naming `openai/…`.
 *
 * This is the shape in the field, and moving it is what the migration is for —
 * an `apiKey` there pins the whole provider to API-key auth on the pinned core,
 * so the owner's ChatGPT sign-in is filtered out of its own provider.
 */
function legacyBox(overrides: {
  openai?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  v2?: boolean;
} = {}): Config {
  const slot = { primary: CLAWBOX_AI_LEGACY_IMAGE_MODEL };
  return {
    models: {
      providers: {
        deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
        openai: overrides.openai ?? {
          apiKey: "claw_token123",
          models: [{
            id: CLAWBOX_AI_IMAGE_MODEL_ID,
            name: "ClawBox AI Images",
            baseUrl: "https://clawbox.com/api/ai",
          }],
        },
      },
    },
    agents: {
      defaults: overrides.defaults ?? (overrides.v2
        ? { mediaModels: { image: slot } }
        : { imageGenerationModel: slot }),
    },
  };
}

function providerEntry(cfg: Config, id: string): Record<string, unknown> | undefined {
  const models = (cfg.models ?? {}) as { providers?: Record<string, unknown> };
  const entry = models.providers?.[id];
  return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
}

/** `models.providers.litellm` — where the image endpoint lives now. */
function imageProvider(cfg: Config): Record<string, unknown> {
  return providerEntry(cfg, "litellm") ?? {};
}

/** `models.providers.openai` — where it used to, and what has to be given back. */
function legacyProvider(cfg: Config): Record<string, unknown> | undefined {
  return providerEntry(cfg, "openai");
}

function legacyModels(cfg: Config): OpenAiModelEntry[] {
  return (legacyProvider(cfg)?.models ?? []) as OpenAiModelEntry[];
}

function imageGenerationModel(cfg: Config): unknown {
  const agents = (cfg.agents ?? {}) as { defaults?: Record<string, unknown> };
  return agents.defaults?.imageGenerationModel;
}

function mediaImage(cfg: Config): unknown {
  const agents = (cfg.agents ?? {}) as { defaults?: { mediaModels?: { image?: unknown } } };
  return agents.defaults?.mediaModels?.image;
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI image migration", () => {
  it("provisions the image provider and the slot on a paired box", () => {
    const { cfg, changed } = migrate(pairedBox());

    expect(changed).toBe(true);
    expect(imageProvider(cfg)).toEqual({
      apiKey: "claw_token123",
      baseUrl: "https://clawbox.com/api/ai",
    });
    // The write that actually makes the tool appear — and the write that enables
    // the bundled litellm plugin at gateway start
    // (`collectConfiguredGenerationProviderIds` reads the provider id out of it).
    // `imageModel` is a different key (vision) and must not be touched.
    expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    expect((cfg.agents as { defaults: Record<string, unknown> }).defaults.imageModel).toBeUndefined();
  });

  it("writes NO models[] row — the generic image provider takes the provider baseUrl", () => {
    // The row the `openai` entry needed had a cost: a configured row is exempt
    // from the core's picker hide rule, so `openai/gpt-image-1-mini` stayed
    // offerable as a chat model in OpenClaw's own surfaces. Writing none closes
    // that for the new id rather than re-opening it.
    const { cfg } = migrate(pairedBox());

    expect(imageProvider(cfg)).not.toHaveProperty("models");
  });

  it("leaves models.providers.openai alone on a box that never had one", () => {
    // The whole point: nothing this migration writes may land on the provider
    // the ChatGPT sign-in belongs to.
    const { cfg } = migrate(pairedBox());

    expect(legacyProvider(cfg)).toBeUndefined();
  });

  it("keeps the model id and the provider ids in step with the TypeScript constants", () => {
    // The .sh hardcodes them because a shell migration cannot import a TS
    // constant. The cloud proxy matches the bare id and answers 400 "Model not
    // allowed" on a miss, and the provider id decides which core plugin serves
    // the request at all.
    expect(POLICY).toContain(`CLAWBOX_IMAGE_MODEL_ID = "${CLAWBOX_AI_IMAGE_MODEL_ID}"`);
    expect(POLICY).toContain(`CLAWBOX_IMAGE_PROVIDER = "${CLAWBOX_AI_IMAGE_MODEL.split("/")[0]}"`);
    expect(POLICY).toContain(
      `CLAWBOX_LEGACY_IMAGE_PROVIDER = "${CLAWBOX_AI_LEGACY_IMAGE_MODEL.split("/")[0]}"`,
    );
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
    expect(imageProvider(cfg)).toEqual({});
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
    expect(imageProvider(cfg)).toEqual({});
    expect(imageGenerationModel(cfg)).toBeUndefined();
  });

  it("skips a non-string deepseek apiKey without crashing the boot script", () => {
    const { changed } = migrate({
      models: { providers: { deepseek: { apiKey: 12345 } } },
      agents: { defaults: {} },
    });

    expect(changed).toBe(false);
  });

  it("takes the image baseUrl off the deepseek entry so a staging proxy stays staging", () => {
    const { cfg } = migrate(pairedBox({
      models: { providers: { deepseek: { apiKey: "claw_token123", baseUrl: "https://staging.clawbox.com/api/ai" } } },
    }));

    expect(imageProvider(cfg).baseUrl).toBe("https://staging.clawbox.com/api/ai");
  });

  it("falls back to the production proxy when the deepseek entry carries no baseUrl", () => {
    const { cfg } = migrate(pairedBox({
      models: { providers: { deepseek: { apiKey: "claw_token123" } } },
    }));

    expect(imageProvider(cfg).baseUrl).toBe("https://clawbox.com/api/ai");
  });

  it("keeps its ownership host list identical to the route's", () => {
    // The two writers decide "is this row ours?" from separate literal lists,
    // in two languages. If they ever diverge one writer claims a row the other
    // calls foreign — and the route's back-off is total, so the box silently
    // stops getting its image provider.
    const shellHosts = Array.from(POLICY.matchAll(/"(https:\/\/[^"]+)"/g))
      .map((match) => match[1])
      .filter((url) => url.includes("/api/ai"));
    expect(new Set(shellHosts)).toEqual(new Set(CLAWBOX_AI_PROXY_URLS));
  });

  describe("migrating a box provisioned on the openai provider", () => {
    it("moves the credential off models.providers.openai and removes the empty entry", () => {
      const { cfg, changed, log } = migrate(legacyBox());

      expect(changed).toBe(true);
      // THE DEFECT: an apiKey here makes the core infer an api-key route
      // requirement for the whole provider and filter every subscription
      // profile out of it, so the box's own ChatGPT sign-in is never tried.
      expect(legacyProvider(cfg)).toBeUndefined();
      expect(imageProvider(cfg)).toEqual({
        apiKey: "claw_token123",
        baseUrl: "https://clawbox.com/api/ai",
      });
      expect(log).toContain("Moved the ClawBox AI image provider off models.providers.openai");
    });

    it("repoints a slot that still names the legacy ref", () => {
      const { cfg } = migrate(legacyBox());

      expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });

    it("repoints the v2 home too", () => {
      const { cfg } = migrate(legacyBox({ v2: true }), true);

      expect(mediaImage(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
      expect(legacyProvider(cfg)).toBeUndefined();
    });

    it("repoints a bare-string slot naming the legacy ref", () => {
      // The core resolves a bare string as a model, and this one names the row
      // the migration has just removed — so it has to move with it.
      const { cfg } = migrate(legacyBox({ defaults: { imageGenerationModel: CLAWBOX_AI_LEGACY_IMAGE_MODEL } }));

      expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });

    it("is idempotent — the migrated box reports no change on the next boot", () => {
      const once = migrate(legacyBox());
      const twice = migrate(once.cfg);

      expect(twice.changed).toBe(false);
      expect(twice.cfg).toEqual(once.cfg);
    });

    it("keeps the rest of an openai entry the owner configured", () => {
      // Leaves, not the provider: only our key and our row come off.
      const { cfg } = migrate(legacyBox({
        openai: {
          apiKey: "claw_token123",
          request: { timeoutMs: 90000 },
          models: [{
            id: CLAWBOX_AI_IMAGE_MODEL_ID,
            name: "ClawBox AI Images",
            baseUrl: "https://clawbox.com/api/ai",
          }],
        },
      }));

      expect(legacyProvider(cfg)).toEqual({ request: { timeoutMs: 90000 } });
    });

    it("keeps a sibling row of the owner's and removes only ours", () => {
      const sibling = { id: "house-model", name: "House model", api: "openai-completions", baseUrl: "https://clawbox.com/api/ai" };
      const { cfg } = migrate(legacyBox({
        openai: {
          apiKey: "claw_token123",
          models: [
            sibling,
            { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "ClawBox AI Images", baseUrl: "https://clawbox.com/api/ai" },
          ],
        },
      }));

      expect(legacyModels(cfg)).toEqual([sibling]);
      expect(legacyProvider(cfg)).not.toHaveProperty("apiKey");
    });

    it("removes every duplicate of our row, not just the first", () => {
      const ours = { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "ClawBox AI Images", baseUrl: "https://clawbox.com/api/ai" };
      const { cfg } = migrate(legacyBox({
        openai: { apiKey: "claw_token123", models: [{ ...ours }, { ...ours, api: "openai-completions" }] },
      }));

      expect(legacyProvider(cfg)).toBeUndefined();
    });

    it("recognises our row on a RETIRED proxy host as ours", () => {
      // A box paired before the clawbox.com move still names an old host. The
      // ownership set carries every host ClawBox has ever written, so the row
      // is removed rather than mistaken for a third party's.
      const { cfg } = migrate(legacyBox({
        openai: {
          apiKey: "claw_token123",
          models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "ClawBox AI Images", baseUrl: "https://www.openclawhardware.dev/api/ai" }],
        },
      }));

      expect(legacyProvider(cfg)).toBeUndefined();
    });

    it("normalises a default port away, exactly as `new URL(u).host` does", () => {
      // `urlsplit` KEEPS an explicit :443 and `URL.host` drops it, so a row
      // naming the default port was ours to the route and foreign to this
      // script — and the two writers then disagreed about one config.
      const { cfg } = migrate(legacyBox({
        openai: {
          apiKey: "claw_token123",
          models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "ClawBox AI Images", baseUrl: "https://clawbox.com:443/api/ai" }],
        },
      }));

      expect(legacyProvider(cfg)).toBeUndefined();
    });

    it("leaves an owner's own OpenAI key and their row of our id exactly as they are", () => {
      // ClawBox has never written a non-`claw_` key there, so it is the owner's
      // credential; and `gpt-image-1-mini` on their own host is their row. The
      // box simply never had our image setup on this provider.
      const theirs = { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "My Azure image model", baseUrl: "https://my-azure.example/openai/v1" };
      const { cfg, log } = migrate(legacyBox({
        openai: { apiKey: "sk-proj-users-own-key", models: [theirs] },
      }));

      expect(legacyProvider(cfg)).toEqual({ apiKey: "sk-proj-users-own-key", models: [theirs] });
      expect(log).not.toContain("Moved the ClawBox AI image provider");
    });

    it("still gives such a box its own image provider on the new id", () => {
      // The owner's OpenAI setup is not a reason to withhold pictures: the two
      // providers are independent now, which is the whole point of the move.
      const { cfg, changed } = migrate(legacyBox({
        openai: { apiKey: "sk-proj-users-own-key" },
        defaults: {},
      }));

      expect(changed).toBe(true);
      expect(imageProvider(cfg).apiKey).toBe("claw_token123");
      expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });

    it("removes the key even when the new provider is one we refuse to touch", () => {
      // The key is a defect on its own. A box running a real LiteLLM proxy gets
      // no ClawBox image provider — and still gets its ChatGPT lane back.
      const { cfg, changed, log } = migrate(legacyBox({
        openai: { apiKey: "claw_token123" },
      }));
      expect(changed).toBe(true);
      expect(legacyProvider(cfg)).toBeUndefined();
      expect(log).toContain("Moved the ClawBox AI image provider off models.providers.openai");
    });

    it("leaves an image slot the owner chose, whatever the provider entry said", () => {
      const { cfg } = migrate(legacyBox({ defaults: { imageGenerationModel: { primary: "replicate/flux-pro" } } }));

      expect(imageGenerationModel(cfg)).toEqual({ primary: "replicate/flux-pro" });
      expect(legacyProvider(cfg)).toBeUndefined();
    });

    it("leaves our legacy primary alone once the owner has added fallbacks to it", () => {
      // We only ever wrote `{primary: <our ref>}` into an EMPTY slot. Anything
      // else in the object is theirs.
      const owned = { primary: CLAWBOX_AI_LEGACY_IMAGE_MODEL, fallbacks: ["openai/their-backup"] };
      const { cfg } = migrate(legacyBox({ defaults: { imageGenerationModel: owned } }));

      expect(imageGenerationModel(cfg)).toEqual(owned);
    });
  });

  describe("will not make the portal token the credential for someone else's endpoint", () => {
    // `models.providers.<id>.apiKey` is provider-wide, so before writing it we
    // have to know that every route already configured under that id stays on
    // our own proxy. On `litellm` a configured route means a real LiteLLM proxy
    // the owner runs.
    function backedOff(cfg: Config) {
      const result = migrate(cfg);
      expect(imageProvider(result.cfg).apiKey).toBeUndefined();
      expect(imageGenerationModel(result.cfg)).toBeUndefined();
      return result;
    }

    function boxWithLitellm(litellm: Record<string, unknown>): Config {
      return pairedBox({
        models: {
          providers: {
            deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
            litellm,
          },
        },
      });
    }

    it("refuses to overwrite a hand-placed non-ClawBox apiKey", () => {
      const { cfg, changed, log } = migrate(boxWithLitellm({ apiKey: "sk-litellm-users-own-key" }));

      expect(changed).toBe(false);
      expect(imageProvider(cfg).apiKey).toBe("sk-litellm-users-own-key");
      expect(imageProvider(cfg)).not.toHaveProperty("baseUrl");
      expect(imageGenerationModel(cfg)).toBeUndefined();
      expect(log).toContain("holds a non-ClawBox key we will not overwrite");
    });

    it("claims an empty-string apiKey — a placeholder is not a credential", () => {
      const { cfg, changed } = migrate(boxWithLitellm({ apiKey: "   " }));

      expect(changed).toBe(true);
      expect(imageProvider(cfg).apiKey).toBe("claw_token123");
    });

    it("refreshes a stale claw_ token it wrote itself on an earlier pairing", () => {
      const { cfg, changed } = migrate(pairedBox({
        models: {
          providers: {
            deepseek: { apiKey: "claw_new", baseUrl: "https://clawbox.com/api/ai" },
            litellm: { apiKey: "claw_old", baseUrl: "https://clawbox.com/api/ai" },
          },
        },
      }));

      expect(changed).toBe(true);
      expect(imageProvider(cfg).apiKey).toBe("claw_new");
    });

    it("backs off on a provider-level baseUrl that is not ours", () => {
      // The owner's own LiteLLM proxy. Every row without a baseUrl of its own
      // inherits this one.
      const { log } = backedOff(boxWithLitellm({ baseUrl: "http://litellm.home.example:4000/v1" }));

      expect(log).toContain("litellm.home.example:4000");
    });

    it("backs off on a sibling row that resolves to the LiteLLM default host", () => {
      const { log } = backedOff(boxWithLitellm({
        models: [{ id: "gpt-5", name: "GPT-5", api: "openai-completions" }],
      }));

      expect(log).toContain("Skipped ClawBox AI image provider");
      expect(log).toContain("localhost:4000");
    });

    it("backs off on a sibling row pointing at a third-party host", () => {
      backedOff(boxWithLitellm({
        models: [{ id: "local-gpt", name: "Local GPT", api: "openai-completions", baseUrl: "https://someone-elses-proxy.example/v1" }],
      }));
    });

    it("backs off on a baseUrl it cannot parse", () => {
      // We cannot say where "not-a-url" points, and guessing permissively is
      // the wrong direction to be wrong in.
      backedOff(boxWithLitellm({ models: [{ id: "mystery", name: "Mystery", baseUrl: "not-a-url" }] }));
    });

    it("leaves an owner's own row of OUR id on their private proxy alone", () => {
      const theirs = { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "My own image model", baseUrl: "https://my-azure.example/openai/v1" };
      const { cfg, log } = migrate(boxWithLitellm({ models: [{ ...theirs }] }));

      expect(imageProvider(cfg).models).toEqual([theirs]);
      expect(imageProvider(cfg).apiKey).toBeUndefined();
      expect(log).toContain("my-azure.example");
    });

    it("proceeds when a sibling row points at a RETIRED ClawBox proxy host", () => {
      const { cfg, changed } = migrate(boxWithLitellm({
        models: [{ id: "house-model", name: "House model", baseUrl: "https://openclawhardware.dev/api/ai" }],
      }));

      expect(changed).toBe(true);
      expect(imageProvider(cfg).apiKey).toBe("claw_token123");
    });

    it("proceeds on a box whose only row is one of ours from an older build", () => {
      // Re-running must not back off on this migration's own output, and the
      // leftover row is removed because the generic provider never reads one.
      const { cfg, changed } = migrate(boxWithLitellm({
        apiKey: "claw_old",
        models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "ClawBox AI Images", baseUrl: "https://clawbox.com/api/ai" }],
      }));

      expect(changed).toBe(true);
      expect(imageProvider(cfg).apiKey).toBe("claw_token123");
      expect(imageProvider(cfg)).not.toHaveProperty("models");
    });

    it("prints only the host of the route it refuses to claim, never its credentials", () => {
      // An owner-configured URL can carry user-info or query credentials, and
      // the journal keeps what is logged.
      const { log } = migrate(boxWithLitellm({
        models: [{ id: "their-model", name: "Theirs", baseUrl: "https://hunter2:s3cret@their-host.example/v1?token=abc" }],
      }));

      expect(log).toContain("their-host.example");
      expect(log).not.toContain("hunter2");
      expect(log).not.toContain("s3cret");
      expect(log).not.toContain("token=abc");
    });

    it("stays quiet about a box it was never going to touch", () => {
      // The hand-placed-key branch backs off with its own sentence; it must not
      // also print a routing complaint about a config it is leaving alone.
      const { log } = migrate(boxWithLitellm({
        apiKey: "sk-litellm-users-own-key",
        baseUrl: "http://localhost:4000",
      }));

      expect(log).toContain("holds a non-ClawBox key");
      expect(log).not.toContain("already routes to");
    });

    it("survives a provider entry that is not an object", () => {
      const { cfg, changed } = migrate(pairedBox({
        models: {
          providers: {
            deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
            litellm: "garbage",
          },
        },
      }));

      expect(changed).toBe(true);
      expect(imageProvider(cfg).apiKey).toBe("claw_token123");
    });

    it("preserves other settings on the entry — it writes leaves, not the provider", () => {
      const { cfg } = migrate(boxWithLitellm({ request: { timeoutMs: 90000 } }));

      expect(imageProvider(cfg).request).toEqual({ timeoutMs: 90000 });
      expect(imageProvider(cfg).apiKey).toBe("claw_token123");
    });
  });

  describe("does not steal an image model the owner already chose", () => {
    it("leaves an existing primary alone", () => {
      const { cfg } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: { primary: "replicate/flux-pro" } } },
      }));

      expect(imageGenerationModel(cfg)).toEqual({ primary: "replicate/flux-pro" });
    });

    it("leaves a fallbacks-only config alone", () => {
      // OpenClaw's own gate (hasToolModelConfig) accepts primary OR a non-empty
      // fallback, so fallbacks-only is a working setup and replacing the whole
      // object would delete the owner's fallbacks.
      const { cfg } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: { fallbacks: ["replicate/flux-pro"] } } },
      }));

      expect(imageGenerationModel(cfg)).toEqual({ fallbacks: ["replicate/flux-pro"] });
    });

    it("leaves a primary+fallbacks config alone", () => {
      const chosen = { primary: "replicate/flux-pro", fallbacks: ["stability/sd3"] };
      const { cfg } = migrate(pairedBox({ agents: { defaults: { imageGenerationModel: chosen } } }));

      expect(imageGenerationModel(cfg)).toEqual(chosen);
    });

    it("still provisions the provider entry when the slot is taken", () => {
      const { cfg, changed } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: { fallbacks: ["replicate/flux-pro"] } } },
      }));

      expect(changed).toBe(true);
      expect(imageProvider(cfg).apiKey).toBe("claw_token123");
      expect(imageProvider(cfg).baseUrl).toBe("https://clawbox.com/api/ai");
    });

    it.each([
      ["an empty object", {}],
      ["a blank primary", { primary: "   " }],
      ["an empty fallbacks list", { fallbacks: [] }],
      ["fallbacks holding only blanks", { fallbacks: ["", "  "] }],
      ["fallbacks that is not a list", { fallbacks: "replicate/flux-pro" }],
      ["a non-string primary", { primary: 42 }],
    ])("claims the slot when it holds %s — OpenClaw would not resolve a model from it", (_label, existing) => {
      const { cfg } = migrate(pairedBox({ agents: { defaults: { imageGenerationModel: existing } } }));

      expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });

    it("leaves a BARE STRING alone — the core resolves one as a model (TASK-755)", () => {
      const { cfg } = migrate(pairedBox({
        agents: { defaults: { imageGenerationModel: "replicate/flux-pro" } },
      }));

      expect(imageGenerationModel(cfg)).toBe("replicate/flux-pro");
    });

    it.each([
      ["a blank string", "   "],
      ["an empty string", ""],
    ])("still claims the slot when it holds %s — the core resolves no model from it", (_label, existing) => {
      const { cfg } = migrate(pairedBox({ agents: { defaults: { imageGenerationModel: existing } } }));

      expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });
  });
});

// OpenClaw 2's home for the image-generation pick is
// agents.defaults.mediaModels.image; the legacy imageGenerationModel key
// fails config validation there. Same block, other home — picked from
// CLAWBOX_OPENCLAW_V2, bound via globals() so this preamble can set it.
describe.skipIf(!hasPython3)("the image-generation home on OpenClaw 2", () => {
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

  it("leaves a bare string in the v2 home alone (TASK-755)", () => {
    const { cfg } = migrate(pairedBox({
      agents: { defaults: { mediaModels: { image: "replicate/flux-pro" } } },
    }), true);

    expect(mediaImage(cfg)).toBe("replicate/flux-pro");
  });

  it("leaves an owner's mediaModels.image alone", () => {
    const { cfg } = migrate(
      pairedBox({ agents: { defaults: { mediaModels: { image: { primary: "openai/their-pick" } } } } }),
      true,
    );
    expect(mediaImage(cfg)).toEqual({ primary: "openai/their-pick" });
  });

  /**
   * TASK-743 — the dual-home shape, and link 1 of the incident TASK-737 is
   * about. `agents.defaults` is `.strict()`, so both homes present is
   * `Unrecognized key: "imageGenerationModel"` and gateway exit 78.
   *
   * The guard is #751's, on the KEY rather than its contents.
   */
  describe("a legacy image key the core has not migrated yet", () => {
    const EMPTY_LEGACY_SHAPES: Array<[string, unknown]> = [
      ["an empty object", {}],
      ["an empty primary", { primary: "" }],
      ["a whitespace primary", { primary: "   " }],
      ["an empty fallbacks list", { fallbacks: [] }],
      ["a null", null],
      ["a blank scalar", "   "],
      ["a list", []],
    ];

    for (const [name, legacy] of EMPTY_LEGACY_SHAPES) {
      it(`stands down rather than writing the v2 home beside ${name}`, () => {
        const { cfg, log } = migrate(
          pairedBox({ agents: { defaults: { imageGenerationModel: legacy } } }),
          true,
        );

        expect(mediaImage(cfg)).toBeUndefined();
        // The legacy key is left exactly as it was, for the core's own
        // migration to move. This block never removes it.
        expect(imageGenerationModel(cfg)).toEqual(legacy);
        expect(log).toContain("Skipped the ClawBox AI image model");
      });
    }

    it("does not even reach the stand-down when the legacy key names a model as a bare string", () => {
      const { cfg, log } = migrate(
        pairedBox({ agents: { defaults: { imageGenerationModel: "replicate/flux-pro" } } }),
        true,
      );

      expect(mediaImage(cfg)).toBeUndefined();
      expect(imageGenerationModel(cfg)).toBe("replicate/flux-pro");
      expect(log).not.toContain("Skipped the ClawBox AI image model");
    });

    it("still writes the provider entry, so the next boot has nothing left to do", () => {
      // Narrower than #751's stand-down on purpose: only the SLOT has two
      // homes, so only the slot stands down.
      const { cfg, changed } = migrate(
        pairedBox({ agents: { defaults: { imageGenerationModel: { primary: "" } } } }),
        true,
      );

      expect(changed).toBe(true);
      expect(imageProvider(cfg)).toEqual({
        apiKey: "claw_token123",
        baseUrl: "https://clawbox.com/api/ai",
      });
    });

    it("claims the v2 home the moment the core's migration has moved the key", () => {
      const { cfg, changed, log } = migrate(pairedBox(), true);

      expect(changed).toBe(true);
      expect(mediaImage(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
      expect(imageGenerationModel(cfg)).toBeUndefined();
      expect(log).not.toContain("Skipped the ClawBox AI image model");
    });

    it("does not stand down on a v1 core, whose only home this key is", () => {
      const { cfg, log } = migrate(
        pairedBox({ agents: { defaults: { imageGenerationModel: { primary: "" } } } }),
      );

      expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
      expect(log).not.toContain("Skipped the ClawBox AI image model");
    });

    it("reports no change when the slot is all there was to write", () => {
      // `changed` is what makes the boot script rewrite openclaw.json.
      const armed = migrate(pairedBox(), true).cfg;
      const agents = (armed.agents ?? {}) as { defaults: Record<string, unknown> };
      delete (agents.defaults.mediaModels as Record<string, unknown>).image;
      agents.defaults.imageGenerationModel = { primary: "" };

      const { changed } = migrate(armed, true);

      expect(changed).toBe(false);
    });
  });
});

/**
 * TASK-727, second half: the agent's own image path.
 *
 * The pinned core has no back-off and no disable-on-refusal for image
 * generation, so the only lever the harness gives us is whether the image path
 * is declared at all. A box whose credential the proxy has PERMANENTLY refused
 * otherwise spends refused calls for as long as it is switched on (6,554 in
 * twelve hours from one box, ~34/min at the peak).
 *
 * On its OWN provider id the take-back is finally complete: the entry is the
 * image path and nothing else, so it goes with the row and the slot. It used to
 * have to leave `models.providers.openai.apiKey` behind because channel audio
 * took its bearer from that same field — the audio row carries its own
 * `profile` now.
 */
describe.skipIf(!hasPython3)("standing down when the credential has been refused", () => {
  const REFUSED = { clawai_credential_refused_at: 1_788_000_000_000 };

  /** The box as this migration leaves an entitled one. */
  function armedBox(v2 = false): Config {
    return migrate(pairedBox(), v2).cfg;
  }

  it("does not arm the image path on a box whose credential the proxy has refused", () => {
    const { cfg, changed } = migrate(pairedBox(), false, REFUSED);

    expect(imageGenerationModel(cfg)).toBeUndefined();
    expect(providerEntry(cfg, "litellm")).toBeUndefined();
    expect(changed).toBe(false);
  });

  it("takes back the provider entry and the slot it wrote itself", () => {
    const { cfg, changed, log } = migrate(armedBox(), false, REFUSED);

    expect(imageGenerationModel(cfg)).toBeUndefined();
    expect(providerEntry(cfg, "litellm")).toBeUndefined();
    expect(changed).toBe(true);
    expect(log).toContain("Removed the ClawBox AI image model");
  });

  it("takes back the credential and the endpoint from an entry the owner has added their own settings to", () => {
    // The whole-entry delete only fires when nothing but ours is in it. An
    // owner who added `request` to the entry keeps that — but the refused key
    // and our endpoint must still go, or the bundled plugin keeps offering
    // chat rows on a credential the proxy refuses.
    const box = armedBox();
    providerEntry(box, "litellm")!.request = { timeoutMs: 90000 };
    const { cfg, changed, log } = migrate(box, false, REFUSED);

    expect(imageGenerationModel(cfg)).toBeUndefined();
    expect(providerEntry(cfg, "litellm")).toEqual({ request: { timeoutMs: 90000 } });
    expect(changed).toBe(true);
    expect(log).toContain("Removed the ClawBox AI image model");
  });

  it("takes back the v2 home too", () => {
    const { cfg, changed } = migrate(armedBox(true), true, REFUSED);

    expect(mediaImage(cfg)).toBeUndefined();
    expect(providerEntry(cfg, "litellm")).toBeUndefined();
    expect(changed).toBe(true);
  });

  it("still moves a legacy openai box off that provider before standing down", () => {
    // The two are independent: a refused credential is no reason to leave the
    // key that hides the ChatGPT sign-in.
    const { cfg, changed } = migrate(legacyBox(), false, REFUSED);

    expect(changed).toBe(true);
    expect(legacyProvider(cfg)).toBeUndefined();
    expect(providerEntry(cfg, "litellm")).toBeUndefined();
    expect(imageGenerationModel(cfg)).toBeUndefined();
  });

  it("re-arms once the refusal is cleared — a re-linked box gets its pictures back", () => {
    const stoodDown = migrate(armedBox(), false, REFUSED).cfg;
    const { cfg, changed } = migrate(stoodDown);

    expect(changed).toBe(true);
    expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    expect(imageProvider(cfg).baseUrl).toBe("https://clawbox.com/api/ai");
  });

  it("is idempotent — a second refused boot reports no change", () => {
    const once = migrate(armedBox(), false, REFUSED);
    const twice = migrate(once.cfg, false, REFUSED);

    expect(twice.changed).toBe(false);
    expect(twice.cfg).toEqual(once.cfg);
  });

  it("leaves an image model the owner chose, and the entry with it", () => {
    const { cfg } = migrate(
      pairedBox({ agents: { defaults: { imageGenerationModel: { primary: "openai/their-pick" } } } }),
      false,
      REFUSED,
    );

    expect(imageGenerationModel(cfg)).toEqual({ primary: "openai/their-pick" });
  });

  it("leaves our primary alone once the owner has added fallbacks to it", () => {
    // We only ever wrote `{primary: <our ref>}` into an EMPTY slot.
    const owned = { primary: CLAWBOX_AI_IMAGE_MODEL, fallbacks: ["openai/their-backup"] };
    const { cfg } = migrate(
      pairedBox({ agents: { defaults: { imageGenerationModel: owned } } }),
      false,
      REFUSED,
    );

    expect(imageGenerationModel(cfg)).toEqual(owned);
  });

  it("leaves an owner's own litellm entry entirely alone", () => {
    const theirs = { apiKey: "sk-litellm-users-own-key", baseUrl: "http://localhost:4000" };
    const { cfg, changed } = migrate(
      pairedBox({
        models: {
          providers: {
            deepseek: { apiKey: "claw_token123", baseUrl: "https://clawbox.com/api/ai" },
            litellm: { ...theirs },
          },
        },
      }),
      false,
      REFUSED,
    );

    expect(imageProvider(cfg)).toEqual(theirs);
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
    // An integer too large for a double: Python parses it exactly, `JSON.parse`
    // reads the same bytes as `Infinity`, and `math.isfinite()` on it raises
    // OverflowError instead of answering.
    ["an integer past Number.MAX_VALUE", { body: `{"clawai_credential_refused_at": ${"9".repeat(400)}}` } as DeviceStore],
  ])("arms as before over %s — not knowing is not a refusal", (_label, store) => {
    const { cfg } = migrate(pairedBox(), false, store);

    expect(imageGenerationModel(cfg)).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    expect(imageProvider(cfg).apiKey).toBe("claw_token123");
  });

  it("takes back BOTH homes on a v2 box that carries both", () => {
    // Neither home may be left naming a provider the other arm has just
    // removed: the core's loader migration re-creates `mediaModels.image` from
    // the legacy key, so a stand-down that cleared only one would be undone.
    const withLegacy = JSON.parse(JSON.stringify(armedBox(true))) as Config;
    ((withLegacy.agents as { defaults: Record<string, unknown> }).defaults)
      .imageGenerationModel = { primary: CLAWBOX_AI_IMAGE_MODEL };

    const { cfg } = migrate(withLegacy, true, REFUSED);
    const defaults = (cfg.agents as { defaults: Record<string, unknown> }).defaults;

    expect(defaults.imageGenerationModel).toBeUndefined();
    expect(mediaImage(cfg)).toBeUndefined();
    expect(providerEntry(cfg, "litellm")).toBeUndefined();
  });

  /**
   * TASK-743 — an EMPTY leftover legacy key used to veto the whole take-back,
   * so a box whose credential the proxy had permanently refused kept the image
   * path declared for as long as that key survived (the TASK-727 shape).
   *
   * Both arms now ask ONE question, and it is deliberately WIDER for the delete
   * than the upsert's: a bare string counts, because the core coerces one and
   * this is the only place in the file that destroys configuration.
   */
  it.each<[string, unknown]>([
    ["an empty object", {}],
    ["an empty primary", { primary: "" }],
    ["an empty fallbacks list", { fallbacks: [] }],
    ["a list", []],
  ])("takes the image path back over a leftover legacy key holding %s", (_label, leftover) => {
    const withLeftover = JSON.parse(JSON.stringify(armedBox(true))) as Config;
    ((withLeftover.agents as { defaults: Record<string, unknown> }).defaults)
      .imageGenerationModel = leftover;

    const { cfg, changed } = migrate(withLeftover, true, REFUSED);

    expect(changed).toBe(true);
    expect(mediaImage(cfg)).toBeUndefined();
    expect(providerEntry(cfg, "litellm")).toBeUndefined();
    // The leftover itself is not ours to remove — only the core migrates it.
    expect(imageGenerationModel(cfg)).toEqual(leftover);
  });

  it("still leaves a legacy key that NAMES a model, including a bare string", () => {
    // A string is a configured model to the core, so it may well name our
    // provider — and a delete cannot be undone.
    for (const theirs of [{ primary: "replicate/flux-pro" }, "replicate/flux-pro"]) {
      const withTheirs = JSON.parse(JSON.stringify(armedBox(true))) as Config;
      ((withTheirs.agents as { defaults: Record<string, unknown> }).defaults)
        .imageGenerationModel = theirs;

      const { cfg, changed } = migrate(withTheirs, true, REFUSED);

      expect(changed).toBe(false);
      expect(providerEntry(cfg, "litellm")).toBeDefined();
      expect(imageGenerationModel(cfg)).toEqual(theirs);
    }
  });
});
