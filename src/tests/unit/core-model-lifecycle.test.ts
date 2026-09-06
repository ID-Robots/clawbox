import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The installed core, when there is one, is the FIRST place the module looks —
// and this machine has one, so a case about "no manifest anywhere" would read
// the real /usr/lib copy instead. Neutralised to a bare name, which is exactly
// what `findOpenclawBin` itself answers on a box with no core installed.
vi.mock("@/lib/openclaw-config", () => ({ findOpenclawBin: () => "openclaw" }));

/**
 * The picker must not offer what the harness has retired.
 *
 * The pinned core (2026.8.1) publishes each model's lifecycle in its provider
 * manifest — `{"id":"claude-opus-4-8","status":"deprecated","replacedBy":
 * "claude-opus-5"}` — and does NOT project it through `models list --json`,
 * whose rows carry `tags: []` for exactly that model. Measured, not assumed.
 * So the manifest is the only place the answer exists on this core, and these
 * cases pin that it is read from where the core actually puts it and that
 * every way of failing to read it is harmless.
 */

let tmpHome: string;
let originalHome: string | undefined;
let originalOpenclawHome: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "core-lifecycle-"));
  originalHome = process.env.HOME;
  originalOpenclawHome = process.env.OPENCLAW_HOME;
  process.env.HOME = tmpHome;
  process.env.OPENCLAW_HOME = path.join(tmpHome, ".openclaw");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = originalOpenclawHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write a provider manifest where OpenClaw 2 puts it: beside the config. */
function writeManifest(provider: string, body: unknown): void {
  const dir = path.join(tmpHome, ".openclaw", "extensions", provider);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(body));
}

async function load() {
  const mod = await import("@/lib/core-model-lifecycle");
  mod.resetCoreModelLifecycle();
  return mod;
}

/** The anthropic manifest's real shape on 2026.8.1, cut to what matters. */
const ANTHROPIC = {
  name: "anthropic",
  providers: {
    anthropic: {
      modelCatalog: [
        { id: "claude-opus-5", contextWindow: 1_000_000 },
        { id: "claude-sonnet-5", contextWindow: 1_000_000 },
        { id: "claude-opus-4-8", contextWindow: 1_000_000, status: "deprecated", replacedBy: "claude-opus-5" },
        { id: "claude-haiku-4-5", contextWindow: 200_000 },
      ],
    },
  },
};

describe("coreModelLifecycle", () => {
  it("reads the retirement the core itself published", async () => {
    writeManifest("anthropic", ANTHROPIC);
    const { coreModelLifecycle } = await load();
    expect(coreModelLifecycle("anthropic", "claude-opus-4-8")).toEqual({
      deprecated: true,
      replacedBy: "claude-opus-5",
    });
    expect(coreModelLifecycle("anthropic", "claude-opus-5")).toEqual({
      deprecated: false,
      replacedBy: null,
    });
  });

  it("finds the row wherever the manifest nests it", async () => {
    // The shape has moved between core generations — a provider block, a
    // modelCatalog, one copy per auth mode — and the ids are the same in all of
    // them. A fixed path that went stale would answer "nothing is deprecated",
    // which is the failure this file replaces.
    writeManifest("openai", {
      auth: {
        "api-key": { models: [{ id: "gpt-5.5", status: "deprecated", replacedBy: "gpt-5.6-sol" }] },
        oauth: { models: [{ id: "gpt-5.6-sol" }] },
      },
    });
    const { coreModelLifecycle } = await load();
    expect(coreModelLifecycle("openai", "gpt-5.5")?.deprecated).toBe(true);
    expect(coreModelLifecycle("openai", "gpt-5.6-sol")?.deprecated).toBe(false);
  });

  it("says nothing rather than guessing when it cannot read a manifest", async () => {
    // A box with no core, no plugin, an unreadable file or a shape this does
    // not recognise must leave the picker exactly as it is. The failure this
    // must never have is emptying a customer's model list over a parse slip.
    const { coreModelLifecycle } = await load();
    expect(coreModelLifecycle("anthropic", "claude-opus-4-8")).toBeNull();

    writeManifest("gemini", "}{ not json" as unknown);
    const broken = await load();
    expect(broken.coreModelLifecycle("gemini", "anything")).toBeNull();
  });

  it("never reports a model the manifest does not name", async () => {
    writeManifest("anthropic", ANTHROPIC);
    const { coreModelLifecycle } = await load();
    expect(coreModelLifecycle("anthropic", "claude-something-else")).toBeNull();
    expect(coreModelLifecycle("", "claude-opus-5")).toBeNull();
    expect(coreModelLifecycle("anthropic", "")).toBeNull();
  });
});
