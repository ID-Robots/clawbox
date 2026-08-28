import { describe, expect, it, vi } from "vitest";
import { repairOpenclawConfig } from "@/instrumentation";

/**
 * The boot-time repairs of openclaw.json ran TOGETHER. Each is a read-modify-
 * write of the same file through the same `.tmp` path, so run side by side
 * they read the same original and the last rename wins: the other repair is
 * silently undone until the next boot, and two writers on one temp path can
 * rename a half-written file into place.
 *
 * The sequencing is a plain function with the repairs handed in, so this can
 * pin the order without `require()`-ing the real config module.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("repairOpenclawConfig", () => {
  it("starts the second repair only after the first has finished", async () => {
    const first = deferred<boolean>();
    const ensureLocalAiProxyUrls = vi.fn(() => first.promise);
    const ensureMicrosoftTtsExcluded = vi.fn(async () => false);
    const restartGateway = vi.fn(async () => {});

    const done = repairOpenclawConfig({ ensureLocalAiProxyUrls, ensureMicrosoftTtsExcluded, restartGateway });
    await Promise.resolve();
    expect(ensureLocalAiProxyUrls).toHaveBeenCalledTimes(1);
    // The first is still writing. The second must not have read the file yet.
    expect(ensureMicrosoftTtsExcluded).not.toHaveBeenCalled();

    first.resolve(false);
    await done;
    expect(ensureMicrosoftTtsExcluded).toHaveBeenCalledTimes(1);
  });

  it("restarts the gateway once when either repair wrote something", async () => {
    const restartGateway = vi.fn(async () => {});
    await repairOpenclawConfig({
      ensureLocalAiProxyUrls: async () => true,
      ensureMicrosoftTtsExcluded: async () => true,
      restartGateway,
    });
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("leaves the gateway alone when nothing changed", async () => {
    const restartGateway = vi.fn(async () => {});
    await repairOpenclawConfig({
      ensureLocalAiProxyUrls: async () => false,
      ensureMicrosoftTtsExcluded: async () => false,
      restartGateway,
    });
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("keeps going when one repair throws, and still restarts for the other", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const restartGateway = vi.fn(async () => {});
    const ensureMicrosoftTtsExcluded = vi.fn(async () => true);
    await repairOpenclawConfig({
      ensureLocalAiProxyUrls: async () => { throw new Error("config unreadable"); },
      ensureMicrosoftTtsExcluded,
      restartGateway,
    });
    expect(ensureMicrosoftTtsExcluded).toHaveBeenCalledTimes(1);
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Local AI proxy URLs"), "config unreadable");
    error.mockRestore();
  });

  it("never throws — a restart that fails is logged, not raised into boot", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(repairOpenclawConfig({
      ensureLocalAiProxyUrls: async () => true,
      ensureMicrosoftTtsExcluded: async () => false,
      restartGateway: async () => { throw new Error("systemctl failed"); },
    })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("restart"), "systemctl failed");
    error.mockRestore();
  });
});
