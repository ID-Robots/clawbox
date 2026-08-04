import { describe, expect, it } from "vitest";
import { lastUsefulJournalLine, parseGatewaySystemctlProperties } from "@/lib/gateway-health";

describe("gateway service health", () => {
  it("keeps the final startup error instead of a repeated restart notice", () => {
    const journal = [
      "Config validation failed: exec SecretRef command must resolve to a real path",
      "clawbox-gateway.service: Main process exited, code=exited, status=1/FAILURE",
      "clawbox-gateway.service: Scheduled restart job, restart counter is at 3.",
    ].join("\n");

    expect(lastUsefulJournalLine(journal)).toBe(
      "Config validation failed: exec SecretRef command must resolve to a real path",
    );
  });

  it("returns null for an empty journal", () => {
    expect(lastUsefulJournalLine("\n")).toBeNull();
  });

  it("recognizes systemd 249's documented start-limit-hit result", () => {
    expect(parseGatewaySystemctlProperties([
      "ActiveState=failed",
      "SubState=failed",
      "Result=start-limit-hit",
      "NRestarts=5",
    ].join("\n"))).toEqual({
      active: false,
      breakerActive: true,
      activeState: "failed",
      subState: "failed",
      result: "start-limit-hit",
      restartCount: 5,
    });
  });

  it("normalizes control characters and caps journal output", () => {
    const unsafe = `\u001b[31mConfig\u0000 failure ${"x".repeat(2_000)}`;
    const result = lastUsefulJournalLine(unsafe);

    expect(result).toMatch(/^Config failure x+$/);
    expect(result).toHaveLength(1_000);
    expect(result).not.toContain("\u001b");
  });

  it("redacts credentials from the authenticated error summary", () => {
    const line = 'Config failed token="super-secret-value" bot=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ012345';
    const result = lastUsefulJournalLine(line);

    expect(result).toContain('token="[redacted]');
    expect(result).toContain("[redacted-telegram-token]");
    expect(result).not.toContain("super-secret-value");
    expect(result).not.toContain("ABCdefGHI");
  });
});
