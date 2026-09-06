import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsSync from "fs";
import { createManifestFixture, loadLifecycle, type ManifestFixture } from "@/tests/helpers/core-model-manifests";

/**
 * The binary the lifecycle module resolves the BUNDLED candidate from.
 *
 * Defaulted to a bare name — exactly what `findOpenclawBin` answers on a box
 * with no core installed — because this machine has a core, and a case about
 * "no manifest anywhere" would otherwise read the real /usr/lib copy. The one
 * case that means to exercise the bundled candidate points it at the fixture.
 */
const bin = vi.hoisted(() => ({ override: "openclaw" }));
vi.mock("@/lib/openclaw-config", () => ({ findOpenclawBin: () => bin.override }));

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

let fixture: ManifestFixture;

beforeEach(() => {
  vi.resetModules();
  bin.override = "openclaw";
  fixture = createManifestFixture("core-lifecycle-");
});

afterEach(() => {
  fixture.cleanup();
  vi.restoreAllMocks();
});

/**
 * The anthropic manifest's REAL nesting on 2026.8.1, cut to what matters:
 * `modelCatalog.providers.<route>.models`, with the two routes the core ships.
 * Copied from the installed file rather than invented, so these cases exercise
 * the path a real manifest takes.
 */
const ANTHROPIC = {
  name: "anthropic",
  modelCatalog: {
    discovery: { anthropic: "refreshable" },
    providers: {
      "claude-cli": {
        models: [
          { id: "claude-opus-5", contextWindow: 1_000_000 },
          { id: "claude-sonnet-5", contextWindow: 1_000_000 },
        ],
      },
      anthropic: {
        models: [
          { id: "claude-opus-5", contextWindow: 1_000_000 },
          { id: "claude-sonnet-5", contextWindow: 1_000_000 },
          { id: "claude-opus-4-8", contextWindow: 1_000_000, status: "deprecated", replacedBy: "claude-opus-5" },
          { id: "claude-haiku-4-5", contextWindow: 200_000 },
        ],
      },
    },
  },
};

describe("coreModelRetired", () => {
  it("reads the retirement the core itself published", async () => {
    fixture.writeManifest("anthropic", ANTHROPIC);
    const { coreModelRetired } = await loadLifecycle();
    expect(coreModelRetired("anthropic", "claude-opus-4-8")).toBe(true);
    expect(coreModelRetired("anthropic", "claude-opus-5")).toBe(false);
  });

  it("honours `disabled` as well as `deprecated`, like the core's own filter", async () => {
    // `catalog.filter(e => … e.status !== "deprecated" && e.status !== "disabled")`
    // in the installed core's list probe. `disabled` is the stronger signal;
    // reading only half the harness's predicate is not deferring to it.
    fixture.writeManifest("google", { models: [
      { id: "gemini-old", status: "disabled" },
      { id: "gemini-2.5-flash" },
    ] });
    const { coreModelRetired } = await loadLifecycle();
    expect(coreModelRetired("google", "gemini-old")).toBe(true);
    expect(coreModelRetired("google", "gemini-2.5-flash")).toBe(false);
  });

  it("answers for a slashed id under either form", async () => {
    // The shipped manifests carry both: bare ids for anthropic and openai,
    // slashed ones for nvidia (`z-ai/glm-5.1`). The caller holds whichever
    // form its own catalogue uses, and a lookup that only matched one would
    // fail open — silently, which is this module's stated anti-goal.
    fixture.writeManifest("openrouter", { models: [{ id: "z-ai/glm-5.1", status: "deprecated" }] });
    const { coreModelRetired } = await loadLifecycle();
    expect(coreModelRetired("openrouter", "z-ai/glm-5.1")).toBe(true);
    expect(coreModelRetired("openrouter", "glm-5.1")).toBe(true);
    expect(coreModelRetired("openrouter", "glm-5.2")).toBe(false);
  });

  it("reads the provider's OWN catalogue block, not its neighbour's", async () => {
    // The anthropic manifest ships two under `modelCatalog.providers` —
    // `claude-cli` and `anthropic` — and they are different surfaces, not
    // copies. A model retired on the narrower route must not vanish from the
    // wider one, where the core still lists and routes it.
    fixture.writeManifest("anthropic", { modelCatalog: { providers: {
      "claude-cli": { models: [{ id: "claude-sonnet-5", status: "deprecated" }] },
      anthropic: { models: [{ id: "claude-sonnet-5" }, { id: "claude-opus-4-8", status: "deprecated" }] },
    } } });
    const { coreModelRetired } = await loadLifecycle();
    expect(coreModelRetired("anthropic", "claude-sonnet-5")).toBe(false);
    expect(coreModelRetired("anthropic", "claude-opus-4-8")).toBe(true);
  });

  it("does not read sibling provider blocks when the provider map exists", async () => {
    writeManifest("deepseek", {
      modelCatalog: {
        providers: {
          "deepseek-cli": { models: [{ id: "deepseek-local", status: "deprecated" }] },
        },
      },
      providers: {
        deepseek: { models: [{ id: "deepseek-web", status: "deprecated" }] },
      },
    });
    const { coreModelRetired } = await load();
    expect(coreModelRetired("deepseek", "deepseek-local")).toBe(false);
    expect(coreModelRetired("deepseek", "deepseek-web")).toBe(false);
  });

  it("falls back to top-level providers when modelCatalog.providers is absent", async () => {
    writeManifest("openrouter", {
      providers: {
        openrouter: { models: [{ id: "glm-5.1", status: "deprecated" }] },
      },
    });
    const { coreModelRetired } = await load();
    expect(coreModelRetired("openrouter", "glm-5.1")).toBe(true);
    expect(coreModelRetired("openrouter", "glm-5.2")).toBe(false);
  });

  it("re-reads a manifest the core replaced under a live process", async () => {
    // The in-app OpenClaw-only update runs INSIDE this server and deliberately
    // does not restart it, so "cached for the process lifetime" would keep a
    // retired model on offer until a reboot — and a read taken while
    // `npm install -g` is mid-rename would pin "nothing is retired" forever.
    fixture.writeManifest("openai", { models: [{ id: "gpt-5.5" }] });
    const { coreModelRetired } = await loadLifecycle();
    expect(coreModelRetired("openai", "gpt-5.5")).toBe(false);

    fixture.writeManifest("openai", { models: [{ id: "gpt-5.5", status: "deprecated" }, { id: "gpt-5.6-sol" }] });
    // Past the stat floor, which exists so a payload of hundreds of rows costs
    // one syscall rather than hundreds — not to hold an answer for a minute.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 10_000);
      expect(coreModelRetired("openai", "gpt-5.5")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not remember having found no manifest at all", async () => {
    // "There is no core yet" and "there is nothing retired" are different
    // answers, and caching the first as the second is how a filter turns
    // itself off for the life of a process with no log line.
    const { coreModelRetired } = await loadLifecycle();
    expect(coreModelRetired("openai", "gpt-5.5")).toBe(false);
    fixture.writeManifest("openai", { models: [{ id: "gpt-5.5", status: "deprecated" }] });
    expect(coreModelRetired("openai", "gpt-5.5")).toBe(true);
  });

  it("finds the row wherever the manifest nests it", async () => {
    // The shape has moved between core generations — a provider block, a
    // modelCatalog, one copy per auth mode — and the ids are the same in all of
    // them. A fixed path that went stale would answer "nothing is deprecated",
    // which is the failure this file replaces.
    fixture.writeManifest("openai", {
      auth: {
        "api-key": { models: [{ id: "gpt-5.5", status: "deprecated", replacedBy: "gpt-5.6-sol" }] },
        oauth: { models: [{ id: "gpt-5.6-sol" }] },
      },
    });
    const { coreModelRetired } = await loadLifecycle();
    expect(coreModelRetired("openai", "gpt-5.5")).toBe(true);
    expect(coreModelRetired("openai", "gpt-5.6-sol")).toBe(false);
  });

  it("says nothing rather than guessing when it cannot read a manifest", async () => {
    // A box with no core, no plugin, an unreadable file or a shape this does
    // not recognise must leave the picker exactly as it is. The failure this
    // must never have is emptying a customer's model list over a parse slip.
    const { coreModelRetired } = await loadLifecycle();
    expect(coreModelRetired("anthropic", "claude-opus-4-8")).toBe(false);

    // Valid JSON, and nothing this module knows how to read.
    fixture.writeManifest("openrouter", "not a catalogue at all");
    const shape = await loadLifecycle();
    expect(shape.coreModelRetired("openrouter", "anything")).toBe(false);

    // Not JSON at all, written as RAW BYTES: `JSON.stringify("}{ not json")`
    // is itself a valid JSON string, so putting this through `writeManifest`
    // would take the shape path above and leave the `JSON.parse` catch unrun.
    fixture.writeRawManifest("gemini", "}{ not json");
    const broken = await loadLifecycle();
    expect(broken.coreModelRetired("gemini", "anything")).toBe(false);
  });

  it("remembers a manifest it read but could make nothing of", async () => {
    // The other half of the contrast the next case rests on, asserted rather
    // than only asserted ABOUT: a shape this module does not recognise is still
    // a fair answer about a file it successfully read, so it is cached — which
    // is what makes the parse branch's refusal to cache a deliberate difference
    // rather than an accident of where the `return` landed.
    fixture.writeManifest("google", "not a catalogue at all");
    const { coreModelRetired } = await loadLifecycle();
    vi.useFakeTimers();
    try {
      expect(coreModelRetired("google", "gemini-old")).toBe(false);
      fixture.writeManifest("google", { models: [{ id: "gemini-old", status: "deprecated" }] });
      expect(coreModelRetired("google", "gemini-old")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not remember a manifest it could not parse", async () => {
    // Why the two failures above are not interchangeable: an unrecognised
    // SHAPE caches an empty set — a fair answer about a file that was read —
    // while a PARSE failure deliberately caches nothing, because the file it
    // failed on is the one `npm install -g openclaw@latest` is halfway through
    // writing. Caching that would pin "nothing is retired" for the life of the
    // process, which is the failure this module exists to survive.
    fixture.writeRawManifest("openai", "}{ not json");
    const { coreModelRetired } = await loadLifecycle();
    // Time frozen, so a cached empty set would still be inside the stat floor
    // and the second answer can only have come from a re-read.
    vi.useFakeTimers();
    try {
      expect(coreModelRetired("openai", "gpt-5.5")).toBe(false);
      fixture.writeManifest("openai", { models: [{ id: "gpt-5.5", status: "deprecated" }] });
      expect(coreModelRetired("openai", "gpt-5.5")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a manifest it cannot parse hide the next candidate", async () => {
    // There are two candidates because the provider's manifest moved: bundled
    // in the core's `dist/extensions`, or beside the config once OpenClaw 2
    // unbundled the provider into its own installed plugin. `npm install -g
    // openclaw@latest` renaming `dist/extensions` underneath leaves the FIRST
    // one half-written — the exact window this module exists to survive — and
    // giving up on the whole lookup there discards a perfectly readable second
    // manifest. Failing open is this file's rule for what it CANNOT read; it is
    // not a reason to stop reading what it can.
    fixture.writeRawBundledManifest("anthropic", "}{ not json");
    fixture.writeManifest("anthropic", { models: [{ id: "claude-opus-4-8", status: "deprecated" }] });
    bin.override = fixture.bin;
    const { coreRetiredModels } = await loadLifecycle();
    expect(coreRetiredModels("anthropic").has("claude-opus-4-8")).toBe(true);
  });

  it("goes back to the better manifest once it parses again", async () => {
    // The other half of the fall-through, and the reason the answer read past a
    // broken candidate is not cached: the staleness check re-stats ONE file —
    // the one that was cached — so caching the beside-config answer here would
    // key the whole provider on it and the repaired bundled manifest would
    // never be looked at again. That is the probe-once class, in the file
    // written to defeat it: a single unlucky read during an update would pin
    // the wrong source for the life of the web server.
    //
    // This also pins the candidate ORDER for the case above it: the assertion
    // can only flip if the bundled path really is where the module looks.
    fixture.writeRawBundledManifest("anthropic", "}{ not json");
    fixture.writeManifest("anthropic", { models: [{ id: "claude-opus-4-8", status: "deprecated" }] });
    bin.override = fixture.bin;
    const { coreRetiredModels } = await loadLifecycle();
    expect(coreRetiredModels("anthropic").has("claude-opus-4-8")).toBe(true);

    fixture.writeBundledManifest("anthropic", { models: [{ id: "claude-opus-4-7", status: "deprecated" }] });
    // Time frozen, so a cached set would still be inside the stat floor and the
    // new answer can only have come from a re-read of both candidates.
    vi.useFakeTimers();
    try {
      const retired = coreRetiredModels("anthropic");
      expect(retired.has("claude-opus-4-7")).toBe(true);
      expect(retired.has("claude-opus-4-8")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat a manifest it cannot OPEN as one that is not there", async () => {
    // EACCES after a bad chown, EIO on a failing eMMC, EMFILE under load: the
    // file is there and cannot be used, which is the same degraded read as a
    // truncated one — and caching the answer found past it keys the whole
    // provider on the lower-priority file, since the staleness re-stat only
    // ever stats the file it cached. The repaired manifest would then never be
    // looked at again for the life of the web server.
    fixture.writeBundledManifest("anthropic", { models: [{ id: "claude-opus-4-7", status: "deprecated" }] });
    fixture.writeManifest("anthropic", { models: [{ id: "claude-opus-4-8", status: "deprecated" }] });
    bin.override = fixture.bin;

    // The permission failure, mocked rather than chmod'ed: a suite that runs as
    // root — every container CI job — reads a 000 file perfectly well, and the
    // case would pass by testing nothing.
    let refuseBundled = true;
    const realOpen = fsSync.openSync;
    vi.spyOn(fsSync, "openSync").mockImplementation(((file: fsSync.PathLike, ...rest: unknown[]) => {
      if (refuseBundled && String(file).includes("dist/extensions")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return (realOpen as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fsSync.openSync);

    const { coreRetiredModels } = await loadLifecycle();
    expect(coreRetiredModels("anthropic").has("claude-opus-4-8")).toBe(true);

    // Repaired. Time frozen, so a cached answer would still be inside the stat
    // floor and only a re-read of both candidates can change what is returned.
    refuseBundled = false;
    vi.useFakeTimers();
    try {
      const retired = coreRetiredModels("anthropic");
      expect(retired.has("claude-opus-4-7")).toBe(true);
      expect(retired.has("claude-opus-4-8")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still caches the answer when the better candidate is simply not there", async () => {
    // The other half of the rule, and the load-bearing one: on every OpenClaw 2
    // box the bundled path does not exist at all, and that is not a degraded
    // read. Without this the whole provider would re-open and re-read a file on
    // every catalogue request — the syscall storm the stat floor exists to stop.
    fixture.writeManifest("openai", { models: [{ id: "gpt-5.5", status: "deprecated" }] });
    bin.override = fixture.bin; // absolute, so the bundled candidate is TRIED
    const { coreRetiredModels } = await loadLifecycle();
    expect(coreRetiredModels("openai").has("gpt-5.5")).toBe(true);

    // Rewritten under a frozen clock: a cached answer is the only thing that
    // can still say "retired" here.
    fixture.writeManifest("openai", { models: [{ id: "gpt-5.5" }] });
    vi.useFakeTimers();
    try {
      expect(coreRetiredModels("openai").has("gpt-5.5")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not read the deepseek manifest for the clawai catalogue", async () => {
    // The asymmetry the module docblock records as deliberate: ClawBox's own
    // `clawai` catalogue is served by deepseek models through the ClawBox AI
    // proxy, and the lookup is keyed on the CATALOGUE provider with no inverse
    // mapping — what the proxy accepts is our contract with the customer, not
    // the upstream provider's lifecycle. Pinned so that "fixing the missing
    // mapping" cannot pass the suite, exactly as the codex/openai twin is
    // pinned in curated-defaults-offerable.test.ts.
    fixture.writeManifest("deepseek", { models: [{ id: "deepseek-v4-flash", status: "deprecated" }] });
    const { coreRetiredModels } = await loadLifecycle();
    expect(coreRetiredModels("deepseek").has("deepseek-v4-flash")).toBe(true);
    expect(coreRetiredModels("clawai").has("deepseek-v4-flash")).toBe(false);
  });

  it("refuses a provider id that could name anything but a directory", async () => {
    // The id reaches this module from a request query string by way of the
    // catalogue payload and is joined into a filesystem path. Nothing the core
    // ships is outside `[a-z0-9-]`, so anything else cannot have a manifest —
    // and refusing here closes the traversal class rather than relying on the
    // caller to have validated first.
    fixture.writeManifest("anthropic", ANTHROPIC);
    const { coreModelRetired, coreRetiredModels } = await loadLifecycle();
    for (const bad of ["../anthropic", "a/b", "..", "anthropic\u0000", "-leading"]) {
      expect(coreModelRetired(bad, "claude-opus-4-8")).toBe(false);
      expect(coreRetiredModels(bad).size).toBe(0);
    }
  });

  it("never reports a model the manifest does not name", async () => {
    fixture.writeManifest("anthropic", ANTHROPIC);
    const { coreModelRetired } = await loadLifecycle();
    expect(coreModelRetired("anthropic", "claude-something-else")).toBe(false);
    expect(coreModelRetired("", "claude-opus-5")).toBe(false);
    expect(coreModelRetired("anthropic", "")).toBe(false);
  });
});
