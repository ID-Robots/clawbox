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

  it("forgets everything when the cache is invalidated by hand", async () => {
    runHermesCli.mockResolvedValue(ok("clawai"));
    const { hermesConfigGet, invalidateHermesConfigCache } = await load();
    expect(await hermesConfigGet("model.provider")).toBe("clawai");
    invalidateHermesConfigCache();
    expect(await hermesConfigGet("model.provider")).toBe("clawai");
    expect(runHermesCli).toHaveBeenCalledTimes(2);
  });
});
