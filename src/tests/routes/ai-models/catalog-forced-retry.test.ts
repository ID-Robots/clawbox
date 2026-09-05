import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";

/**
 * TASK-669 (#587 follow-up M2) — the owner can force a retry after a transient
 * enumeration failure.
 *
 * A failed enumeration records a backoff that starts at two minutes and
 * doubles up to the full six-hour refresh interval. That is the right schedule
 * for the BOX's own retries; it was also the only schedule there was. A blip
 * during boot warmup — a network hiccup while the picker was never open —
 * left the owner looking at the curated fallback with `?refresh=1` doing
 * nothing at all, because the GET's stale branch calls `refreshInBackground`
 * with no options and the wait stops it before anything forks.
 *
 * Two things in the card turned out not to be the mechanism, and the fix is
 * shaped by both:
 *
 *   * `serveCurrent` being a no-op on a cold process (both generation counters
 *     default to 0) is true and is not what bites — with a failed warmup the
 *     GET takes the `isStale` branch and never reaches `serveCurrent`;
 *   * `?refresh=1` is not the owner's force button. `useProviderCatalog` sends
 *     it ONLY as its echo of a provider-set change, by which point
 *     `notifyProviderSetChanged` has already cleared the wait. The plain
 *     picker open — the request that finds the box in this state — sends no
 *     parameter at all.
 *
 * So the attempt belongs to the first REQUEST that finds no live payload
 * behind a recorded failure, and there is exactly one per provider per
 * process: the warming poll returns every two seconds and must not become a
 * fork loop.
 */

vi.mock("child_process", () => ({ spawn: vi.fn() }));

vi.mock("@/lib/openclaw-config", () => ({
  findOpenclawBin: () => "openclaw",
  openclawIsAbsent: () => false,
}));

const DATA_DIR = "/tmp/clawbox-catalog-forced-retry-test";
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/tmp/clawbox-catalog-forced-retry-test" }));

const mockSpawn = vi.mocked(childProcess.spawn);

/** A child that answers `json` on stdout and exits 0. */
function okChild(json: unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
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

/** A child that fails the way a network blip does: something on stderr, exit 1. */
function failingChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    child.stderr.emit("data", Buffer.from("getaddrinfo EAI_AGAIN api.anthropic.com", "utf8"));
    child.emit("close", 1);
  });
  return child;
}

const ANTHROPIC_LIVE = {
  count: 2,
  models: [
    { key: "anthropic/claude-opus-5", name: "Opus 5", contextWindow: 1_000_000, available: true, tags: [] },
    { key: "anthropic/claude-sonnet-5", name: "Sonnet 5", contextWindow: 1_000_000, available: true, tags: ["default"] },
  ],
};

function spawnsFor(provider: string): number {
  return mockSpawn.mock.calls.filter((call) => {
    const args = call[1] as string[];
    return args[args.indexOf("--provider") + 1] === provider;
  }).length;
}

/** Let a detached refresh get as far as it is going to get. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

describe("catalog: forcing a retry after a failed enumeration", () => {
  let GET: (req: NextRequest) => Promise<Response>;

  let notifyProviderSetChanged: (p: string | null | undefined) => void;

  beforeEach(async () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(DATA_DIR, "catalog-cache"), { recursive: true });
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/ai-models/catalog/route");
    GET = mod.GET;
    notifyProviderSetChanged = mod.notifyProviderSetChanged;
  });

  async function get(params = ""): Promise<Record<string, unknown>> {
    const res = await GET(new NextRequest(
      `http://clawbox.local/setup-api/ai-models/catalog?provider=anthropic${params}`,
    ));
    return (await res.json()) as Record<string, unknown>;
  }

  it("re-enumerates ONCE when a picker opens over a failed warmup", async () => {
    // The blip. Every enumeration in this window fails, which is what records
    // the wait.
    mockSpawn.mockImplementation(
      () => failingChild() as unknown as ReturnType<typeof childProcess.spawn>,
    );
    await get();
    await settle();
    const afterFailure = spawnsFor("anthropic");
    expect(afterFailure).toBeGreaterThan(0);

    // The network is back, and the owner opens the picker. No `?refresh=1`:
    // that is the client's echo of a change, and no change happened here.
    mockSpawn.mockImplementation(
      () => okChild(ANTHROPIC_LIVE) as unknown as ReturnType<typeof childProcess.spawn>,
    );
    await get();
    await settle();

    expect(spawnsFor("anthropic")).toBe(afterFailure + 1);
    // And the attempt actually landed: the picker's next read is a live list,
    // not the curated fallback it was sitting on.
    const cache = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "catalog-cache", "anthropic.json"), "utf8"),
    ) as { source?: string; models: { id: string }[] };
    expect(cache.source).toBe("live");
    expect(cache.models.map((m) => m.id)).toContain("claude-opus-5");
  });

  it("rations the attempt, so a polling picker cannot chain forks", async () => {
    // `useProviderCatalog` comes back every two seconds while the box is
    // warming, and a mounted picker must not turn a failing provider into a
    // fork loop. The gap is longer than an enumeration for exactly that
    // reason. It is a gap and not a once-ever count because this process runs
    // for weeks: a single allowance would be burnt by the first picker open
    // after the boot blip and the provider would be unreachable for good.
    mockSpawn.mockImplementation(
      () => failingChild() as unknown as ReturnType<typeof childProcess.spawn>,
    );
    await get();
    await settle();
    const afterWarmup = spawnsFor("anthropic");

    await get();
    await settle();
    const afterRetry = spawnsFor("anthropic");
    expect(afterRetry).toBe(afterWarmup + 1);

    await get();
    await get();
    await get();
    await settle();
    expect(spawnsFor("anthropic")).toBe(afterRetry);
  });

  it("counts a LIVE list from before a provider-set change as not current", async () => {
    // The change's own fork is the one that failed. `notifyProviderSetChanged`
    // cleared the wait and started it; when it fails the wait is back, and the
    // payload on file is seconds old and stamped live — so age and
    // `isLivePayload` both say "current" while the generation says otherwise.
    // Without the generation term the picker sits on the PRE-change list for
    // the whole window, which is the shape this card is about.
    mockSpawn.mockImplementation(
      () => okChild(ANTHROPIC_LIVE) as unknown as ReturnType<typeof childProcess.spawn>,
    );
    await get();
    await settle();
    const afterWarmup = spawnsFor("anthropic");

    mockSpawn.mockImplementation(
      () => failingChild() as unknown as ReturnType<typeof childProcess.spawn>,
    );
    notifyProviderSetChanged("anthropic");
    await settle();
    const afterChange = spawnsFor("anthropic");
    expect(afterChange).toBe(afterWarmup + 1);

    mockSpawn.mockImplementation(
      () => okChild(ANTHROPIC_LIVE) as unknown as ReturnType<typeof childProcess.spawn>,
    );
    await get();
    await settle();

    expect(spawnsFor("anthropic")).toBe(afterChange + 1);
  });

  it("leaves a provider with a LIVE, CURRENT catalogue alone", async () => {
    // The attempt is for somebody who does not have the box's own current
    // answer. A box that enumerated fine is not owed a fork because a picker
    // mounted.
    mockSpawn.mockImplementation(
      () => okChild(ANTHROPIC_LIVE) as unknown as ReturnType<typeof childProcess.spawn>,
    );
    await get();
    await settle();
    const afterWarmup = spawnsFor("anthropic");

    await get();
    await get();
    await settle();

    expect(spawnsFor("anthropic")).toBe(afterWarmup);
  });

  it("counts a LIVE list older than the refresh interval as not current", async () => {
    // The discriminating case, and the one a `!isLivePayload(...)` test alone
    // gets wrong: the box was off for three weeks, so the disk cache is a real
    // enumeration and `isLivePayload` is true. The owner is still looking at a
    // three-week-old list with the wait running, which is the same complaint
    // the card makes with an old real list instead of a curated one.
    fs.writeFileSync(
      path.join(DATA_DIR, "catalog-cache", "anthropic.json"),
      JSON.stringify({
        provider: "anthropic",
        models: [{ id: "claude-sonnet-4-6", label: "Sonnet 4.6", contextWindow: 200_000 }],
        defaultModelId: "claude-sonnet-4-6",
        allowCustom: false,
        source: "live",
        fetchedAt: Date.now() - 21 * 24 * 60 * 60_000,
      }),
      "utf8",
    );
    mockSpawn.mockImplementation(
      () => failingChild() as unknown as ReturnType<typeof childProcess.spawn>,
    );
    await get();
    await settle();
    const afterWarmup = spawnsFor("anthropic");

    mockSpawn.mockImplementation(
      () => okChild(ANTHROPIC_LIVE) as unknown as ReturnType<typeof childProcess.spawn>,
    );
    await get();
    await settle();

    expect(spawnsFor("anthropic")).toBe(afterWarmup + 1);
  });
});
