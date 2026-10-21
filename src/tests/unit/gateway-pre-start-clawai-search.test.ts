import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { testEnv } from "@/tests/helpers/env";
import { repairHelpers, sliceScript } from "@/tests/helpers/gateway-pre-start";

// Starts a real process (python3): vitest's 5 s test and 10 s hook defaults
// are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// ClawBox AI web search for the Max plan. The ClawBox proxy serves a
// Brave-compatible search route, and OpenClaw's own Brave plugin already knows
// how to talk to one: `plugins.entries.brave.config.webSearch.baseUrl` points
// it at a trusted Brave-compatible base and the plugin appends
// `/res/v1/web/search`, sending the key as `X-Subscription-Token`. So the box
// only has to aim that entry at the proxy with the box's own `claw_` token —
// the company's Brave key never reaches the box.
//
// Behind a device-store flag that is OFF by default, because search reaches
// customers only once the provider's terms allow it. With the flag off, or on
// any plan but Max, openclaw.json must come out exactly as it went in.
//
// Like the speech and transcription migrations next door, these run the block
// out of the shipped .sh rather than a copy, so the test fails if the real
// script drifts.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

const PROXY = "https://clawbox.com/api/ai";
/** Where the box points the Brave plugin: the proxy's Brave-compatible base. */
const SEARCH = `${PROXY}/search`;
const TOKEN = "claw_test_token";
/** The plan stamp of the MAX plan. The two names are off by one on purpose. */
const MAX_PLAN = "pro";
/** The plan stamp of the PRO plan, which the proxy does not serve search to. */
const PRO_PLAN = "flash";
const FLAG = "clawai_web_search";

function slice(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`block not found: ${from}`);
  return src.slice(start, end);
}

/** The block under test, or nothing on a script that does not carry it yet. */
function sliceIfPresent(from: string, to: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf(from);
  if (start < 0) return "";
  const end = src.indexOf(to, start);
  return end < 0 ? "" : src.slice(start, end);
}

/**
 * The hosts ClawBox has ever written as its AI proxy and the URL normaliser
 * that builds them, plus the shared route-ownership rule — taken from the
 * shipped script rather than restated, so "is this route ours" has one answer
 * across the speech and search migrations.
 */
const PROXY_HOSTS = hasPython3 ? slice("from urllib.parse import urlsplit", "def _is_our_image_row(_row):") : "";
const SAME_ENDPOINT = hasPython3 ? slice("def _same_endpoint(_a, _b):", "if _clawai_openai_route_is_ours:") : "";
const POLICY = hasPython3
  ? sliceIfPresent("# Migration: ClawBox AI web search", "if changed:\n    # Atomic write")
  : "";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "clawai-search-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;
type WebSearch = { baseUrl?: unknown; apiKey?: unknown; mode?: unknown; [key: string]: unknown };

interface Options {
  /** The device store, or `null` for a box the Next app has never run on. */
  store?: Record<string, unknown> | null;
  /** A device store that is not JSON, or not an object. */
  storeBody?: string;
  /** The key on the ClawBox AI chat provider; `null` for a box with none. */
  token?: string | null;
  /** The proxy base the ClawBox AI chat provider names. */
  proxy?: string;
  /** Extra gateway environment. */
  env?: Record<string, string>;
  /** Contents of the OpenClaw home's `.env`, which the gateway also reads. */
  dotenv?: string;
  /** Run on an OpenClaw 1 core (no CLAWBOX_OPENCLAW_V2). */
  v1?: boolean;
}

const ENTITLED = { clawai_plan_tier: MAX_PLAN, [FLAG]: true };

/**
 * Run the extracted block over a whole openclaw.json.
 *
 * The preamble binds only what the real script binds upstream of this point:
 * `cfg`, `cfg_path`, `changed`, the ClawBox AI chat provider entry and the
 * token read off it. `CLAWBOX_DEVICE_STORE` is the env var the shell exports.
 */
function migrate(cfg: Config, opts: Options = {}): { cfg: Config; changed: boolean; log: string } {
  const { store = ENTITLED, storeBody, token = TOKEN, proxy = PROXY, env = {}, dotenv, v1 = false } = opts;
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(cfg));
  const storePath = path.join(dir, "device-store.json");
  if (storeBody !== undefined) writeFileSync(storePath, storeBody);
  else if (store !== null) writeFileSync(storePath, JSON.stringify(store));
  if (dotenv !== undefined) writeFileSync(path.join(dir, ".env"), dotenv);
  const provider = token === null ? { baseUrl: proxy } : { baseUrl: proxy, apiKey: token };
  const program = [
    "import json, os, sys",
    "cfg_path = sys.argv[1]",
    "cfg = json.load(open(cfg_path))",
    "changed = False",
    `deepseek_provider = ${JSON.stringify(provider)}`,
    "_clawai_token = deepseek_provider.get('apiKey')",
    // The real script binds this at the top of the pass from the env var.
    ...(v1 ? [] : ["CLAWBOX_OPENCLAW_V2 = True"]),
    PROXY_HOSTS,
    SAME_ENDPOINT,
    POLICY,
    "print(json.dumps({'cfg': cfg, 'changed': changed}))",
  ].join("\n");
  const baseEnv = { ...process.env };
  delete baseEnv.BRAVE_API_KEY;
  const lines = execFileSync("python3", ["-c", program, file], {
    encoding: "utf-8",
    env: { ...baseEnv, CLAWBOX_DEVICE_STORE: storePath, ...env },
  }).trim().split("\n");
  return { ...JSON.parse(lines[lines.length - 1]), log: lines.slice(0, -1).join("\n") };
}

function brave(cfg: Config): { enabled?: unknown; config?: { webSearch?: WebSearch; [k: string]: unknown } } | undefined {
  const plugins = cfg.plugins as { entries?: Record<string, never> } | undefined;
  return plugins?.entries?.brave;
}

function webSearch(cfg: Config): WebSearch | undefined {
  return brave(cfg)?.config?.webSearch;
}

const OURS = { baseUrl: SEARCH, apiKey: TOKEN };
const seeded = (ws: WebSearch, extra: Record<string, unknown> = {}): Config => ({
  plugins: { entries: { brave: { ...extra, config: { webSearch: { ...ws } } } } },
});

describe.skipIf(!hasPython3)("gateway-pre-start.sh ClawBox AI web search (Brave-compatible proxy)", () => {
  it("points the Brave plugin at the proxy's search route with the box's own token", () => {
    const { cfg, changed } = migrate({});

    expect(changed).toBe(true);
    expect(webSearch(cfg)?.baseUrl).toBe(SEARCH);
    expect(webSearch(cfg)?.apiKey).toBe(TOKEN);
    expect(webSearch(cfg)).toEqual(OURS);
  });

  it("writes nothing the Brave plugin's own config schema would refuse", () => {
    // @openclaw/brave-plugin 2026.10.3 declares `additionalProperties: false`
    // on its config AND on `webSearch`, with exactly apiKey, mode and baseUrl.
    // An ownership stamp in there is a config the gateway will not load.
    const { cfg } = migrate({});

    expect(Object.keys(brave(cfg) ?? {})).toEqual(["config"]);
    expect(Object.keys(brave(cfg)?.config ?? {})).toEqual(["webSearch"]);
    for (const key of Object.keys(webSearch(cfg) ?? {})) {
      expect(["apiKey", "mode", "baseUrl"]).toContain(key);
    }
  });

  it("leaves the provider choice unset, so auto-detection — and an owner's own pick — still decide", () => {
    const { cfg } = migrate({});
    const tools = cfg.tools as { web?: { search?: { provider?: unknown } } } | undefined;
    expect(tools?.web?.search?.provider).toBeUndefined();
  });

  it("is idempotent — a second start rewrites nothing", () => {
    const first = migrate({});
    const second = migrate(first.cfg);

    expect(second.changed).toBe(false);
    expect(webSearch(second.cfg)).toEqual(OURS);
  });

  it("re-points an entry whose token was rotated", () => {
    const { cfg, changed } = migrate(seeded({ baseUrl: SEARCH, apiKey: "claw_stale" }));

    expect(changed).toBe(true);
    expect(webSearch(cfg)).toEqual(OURS);
  });

  it("keeps every other field the entry already carries", () => {
    const { cfg } = migrate(seeded({ mode: "web" }, { enabled: true }));

    expect(brave(cfg)?.enabled).toBe(true);
    expect(webSearch(cfg)).toEqual({ mode: "web", ...OURS });
  });

  it("re-points our own entry left on a retired proxy address", () => {
    const { cfg, changed } = migrate(seeded({ baseUrl: "https://openclawhardware.dev/api/ai/search", apiKey: TOKEN }));

    expect(changed).toBe(true);
    expect(webSearch(cfg)).toEqual(OURS);
  });

  it("honours a staging proxy rather than dragging the box to production", () => {
    const staging = "https://staging.clawbox.com/api/ai";
    const { cfg } = migrate({}, { proxy: staging });

    expect(webSearch(cfg)?.baseUrl).toBe(`${staging}/search`);
  });

  it("does not turn a provider-level trailing slash into a double slash", () => {
    const { cfg } = migrate({}, { proxy: `${PROXY}/` });

    expect(webSearch(cfg)?.baseUrl).toBe(SEARCH);
  });

  describe("is OFF unless the flag says on, and leaves openclaw.json exactly as it was", () => {
    const before = { tools: { web: { search: { enabled: true } } }, plugins: { entries: { deepseek: { enabled: true } } } };

    for (const [name, store] of [
      ["the flag is absent", { clawai_plan_tier: MAX_PLAN }],
      ["the flag is false", { clawai_plan_tier: MAX_PLAN, [FLAG]: false }],
      ["the flag is the string \"true\"", { clawai_plan_tier: MAX_PLAN, [FLAG]: "true" }],
      ["the flag is 1", { clawai_plan_tier: MAX_PLAN, [FLAG]: 1 }],
    ] as const) {
      it(`when ${name}`, () => {
        const { cfg, changed } = migrate(structuredClone(before), { store });

        expect(changed).toBe(false);
        expect(brave(cfg)).toBeUndefined();
        expect(cfg).toEqual(before);
      });
    }
  });

  describe("is Max only, and the PLAN is the only evidence for it", () => {
    it("leaves a Pro plan alone", () => {
      const { cfg, changed } = migrate({}, { store: { clawai_plan_tier: PRO_PLAN, [FLAG]: true } });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });

    it("leaves a cancelled subscription alone", () => {
      const { cfg, changed } = migrate({}, { store: { clawai_plan_tier: "free", [FLAG]: true } });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });

    it("does not arm on the device badge alone, which a Pro plan can carry", () => {
      // `clawai_tier` is the DEFAULT the box runs and can read "pro" for an
      // account that does not pay for Max; the proxy would refuse every search.
      const { cfg, changed } = migrate({}, { store: { clawai_tier: MAX_PLAN, [FLAG]: true } });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });

    it("ignores a plan stamp it does not recognise", () => {
      const { cfg, changed } = migrate({}, { store: { clawai_plan_tier: "enterprise", [FLAG]: true } });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });
  });

  it("stays out of an OpenClaw 1 core, whose bundled Brave it has not been checked against", () => {
    const { cfg, changed, log } = migrate({}, { v1: true });

    expect(changed).toBe(false);
    expect(brave(cfg)).toBeUndefined();
    expect(log).toContain("Skipped ClawBox AI web search");
  });

  describe("needs a ClawBox AI account on the box", () => {
    it("leaves a box with no ClawBox AI token alone", () => {
      const { cfg, changed } = migrate({}, { token: null });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });

    it("leaves a box running on a raw provider key alone", () => {
      const { cfg, changed } = migrate({}, { token: "sk-raw-provider-key", proxy: "https://api.deepseek.com" });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });
  });

  describe("treats a device store it cannot read as saying nothing", () => {
    it("leaves a box with no device store alone", () => {
      const { cfg, changed } = migrate({}, { store: null });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });

    it("does not crash over a store that is not JSON", () => {
      const { cfg, changed } = migrate({}, { storeBody: "not json at all" });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });

    it("does not crash over a store that is not an object", () => {
      const { cfg, changed } = migrate({}, { storeBody: '["pro"]' });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });
  });

  describe("an owner's own search setup wins", () => {
    it("leaves an owner's own Brave key alone", () => {
      const own = { apiKey: "BSA-owner-key" };
      const { cfg, changed, log } = migrate(seeded(own));

      expect(changed).toBe(false);
      expect(webSearch(cfg)).toEqual(own);
      expect(log).toContain("Skipped ClawBox AI web search");
    });

    it("leaves an owner's key held as a secret reference alone", () => {
      const own = { apiKey: { source: "env", provider: "default", id: "MY_BRAVE_KEY" } };
      const { cfg, changed } = migrate(seeded(own));

      expect(changed).toBe(false);
      expect(webSearch(cfg)).toEqual(own);
    });

    it("leaves an owner's own Brave-compatible proxy alone, keyless or not", () => {
      for (const own of [{ baseUrl: "https://search.example.org" }, { baseUrl: "https://search.example.org", apiKey: TOKEN }]) {
        const { cfg, changed } = migrate(seeded(own));

        expect(changed).toBe(false);
        expect(webSearch(cfg)).toEqual(own);
      }
    });

    it("leaves a different route on our own host alone when nothing else says it is ours", () => {
      const own = { baseUrl: "https://clawbox.com/their-own-route" };
      const { cfg, changed } = migrate(seeded(own));

      expect(changed).toBe(false);
      expect(webSearch(cfg)).toEqual(own);
    });

    it("does not shadow a BRAVE_API_KEY in the gateway's environment", () => {
      // The plugin reads its config key FIRST and the env var only as a
      // fallback, so writing ours would silently replace the owner's.
      const { cfg, changed } = migrate({}, { env: { BRAVE_API_KEY: "BSA-owner-env" } });

      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });

    it("does not shadow a BRAVE_API_KEY in the OpenClaw home's .env", () => {
      const { cfg, changed } = migrate({}, { dotenv: "# mine\nexport BRAVE_API_KEY='BSA-owner-dotenv'\n" });

      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });

    it("still arms when the .env names BRAVE_API_KEY with no value", () => {
      const { cfg } = migrate({}, { dotenv: "BRAVE_API_KEY=\nOTHER=1\n" });
      expect(webSearch(cfg)).toEqual(OURS);
    });

    it("stays out of a box whose owner picked another search provider", () => {
      const before = { tools: { web: { search: { provider: "tavily" } } } };
      const { cfg, changed } = migrate(structuredClone(before));

      expect(changed).toBe(false);
      expect(cfg).toEqual(before);
    });

    it("fills in a box whose owner picked Brave and never gave it a key", () => {
      const { cfg, changed } = migrate({ tools: { web: { search: { provider: "brave" } } } });

      expect(changed).toBe(true);
      expect(webSearch(cfg)).toEqual(OURS);
    });

    it("stays out of a box whose web search is switched off", () => {
      const before = { tools: { web: { search: { enabled: false } } } };
      const { cfg, changed } = migrate(structuredClone(before));

      expect(changed).toBe(false);
      expect(cfg).toEqual(before);
    });

    it("stays out of a box whose owner switched the Brave plugin off", () => {
      const before = { plugins: { entries: { brave: { enabled: false } } } };
      const { cfg, changed } = migrate(structuredClone(before));

      expect(changed).toBe(false);
      expect(cfg).toEqual(before);
    });

    it("does not replace a plugins section the gateway could not read", () => {
      // Unlike a media slot, `plugins` carries every installed plugin's
      // switches; writing over a malformed one would lose them.
      const before = { plugins: "nonsense" };
      const { cfg, changed } = migrate(structuredClone(before));

      expect(changed).toBe(false);
      expect(cfg).toEqual(before);
    });
  });

  describe("takes back only what it wrote when the box stops being entitled", () => {
    const ourEntry = () => seeded({ ...OURS }, { enabled: true });

    it("withdraws when the flag is switched off", () => {
      const { cfg, changed, log } = migrate(ourEntry(), { store: { clawai_plan_tier: MAX_PLAN, [FLAG]: false } });

      expect(changed).toBe(true);
      expect(webSearch(cfg)).toBeUndefined();
      // The plugin's own switch and install are left as they are: without a
      // key the plugin cannot win auto-detection, and a reinstall costs more
      // than a dormant entry.
      expect(brave(cfg)).toEqual({ enabled: true });
      expect(log).toContain("Removed ClawBox AI web search");
    });

    it("withdraws when the flag is removed from the store", () => {
      const { cfg, changed } = migrate(ourEntry(), { store: { clawai_plan_tier: MAX_PLAN } });
      expect(changed).toBe(true);
      expect(webSearch(cfg)).toBeUndefined();
    });

    it("withdraws when the plan drops to Pro", () => {
      const { cfg, changed } = migrate(ourEntry(), { store: { clawai_plan_tier: PRO_PLAN, [FLAG]: true } });
      expect(changed).toBe(true);
      expect(webSearch(cfg)).toBeUndefined();
    });

    it("withdraws from a cancelled subscription", () => {
      const { cfg, changed } = migrate(ourEntry(), { store: { clawai_plan_tier: "free", [FLAG]: true } });
      expect(changed).toBe(true);
      expect(webSearch(cfg)).toBeUndefined();
    });

    it("withdraws when the owner adds a BRAVE_API_KEY of their own", () => {
      const { cfg, changed } = migrate(ourEntry(), { env: { BRAVE_API_KEY: "BSA-owner-env" } });
      expect(changed).toBe(true);
      expect(webSearch(cfg)).toBeUndefined();
    });

    it("keeps the owner's other fields when it withdraws", () => {
      const { cfg } = migrate(seeded({ ...OURS, mode: "web" }), { store: { clawai_plan_tier: PRO_PLAN, [FLAG]: true } });
      expect(webSearch(cfg)).toEqual({ mode: "web" });
    });

    it("withdraws our entry left on a retired proxy address", () => {
      const { cfg, changed } = migrate(
        seeded({ baseUrl: "https://openclawhardware.dev/api/ai/search", apiKey: TOKEN }),
        { store: { clawai_plan_tier: PRO_PLAN, [FLAG]: true } },
      );
      expect(changed).toBe(true);
      expect(webSearch(cfg)).toBeUndefined();
    });

    it("does nothing on a box that never had one", () => {
      const { cfg, changed } = migrate({}, { store: { clawai_plan_tier: PRO_PLAN, [FLAG]: true } });
      expect(changed).toBe(false);
      expect(brave(cfg)).toBeUndefined();
    });

    it("never takes an owner's own key, whatever the plan says", () => {
      const own = { apiKey: "BSA-owner-key" };
      const { cfg, changed } = migrate(seeded(own), { store: { clawai_plan_tier: PRO_PLAN } });
      expect(changed).toBe(false);
      expect(webSearch(cfg)).toEqual(own);
    });

    it("never takes our token off an owner's own proxy", () => {
      const own = { baseUrl: "https://search.example.org", apiKey: TOKEN };
      const { cfg, changed } = migrate(seeded(own), { store: { clawai_plan_tier: PRO_PLAN } });
      expect(changed).toBe(false);
      expect(webSearch(cfg)).toEqual(own);
    });

    it("never takes a keyless entry on our host, which is not positive evidence", () => {
      const own = { baseUrl: SEARCH };
      const { cfg, changed } = migrate(seeded(own), { store: { clawai_plan_tier: PRO_PLAN } });
      expect(changed).toBe(false);
      expect(webSearch(cfg)).toEqual(own);
    });

    describe("and a reading it could not make is never a reason", () => {
      it("keeps a working entry when the plan is not on record", () => {
        const { cfg, changed } = migrate(ourEntry(), { store: { [FLAG]: true } });
        expect(changed).toBe(false);
        expect(webSearch(cfg)).toEqual(OURS);
      });

      it("keeps a working entry over a device store it cannot read", () => {
        const { cfg, changed } = migrate(ourEntry(), { storeBody: "not json at all" });
        expect(changed).toBe(false);
        expect(webSearch(cfg)).toEqual(OURS);
      });

      it("keeps a working entry on a box with no device store", () => {
        const { cfg, changed } = migrate(ourEntry(), { store: null });
        expect(changed).toBe(false);
        expect(webSearch(cfg)).toEqual(OURS);
      });
    });
  });
});

/**
 * The flag, the plugin and the route are named in the boot script and in
 * TypeScript, which cannot import one another. These pin the pairs so a rename
 * on one side fails here rather than on a box.
 */
describe("the box-side constants agree across the shell and TypeScript", () => {
  it("names the same flag, plugin, package, route and plan", async () => {
    const search = await import("@/lib/clawai-web-search");
    const src = readFileSync(SCRIPT, "utf-8");
    const constant = (name: string) => src.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, "m"))?.[1];

    expect(constant("CLAWBOX_SEARCH_FLAG_KEY")).toBe(search.CLAWAI_WEB_SEARCH_FLAG_KEY);
    expect(constant("CLAWBOX_SEARCH_PLUGIN_ID")).toBe(search.CLAWAI_WEB_SEARCH_PLUGIN_ID);
    expect(constant("CLAWBOX_SEARCH_ROUTE")).toBe(search.CLAWAI_WEB_SEARCH_ROUTE);
    expect(constant("CLAWBOX_SEARCH_PLAN_TIER")).toBe(search.CLAWAI_WEB_SEARCH_PLAN_TIER);
    expect(src).toContain(`CLAWBOX_SEARCH_PLUGIN_PACKAGE="${search.CLAWAI_WEB_SEARCH_PLUGIN_PACKAGE}"`);
  });

  it("reads the plan key and the unpaid word the plan-tier module names", async () => {
    const { CLAWAI_PLAN_TIER_KEY, CLAWAI_PLAN_UNPAID } = await import("@/lib/clawai-plan-tier");
    const block = sliceIfPresent("# Migration: ClawBox AI web search", "if changed:\n    # Atomic write");

    expect(block).toContain(`_store.get("${CLAWAI_PLAN_TIER_KEY}")`);
    expect(block).toContain(`CLAWBOX_SEARCH_PLAN_TIER, "${CLAWAI_PLAN_UNPAID}")`);
    // The PLAN alone: the device badge is never read by this block.
    expect(block).not.toContain('"clawai_tier"');
  });

  it("is off by default and on only for a literal true", async () => {
    const { clawaiWebSearchFlagOn } = await import("@/lib/clawai-web-search");

    expect(clawaiWebSearchFlagOn(undefined)).toBe(false);
    expect(clawaiWebSearchFlagOn(null)).toBe(false);
    expect(clawaiWebSearchFlagOn(false)).toBe(false);
    expect(clawaiWebSearchFlagOn("true")).toBe(false);
    expect(clawaiWebSearchFlagOn(1)).toBe(false);
    expect(clawaiWebSearchFlagOn(true)).toBe(true);
  });

  it("builds the base the plugin appends /res/v1/web/search to", async () => {
    const { clawaiWebSearchBaseUrl } = await import("@/lib/clawai-web-search");

    expect(clawaiWebSearchBaseUrl(PROXY)).toBe(SEARCH);
    expect(clawaiWebSearchBaseUrl(`${PROXY}/`)).toBe(SEARCH);
  });

  /**
   * Who the Brave plugin belongs to. An owner can install the same plugin for a
   * Brave key of their own, so the id is never the answer: ClawBox may consent
   * for it (install.sh's refresh) or treat a refusal naming it as its own
   * (src/lib/updater.ts) only while the entry carries our `claw_` token.
   */
  const OWNERSHIP: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ["our entry", seeded({ ...OURS }, { enabled: true }), true],
    ["our entry, switched off by a start that could not reinstall it", seeded({ ...OURS }, { enabled: false }), true],
    ["an owner's own Brave key", seeded({ apiKey: "BSA-owner-key" }), false],
    ["an owner's key held as a secret reference", seeded({ apiKey: { source: "env", provider: "default", id: "BRAVE" } }), false],
    ["an installed plugin with no search config at all", { plugins: { entries: { brave: { enabled: true } } } }, false],
    ["an entry ClawBox has withdrawn", seeded({ mode: "web" }, { enabled: true }), false],
    ["no plugins section", {}, false],
    ["a plugins section the gateway could not read", { plugins: "nonsense" }, false],
  ];

  it("owns the Brave plugin by its entry, never by its id", async () => {
    const { clawaiWebSearchEntryIsOurs } = await import("@/lib/clawai-web-search");

    for (const [name, cfg, ours] of OWNERSHIP) {
      expect(clawaiWebSearchEntryIsOurs(cfg), name).toBe(ours);
    }
    expect(clawaiWebSearchEntryIsOurs(null)).toBe(false);
  });

  it.skipIf(!hasBash || !hasPython3)("install.sh's refresh asks the same question and gets the same answer", () => {
    const installSh = readFileSync(path.resolve(process.cwd(), "install.sh"), "utf-8");
    const start = installSh.indexOf("clawbox_search_plugin_is_ours() {");
    expect(start, "clawbox_search_plugin_is_ours was not found in install.sh").toBeGreaterThan(-1);
    const fn = installSh.slice(start, installSh.indexOf("\n}\n", start) + 3);
    // The consent arm calls it for `brave` and nowhere else.
    expect(installSh).toMatch(/\n\s+brave\)\n(?:\s+#.*\n)*\s+if clawbox_search_plugin_is_ours; then\n\s+openclaw_is_v2 && CAP_ARGS=\(--accept-capabilities\)/);

    let asked = 0;
    const ask = (config: string | null): boolean => {
      const home = path.join(dir, `home-${asked++}`);
      mkdirSync(path.join(home, ".openclaw"), { recursive: true });
      if (config !== null) writeFileSync(path.join(home, ".openclaw", "openclaw.json"), config);
      const res = spawnSync("bash", ["-c", `set -euo pipefail\n${fn}\nif clawbox_search_plugin_is_ours; then echo yes; else echo no; fi`], {
        encoding: "utf-8",
        env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin", CLAWBOX_HOME: home }),
      });
      if (res.status !== 0) throw new Error(`exited ${res.status}: ${res.stderr}`);
      return res.stdout.trim() === "yes";
    };

    for (const [name, cfg, ours] of OWNERSHIP) {
      expect(ask(JSON.stringify(cfg)), name).toBe(ours);
    }
    expect(ask("{ not json"), "an unreadable config").toBe(false);
    expect(ask(null), "no config at all").toBe(false);
  });
});

/**
 * The fallback half. An auto-detected provider that fails moves on only to
 * another configured API provider, never to a key-free one, so over the cap
 * the agent is handed a provider error. What it does next is behaviour, and
 * the workspace guide every box seeds is where that is told.
 */
describe("the browser is the fallback when search is refused", () => {
  const GUIDE = path.resolve(process.cwd(), "config/clawbox-workspace-guide.md");
  const HEADING = "## When web search is unavailable";

  /** One helper out of the shipped guide-seeding block, run on the template. */
  function guideHelper(fn: string, ...args: string[]): string {
    const script = [
      "set -euo pipefail",
      `CLAWBOX_ROOT=${JSON.stringify(dir)}`,
      `CLAWBOX_WORKSPACE=${JSON.stringify(path.join(dir, "no-such-workspace"))}`,
      sliceScript('CLAWBOX_GUIDE_SRC="$CLAWBOX_ROOT', "# --- end guide seeding ---"),
      [fn, GUIDE, ...args].map((a) => JSON.stringify(a)).join(" "),
    ].join("\n");
    const res = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
    if (res.status !== 0) throw new Error(`${fn} exited ${res.status}\n${res.stderr}`);
    return res.stdout;
  }

  it("the seeded workspace guide tells the agent to search with the browser", () => {
    const guide = readFileSync(GUIDE, "utf-8");
    const start = guide.indexOf(HEADING);
    expect(start).toBeGreaterThan(-1);
    const section = guide.slice(start, guide.indexOf("\n---", start));

    expect(section).toMatch(/limit/);
    expect(section).toContain("browser_navigate");
    expect(section).toMatch(/Don't keep retrying `web_search`/);
  });

  it.skipIf(!hasBash)("is a section of its own, so a box seeded before it gets it on the next boot", () => {
    // The top-up appends the `## ` sections a box's CLAWBOX.md lacks and never
    // re-sends one it has. Under `## Browser`, which every box already
    // carries, the fallback would only ever reach a freshly seeded box.
    expect(guideHelper("clawbox_guide_headings").split("\n")).toContain(HEADING);
    const section = guideHelper("clawbox_guide_section", HEADING);
    expect(section).toContain("browser_navigate");
    expect(section).not.toContain("## Apps and UI");
  });
});

/**
 * The plugin install the entry needs. Pinned to the core's own release — an
 * unpinned spec resolves @latest and can drift ahead of the core — and only
 * ever on a box whose config carries our entry, so a flag-off box never
 * installs anything.
 */
describe("the Brave plugin install in the boot script", () => {
  const src = readFileSync(SCRIPT, "utf-8");
  const block = sliceIfPresent("# ClawBox AI web search: the Brave plugin", "# End of the ClawBox AI web search plugin install");

  it("exists, and installs only pinned specs", () => {
    expect(block).not.toBe("");
    expect(block).toContain('npm:${CLAWBOX_SEARCH_PLUGIN_PACKAGE}@${CLAWBOX_OPENCLAW_EFFECTIVE}');
    expect(block).toContain('clawhub:${CLAWBOX_SEARCH_PLUGIN_PACKAGE}@${CLAWBOX_OPENCLAW_EFFECTIVE}');
    // No bare spec anywhere in the loop: every try carries the core version.
    expect(block).not.toMatch(/plugins install "\$CLAWBOX_SEARCH_PLUGIN_PACKAGE"/);
  });

  it("never fails the boot over it", () => {
    // Search is optional: the agent falls back to the browser. A failed
    // install is a WARN, not an exit; the one row it ever files is the
    // switch-off that lets the gateway start past a stale payload (run below).
    expect(block).not.toMatch(/\bexit\s+1\b/);
    expect(block.match(/clawbox_plugin_boot_without brave/g)).toHaveLength(1);
  });

  it("sits after the config migration that writes the entry it looks for", () => {
    expect(src.indexOf("# Migration: ClawBox AI web search")).toBeGreaterThan(-1);
    expect(src.indexOf("# ClawBox AI web search: the Brave plugin")).toBeGreaterThan(
      src.indexOf("# Migration: ClawBox AI web search"),
    );
  });
});

/**
 * The same install, RUN: the block out of the shipped script, under the
 * script's own `set -euo pipefail`, against a fake `openclaw` that records its
 * argv. The strings above say which specs are written down; these say which
 * ones a box actually asks for, and when it asks for none.
 */
const RELEASE = "2026.10.3";
const NPM_SPEC = `npm:@openclaw/brave-plugin@${RELEASE}`;
const CLAWHUB_SPEC = `clawhub:@openclaw/brave-plugin@${RELEASE}`;

interface InstallOptions {
  /** openclaw.json as the config migration left it; our entry by default. */
  config?: Config | string;
  /** The running core's release as the script resolved it; "" = could not be asked. */
  effective?: string;
  /** Run on an OpenClaw 1 core. */
  v1?: boolean;
  /** Where a payload already sits, and for an npm one the version it declares. */
  payload?: { at: "bundled" | "clawhub" } | { at: "npm"; version: string };
  /** Specs the fake CLI refuses, and specs it lets run into `timeout`'s deadline. */
  refuse?: string[];
  hang?: string[];
  /** The device store; entitled by default, `null` for none, a string for a body that is not JSON. */
  store?: Record<string, unknown> | null | string;
  /** A brave row already in data/plugin-repair.json, as an earlier start filed it. */
  row?: { disabled: boolean };
}

interface InstallResult {
  installs: string[];
  argv: string[];
  stdout: string;
  stderr: string;
  /** `plugins.entries.brave` as the run left it. */
  entry: { enabled?: unknown; config?: unknown } | undefined;
  /** The brave row in data/plugin-repair.json as the run left it. */
  row: { stage?: string; disabled?: boolean; spec?: string; reason?: string } | undefined;
}

function installBlock(): string {
  // Sliced per run rather than at load, so a script without the block fails
  // each case by name instead of the whole file at collection.
  return [
    "set -euo pipefail",
    repairHelpers(),
    sliceScript("# ClawBox AI web search: the Brave plugin", "# End of the ClawBox AI web search plugin install"),
  ].join("\n");
}

function install(opts: InstallOptions = {}): InstallResult {
  const home = path.join(dir, "openclaw-home");
  const storePath = path.join(dir, "device-store.json");
  const store = opts.store === undefined ? ENTITLED : opts.store;
  if (typeof store === "string") writeFileSync(storePath, store);
  else if (store !== null) writeFileSync(storePath, JSON.stringify(store));
  const rowsPath = path.join(dir, "data", "plugin-repair.json");
  if (opts.row) {
    mkdirSync(path.dirname(rowsPath), { recursive: true });
    writeFileSync(rowsPath, JSON.stringify({
      brave: {
        id: "brave", stage: "install", reason: "offline", atMs: 1, disabled: opts.row.disabled, spec: NPM_SPEC,
      },
    }));
  }
  const binDir = path.join(dir, "core", "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const payload = opts.payload;
  if (payload?.at === "bundled") {
    const bundled = path.join(dir, "core", "lib", "node_modules", "openclaw", "dist", "extensions", "brave");
    mkdirSync(bundled, { recursive: true });
    writeFileSync(path.join(bundled, "openclaw.plugin.json"), "{}");
  } else if (payload?.at === "clawhub") {
    mkdirSync(path.join(home, "extensions", "brave"), { recursive: true });
    writeFileSync(path.join(home, "extensions", "brave", "openclaw.plugin.json"), "{}");
  } else if (payload?.at === "npm") {
    const pkg = path.join(home, "npm", "projects", "openclaw-brave-plugin-0123456789", "node_modules", "@openclaw", "brave-plugin");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "openclaw.plugin.json"), "{}");
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openclaw/brave-plugin", version: payload.version }));
  }
  const config = path.join(dir, "openclaw.json");
  const document = opts.config ?? seeded({ ...OURS }, { enabled: true });
  writeFileSync(config, typeof document === "string" ? document : JSON.stringify(document));
  const installsLog = path.join(dir, "installs.log");
  const argvLog = path.join(dir, "argv.log");
  const bin = path.join(binDir, "openclaw");
  const list = (specs: string[] = []) => specs.map((s) => `'${s}'`).join(" ");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      // The real `config set` semantics for the one key the repair helpers
      // write, because they prove their write against the FILE.
      'if [ "$1" = "config" ] && [ "$2" = "set" ]; then',
      '  CLAWBOX_PATH="$3" CLAWBOX_VALUE="$4" python3 - "$OPENCLAW_CONFIG" <<\'PY\'',
      "import json, os, re, sys",
      "with open(sys.argv[1]) as fh:",
      "    cfg = json.load(fh)",
      "m = re.match(r'^plugins\\.entries\\[\"(.+)\"\\]\\.enabled$', os.environ['CLAWBOX_PATH'])",
      "if not m:",
      "    raise SystemExit(1)",
      "cfg.setdefault('plugins', {}).setdefault('entries', {}).setdefault(m.group(1), {})['enabled'] = os.environ['CLAWBOX_VALUE'] == 'true'",
      "with open(sys.argv[1], 'w') as fh:",
      "    json.dump(cfg, fh)",
      "PY",
      "  exit $?",
      "fi",
      `if [ "$2" = "install" ]; then echo "$3" >> "${installsLog}"; echo "$*" >> "${argvLog}"; fi`,
      `for r in ${list(opts.hang)}; do`,
      '  if [ "$3" = "$r" ]; then echo "Resolving $3..."; exit 124; fi',
      "done",
      `for r in ${list(opts.refuse)}; do`,
      '  if [ "$3" = "$r" ]; then echo "Version not found: $3" >&2; exit 1; fi',
      "done",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const result = spawnSync("bash", ["-c", installBlock()], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAWBOX_ROOT: dir,
      CLAWBOX_OPENCLAW_V2: opts.v1 ? "0" : "1",
      CLAWBOX_OPENCLAW_EFFECTIVE: opts.effective ?? RELEASE,
      CLAWBOX_DEVICE_STORE: storePath,
      OPENCLAW_HOME_DIR: home,
      OPENCLAW_CONFIG: config,
      OPENCLAW_BIN: bin,
    }),
  });
  // Never fatal: whatever happened, the gateway still starts.
  if (result.status !== 0) throw new Error(`block exited ${result.status}: ${result.stderr}`);
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").filter(Boolean) : []);
  const json = (file: string) => {
    try { return JSON.parse(readFileSync(file, "utf-8")); } catch { return undefined; }
  };
  return {
    installs: lines(installsLog),
    argv: lines(argvLog),
    stdout: result.stdout,
    stderr: result.stderr ?? "",
    entry: json(config)?.plugins?.entries?.brave,
    row: json(rowsPath)?.brave,
  };
}

describe.skipIf(!hasBash || !hasPython3)("the Brave plugin install, run out of the shipped script", () => {
  it("installs the core's own build from npm, with consent, and stops there", () => {
    const { installs, argv, stdout } = install();

    expect(installs).toEqual([NPM_SPEC]);
    expect(argv).toEqual([`plugins install ${NPM_SPEC} --force --accept-capabilities`]);
    expect(stdout).toContain(`Brave web search plugin installed (${NPM_SPEC})`);
  });

  it("asks ClawHub for the same pinned build when npm refuses, and never the unpinned spec", () => {
    const { installs, argv } = install({ refuse: [NPM_SPEC] });

    expect(installs).toEqual([NPM_SPEC, CLAWHUB_SPEC]);
    // `--force` is the consent to a non-ClawHub source: the npm spec only.
    expect(argv[1]).toBe(`plugins install ${CLAWHUB_SPEC} --accept-capabilities`);
  });

  it("boots without it when both registries refuse: a warning, no repair row", () => {
    const { installs, stderr } = install({ refuse: [NPM_SPEC, CLAWHUB_SPEC] });

    expect(installs).toEqual([NPM_SPEC, CLAWHUB_SPEC]);
    expect(stderr).toContain("WARN: could not install @openclaw/brave-plugin");
    expect(stderr).toContain("searches with the browser");
    // Search is optional; Settings has nothing to repair.
    expect(existsSync(path.join(dir, "data", "plugin-repair.json"))).toBe(false);
  });

  it("spends one deadline, not two, on a box that is offline", () => {
    const { installs, stderr } = install({ hang: [NPM_SPEC] });

    expect(installs).toEqual([NPM_SPEC]);
    expect(stderr).toContain("killed at its deadline");
  });

  it("installs nothing without the running core's version to pin to", () => {
    const { installs, stderr } = install({ effective: "" });

    expect(installs).toEqual([]);
    expect(stderr).toContain("no pinned build can be chosen");
  });

  describe("asks the device store as the migration does, so a stale entry never buys an install", () => {
    // The migration takes our entry back when the store says off, but a write
    // that failed, or a box whose chat provider no longer carries a `claw_`
    // token (the migration's own gate), leaves it on disk.
    for (const [name, store] of [
      ["the flag is off", { clawai_plan_tier: MAX_PLAN, [FLAG]: false }],
      ["the flag is absent", { clawai_plan_tier: MAX_PLAN }],
      ["the plan is Pro", { clawai_plan_tier: PRO_PLAN, [FLAG]: true }],
      ["the subscription is cancelled", { clawai_plan_tier: "free", [FLAG]: true }],
    ] as const) {
      it(`installs nothing when ${name}`, () => {
        expect(install({ store }).installs).toEqual([]);
      });
    }

    it("still installs for its entry when the store cannot be read, which the migration keeps", () => {
      expect(install({ store: "not json at all" }).installs).toEqual([NPM_SPEC]);
    });

    it("still installs for its entry on a box with no device store", () => {
      expect(install({ store: null }).installs).toEqual([NPM_SPEC]);
    });

    it("still installs for its entry when the store is silent about the plan", () => {
      expect(install({ store: { [FLAG]: true } }).installs).toEqual([NPM_SPEC]);
    });
  });

  describe("a payload an older core left behind", () => {
    // A core update leaves the old build on disk, unreachable, with the
    // install record that has the core verify it at startup: an enabled entry
    // over it is a gateway that refuses readiness. Never-installed is the
    // other case, and stays a warning (above).
    const stale = { at: "npm", version: "2026.9.4" } as const;

    it("is switched off, with a repair row, when the reinstall fails", () => {
      const { installs, entry, row, stderr } = install({ payload: stale, refuse: [NPM_SPEC, CLAWHUB_SPEC] });

      expect(installs).toEqual([NPM_SPEC, CLAWHUB_SPEC]);
      expect(entry?.enabled).toBe(false);
      // Our fields stay: the entry is still ours, and the next start retries it.
      expect((entry?.config as { webSearch?: unknown })?.webSearch).toEqual(OURS);
      expect(row).toMatchObject({ stage: "install", disabled: true, spec: NPM_SPEC });
      expect(row?.reason).toContain("ClawBox AI web search");
      expect(stderr).toContain("would stop the gateway");
    });

    it("is switched off after one deadline on a box that is offline", () => {
      const { installs, entry, row } = install({ payload: stale, hang: [NPM_SPEC] });

      expect(installs).toEqual([NPM_SPEC]);
      expect(entry?.enabled).toBe(false);
      expect(row?.disabled).toBe(true);
    });

    it("is replaced, and nothing is switched off, when the reinstall works", () => {
      const { installs, entry, row } = install({ payload: stale });

      expect(installs).toEqual([NPM_SPEC]);
      expect(entry?.enabled).toBe(true);
      expect(row).toBeUndefined();
    });
  });

  describe("an entry a previous start switched off is ClawBox's to bring back", () => {
    const offByUs = () => ({ config: seeded({ ...OURS }, { enabled: false }), row: { disabled: true } });

    it("installs again, then switches it on and clears the row", () => {
      const { installs, entry, row, stdout } = install(offByUs());

      expect(installs).toEqual([NPM_SPEC]);
      expect(entry?.enabled).toBe(true);
      expect(row).toBeUndefined();
      expect(stdout).toContain("Switched the brave plugin back on");
    });

    it("switches it on and clears the row when the payload is already back", () => {
      // An update's plugin refresh, or the owner's Retry, put it there.
      const { installs, entry, row } = install({ ...offByUs(), payload: { at: "npm", version: RELEASE } });

      expect(installs).toEqual([]);
      expect(entry?.enabled).toBe(true);
      expect(row).toBeUndefined();
    });

    it("keeps it off, and its row ours, when the retry fails too", () => {
      const { entry, row } = install({ ...offByUs(), refuse: [NPM_SPEC, CLAWHUB_SPEC] });

      expect(entry?.enabled).toBe(false);
      expect(row).toMatchObject({ stage: "install", disabled: true });
    });

    it("but never one the OWNER switched off", () => {
      const { installs, entry } = install({ config: seeded({ ...OURS }, { enabled: false }) });

      expect(installs).toEqual([]);
      expect(entry?.enabled).toBe(false);
    });

    it("nor one the owner switched off over a payload this core can load", () => {
      const { installs, entry } = install({
        config: seeded({ ...OURS }, { enabled: false }),
        payload: { at: "npm", version: RELEASE },
      });

      expect(installs).toEqual([]);
      expect(entry?.enabled).toBe(false);
    });

    it("nor once the device store says search is off", () => {
      const { installs, entry, row } = install({ ...offByUs(), store: { clawai_plan_tier: MAX_PLAN, [FLAG]: false } });

      expect(installs).toEqual([]);
      expect(entry?.enabled).toBe(false);
      expect(row?.disabled).toBe(true);
    });
  });

  describe("installs nothing on a box that does not need it", () => {
    for (const [name, config] of [
      ["the flag is off (no entry at all)", {}],
      ["the owner's own Brave key is on the entry", seeded({ apiKey: "BSA-owner-key" })],
      ["the owner's key is a secret reference", seeded({ apiKey: { source: "env", provider: "default", id: "BRAVE" } })],
      ["the owner switched the plugin off", seeded({ ...OURS }, { enabled: false })],
      ["plugins is not an object", { plugins: "nonsense" }],
      ["openclaw.json is not JSON", "{ not json"],
    ] as const) {
      it(`when ${name}`, () => {
        const { installs, stderr } = install({ config });
        expect(installs).toEqual([]);
        expect(stderr).toBe("");
      });
    }

    it("on an OpenClaw 1 core", () => {
      expect(install({ v1: true }).installs).toEqual([]);
    });
  });

  describe("pays nothing when a payload this core can load is on disk", () => {
    it("bundled with the core", () => {
      expect(install({ payload: { at: "bundled" } }).installs).toEqual([]);
    });

    it("from ClawHub", () => {
      expect(install({ payload: { at: "clawhub" } }).installs).toEqual([]);
    });

    it("from npm, at the core's own release", () => {
      expect(install({ payload: { at: "npm", version: RELEASE } }).installs).toEqual([]);
    });

    it("but replaces an npm payload an older core left behind", () => {
      expect(install({ payload: { at: "npm", version: "2026.9.4" } }).installs).toEqual([NPM_SPEC]);
    });
  });
});
