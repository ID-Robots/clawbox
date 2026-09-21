import { describe, expect, it } from "vitest";
import { memoryStatusTimeoutMs } from "@/lib/memory-status-timeout";

describe("memory status timeout override", () => {
  it("keeps the normal deadline when unset", () => {
    expect(memoryStatusTimeoutMs(undefined)).toBe(90_000);
  });

  it("allows a bounded extension for a large database", () => {
    expect(memoryStatusTimeoutMs("180000")).toBe(180_000);
    expect(memoryStatusTimeoutMs("300000")).toBe(300_000);
  });

  it.each(["", "abc", "Infinity", "-1", "0", "89999", "300001", "180000.5"])(
    "uses the safe default for invalid override %j",
    (value) => expect(memoryStatusTimeoutMs(value)).toBe(90_000),
  );
});
