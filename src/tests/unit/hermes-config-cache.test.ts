import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The memo around `hermes config get <key>`.
 *
 * Two facts about the live box (192.168.1.47, hermes 2026-08-27) set the shape
 * of what follows, and both were measured rather than assumed:
 *
 *   - one `hermes config get` costs ~816 ms on an IDLE Jetson, because it
 *     starts a Python interpreter. That is why the memo exists at all;
 *   - an UNSET key is not an error. `hermes config get zzz.nope` exits 1 and
 *     prints `Config key not set: zzz.nope` on stderr, while a set key exits 0
 *     and prints the value. So a non-zero exit is the CLI ANSWERING "nothing is
 *     configured there", and config.yaml's mtime is a correct invalidator for
 *     it: the only thing that can make an unset key set is a write to that file.
 *
 * What is NOT an answer is a read that never finished — `runHermesCli` rejects
 * on a timeout, on a missing binary, and when it has to SIGKILL the child, and
 * a child killed by a signal comes back with `code: null`. Caching "" for those
 * against the current mtime remembers a failed QUESTION as a negative ANSWER,
 * and on a linked, stable box nothing ever rewrites config.yaml again, so the
 * memo holds it until the web server restarts.
 */

const runHermesCli = vi.fn();
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli }));

/** config.yaml's mtime, controlled by each test. `null` = no file yet. */
let mtimeMs: number | null = 1_000;
const stat = vi.fn(async () => {
  if (mtimeMs === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return { mtimeMs };
});
vi.mock("fs/promises", () => ({ default: { stat: () => stat() }, stat: () => stat() }));

/** Matches `FAILED_READ_TTL_MS` in the module under test, with room to spare. */
const PAST_THE_BACKOFF_MS = 61_000;

async function load() {
  vi.resetModules();
  return import("@/lib/hermes-config-cache");
}

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
/** What the real CLI answers for a key nobody has configured. */
const notSet = (key: string) => ({ code: 1, stdout: "", stderr: `Config key not set: ${key}` });

/**
 * Let every pending microtask run, WITHOUT advancing the fake clock.
 *
 * The concurrency tests below need the racing callers to have all reached
 * `runHermesCli` — each of them first awaits the `fs.stat` behind
 * `configMtime` — while the CLI promise is still unsettled. `vi.runAllTicks`
 * would not help: these are plain promise continuations, not `nextTick`.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("hermesConfigGet", () => {
  beforeEach(() => {
    mtimeMs = 1_000;
    runHermesCli.mockReset();
    stat.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("asks the CLI once and serves the memo while config.yaml is unchanged", async () => {
    runHermesCli.mockResolvedValue(ok("gpt-4.1-mini"));
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("auxiliary.vision.model")).toBe("gpt-4.1-mini");
    expect(await hermesConfigGet("auxiliary.vision.model")).toBe("gpt-4.1-mini");
    expect(runHermesCli).toHaveBeenCalledTimes(1);
  });

  it("re-reads once config.yaml has been rewritten", async () => {
    runHermesCli.mockResolvedValue(ok(""));
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("image_gen.provider")).toBe("");

    runHermesCli.mockResolvedValue(ok("clawai"));
    mtimeMs = 2_000; // `hermes config set` — i.e. the customer linked.
    expect(await hermesConfigGet("image_gen.provider")).toBe("clawai");
  });

  it("keeps the CLI's own 'not set' verdict memoised", async () => {
    // Verified on the box: an unset key exits 1. That is an ANSWER, and the
    // mtime is the right invalidator for it — re-spawning Python for it on
    // every poll of /setup-api/ai-models/status is the cost the memo exists to
    // avoid, and an unlinked box hits this path on nearly every key.
    runHermesCli.mockResolvedValue(notSet("image_gen.provider"));
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("image_gen.provider")).toBe("");
    expect(await hermesConfigGet("image_gen.provider")).toBe("");
    expect(runHermesCli).toHaveBeenCalledTimes(1);
  });

  it("does not remember a read that timed out as an answer", async () => {
    // THE BUG. A 10 s timeout on a loaded Jetson used to be cached as "" against
    // the CURRENT mtime, and on a linked box config.yaml is never written again
    // — so one slow moment hid the vision route until the next restart.
    runHermesCli.mockRejectedValue(new Error("hermes timed out"));
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("auxiliary.vision.model")).toBe("");

    runHermesCli.mockReset();
    runHermesCli.mockResolvedValue(ok("gpt-4.1-mini"));
    vi.setSystemTime(Date.now() + PAST_THE_BACKOFF_MS);
    expect(await hermesConfigGet("auxiliary.vision.model")).toBe("gpt-4.1-mini");
  });

  it("does not remember a spawn failure as an answer", async () => {
    runHermesCli.mockRejectedValue(new Error("Hermes is not installed on this device"));
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("model.provider")).toBe("");

    runHermesCli.mockReset();
    runHermesCli.mockResolvedValue(ok("clawai"));
    vi.setSystemTime(Date.now() + PAST_THE_BACKOFF_MS);
    expect(await hermesConfigGet("model.provider")).toBe("clawai");
  });

  it("does not remember a child killed by a signal as an answer", async () => {
    // An OOM-killed CLI closes with no exit code at all. It never told us
    // anything about the key, so it must not be stored as if it had.
    runHermesCli.mockResolvedValue({ code: null, stdout: "", stderr: "" });
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("image_gen.provider")).toBe("");

    runHermesCli.mockReset();
    runHermesCli.mockResolvedValue(ok("clawai"));
    vi.setSystemTime(Date.now() + PAST_THE_BACKOFF_MS);
    expect(await hermesConfigGet("image_gen.provider")).toBe("clawai");
  });

  it("does not re-spawn the CLI for every caller while a read is failing", async () => {
    // Forgetting the failure must not turn a hanging `hermes` into one Python
    // start per request. The failure is held for a short backoff, then re-asked.
    runHermesCli.mockRejectedValue(new Error("hermes timed out"));
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("model.default")).toBe("");
    expect(await hermesConfigGet("model.default")).toBe("");
    expect(await hermesConfigGet("model.default")).toBe("");
    expect(runHermesCli).toHaveBeenCalledTimes(1);
  });

  it("still answers, uncached, before config.yaml exists", async () => {
    // Fresh device: nothing to invalidate against, so every call asks again.
    mtimeMs = null;
    runHermesCli.mockResolvedValue(ok("clawai"));
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("model.provider")).toBe("clawai");
    expect(await hermesConfigGet("model.provider")).toBe("clawai");
    expect(runHermesCli).toHaveBeenCalledTimes(2);
  });

  it("still backs off a failed read before config.yaml exists", async () => {
    // The mirror of the bug. An answer has nothing to invalidate it here, so it
    // is not kept — but a FAILURE is invalidated by the clock, not by the file,
    // and dropping it outright would start a Python interpreter per request on
    // exactly the box most likely to have a broken `hermes`: an unset-up one.
    mtimeMs = null;
    runHermesCli.mockRejectedValue(new Error("hermes timed out"));
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("auxiliary.vision.model")).toBe("");
    expect(await hermesConfigGet("auxiliary.vision.model")).toBe("");
    expect(await hermesConfigGet("auxiliary.vision.model")).toBe("");
    expect(runHermesCli).toHaveBeenCalledTimes(1);

    runHermesCli.mockReset();
    runHermesCli.mockResolvedValue(ok("gpt-4.1-mini"));
    vi.setSystemTime(Date.now() + PAST_THE_BACKOFF_MS);
    expect(await hermesConfigGet("auxiliary.vision.model")).toBe("gpt-4.1-mini");
  });

  it("drops a failure held from before config.yaml the moment the file appears", async () => {
    // The backoff must not become its own stale probe: the customer linking is
    // precisely the event these reads have to notice, and it writes the file.
    mtimeMs = null;
    runHermesCli.mockRejectedValue(new Error("hermes timed out"));
    const { hermesConfigGet } = await load();
    expect(await hermesConfigGet("image_gen.provider")).toBe("");

    runHermesCli.mockReset();
    runHermesCli.mockResolvedValue(ok("clawai"));
    mtimeMs = 1_000; // first write to config.yaml — well inside the backoff.
    expect(await hermesConfigGet("image_gen.provider")).toBe("clawai");
    expect(runHermesCli).toHaveBeenCalledTimes(1);
  });

  it("forgets everything when the cache is invalidated by hand", async () => {
    runHermesCli.mockResolvedValue(ok("clawai"));
    const { hermesConfigGet, invalidateHermesConfigCache } = await load();
    expect(await hermesConfigGet("model.provider")).toBe("clawai");
    invalidateHermesConfigCache();
    expect(await hermesConfigGet("model.provider")).toBe("clawai");
    expect(runHermesCli).toHaveBeenCalledTimes(2);
  });

  it("shares ONE interpreter between callers racing the same key", async () => {
    // The production shape, and the one a sequential `await` cannot express.
    // `/setup-api/chat/capabilities` asks `hermesHasVisionRoute` and
    // `hermesAgentDrawsImages` on every chat open with no route-level dedup,
    // and `readCurrentFromCli` issues three of these under one `Promise.all`.
    // With a wedged `hermes` the backoff entry is not written until the first
    // read gives up, so every overlapping caller in that window used to start
    // its own Python interpreter — on a Jetson, for the whole timeout — which
    // is the exact fan-out the backoff exists to prevent.
    let finish: (value: unknown) => void = () => {};
    runHermesCli.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { hermesConfigGet } = await load();
    const racing = Promise.all([
      hermesConfigGet("auxiliary.vision.model"),
      hermesConfigGet("auxiliary.vision.model"),
      hermesConfigGet("auxiliary.vision.model"),
    ]);
    await flushMicrotasks();
    expect(runHermesCli).toHaveBeenCalledTimes(1);

    finish(ok("gpt-4.1-mini"));
    expect(await racing).toEqual(["gpt-4.1-mini", "gpt-4.1-mini", "gpt-4.1-mini"]);
  });

  it("shares one interpreter between racing callers even when the read FAILS", async () => {
    // The half that matters most: a hanging `hermes` is precisely when the
    // callers pile up, and the entry has to be in the map before the failure
    // is known, not after.
    let fail: (reason: unknown) => void = () => {};
    runHermesCli.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { hermesConfigGet } = await load();
    const racing = Promise.all([
      hermesConfigGet("image_gen.provider"),
      hermesConfigGet("image_gen.provider"),
      hermesConfigGet("image_gen.provider"),
    ]);
    await flushMicrotasks();
    expect(runHermesCli).toHaveBeenCalledTimes(1);

    fail(new Error("hermes timed out"));
    expect(await racing).toEqual(["", "", ""]);
    // …and the failure is still only held for the backoff, not for ever.
    runHermesCli.mockReset();
    runHermesCli.mockResolvedValue(ok("clawai"));
    vi.setSystemTime(Date.now() + PAST_THE_BACKOFF_MS);
    expect(await hermesConfigGet("image_gen.provider")).toBe("clawai");
  });

  it("does not race a still-answered key against a config.yaml written mid-read", async () => {
    // An in-flight entry is stamped with the mtime it was started against, so
    // a write that lands while the CLI is running is still noticed by the next
    // caller rather than being served the older question's answer.
    let finish: (value: unknown) => void = () => {};
    runHermesCli.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { hermesConfigGet } = await load();
    const first = hermesConfigGet("model.provider");
    await flushMicrotasks();

    mtimeMs = 2_000; // the customer linked while the first read was in flight
    runHermesCli.mockResolvedValue(ok("clawai"));
    expect(await hermesConfigGet("model.provider")).toBe("clawai");

    finish(ok("stale"));
    expect(await first).toBe("stale");
    expect(runHermesCli).toHaveBeenCalledTimes(2);
  });
});

describe("hermesConfigReadPending", () => {
  beforeEach(() => {
    mtimeMs = 1_000;
    runHermesCli.mockReset();
    stat.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("says nothing is pending before anyone has asked", async () => {
    const { hermesConfigReadPending } = await load();
    expect(hermesConfigReadPending("model.provider")).toBe(false);
  });

  it("reports a value served from the FAILURE backoff as pending", async () => {
    // This is the fact the browser needs and never got: the `false` it was
    // handed is a placeholder the server will replace by itself in a minute,
    // not a negative answer about the box.
    runHermesCli.mockRejectedValue(new Error("hermes timed out"));
    const { hermesConfigGet, hermesConfigReadPending } = await load();
    expect(await hermesConfigGet("auxiliary.vision.model")).toBe("");
    expect(hermesConfigReadPending("auxiliary.vision.model")).toBe(true);
  });

  it("does not report a real ANSWER as pending, set or unset", async () => {
    runHermesCli.mockResolvedValue(notSet("image_gen.provider"));
    const { hermesConfigGet, hermesConfigReadPending } = await load();
    expect(await hermesConfigGet("image_gen.provider")).toBe("");
    expect(hermesConfigReadPending("image_gen.provider")).toBe(false);

    runHermesCli.mockResolvedValue(ok("clawai"));
    mtimeMs = 2_000;
    expect(await hermesConfigGet("image_gen.provider")).toBe("clawai");
    expect(hermesConfigReadPending("image_gen.provider")).toBe(false);
  });

  it("stops reporting pending once the backoff has produced an answer", async () => {
    runHermesCli.mockRejectedValue(new Error("hermes timed out"));
    const { hermesConfigGet, hermesConfigReadPending } = await load();
    expect(await hermesConfigGet("model.default")).toBe("");
    expect(hermesConfigReadPending("model.default")).toBe(true);

    runHermesCli.mockReset();
    runHermesCli.mockResolvedValue(ok("claude-sonnet-5"));
    vi.setSystemTime(Date.now() + PAST_THE_BACKOFF_MS);
    expect(await hermesConfigGet("model.default")).toBe("claude-sonnet-5");
    expect(hermesConfigReadPending("model.default")).toBe(false);
  });
});
