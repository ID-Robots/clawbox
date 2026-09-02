import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

// M-05 / TASK-653 — "I want the latest and the correct (usable) models to be
// pulled, not hard-coded."
//
// The harness already answers that question: `openclaw models list --provider
// <id> --all --json` is the catalogue (docs.openclaw.ai/cli/models,
// /concepts/models — bundled + plugin-captured + a remote refresh every 6h).
// This route proxies it, and that part was right.
//
// What went wrong on the box, 2026-09-02 07:13: the Anthropic plugin was
// disabled, the live query came back with one row, and the route appended the
// curated cold-start list from provider-models.ts and wrote the result to
// data/catalog-cache/anthropic.json as though a device had reported it. The
// file then looked fresh for the whole 6h refresh interval, so the chat picker
// offered exactly three Claude models for the rest of the day while the box
// could run eleven. The same path turned "[catalog] refreshed codex: 0 models"
// into a persisted copy of the six hard-coded CODEX_MODELS.
//
// Three rules follow, and this file pins them:
//   1. a payload built from the static list is never persisted as a live one;
//   2. a live enumeration that returns nothing is not a success;
//   3. a cached payload that is not a live enumeration is refreshed on the
//      next request, and the live list replaces it.

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

const DATA_DIR = "/tmp/clawbox-catalog-live-fallback-test";
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-live-fallback-test" }));

import { GET, refreshInBackground } from "@/app/setup-api/ai-models/catalog/route";

const mockSpawn = vi.mocked(childProcess.spawn);

/** Minimal stand-in for the openclaw child process the route drives. */
function fakeChild(json: unknown, stderr = "") {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf8"));
    child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
    child.emit("close", 0);
  });
  return child;
}

/**
 * `openclaw models list --provider anthropic --all --json` as the box answered
 * it once the plugin was enabled again: eleven rows, every one `available`.
 */
const ANTHROPIC_LIVE = {
  count: 11,
  models: [
    { key: "anthropic/claude-fable-5", name: "Claude Fable 5", contextWindow: 1_000_000, available: true, tags: [] },
    { key: "anthropic/claude-fable-5-1", name: "Claude Fable 5.1", contextWindow: 1_000_000, available: true, tags: [] },
    { key: "anthropic/claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000, available: true, tags: [] },
    { key: "anthropic/claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1_000_000, available: true, tags: [] },
    { key: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 1_000_000, available: true, tags: [] },
    { key: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 1_000_000, available: true, tags: [] },
    { key: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 1_000_000, available: true, tags: ["default"] },
    { key: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000, available: true, tags: [] },
    { key: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, available: true, tags: [] },
    { key: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (2025-10-01)", contextWindow: 200_000, available: true, tags: [] },
    { key: "anthropic/claude-mythos-5", name: "Claude Mythos 5", contextWindow: 1_000_000, available: true, tags: [] },
  ],
};

/** The same command while the Anthropic plugin was disabled: one row. */
const ANTHROPIC_THIN = {
  count: 1,
  models: [
    { key: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000, available: true, tags: [] },
  ],
};

/** Make every `openclaw models list` spawn answer with `json` (and `stderr`). */
function mockList(json: unknown, stderr = ""): void {
  mockSpawn.mockImplementation(
    () => fakeChild(json, stderr) as unknown as ReturnType<typeof childProcess.spawn>,
  );
}

function cacheFile(provider: string): string {
  return path.join(DATA_DIR, "catalog-cache", `${provider}.json`);
}

function readCache(provider: string): { models: Array<{ id: string }>; source?: string } {
  return JSON.parse(fs.readFileSync(cacheFile(provider), "utf8"));
}

function writeCache(provider: string, payload: unknown): void {
  fs.mkdirSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true });
  fs.writeFileSync(cacheFile(provider), JSON.stringify(payload), "utf8");
}

async function get(provider: string, params = ""): Promise<Record<string, unknown>> {
  const url = `http://clawbox.local/setup-api/ai-models/catalog?provider=${provider}${params}`;
  const res = await GET(new NextRequest(url));
  return (await res.json()) as Record<string, unknown>;
}

/**
 * The provider each `openclaw models list` spawn was for.
 *
 * Read instead of the raw call count because the module-level boot warmup
 * schedules a refresh for every provider on real timers, so an unrelated one
 * can land inside a test's window.
 */
function spawnedProviders(): string[] {
  return mockSpawn.mock.calls.map((call) => {
    const args = call[1] as string[];
    return args[args.indexOf("--provider") + 1];
  });
}

/** Let a detached refresh get as far as it is going to get. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
}

/** Ids in the payload the route published for `provider`. */
async function publishedIds(provider: string, expected: number): Promise<string[]> {
  let ids: string[] = [];
  await vi.waitFor(() => {
    if (!fs.existsSync(cacheFile(provider))) {
      refreshInBackground(provider);
      throw new Error("not published yet");
    }
    ids = readCache(provider).models.map((m) => m.id);
    expect(ids).toHaveLength(expected);
  }, { timeout: 4000, interval: 25 });
  return ids;
}

// The first GET in this file starts the route's module-level `bootWarmup`,
// which schedules a refresh for every CATALOG_PROVIDERS entry (clawai at 0ms,
// then 5s apart) and cannot be reset between tests. Two consequences are
// handled here rather than tolerated: the openrouter warmup would make a REAL
// request to openrouter.ai, so fetch is stubbed; and a late google timer could
// write that provider's cache, so the assertion below is about the CONTENT the
// route would have persisted, not about a file existing.
//
// Deliberately NOT paired with an `unstubAllGlobals` teardown. The stub cannot
// leak: vitest runs each test file in its own isolated environment (`isolate`
// defaults to true and this project overrides neither it nor `pool`), so it
// dies with this file. Unstubbing between tests would instead OPEN the hole —
// those warmup timers are real and fire on the wall clock, including in the gap
// between an `afterEach` and the next `beforeEach`, which is the one window a
// real openrouter.ai request could slip through.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no network in this suite");
  }));
});

describe("catalog — a fallback is never served as a live enumeration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
  });

  // FIRST in the file on purpose: it is the only test that needs the route's
  // process-local memCache to be empty for anthropic, and nothing resets it.
  it("re-reads a cached payload that no live enumeration produced, and the live list replaces it", async () => {
    // What the box actually had on disk at 07:13 — the three hard-coded
    // ANTHROPIC_MODELS, stamped with a fresh `fetchedAt` so the 6h staleness
    // check saw nothing wrong with it.
    writeCache("anthropic", {
      provider: "anthropic",
      models: [
        { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000 },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1_000_000 },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000 },
      ],
      defaultModelId: "claude-sonnet-5",
      allowCustom: true,
      fetchedAt: Date.now(),
    });
    mockList(ANTHROPIC_LIVE);

    const first = await get("anthropic");
    // It is served — a blank picker helps nobody — but it carries no
    // `source: "live"`, and that absence is what tells the client what it is
    // holding. One marker, so two cannot disagree.
    expect(first.source).toBeUndefined();
    expect((first.models as unknown[]).length).toBe(3);

    // And it is retried rather than trusted for the next six hours.
    const live = await publishedIds("anthropic", 11);
    expect(live).toContain("claude-fable-5");
    expect(live).toContain("claude-opus-4-8");

    const second = await get("anthropic");
    expect(second.source).toBe("live");
    expect((second.models as Array<{ id: string }>).map((m) => m.id)).toHaveLength(11);
  });

  it("never appends the curated list to a thin live enumeration", async () => {
    mockList(ANTHROPIC_THIN);
    refreshInBackground("anthropic");

    const ids = await publishedIds("anthropic", 1);
    expect(ids).toEqual(["claude-sonnet-4-6"]);
    // The curated cold-start ids must not be in a file the picker and the
    // server-side surface guard both read back as a device answer.
    expect(ids).not.toContain("claude-opus-5");
    expect(readCache("anthropic").source).toBe("live");
  });

  it("does not persist anything when the live enumeration returns no models", async () => {
    // The real shape of a refusal, measured on 2026.8.1: `{ok: false, error}`
    // on STDOUT, empty stderr, exit code 0. Reading the exit code alone would
    // call this a successful refresh — which is precisely what
    // "[catalog] refreshed codex: 0 models" was.
    mockList({
      ok: false,
      error: {
        type: "cli_error",
        message: 'Unknown provider filter "google" for this installation.',
      },
    });

    refreshInBackground("google");
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Zero models is not an answer about what the box can run. Writing the
    // curated ids here is what made "[catalog] refreshed codex: 0 models" look
    // like a successful refresh.
    const persisted = fs.existsSync(cacheFile("google"))
      ? readCache("google").models.map((m) => m.id)
      : [];
    expect(persisted).toEqual([]);
  });
});

describe("catalog — the ChatGPT surface has no enumeration on this core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
  });

  // `codex` is gone from the OpenClaw 2 core, so the obvious move is to serve
  // its picker from the `openai` catalogue narrowed by the ChatGPT-account
  // allowlist. That would be a WRONG live list, not a live list: the openai
  // catalogue is not plan-scoped — it carries gpt-5.6-sol on any box, and
  // gpt-5.6 is plan-gated upstream — so a Free account would be offered it as
  // the only row AND handed it as the saved default, and every turn would 400.
  // Replacing a hard-coded list with a wrong one is the same defect pointed the
  // other way, so this catalogue enumerates nothing and says so.
  it("does not synthesise a ChatGPT catalogue out of the openai one, and does not ask", async () => {
    refreshInBackground("codex");
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Not from openai — and not from `codex` either. The CLI's answer is known
    // and written down; forking a whole openclaw process on a Jetson at every
    // boot, and again once per backoff window, to be told
    // `Unknown provider filter "codex"` buys nothing.
    expect(spawnedProviders()).not.toContain("codex");
    expect(spawnedProviders()).not.toContain("openai");
    expect(fs.existsSync(cacheFile("codex"))).toBe(false);
  });

  // The sibling of the backoff bypass: `?refresh=1` now means "the provider set
  // changed" and clears the wait for a provider a connect could make listable.
  // Nothing a box can do makes `codex` listable on this core, so it must not be
  // cleared there — otherwise every forced read reprints its one log line, and
  // the picker sends one per provider-set signal.
  it("stays unasked even when the provider set changes", async () => {
    mockSpawn.mockClear();
    await get("codex", "&refresh=1");
    await settle();

    expect(spawnedProviders()).not.toContain("codex");
    expect(spawnedProviders()).not.toContain("openai");
    expect(fs.existsSync(cacheFile("codex"))).toBe(false);
  });

  it("serves the curated ChatGPT list marked fallback, in its curated order", async () => {
    const body = await get("codex");

    expect(body.source).toBeUndefined();
    // Curated newest-first, and it stays that way: sorting by context window
    // put GPT-5.4 at the top, because only the Anthropic ids carry a real
    // window in the cold-start table.
    expect((body.models as Array<{ id: string }>).map((m) => m.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    expect(body.defaultModelId).toBe("gpt-5.5");
  });

  // The API-key surface is NOT the ChatGPT one and must not borrow its
  // narrowing — nor the generation allowlist that used to sit on it. On a
  // stock 2026.8.1 host `openclaw models list --provider openai --all --json`
  // answers with exactly one row, `openai/gpt-5.6-sol`, tagged default: the
  // old /^gpt-5\.[45](-pro|-mini)?$/ matched none of it, so the box's whole
  // openai catalogue was filtered away and the picker fell back to five
  // hand-written ids.
  it("publishes the newest generation the box lists, and skips the image SKUs", async () => {
    mockList({
      count: 4,
      models: [
        { key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 400_000, available: true, tags: ["default"] },
        { key: "openai/gpt-5.5-pro", name: "GPT-5.5 Pro", contextWindow: 400_000, available: true, tags: [] },
        { key: "openai/gpt-5.4", name: "GPT-5.4", contextWindow: 1_000_000, available: true, tags: [] },
        // Listed by the same command, unusable by a chat picker, and the
        // harness offers no capability filter to ask it apart. All four id
        // SHAPES are taken from the live OpenRouter catalogue (2026-09-02),
        // which is the one catalogue that states the modality next to the name:
        // a prefix family, the `-image` suffix family that the earlier pattern
        // missed entirely, and google's image/video engines.
        { key: "openai/gpt-image-1-mini", name: "GPT Image 1 Mini", contextWindow: 0, available: true, tags: [] },
        { key: "openai/gpt-5-image", name: "GPT-5 Image", contextWindow: 0, available: true, tags: [] },
        { key: "openai/gpt-5.4-image-2", name: "GPT-5.4 Image 2", contextWindow: 0, available: true, tags: [] },
        { key: "google/imagen-4", name: "Imagen 4", contextWindow: 0, available: true, tags: [] },
      ],
    });

    refreshInBackground("openai");
    const ids = await publishedIds("openai", 3);
    expect(ids.sort()).toEqual(["gpt-5.4", "gpt-5.5-pro", "gpt-5.6-sol"]);
  });

  // Finding 3 of the review pass: the harness answers "which of these is the
  // default" and the route threw it away for a hand-written map. That is the
  // same defect as the hard-coded list, pointed at the default.
  it("takes the default the box tags, not the one the map remembers", async () => {
    mockList({
      count: 2,
      models: [
        { key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 400_000, available: true, tags: ["default"] },
        // The id DEFAULT_MODEL_BY_PROVIDER carries for openai. It is in the
        // catalogue, so the old lookup found it and stopped.
        { key: "openai/gpt-5.4", name: "GPT-5.4", contextWindow: 1_000_000, available: true, tags: [] },
      ],
    });

    refreshInBackground("openai");
    await publishedIds("openai", 2);
    const body = await get("openai");
    expect(body.defaultModelId).toBe("gpt-5.6-sol");
  });

  it("drops a row the harness itself reports as unavailable, and keeps an undetermined one", async () => {
    // `available` is tristate — it mirrors the CLI's Auth column (`ok` /
    // `unknown` / `unavailable`). `null` is what an unconfigured host answers
    // for every row, and hiding those would empty the picker during setup.
    // Runs on openai because the previous test published it successfully,
    // which clears the failed-refresh backoff; google is still serving one.
    mockList({
      count: 3,
      models: [
        { key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 400_000, available: true, tags: [] },
        { key: "openai/gpt-5.5", name: "GPT-5.5", contextWindow: 400_000, available: null, tags: [] },
        { key: "openai/gpt-4.1", name: "GPT-4.1", contextWindow: 128_000, available: false, tags: [] },
      ],
    });

    refreshInBackground("openai");
    const ids = await publishedIds("openai", 2);
    expect(ids.sort()).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
  });
});

describe("catalog — a provider that cannot answer is not asked on every request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
  });

  // `openclaw models list` costs ~3 minutes and ~2 cores on a Jetson. The rule
  // "a payload no device produced is a reason to ask again" would, on a
  // provider that can NEVER enumerate, turn every picker open into another
  // fork — and the client retries twelve times with `refresh=1`. The
  // single-flight set only collapses the concurrent ones.
  it("backs off after an enumeration that did not answer", async () => {
    mockList({
      ok: false,
      error: { type: "cli_error", message: "the anthropic plugin is disabled" },
    });

    // anthropic, because the backoff map is module state: google and codex are
    // already serving one from the tests above, while anthropic's last refresh
    // in this file succeeded and therefore cleared it. This describe is last,
    // so leaving anthropic backed off costs nothing.
    refreshInBackground("anthropic");
    await vi.waitFor(() => expect(spawnedProviders()).toContain("anthropic"), { timeout: 2000 });
    await settle();

    mockSpawn.mockClear();
    refreshInBackground("anthropic");
    refreshInBackground("anthropic");
    await settle();
    expect(spawnedProviders()).not.toContain("anthropic");
  });

  // A wait that does not GROW is not a backoff. Deriving the last wait from the
  // stored DEADLINE cannot grow: an attempt only gets past the guard once that
  // deadline has passed, so `deadline - now` is negative by the time the next
  // failure records it, and the doubling collapses to the two-minute floor
  // forever — the flat 2-minute fork loop this brake exists to bound.
  //
  // Only `Date` is faked. The route's own waits are real (the mocked child
  // settles on a microtask), and faking the timer queue as well would stop the
  // module-level boot warmup that the rest of this file runs against.
  it("doubles the wait after each attempt that does not answer", async () => {
    mockList({
      ok: false,
      error: { type: "cli_error", message: "the anthropic plugin is disabled" },
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // anthropic is two minutes into a backoff from the test above, which is
      // where the sequence starts: the wait after THIS failure must be four.
      const t0 = Date.now();
      vi.setSystemTime(t0 + 2 * 60_000 + 1_000);

      mockSpawn.mockClear();
      refreshInBackground("anthropic");
      await settle();
      expect(spawnedProviders()).toContain("anthropic");

      // Two more minutes is no longer enough.
      vi.setSystemTime(Date.now() + 2 * 60_000 + 1_000);
      mockSpawn.mockClear();
      refreshInBackground("anthropic");
      await settle();
      expect(spawnedProviders()).not.toContain("anthropic");

      // Four is.
      vi.setSystemTime(Date.now() + 2 * 60_000 + 1_000);
      mockSpawn.mockClear();
      refreshInBackground("anthropic");
      await settle();
      expect(spawnedProviders()).toContain("anthropic");
    } finally {
      vi.useRealTimers();
    }
  });

  // The brake rate-limits a client ASKING AGAIN. It must not survive the box
  // CHANGING — a connect enables the plugin and writes the credential, which is
  // the moment a provider that could not enumerate starts being able to. Held
  // there, this fix recreates the very symptom it exists to remove: no fork, so
  // no `warming`, so the picker stops polling and keeps the curated list.
  it("lets a provider-set change through the backoff, and says an answer is coming", async () => {
    // google is under a backoff from the empty-enumeration test above, and has
    // no cached payload of its own — the state a box is in when the customer
    // connects the provider whose pre-auth enumeration came back empty.
    mockList({
      count: 2,
      models: [
        { key: "google/gemini-3-pro", name: "Gemini 3 Pro", contextWindow: 1_000_000, available: true, tags: ["default"] },
        { key: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_000_000, available: true, tags: [] },
      ],
    });

    mockSpawn.mockClear();
    refreshInBackground("google");
    await settle();
    // A plain ask is still held. That part of the brake is the point of it.
    expect(spawnedProviders()).not.toContain("google");

    const body = await get("google", "&refresh=1");
    // Two things, and the second is the one that was missing: the fork starts,
    // AND the response tells the picker an answer is on its way, so something
    // is left asking for it.
    await vi.waitFor(() => expect(spawnedProviders()).toContain("google"), { timeout: 2000 });
    expect(body.warming).toBe(true);
    expect(body.source).toBeUndefined();

    // And the live rows land, replacing the curated ones.
    const ids = await publishedIds("google", 2);
    expect(ids.sort()).toEqual(["gemini-2.5-flash", "gemini-3-pro"]);
  });
});

describe("catalog — OpenRouter publishes the capability, so the guess is not used", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
  });

  /**
   * Rows and modalities as `https://openrouter.ai/api/v1/models` reported them
   * on 2026-09-02 (423 rows; every one carries `output_modalities` — 408
   * `["text"]`, 11 `["image","text"]`, 4 `["audio","text"]`).
   */
  const OPENROUTER_LIVE = {
    data: [
      { id: "anthropic/claude-opus-5", name: "Claude Opus 5", context_length: 1_000_000,
        architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      // Image SKUs. NONE of these matched the original name pattern — the
      // measurement that sent this PR back.
      { id: "google/gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", context_length: 32_768,
        architecture: { input_modalities: ["text", "image"], output_modalities: ["image", "text"] } },
      { id: "openai/gpt-5-image", name: "GPT-5 Image", context_length: 400_000,
        architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] } },
      // Audio out. It is not a text-output chat model, whatever its name reads
      // like: `openai/gpt-audio` reports `["audio","text"]` out.
      { id: "openai/gpt-audio", name: "GPT Audio", context_length: 128_000,
        architecture: { input_modalities: ["text", "audio"], output_modalities: ["audio", "text"] } },
      // The meta ROUTER. Its modalities are the union over everything it can
      // route to, not a claim about one model, so the modality test does not
      // apply to it and it stays in the picker.
      { id: "openrouter/auto", name: "Auto Router", context_length: 2_000_000,
        architecture: { input_modalities: ["text", "image"], output_modalities: ["image", "text"] } },
      // A text-output model whose NAME matches the fallback pattern. The field
      // is the answer for this catalogue, so the guess never runs on it.
      { id: "some-lab/chat-image-2", name: "Chat Image 2", context_length: 128_000,
        architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
    ],
  };

  it("drops what the field calls non-text, keeps the router, and keeps a text model the name rule would hide", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => OPENROUTER_LIVE,
    })));

    refreshInBackground("openrouter");
    const ids = await publishedIds("openrouter", 3);

    expect(ids.sort()).toEqual([
      "anthropic/claude-opus-5",
      "openrouter/auto",
      "some-lab/chat-image-2",
    ]);
    expect(ids).not.toContain("google/gemini-2.5-flash-image");
    expect(ids).not.toContain("openai/gpt-5-image");
    expect(ids).not.toContain("openai/gpt-audio");
  });
});
