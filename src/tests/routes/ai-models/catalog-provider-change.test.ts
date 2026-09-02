import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

// A PROVIDER-SET CHANGE — a key saved, a plugin switched on — is not a client
// polling for an answer, and the route has to tell them apart in two places.
// This file pins both, in its own module so neither depends on what an earlier
// test left in `memCache`, `refreshing` or the backoff map.
//
// The timing that makes finding 1 the common case rather than a race:
// `bootWarmup` starts on the FIRST picker GET, not at boot, and staggers the
// providers 5s apart at ~3 minutes each on a Jetson. A key saved a minute after
// the AI-models step opens therefore lands inside its provider's window.

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

const DATA_DIR = "/tmp/clawbox-catalog-provider-change-test";
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-provider-change-test" }));

import { GET, refreshInBackground } from "@/app/setup-api/ai-models/catalog/route";

const mockSpawn = vi.mocked(childProcess.spawn);

function newChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function fakeChild(json: unknown) {
  const child = newChild();
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
    child.emit("close", 0);
  });
  return child;
}

/**
 * A child that has been started but has not answered yet — an `openclaw models
 * list` fork mid-flight, which on a Jetson is a ~3-minute state, not an instant.
 */
function heldChild(json: unknown) {
  const child = newChild();
  return {
    child,
    release() {
      child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
      child.emit("close", 0);
    },
  };
}

/** `openclaw models list --provider openai` on a stock host: one row. */
const PRE_KEY = {
  count: 1,
  models: [
    { key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 400_000, available: true, tags: ["default"] },
  ],
};

/** The same command once the key is saved and the plugin is on. */
const LINKED = {
  count: 3,
  models: [
    { key: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 400_000, available: true, tags: ["default"] },
    { key: "openai/gpt-5.5", name: "GPT-5.5", contextWindow: 400_000, available: true, tags: [] },
    { key: "openai/gpt-5.4", name: "GPT-5.4", contextWindow: 1_000_000, available: true, tags: [] },
  ],
};

function cacheFile(provider: string): string {
  return path.join(DATA_DIR, "catalog-cache", `${provider}.json`);
}

function readCache(provider: string): { models: Array<{ id: string }>; source?: string } {
  return JSON.parse(fs.readFileSync(cacheFile(provider), "utf8"));
}

async function get(provider: string, params = ""): Promise<Record<string, unknown>> {
  const res = await GET(new NextRequest(
    `http://clawbox.local/setup-api/ai-models/catalog?provider=${provider}${params}`,
  ));
  return (await res.json()) as Record<string, unknown>;
}

/** Let a detached refresh get as far as it is going to get. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
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
});

describe("catalog — a connect on a provider that already has a live catalogue", () => {
  // `warming` used to be suppressed whenever the cached payload was live. That
  // clause is what keeps a routine 6h refresh from making every mounted picker
  // poll — but it also hid the one case that matters: the box just changed and
  // an enumeration IS in flight. `useProviderCatalog` polls on `warming` alone,
  // so it read once, settled, and the post-credential list landed minutes later
  // with nobody asking. The customer saw the old list until a remount.
  it("says an answer is coming, rather than serving the pre-connect rows in silence", async () => {
    mockSpawn.mockImplementation(
      () => fakeChild(PRE_KEY) as unknown as ReturnType<typeof childProcess.spawn>,
    );

    // A clean, live, one-row catalogue — published, no fork left out.
    refreshInBackground("openai");
    await vi.waitFor(() => expect(fs.existsSync(cacheFile("openai"))).toBe(true), { timeout: 4000 });
    await settle();

    mockSpawn.mockImplementation(
      () => fakeChild(LINKED) as unknown as ReturnType<typeof childProcess.spawn>,
    );
    const body = await get("openai", "&refresh=1");

    // It serves the rows it has — they are a device's — and still says a better
    // answer is on its way, which is the only thing that keeps the picker asking.
    expect(body.source).toBe("live");
    expect(body.warming).toBe(true);

    await vi.waitFor(() => {
      expect(readCache("openai").models.map((m) => m.id).sort())
        .toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]);
    }, { timeout: 4000, interval: 25 });
  });
});

describe("catalog — a connect while an enumeration is already in flight", () => {
  // The single-flight guard is right to collapse two enumerations that ask the
  // same question. A connect changes the question: the fork already running was
  // started before the credential existed. Dropped, it does worse than lose a
  // refresh — the pre-credential answer is published with `source: "live"` and
  // a fresh `fetchedAt`, so `force || isStale || !isLivePayload` is false
  // against it for six hours and the marker this route introduced ends up
  // vouching for the very thing it exists to catch. One openai row on a stock
  // host, on a box that lists three.
  it("re-enumerates once the in-flight fork settles, and the post-credential list is what stands", async () => {
    const held = heldChild(PRE_KEY);
    let openaiSpawns = 0;
    mockSpawn.mockImplementation((_bin, args) => {
      const argv = args as string[];
      const target = argv[argv.indexOf("--provider") + 1];
      if (target !== "openai") {
        return fakeChild({ count: 0, models: [] }) as unknown as ReturnType<typeof childProcess.spawn>;
      }
      openaiSpawns += 1;
      const child = openaiSpawns === 1 ? held.child : fakeChild(LINKED);
      return child as unknown as ReturnType<typeof childProcess.spawn>;
    });

    // The warmup fork, started when the customer opened the AI models step.
    refreshInBackground("openai");
    await settle();
    expect(openaiSpawns).toBe(1);

    // ~45s later the key is saved. Step 8c fires this one statement after the
    // plugin is switched on.
    refreshInBackground("openai", { providerChanged: true });
    await settle();
    // Still ONE fork. Collapsing is correct; losing the change is not.
    expect(openaiSpawns).toBe(1);

    // The pre-key answer lands and publishes its single row...
    held.release();

    // ...and the change is then served against the box as it now is.
    await vi.waitFor(() => {
      expect(readCache("openai").models.map((m) => m.id).sort())
        .toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]);
    }, { timeout: 4000, interval: 25 });
    expect(openaiSpawns).toBe(2);
    expect(readCache("openai").source).toBe("live");
  });
});
