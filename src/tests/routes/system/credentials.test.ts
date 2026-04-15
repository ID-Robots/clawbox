import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fs from "fs/promises";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock("@/lib/config-store", () => ({
  set: vi.fn(),
  get: vi.fn(async () => false),
}));

vi.mock("@/lib/auth", () => ({
  getSystemUsername: vi.fn(() => process.env.CLAWBOX_USER || "clawbox"),
  PASSWORD_CONTROL_CHAR_RE: /[\r\n\x00-\x1f\x7f]/,
  isSafePasswordChars: (s: string) => !/[\r\n\x00-\x1f\x7f]/.test(s),
  verifyPassword: vi.fn(async () => true),
}));


import { set } from "@/lib/config-store";
import { getSystemUsername } from "@/lib/auth";

const mockSet = vi.mocked(set);
const mockGetSystemUsername = vi.mocked(getSystemUsername);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockFs = vi.mocked(fs);

function setupExecFileMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    _opts: object,
    callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    const key = `${cmd} ${args.join(" ")}`;

    let result = results[key];
    if (!result) {
      for (const k of Object.keys(results)) {
        if (key.includes(k) || k.includes(cmd)) {
          result = results[k];
          break;
        }
      }
    }

    if (callback) {
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else if (result) {
        callback(null, result);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("POST /setup-api/system/credentials", () => {
  let credentialsPost: (req: Request) => Promise<Response>;

  function jsonRequest(body: unknown, headers?: Record<string, string>): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue();
    mockFs.unlink.mockResolvedValue();
    mockSet.mockResolvedValue();
    mockGetSystemUsername.mockImplementation(() => process.env.CLAWBOX_USER || "clawbox");
    setupExecFileMock({
      systemctl: { stdout: "", stderr: "" },
    });

    const mod = await import("@/app/setup-api/system/credentials/route");
    credentialsPost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.CLAWBOX_USER;
  });

  it("sets password successfully", async () => {
    const res = await credentialsPost(jsonRequest({ password: "securepassword123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockFs.writeFile).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith("password_configured", true);
  });

  it("writes the password for the configured install user", async () => {
    process.env.CLAWBOX_USER = "desktopuser";

    const res = await credentialsPost(jsonRequest({ password: "securepassword123" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      "desktopuser:securepassword123\n",
      expect.objectContaining({ mode: 0o600 })
    );
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await credentialsPost(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Invalid JSON");
  });

  it("returns 400 for missing password", async () => {
    const res = await credentialsPost(jsonRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Password is required");
  });

  it("returns 400 for password too short", async () => {
    const res = await credentialsPost(jsonRequest({ password: "short" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Password must be at least 8 characters");
  });

  it("returns 400 for password with newlines", async () => {
    const res = await credentialsPost(jsonRequest({ password: "password\nwith\nnewlines" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("control characters");
  });

  it("returns 400 for password with control characters", async () => {
    const res = await credentialsPost(jsonRequest({ password: "password\x00with\x1fnull" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("control characters");
  });

  it("returns 500 when systemctl fails", async () => {
    setupExecFileMock({
      systemctl: new Error("Service failed"),
    });

    const res = await credentialsPost(jsonRequest({ password: "securepassword123" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Service failed");
  });

  it("cleans up input file on systemctl failure", async () => {
    setupExecFileMock({
      systemctl: new Error("Service failed"),
    });

    await credentialsPost(jsonRequest({ password: "securepassword123" }));

    expect(mockFs.unlink).toHaveBeenCalled();
  });

  it("extracts client IP from x-forwarded-for header", async () => {
    // Make multiple requests to trigger rate limiting
    for (let i = 0; i < 5; i++) {
      await credentialsPost(jsonRequest(
        { password: "pass" }, // Too short, will fail validation
        { "x-forwarded-for": "192.168.1.100, 10.0.0.1" }
      ));
    }

    // 6th request should be rate limited
    const res = await credentialsPost(jsonRequest(
      { password: "securepassword123" },
      { "x-forwarded-for": "192.168.1.100" }
    ));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).toContain("Too many attempts");
  });

  it("resets rate limit on successful password change", async () => {
    // Make some requests
    await credentialsPost(jsonRequest({ password: "short" })); // Fails validation
    await credentialsPost(jsonRequest({ password: "short" })); // Fails validation

    // Successful request should reset rate limit
    const res = await credentialsPost(jsonRequest({ password: "securepassword123" }));
    expect(res.status).toBe(200);

    // Should be able to make more requests now
    const res2 = await credentialsPost(jsonRequest({ password: "anotherpassword123" }));
    expect(res2.status).toBe(200);
  });
});
