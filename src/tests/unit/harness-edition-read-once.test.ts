import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ONE read of the edition per answer.
 *
 * `getActiveHarnessSource()` resolved its answer from three separate reads of
 * `/etc/clawbox/edition.env` — its own `readEditionSource()`, then
 * `lockedHarness()` → `isDualUnlocked()` → `getEdition()`, then `lockedHarness`'s
 * own `getEdition()` — and `/setup-api/harness/active` took a fourth for the
 * `edition` field it reports beside it.
 *
 * `install.sh` rewrites that file with `printf >` on every update, and the reads
 * are separate syscalls against a file another process owns: one that lands in
 * the truncated window answers this module's "openclaw" default. The first read
 * saying "hermes" and the second saying nothing is what turns a Hermes box into
 * `{ active: "openclaw", defaulted: false }` — a guess reported as a fact, which
 * is exactly what `defaulted` exists to prevent (the wallpaper ruling brands the
 * box from it).
 *
 * So the source is read ONCE and its edition threaded through. The mock counts
 * every read, which is the property; the fixture that changes its answer is what
 * the counting is for.
 */

const reads = vi.hoisted(() => vi.fn<() => { edition: string; defaulted: boolean }>());

vi.mock("@/lib/edition-source", () => ({
  readEditionSource: reads,
  readEdition: () => reads().edition,
  hasHermesHarness: () => reads().edition !== "openclaw",
}));
const licenseVerifies = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/edition-license", () => ({ verifyDualLicense: licenseVerifies }));
vi.mock("@/lib/config-store", () => ({
  getKnown: async () => ({ value: "hermes", known: true }),
  swap: vi.fn(),
}));

import { getActiveHarnessSource } from "@/lib/harness";

beforeEach(() => {
  reads.mockReset();
  licenseVerifies.mockClear();
});

describe("getActiveHarnessSource", () => {
  it("resolves the whole answer from one read of the edition source", async () => {
    reads.mockReturnValue({ edition: "hermes", defaulted: false });

    const source = await getActiveHarnessSource();

    expect(source.active).toBe("hermes");
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("carries the edition it resolved from, so a caller needs no second read", async () => {
    reads.mockReturnValue({ edition: "hermes", defaulted: false });
    expect((await getActiveHarnessSource()).edition).toBe("hermes");
  });

  it("does not report a guess as a fact when the lock is rewritten mid-answer", async () => {
    // The update window: the first read is the real lock, everything after it
    // lands while `install.sh` has the file truncated.
    reads
      .mockReturnValueOnce({ edition: "hermes", defaulted: false })
      .mockReturnValue({ edition: "openclaw", defaulted: true });

    expect(await getActiveHarnessSource()).toEqual({
      active: "hermes",
      defaulted: false,
      edition: "hermes",
      locked: true,
    });
  });

  it("still answers the honest default when the FIRST read is the unreadable one", async () => {
    // The mirror case, and the one that must not change: nothing on the device
    // named an edition when we looked, so the answer is a default and says so —
    // whatever the file says a microsecond later.
    reads
      .mockReturnValueOnce({ edition: "openclaw", defaulted: true })
      .mockReturnValue({ edition: "hermes", defaulted: false });

    expect(await getActiveHarnessSource()).toEqual({
      active: "openclaw",
      defaulted: true,
      edition: "openclaw",
      locked: true,
    });
  });

  it("answers the switcher question from the SAME resolution, not a second licence verify", async () => {
    // `locked` used to be re-derived by the caller, which re-ran
    // `verifyDualLicense()` — a file read and an ed25519 verify — across the
    // caller's own await: a licence replaced or expired in between answered
    // `edition: "dual"` beside `locked: true`, hiding the switcher on a box
    // that has it.
    reads.mockReturnValue({ edition: "dual", defaulted: false });
    expect((await getActiveHarnessSource()).locked).toBe(false);
    expect(licenseVerifies).toHaveBeenCalledTimes(1);
  });

  it("reads the store for a licensed dual, still from one edition read", async () => {
    reads.mockReturnValue({ edition: "dual", defaulted: false });

    expect(await getActiveHarnessSource()).toEqual({
      active: "hermes",
      defaulted: false,
      edition: "dual",
      locked: false,
    });
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
