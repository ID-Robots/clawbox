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
    // It is served — a blank picker helps nobody — but it says what it is.
    expect(first.fallback).toBe(true);
    expect((first.models as unknown[]).length).toBe(3);

    // And it is retried rather than trusted for the next six hours.
    const live = await publishedIds("anthropic", 11);
    expect(live).toContain("claude-fable-5");
    expect(live).toContain("claude-opus-4-8");

    const second = await get("anthropic");
    expect(second.fallback).toBeFalsy();
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
  it("does not synthesise a ChatGPT catalogue out of the openai one", async () => {
    mockList({
      ok: false,
      error: {
        type: "cli_error",
        message: 'Unknown provider filter "codex" for this installation.',
      },
    });

    refreshInBackground("codex");
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const providerArgs = mockSpawn.mock.calls
      .map((call) => (call[1] as string[]))
      .map((args) => args[args.indexOf("--provider") + 1]);
    expect(providerArgs).not.toContain("openai");
    expect(fs.existsSync(cacheFile("codex"))).toBe(false);
  });

  it("serves the curated ChatGPT list marked fallback, in its curated order", async () => {
    const body = await get("codex");

    expect(body.fallback).toBe(true);
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
        // harness offers no capability filter to ask it apart.
        { key: "openai/gpt-image-1-mini", name: "GPT Image 1 Mini", contextWindow: 0, available: true, tags: [] },
      ],
    });

    refreshInBackground("openai");
    const ids = await publishedIds("openai", 3);
    expect(ids.sort()).toEqual(["gpt-5.4", "gpt-5.5-pro", "gpt-5.6-sol"]);
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
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    mockSpawn.mockClear();
    refreshInBackground("anthropic");
    refreshInBackground("anthropic");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
