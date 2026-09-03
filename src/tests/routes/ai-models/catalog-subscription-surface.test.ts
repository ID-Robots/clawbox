import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fs from "fs";
import path from "path";
import { isModelUsableOnSubscription } from "@/lib/provider-models";

// HOW MANY catalogues this route enumerates for a provider, and which.
//
// It used to ask TWO for anthropic: the plugin's own list, plus the plugin's
// second `claude-cli` list, which was the surface a Claude SUBSCRIPTION could
// route while the transport was a `models.providers.anthropic` openai-compat
// override. That was right then. PR #532 replaced the override with the native
// anthropic plugin (`POST /v1/messages`), which serves the plugin's own
// catalogue on a subscription credential — so the second enumeration now
// describes a transport the box no longer uses, and the models it omits
// (Fable, Mythos, Haiku) are models the box can in fact run.
//
// One catalogue, then — and every row on it stamped usable, including the
// three the owner reported greyed out.//
// Verified on the affected box (OpenClaw 2026.7.1-2, Claude subscription):
// claude-fable-5 and claude-haiku-4-5 both answer over
// POST https://api.anthropic.com/v1/messages with status=200 and a real
// completion, fallbackUsed=false. claude-mythos-5 reaches the same endpoint
// and comes back `not_found_error: model: claude-mythos-5` — an id the
// provider does not serve, NOT an auth or entitlement refusal, and not
// something an API key would fix. The old rule greyed it out for a reason
// ("requires API key") that was never true of it. Stamping it usable is the
// honest answer to the question this flag asks — whether the SUBSCRIPTION
// narrows the catalogue — and the 404 surfaces loudly at turn time.

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

const DATA_DIR = "/tmp/clawbox-catalog-surface-test";
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-surface-test" }));

import { refreshInBackground } from "@/app/setup-api/ai-models/catalog/route";

const mockSpawn = vi.mocked(childProcess.spawn);

/** Minimal stand-in for the openclaw child process the route drives. */
function fakeChild(json: unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  // The route parses on each stdout chunk, so one chunk is enough.
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(json), "utf8"));
  });
  return child;
}

/**
 * `openclaw models list --provider anthropic` as a 2026.7.1 device answers it,
 * trimmed: the plugin's own catalogue, Fable and Mythos included. Since #532
 * this is what a subscription credential routes on.
 */
const ANTHROPIC_LIST = {
  count: 3,
  models: [
    { key: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000 },
    { key: "anthropic/claude-mythos-5", name: "Claude Mythos 5", contextWindow: 1_000_000 },
    { key: "anthropic/claude-fable-5", name: "Claude Fable 5", contextWindow: 1_000_000 },
  ],
};

/**
 * Refresh anthropic and return the stamped payload the route publishes.
 *
 * The refresh is re-issued inside the poll rather than fired once: the route
 * single-flights per provider through a module-level `refreshing` set that
 * clears a tick after the last publish, so a call made while a previous test's
 * refresh is still settling is silently dropped.
 */
async function stampedCatalogue(): Promise<Record<string, boolean | undefined>> {
  const cacheFile = path.join(DATA_DIR, "catalog-cache", "anthropic.json");
  let byId: Record<string, boolean | undefined> = {};
  await vi.waitFor(() => {
    if (!fs.existsSync(cacheFile)) {
      refreshInBackground("anthropic");
      throw new Error("not published yet");
    }
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    byId = Object.fromEntries(
      (cached.models as Array<{ id: string; availableOnSubscription?: boolean }>)
        .map((m) => [m.id, m.availableOnSubscription]),
    );
    // Published unstamped first so the picker stops serving `warming` early —
    // wait for the stamped republish, not merely for the file.
    expect(byId["claude-sonnet-4-6"]).toBe(true);
  }, { timeout: 5000, interval: 25 });
  return byId;
}

/** The `--provider <id>` a recorded `openclaw models list` spawn was given. */
function providerOf(call: unknown[]): string {
  const args = call[1] as string[];
  return args[args.indexOf("--provider") + 1];
}

describe("catalog refresh — subscription surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The route persists every catalogue it enumerates, so a cache left by an
    // earlier run would (correctly) suppress the spawn these tests count.
    fs.rmSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true, force: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSpawn.mockImplementation((() => fakeChild(ANTHROPIC_LIST)) as any);
  });

  it("enumerates the Anthropic catalogue ONCE — it is the surface, natively routed", async () => {
    await stampedCatalogue();
    // A beat, so a second spawn has room to show up if one were still issued.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(mockSpawn.mock.calls.map(providerOf)).toEqual(["anthropic"]);
    // Nothing is written under the old surface id: a payload published there
    // would be an unmerged, unsanitized copy of a list nothing reads any more.
    expect(fs.existsSync(path.join(DATA_DIR, "catalog-cache", "claude-cli.json"))).toBe(false);
  });

  it.each(["claude-fable-5", "claude-mythos-5"])(
    "stamps %s usable — the models the owner saw greyed out",
    async (id) => {
      const byId = await stampedCatalogue();

      expect(byId[id]).toBe(true);
      expect(isModelUsableOnSubscription({ availableOnSubscription: byId[id] }, true)).toBe(true);
    },
  );

  it("publishes the rows the DEVICE enumerated, and no curated ones", async () => {
    const byId = await stampedCatalogue();

    // claude-haiku-4-5 is in ANTHROPIC_MODELS and not in the live list above.
    // It used to be appended here and stamped along with the rest; M-05
    // stopped that, because a payload that mixes the two is written to
    // catalog-cache and read back — by the picker and by the server-side
    // surface guard — as a device answer. A box whose plugin was disabled at
    // boot then showed three hard-coded Claude models all day.
    //
    // Every row this file publishes is stamped; the point here is WHICH rows
    // there are.
    expect(byId["claude-haiku-4-5"]).toBeUndefined();
    expect(Object.keys(byId).sort()).toEqual([
      "claude-fable-5",
      "claude-mythos-5",
      "claude-sonnet-4-6",
    ]);
  });

  it("does not go looking for a second surface for a provider that has none", async () => {
    await vi.waitFor(() => {
      if (mockSpawn.mock.calls.length === 0) refreshInBackground("google");
      expect(mockSpawn).toHaveBeenCalled();
    }, { timeout: 5000, interval: 25 });
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(mockSpawn.mock.calls.map(providerOf)).toEqual(["google"]);
  });
});
