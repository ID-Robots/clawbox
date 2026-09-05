import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

// A LIVE cached payload whose every row the CURRENT rules filter out.
//
// Freshness used to be judged on the RAW cache — age, `stale`, the recorded
// failure, `source` — all of which say "fine" about a file this build's own
// sanitiser then empties. So the route served `models: []`, started no
// enumeration and set no `warming`, and the client rendered the curated list
// with nothing left asking. `fetchProviderCatalog` forwards a `warming` the
// route could never set in that state.
//
// Its own file because it needs a module whose `memCache` is empty for the
// provider under test: the disk cache is only read when nothing is in memory,
// and every provider picks up a memCache entry after the first publish.
//
// Not reachable from a payload this build wrote — the transform and the
// sanitiser share `isOfferableModelId`, so a live file is one these rules just
// passed. It becomes reachable the first time a filter is tightened, which is
// what this branch did to the previous generation of caches.

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

const DATA_DIR = "/tmp/clawbox-catalog-sanitised-empty-test";
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-sanitised-empty-test" }));

import { GET } from "@/app/setup-api/ai-models/catalog/route";

const mockSpawn = vi.mocked(childProcess.spawn);

function fakeChild(json: unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
    child.emit("close", 0);
  });
  return child;
}

/** The providers each `openclaw models list` spawn was for. */
function spawnedProviders(): string[] {
  return mockSpawn.mock.calls.map((call) => {
    const args = call[1] as string[];
    return args[args.indexOf("--provider") + 1];
  });
}

beforeEach(() => {
  // The boot warmup would otherwise make a real request to openrouter.ai. Left
  // installed for the file's lifetime on purpose — see the note in
  // catalog-live-vs-fallback.test.ts.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no network in this suite");
  }));
  vi.clearAllMocks();
  fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
  mockSpawn.mockImplementation(
    () => fakeChild({
      count: 1,
      models: [
        { key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 400_000, available: true, tags: ["default"] },
      ],
    }) as unknown as ReturnType<typeof childProcess.spawn>,
  );
});

/**
 * The GET under test deliberately returns BEFORE its enumeration finishes —
 * that is what `warming: true` means — and the fork it leaves running logs
 * `[catalog] refreshed …` when it publishes. Left to run past the end of the
 * test, that line reaches vitest's reporter while the worker is being torn
 * down and the run dies with
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
 * — every test passing and the job red (CI, 2026-09-04). It only bites under a
 * loaded worker, so it is invisible when this file is run on its own.
 *
 * So the test waits for the fork's own log line before it ends, and then lets
 * the tail of the chain run: after the publish, `.finally` awaits the surface
 * fork, releases the single-flight guard and re-enters `refreshInBackground`
 * with `serveCurrent`, which returns silently because the published generation
 * is now the current one.
 */
async function settleBackgroundRefresh(logs: string[]): Promise<void> {
  // Well past vitest's default 1 s: the fork is a mocked `spawn` resolving on
  // a microtask, so this budget is never spent — but on a loaded four-worker
  // runner a 1 s ceiling would turn the teardown crash this replaced into an
  // intermittent RED test, which is the same flake wearing different clothes.
  await vi.waitFor(() => {
    expect(logs.some((line) => line.startsWith("[catalog] refreshed openai"))).toBe(true);
  }, { timeout: 5_000 });
  // Two turns of the macrotask queue for the awaits after that log.
  for (let i = 0; i < 2; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("catalog — a cache the sanitiser empties is not a fresh answer", () => {
  it("re-enumerates, says stale, and says an answer is coming", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    fs.mkdirSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, "catalog-cache", "openai.json"),
      JSON.stringify({
        provider: "openai",
        // Image SKUs: a real enumeration once carried them, and a later build
        // learned to exclude them. Every row here fails today's rules.
        models: [
          { id: "gpt-image-1", label: "GPT Image 1", contextWindow: 0 },
          { id: "gpt-5.4-image-2", label: "GPT-5.4 Image 2", contextWindow: 0 },
        ],
        defaultModelId: "gpt-image-1",
        allowCustom: true,
        // Fresh, and stamped by a device. Nothing about the raw file is stale.
        fetchedAt: Date.now(),
        source: "live",
      }),
      "utf8",
    );

    const res = await GET(new NextRequest("http://clawbox.local/setup-api/ai-models/catalog?provider=openai"));
    const body = (await res.json()) as Record<string, unknown>;

    // What it serves is nothing — so it must not also claim to be current.
    expect(body.models).toEqual([]);
    expect(body.stale).toBe(true);
    // A fork really is out there, so the picker has a reason to come back.
    expect(body.warming).toBe(true);
    expect(spawnedProviders()).toContain("openai");

    await settleBackgroundRefresh(logs);
    // Above vitest's default 5 s test budget, which the waitFor inside
    // `settleBackgroundRefresh` would otherwise share: a log line that lands
    // late on a loaded runner would time the TEST out first, and the
    // descriptive "expected false to be true" the waitFor exists to give is
    // exactly what would be lost.
  }, 15_000);
});
