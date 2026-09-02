import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import * as childProcess from "child_process";

// The subscription STAMP has to survive a restart. Enumerating a catalogue is
// a multi-minute `openclaw models list` on a Jetson, so a memory-only cache
// would leave the Anthropic picker unstamped for the first minutes after every
// reboot — and an unstamped picker is the state this whole mechanism exists to
// replace.
//
// This used to be a test about caching a SECOND catalogue (`claude-cli`).
// Since PR #532 a Claude subscription routes natively and there is no second
// catalogue: the surface is the anthropic list itself. The property under test
// is unchanged and so is the customer-visible failure it prevents — only the
// list that carries it moved.
//
// Its own file because the route's `memCache` is module-level: a fresh module
// is the only way to observe the cold path and the warm path in one test.

const DATA_DIR = "/tmp/clawbox-catalog-surface-cache-test";

vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-surface-cache-test" }));

import { refreshInBackground } from "@/app/setup-api/ai-models/catalog/route";

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
  });
  return child;
}

const ANTHROPIC_LIST = {
  count: 1,
  models: [
    { key: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000 },
  ],
};

/** The `--provider <id>` a recorded `openclaw models list` spawn was given. */
function providerOf(call: unknown[]): string {
  const args = call[1] as string[];
  return args[args.indexOf("--provider") + 1];
}

const cacheFile = (provider: string) => path.join(DATA_DIR, "catalog-cache", `${provider}.json`);

describe("catalog refresh — the subscription surface is cached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSpawn.mockImplementation((() => fakeChild(ANTHROPIC_LIST)) as any);
  });

  it("enumerates it once, then serves it from cache on the next refresh", async () => {
    refreshInBackground("anthropic");
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));

    // Persisted WITH the stamp, so it survives the restart a process-local
    // cache would not. The payload is published unstamped first (so the picker
    // stops serving `warming` as early as possible), then republished — so
    // wait for the content, not merely for the file.
    await vi.waitFor(() => {
      const cached = JSON.parse(fs.readFileSync(cacheFile("anthropic"), "utf8"));
      const byId = Object.fromEntries(
        (cached.models as Array<{ id: string; availableOnSubscription?: boolean }>)
          .map((m) => [m.id, m.availableOnSubscription]),
      );
      expect(byId["claude-sonnet-4-6"]).toBe(true);
      // And nothing else. The curated ANTHROPIC_MODELS used to be appended to
      // a thin enumeration like this one and persisted with it, which made a
      // hand-maintained list indistinguishable from a device answer for the
      // next six hours (M-05).
      expect(Object.keys(byId)).toEqual(["claude-sonnet-4-6"]);
    });

    // Ask again. `refreshing` single-flights per provider and clears a tick
    // after the last publish, so poll the request rather than assuming the
    // first refresh has already let go — `refreshInBackground` spawns
    // synchronously when it does accept, so one accepted call is one spawn.
    mockSpawn.mockClear();
    await vi.waitFor(() => {
      if (mockSpawn.mock.calls.length === 0) refreshInBackground("anthropic");
      expect(mockSpawn).toHaveBeenCalled();
    }, { timeout: 5000, interval: 25 });
    // A beat for a surface spawn to show up if the cache were being ignored.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mockSpawn.mock.calls.map(providerOf)).toEqual(["anthropic"]);
  });
});
