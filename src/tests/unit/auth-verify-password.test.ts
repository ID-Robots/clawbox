import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";

const mockSpawn = vi.mocked(spawn);

describe("verifyPassword", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.CLAWBOX_USER;
    delete process.env.SUDO_USER;
  });

  it("verifies the configured install user instead of a hardcoded username", async () => {
    process.env.CLAWBOX_USER = "desktopuser";

    const listeners = new Map<string, Array<(code?: number) => void>>();
    const stdinEnd = vi.fn();
    const child = {
      stdin: { end: stdinEnd },
      on: vi.fn((event: string, cb: (code?: number) => void) => {
        const current = listeners.get(event) || [];
        current.push(cb);
        listeners.set(event, current);
        return child;
      }),
    };

    mockSpawn.mockReturnValue(child as never);

    const { verifyPassword } = await import("@/lib/auth");
    const resultPromise = verifyPassword("secret123");
    listeners.get("close")?.forEach((listener) => listener(0));

    await expect(resultPromise).resolves.toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      "/usr/sbin/unix_chkpwd",
      ["desktopuser", "nullok"],
      expect.objectContaining({
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      })
    );
    expect(stdinEnd).toHaveBeenCalledWith("secret123\0");
  });
});
