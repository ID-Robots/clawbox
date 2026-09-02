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
    // The connect, counted by the write that made it — not by the client.
    refreshInBackground("openai", { providerChanged: true });
    const body = await get("openai");

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


describe("catalog — the change generation, not a one-shot flag", () => {
  // Scenario (a). `|| force` made exactly ONE response say `warming` — the
  // single `?refresh=1` the hook sends per provider-set signal. Its next poll
  // is `load(false)` two seconds later, and got `warming: false` while the
  // enumeration still had ~3 minutes to run, so a picker open across a connect
  // settled on the pre-change rows. And the superseded PRE-credential fork was
  // still published with `source: "live"` and a fresh `fetchedAt` one line
  // before its replacement was scheduled, so every client arriving in that
  // window was handed it as final: the same false success, shortened rather
  // than removed.
  it("keeps saying an answer is coming on every poll, and never publishes the superseded fork", async () => {
    const preKey = heldChild(PRE_KEY);
    const postKey = heldChild(LINKED);
    let openaiSpawns = 0;
    mockSpawn.mockImplementation((_bin, args) => {
      const argv = args as string[];
      const target = argv[argv.indexOf("--provider") + 1];
      if (target !== "openai") {
        return fakeChild({ count: 0, models: [] }) as unknown as ReturnType<typeof childProcess.spawn>;
      }
      openaiSpawns += 1;
      const child = openaiSpawns === 1 ? preKey.child : postKey.child;
      return child as unknown as ReturnType<typeof childProcess.spawn>;
    });

    // The warmup fork, started when the customer opened the AI models step.
    refreshInBackground("openai");
    await settle();
    expect(openaiSpawns).toBe(1);

    // The key is saved while it is still out.
    refreshInBackground("openai", { providerChanged: true });
    await settle();
    expect(openaiSpawns).toBe(1);

    // The pre-credential fork answers. Its rows describe a box that no longer
    // exists, so nothing is published — not to disk, and above all not stamped
    // live. The replacement starts instead.
    preKey.release();
    await vi.waitFor(() => expect(openaiSpawns).toBe(2), { timeout: 4000, interval: 25 });
    expect(fs.existsSync(cacheFile("openai"))).toBe(false);

    // Now the window the hook lives in. EVERY poll — none of them carrying
    // `refresh=1`, which the hook sends once per signal — has to say an answer
    // is coming, or the picker stops asking and keeps what it has.
    for (let poll = 0; poll < 3; poll += 1) {
      const body = await get("openai");
      expect(body.warming).toBe(true);
      // And the pre-credential list is never what it is holding. A payload from
      // an EARLIER generation may still be served — it is a device's answer,
      // which is why `warming` above is the thing that has to stay true — but
      // the superseded fork's own rows never became one: nothing was written.
      expect((body.models as Array<{ id: string }>).map((m) => m.id)).not.toEqual(["gpt-5.6-sol"]);
      expect(fs.existsSync(cacheFile("openai"))).toBe(false);
    }

    // The post-credential answer lands, and only then does the asking stop.
    postKey.release();
    await vi.waitFor(() => {
      expect(readCache("openai").models.map((m) => m.id).sort())
        .toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]);
    }, { timeout: 4000, interval: 25 });
    expect(readCache("openai").source).toBe("live");

    const settled = await get("openai");
    expect(settled.warming).toBeUndefined();
    expect(settled.source).toBe("live");
  });

  // Scenario (b). `configure` step 8c and the client's `?refresh=1` are the
  // SAME provider-set change reaching the route twice, ordered by awaits rather
  // than racing. Treating the second as news cost every connect a duplicate
  // ~3-minute `openclaw models list` — ~2 cores of a Jetson, at the wizard's
  // most latency-sensitive moment, for a question the fork already out is
  // answering post-credential.
  it("costs one enumeration when the client echoes a change the write already counted", async () => {
    const held = heldChild({
      count: 2,
      models: [
        { key: "google/gemini-3-pro", name: "Gemini 3 Pro", contextWindow: 1_000_000, available: true, tags: ["default"] },
        { key: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_000_000, available: true, tags: [] },
      ],
    });
    let googleSpawns = 0;
    mockSpawn.mockImplementation((_bin, args) => {
      const argv = args as string[];
      const target = argv[argv.indexOf("--provider") + 1];
      if (target !== "google") {
        return fakeChild({ count: 0, models: [] }) as unknown as ReturnType<typeof childProcess.spawn>;
      }
      googleSpawns += 1;
      return held.child as unknown as ReturnType<typeof childProcess.spawn>;
    });

    // Step 8c, one statement after the credential write and the plugin switch.
    refreshInBackground("google", { providerChanged: true });
    await settle();
    expect(googleSpawns).toBe(1);

    // The same change arriving again as the client's `?refresh=1`, which is now
    // a NUDGE: "does the current generation have an answer?". A fork for that
    // generation is out, so there is nothing to start and nothing to count.
    // This is what removes the duplicate ~3-minute enumeration per connect —
    // and, unlike the predicate it replaces, it cannot swallow a real second
    // change, because a real one comes from a write and says so.
    refreshInBackground("google", { serveCurrent: true });
    await settle();
    expect(googleSpawns).toBe(1);

    held.release();
    await vi.waitFor(() => {
      expect(readCache("google").models.map((m) => m.id).sort())
        .toEqual(["gemini-2.5-flash", "gemini-3-pro"]);
    }, { timeout: 4000, interval: 25 });

    // No replacement scheduled: nothing was superseded.
    await settle();
    expect(googleSpawns).toBe(1);
  });

  // The predicate this replaces read the SHAPE of the fork in flight —
  // change-started, current generation — rather than the identity of the
  // signal, so it could not tell `configure`'s echo from a second, genuinely
  // different change 30 seconds later. Both landed on the same branch, and the
  // real one was dropped: no bump, no re-entry, and the PRE-change fork then
  // published as the CURRENT generation — live, unstale, no `warming`, backoff
  // cleared — so nothing re-enumerated for six hours. Two clicks reach it: a
  // mistyped key corrected, or a provider switched off and back on.
  it("answers a second, different change that lands inside the first enumeration", async () => {
    const first = heldChild(PRE_KEY);
    const second = heldChild(LINKED);
    let spawns = 0;
    mockSpawn.mockImplementation((_bin, args) => {
      const argv = args as string[];
      const target = argv[argv.indexOf("--provider") + 1];
      if (target !== "openai") {
        return fakeChild({ count: 0, models: [] }) as unknown as ReturnType<typeof childProcess.spawn>;
      }
      spawns += 1;
      const child = spawns === 1 ? first.child : second.child;
      return child as unknown as ReturnType<typeof childProcess.spawn>;
    });

    // Key A saved. Generation 1, fork F1.
    refreshInBackground("openai", { providerChanged: true });
    await settle();
    expect(spawns).toBe(1);

    // The client's echo of that same change. Correctly nothing: it is a nudge,
    // and the generation it asks about already has a fork.
    refreshInBackground("openai", { serveCurrent: true });
    await settle();
    expect(spawns).toBe(1);

    // ~30s later the owner does a SECOND thing to this provider — corrects the
    // key and saves again, or flips the Settings switch off and back on. A
    // different write, so a different generation.
    refreshInBackground("openai", { providerChanged: true });
    await settle();
    // Still collapsed while F1 runs; single-flight is right.
    expect(spawns).toBe(1);

    // F1 answers for the box as it was two changes ago, so it is discarded and
    // the current generation is enumerated instead.
    first.release();
    await vi.waitFor(() => expect(spawns).toBe(2), { timeout: 4000, interval: 25 });
    expect(fs.existsSync(cacheFile("openai"))).toBe(false);

    second.release();
    await vi.waitFor(() => {
      expect(readCache("openai").models.map((m) => m.id).sort())
        .toEqual(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol"]);
    }, { timeout: 4000, interval: 25 });
    expect(spawns).toBe(2);

    // And once the current generation is answered, the asking stops.
    const settled = await get("openai");
    expect(settled.warming).toBeUndefined();
    expect(settled.source).toBe("live");
  });
});
