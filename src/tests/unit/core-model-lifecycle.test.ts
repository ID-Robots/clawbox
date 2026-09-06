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

describe("coreModelRetired", () => {
  it("reads the retirement the core itself published", async () => {
    writeManifest("anthropic", ANTHROPIC);
    const { coreModelRetired } = await load();
    expect(coreModelRetired("anthropic", "claude-opus-4-8")).toBe(true);
    expect(coreModelRetired("anthropic", "claude-opus-5")).toBe(false);
  });

  it("honours `disabled` as well as `deprecated`, like the core's own filter", async () => {
    // `catalog.filter(e => … e.status !== "deprecated" && e.status !== "disabled")`
    // in the installed core's list probe. `disabled` is the stronger signal;
    // reading only half the harness's predicate is not deferring to it.
    writeManifest("google", { models: [
      { id: "gemini-old", status: "disabled" },
      { id: "gemini-2.5-flash" },
    ] });
    const { coreModelRetired } = await load();
    expect(coreModelRetired("google", "gemini-old")).toBe(true);
    expect(coreModelRetired("google", "gemini-2.5-flash")).toBe(false);
  });

  it("answers for a slashed id under either form", async () => {
    // The shipped manifests carry both: bare ids for anthropic and openai,
    // slashed ones for nvidia (`z-ai/glm-5.1`). The caller holds whichever
    // form its own catalogue uses, and a lookup that only matched one would
    // fail open — silently, which is this module's stated anti-goal.
    writeManifest("openrouter", { models: [{ id: "z-ai/glm-5.1", status: "deprecated" }] });
    const { coreModelRetired } = await load();
    expect(coreModelRetired("openrouter", "z-ai/glm-5.1")).toBe(true);
    expect(coreModelRetired("openrouter", "glm-5.1")).toBe(true);
    expect(coreModelRetired("openrouter", "glm-5.2")).toBe(false);
  });

  it("reads the provider's OWN catalogue block, not its neighbour's", async () => {
    // The anthropic manifest ships two under `modelCatalog.providers` —
    // `claude-cli` and `anthropic` — and they are different surfaces, not
    // copies. A model retired on the narrower route must not vanish from the
    // wider one, where the core still lists and routes it.
    writeManifest("anthropic", { modelCatalog: { providers: {
      "claude-cli": { models: [{ id: "claude-sonnet-5", status: "deprecated" }] },
      anthropic: { models: [{ id: "claude-sonnet-5" }, { id: "claude-opus-4-8", status: "deprecated" }] },
    } } });
    const { coreModelRetired } = await load();
    expect(coreModelRetired("anthropic", "claude-sonnet-5")).toBe(false);
    expect(coreModelRetired("anthropic", "claude-opus-4-8")).toBe(true);
  });

  it("re-reads a manifest the core replaced under a live process", async () => {
    // The in-app OpenClaw-only update runs INSIDE this server and deliberately
    // does not restart it, so "cached for the process lifetime" would keep a
    // retired model on offer until a reboot — and a read taken while
    // `npm install -g` is mid-rename would pin "nothing is retired" forever.
    writeManifest("openai", { models: [{ id: "gpt-5.5" }] });
    const { coreModelRetired } = await load();
    expect(coreModelRetired("openai", "gpt-5.5")).toBe(false);

    await new Promise((r) => setTimeout(r, 12));
    writeManifest("openai", { models: [{ id: "gpt-5.5", status: "deprecated" }, { id: "gpt-5.6-sol" }] });
    expect(coreModelRetired("openai", "gpt-5.5")).toBe(true);
  });

  it("does not remember having found no manifest at all", async () => {
    // "There is no core yet" and "there is nothing retired" are different
    // answers, and caching the first as the second is how a filter turns
    // itself off for the life of a process with no log line.
    const { coreModelRetired } = await load();
    expect(coreModelRetired("openai", "gpt-5.5")).toBe(false);
    writeManifest("openai", { models: [{ id: "gpt-5.5", status: "deprecated" }] });
    expect(coreModelRetired("openai", "gpt-5.5")).toBe(true);
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
    const { coreModelRetired } = await load();
    expect(coreModelRetired("openai", "gpt-5.5")).toBe(true);
    expect(coreModelRetired("openai", "gpt-5.6-sol")).toBe(false);
  });

  it("says nothing rather than guessing when it cannot read a manifest", async () => {
    // A box with no core, no plugin, an unreadable file or a shape this does
    // not recognise must leave the picker exactly as it is. The failure this
    // must never have is emptying a customer's model list over a parse slip.
    const { coreModelRetired } = await load();
    expect(coreModelRetired("anthropic", "claude-opus-4-8")).toBe(false);

    writeManifest("gemini", "}{ not json" as unknown);
    const broken = await load();
    expect(broken.coreModelRetired("gemini", "anything")).toBe(false);
  });

  it("never reports a model the manifest does not name", async () => {
    writeManifest("anthropic", ANTHROPIC);
    const { coreModelRetired } = await load();
    expect(coreModelRetired("anthropic", "claude-something-else")).toBe(false);
    expect(coreModelRetired("", "claude-opus-5")).toBe(false);
    expect(coreModelRetired("anthropic", "")).toBe(false);
  });
});
