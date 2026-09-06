import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A real DATA_DIR: the runnable verdict is read off disk, from the file the
// catalog route writes when an enumeration answers. Everything else the strip
// touches stays mocked exactly as in status.test.ts.
let dataDir = "";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: vi.fn() }));
vi.mock("@/lib/config-store", () => ({ get: vi.fn(), get DATA_DIR() { return dataDir; } }));
vi.mock("@/lib/hermes-model-options", () => ({
  getModelOptions: vi.fn(),
  probeStillOwed: vi.fn(),
}));
vi.mock("@/lib/clawbox-ai-portal-tier", () => ({ clawaiTokenRejectedByPortal: vi.fn() }));

let GET: () => Promise<Response>;
let getActiveHarness: Mock;
let hasClawaiToken: Mock;
let readConfig: Mock;
let getConfigValue: Mock;
let probeStillOwed: Mock;
let clawaiTokenRejectedByPortal: Mock;

/** What the catalog route records after an enumeration answers for a provider. */
function recordEnumerations(counts: Record<string, number>) {
  const dir = path.join(dataDir, "catalog-cache");
  mkdirSync(dir, { recursive: true });
  const providers: Record<string, { models: number; atMs: number }> = {};
  for (const [provider, models] of Object.entries(counts)) {
    providers[provider] = { models, atMs: Date.now() };
  }
  writeFileSync(path.join(dir, "_enumerations.json"), JSON.stringify({ providers }), "utf8");
}

/**
 * A box pointed at Anthropic, with a Google key and ClawBox AI linked.
 *
 * Three connected rows on purpose: hiding Google has to leave the strip with
 * something other than the default, or the "would this empty the strip?"
 * refusal takes over and these cases would be testing that instead.
 */
function boxWithGoogleKey() {
  readConfig.mockResolvedValue({
    auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
    models: { providers: { google: { apiKey: "AIza-secret" }, deepseek: { apiKey: "claw_token" } } },
    agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "clawbox-runnable-"));
  vi.resetModules();
  vi.clearAllMocks();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ hasClawaiToken } = (await import("@/lib/harness/credentials")) as unknown as { hasClawaiToken: Mock });
  ({ readConfig } = (await import("@/lib/openclaw-config")) as unknown as { readConfig: Mock });
  ({ get: getConfigValue } = (await import("@/lib/config-store")) as unknown as { get: Mock });
  ({ probeStillOwed } = (await import("@/lib/hermes-model-options")) as unknown as { probeStillOwed: Mock });
  ({ clawaiTokenRejectedByPortal } = (await import("@/lib/clawbox-ai-portal-tier")) as unknown as {
    clawaiTokenRejectedByPortal: Mock;
  });
  getConfigValue.mockResolvedValue(null);
  hasClawaiToken.mockResolvedValue(false);
  clawaiTokenRejectedByPortal.mockReturnValue(false);
  probeStillOwed.mockResolvedValue(false);
  getActiveHarness.mockResolvedValue("openclaw");
  ({ GET } = await import("@/app/setup-api/providers/status/route"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

interface Row { id: string; state: string; isDefault: boolean }
const ids = (body: { providers: Row[] }) => body.providers.map((p) => p.id);

describe("GET /setup-api/providers/status — a provider the box can run no model from", () => {
  it("drops the row when the box's own enumeration came back with nothing", async () => {
    // TASK-668. Under `models.mode: "replace"` the core answers `openclaw
    // models list --provider google` with zero rows: connecting a key there
    // buys a picker entry the gateway will refuse. The owner's ruling is that
    // such a row is not offered at all.
    boxWithGoogleKey();
    recordEnumerations({ google: 0, anthropic: 9 });
    const body = await (await GET()).json();

    // NAMED, and kept: the strip does the hiding, so the Connect list below it
    // can still show this provider with its real connection label and its
    // switch. Dropping the row server-side took both away.
    expect(body.unrunnable).toEqual(["google"]);
    expect(ids(body)).toEqual(expect.arrayContaining(["clawai", "openai", "anthropic", "openrouter", "google"]));
  });

  it("keeps the row on a box that can run at least one of that provider's models", async () => {
    boxWithGoogleKey();
    recordEnumerations({ google: 10 });
    const body = await (await GET()).json();

    expect(ids(body)).toContain("google");
    expect(body.unrunnable).toEqual([]);
  });

  /**
   * The refusal, measured against the rows the STRIP renders.
   *
   * Every record below is one the catalog route can actually write. Counting
   * every row in the summary instead made this unsatisfiable on every box —
   * `openai` stands for the never-enumerated `codex` catalogue, `clawai` is a
   * two-row literal and `openrouter` never records a zero — while the harm it
   * guards against stayed perfectly reachable.
   */
  describe("when hiding would leave the strip with the default row alone", () => {
    /** ClawBox AI is the default and connected; `keys` name the other connected rows. */
    function boxWithConnected(keys: string[]) {
      const providers: Record<string, { apiKey: string }> = { deepseek: { apiKey: "claw_token" } };
      for (const key of keys) providers[key] = { apiKey: `${key}-secret` };
      readConfig.mockResolvedValue({
        auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
        models: { providers },
        agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro" } } },
      });
    }

    it("names none — the box with one connected provider that answered zero", async () => {
      // The reachable harm: ClawBox AI the default, a Google key pasted, google
      // enumerating nothing. Hiding it leaves the panel showing ClawBox AI and
      // nothing else, which is never the honest reading of one zero.
      boxWithConnected(["google"]);
      recordEnumerations({ google: 0 });
      const body = await (await GET()).json();

      expect(body.unrunnable).toEqual([]);
      expect(ids(body)).toContain("google");
    });

    it("still names the one that answered zero when another connected row survives", async () => {
      // Anthropic is connected and enumerated fine, so hiding google leaves the
      // strip with something to show and the rule does its job.
      boxWithConnected(["google", "anthropic"]);
      recordEnumerations({ google: 0, anthropic: 15 });
      const body = await (await GET()).json();

      expect(body.unrunnable).toEqual(["google"]);
    });

    it("names none when BOTH connected providers answered zero", async () => {
      // One catalogue-load failure answers `count: 0` for several providers at
      // once. Each is a clean zero per provider and none is a fact about what
      // the box can run.
      boxWithConnected(["google", "anthropic"]);
      recordEnumerations({ google: 0, anthropic: 0 });
      const body = await (await GET()).json();

      expect(body.unrunnable).toEqual([]);
    });

    it("names nothing at all on the box's own catalogue", async () => {
      // The counts this box really records (measured read-only, `merge` mode).
      // Nothing is hidden, and the rule is silent.
      boxWithConnected(["google", "anthropic"]);
      recordEnumerations({ google: 10, anthropic: 15, openai: 27, clawai: 2, openrouter: 417 });
      const body = await (await GET()).json();

      expect(body.unrunnable).toEqual([]);
      expect(ids(body)).toEqual(
        expect.arrayContaining(["clawai", "openai", "anthropic", "google", "openrouter"]),
      );
    });
  });

  it("keeps the row when no enumeration has answered yet — unknown is not empty", async () => {
    // The false-failure guard. A box that has never enumerated google, or
    // whose record cannot be read, knows nothing about it; hiding the row on
    // an absent answer would delete a working provider from the UI.
    boxWithGoogleKey();
    const body = await (await GET()).json();

    expect(ids(body)).toContain("google");
    expect(body.unrunnable).toEqual([]);
  });

  it("names a provider the box can run nothing from even before it is connected", async () => {
    // The strip answers "what is this box set up with and can it run". A
    // provider it can run nothing from does not belong in that answer whether
    // or not a credential is sitting there — and the way OUT of that state is
    // the "Connect AI Provider" list, which offers every provider
    // unconditionally (see `AIModelsStep`). This is the pair: the strip may
    // drop the row only because that list never does.
    readConfig.mockResolvedValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    });
    recordEnumerations({ google: 0 });
    const body = await (await GET()).json();

    expect(body.unrunnable).toEqual(["google"]);
  });

  it("stops trusting a count older than the catalogue's own refresh interval", async () => {
    // Nothing re-enumerates a hidden provider — no row, no picker, no configure
    // POST for it — so a verdict that has aged past the interval the catalogue
    // itself would re-ask on has to expire back to `unknown` rather than hide
    // the row for the life of the box.
    boxWithGoogleKey();
    const dir = path.join(dataDir, "catalog-cache");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "_enumerations.json"),
      JSON.stringify({ providers: { google: { models: 0, atMs: Date.now() - 7 * 60 * 60_000 } } }),
      "utf8",
    );
    const body = await (await GET()).json();

    expect(ids(body)).toContain("google");
    expect(body.unrunnable).toEqual([]);
  });

  it("keeps the row when the record is corrupt", async () => {
    boxWithGoogleKey();
    const dir = path.join(dataDir, "catalog-cache");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "_enumerations.json"), "{not json", "utf8");
    const body = await (await GET()).json();

    expect(ids(body)).toContain("google");
  });

  it("never hides the provider the box is actually pointed at", async () => {
    // A default that can run nothing is the one row that MUST stay visible:
    // it is why chat is broken, and hiding it leaves no way to see or change
    // it.
    readConfig.mockResolvedValue({
      auth: { profiles: { "google:default": { provider: "google", mode: "api_key" } } },
      agents: { defaults: { model: { primary: "google/gemini-2.5-pro" } } },
    });
    recordEnumerations({ google: 0 });
    const body = await (await GET()).json();

    expect(ids(body)).toContain("google");
    expect(body.providers.find((p: Row) => p.id === "google")!.isDefault).toBe(true);
    expect(body.unrunnable).toEqual([]);
  });
});
