// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "@/lib/clipboard";

// Saved originals so we can restore between cases that scrub `navigator`
// or `document.execCommand` to exercise the fallback path.
const realClipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
const realExecCommand = (globalThis.document as Document | undefined)?.execCommand;

describe("copyToClipboard", () => {
  beforeEach(() => {
    // Make sure each test sees a clean DOM with no leftover hidden textareas.
    if (typeof document !== "undefined") document.body.innerHTML = "";
  });

  afterEach(() => {
    // Restore the originals — vi.spyOn handles its own restoration but
    // raw assignments to navigator.clipboard need manual rollback so the
    // next test in the file sees a known starting state.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: realClipboard,
    });
    if (realExecCommand) {
      (document as Document & { execCommand: typeof realExecCommand }).execCommand = realExecCommand;
    }
  });

  it("uses navigator.clipboard.writeText when available and resolves true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("hello");
    // Modern API succeeded → no fallback textarea should have been created.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("falls back to execCommand when the modern API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const exec = vi.fn().mockReturnValue(true);
    (document as Document & { execCommand: typeof exec }).execCommand = exec;

    await expect(copyToClipboard("greetings")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("greetings");
    expect(exec).toHaveBeenCalledExactlyOnceWith("copy");
    // The hidden textarea must always be cleaned up — verify the finally{}.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("falls back to execCommand when navigator.clipboard is missing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const exec = vi.fn().mockReturnValue(true);
    (document as Document & { execCommand: typeof exec }).execCommand = exec;

    await expect(copyToClipboard("legacy")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledExactlyOnceWith("copy");
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("returns false (without throwing) when execCommand throws", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const exec = vi.fn().mockImplementation(() => {
      throw new Error("execCommand blocked");
    });
    (document as Document & { execCommand: typeof exec }).execCommand = exec;

    await expect(copyToClipboard("blocked")).resolves.toBe(false);
    // Finally block must still tear the textarea down even on error.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("returns false when execCommand returns false", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const exec = vi.fn().mockReturnValue(false);
    (document as Document & { execCommand: typeof exec }).execCommand = exec;

    await expect(copyToClipboard("nope")).resolves.toBe(false);
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
