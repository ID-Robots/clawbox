import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import * as childProcess from "child_process";

// The subscription surface has to be CACHED like every other catalogue this
// route enumerates. It is credential-independent, and each enumeration is
// another multi-minute `openclaw models list` on a Jetson — but the reason it
// rides the DISK cache rather than a process-local map is restarts: a
// memory-only cache would leave the Anthropic picker unmarked (every model
// pickable, i.e. the defect this stamp exists to fix) for the first minutes
// after every reboot.
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
const CLAUDE_CLI_LIST = {
  count: 1,
  models: [
    { key: "claude-cli/claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Claude CLI)", contextWindow: 200_000 },
  ],
};

function providerOf(call: unknown[]): string {
  const args = call[1] as string[];
  return args[args.indexOf("--provider") + 1];
}

const cacheFile = (provider: string) => path.join(DATA_DIR, "catalog-cache", `${provider}.json`);

describe("catalog refresh — the subscription surface is cached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
    mockSpawn.mockImplementation(((_bin: string, args: string[]) => {
      const provider = args[args.indexOf("--provider") + 1];
      return fakeChild(provider === "claude-cli" ? CLAUDE_CLI_LIST : ANTHROPIC_LIST);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  it("enumerates it once, then serves it from cache on the next refresh", async () => {
    refreshInBackground("anthropic");
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));

    // Persisted, so it survives the restart a process-local cache would not.
    await vi.waitFor(() => expect(fs.existsSync(cacheFile("claude-cli"))).toBe(true));
    // The main catalogue is published UNSTAMPED first (so the picker stops
    // serving `warming` without waiting on the surface), then republished with
    // the stamp — so wait for the content, not merely for the file.
    await vi.waitFor(() => {
      const cached = JSON.parse(fs.readFileSync(cacheFile("anthropic"), "utf8"));
      const byId = Object.fromEntries(
        (cached.models as Array<{ id: string; availableOnSubscription?: boolean }>)
          .map((m) => [m.id, m.availableOnSubscription]),
      );
      expect(byId["claude-sonnet-4-6"]).toBe(true);
      // ANTHROPIC_MODELS' curated entries get appended by
      // augmentWithStaticCatalog for the thin-enumeration case, and they are
      // stamped too — claude-haiku-4-5 is API-key-only, and leaving it
      // unstamped would make it pickable in exactly that case.
      expect(byId["claude-haiku-4-5"]).toBe(false);
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
