import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import * as childProcess from "child_process";
import fs from "fs/promises";

vi.mock("@/lib/root-step-runner", () => ({
  ROOT_STEP_LAUNCHER: "/usr/local/libexec/clawbox/clawbox-run-root-step.sh",
  startRootStep: vi.fn(async () => {}),
}));
vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("fs/promises", () => ({
  default: { mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn(async () => {}) },
}));
vi.mock("@/lib/config-store", () => ({ DATA_DIR: "/test/data" }));
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => true) }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: vi.fn(() => true) }));
vi.mock("@/lib/login-rate-limit", () => ({ padResponseTime: vi.fn(async () => {}) }));
vi.mock("@/lib/password-reprove", () => ({
  lockoutBuckets: vi.fn(() => [{ key: "global" }]),
  checkReproveLockout: vi.fn(async () => null),
  reproveOwnerPassword: vi.fn(async () => null),
}));
vi.mock("@/lib/system-password", () => ({ hasOwnerPassword: vi.fn(async () => true) }));

import { GET, POST } from "@/app/setup-api/system/ssh/route";
import { startRootStep } from "@/lib/root-step-runner";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { checkReproveLockout, reproveOwnerPassword } from "@/lib/password-reprove";
import { hasOwnerPassword } from "@/lib/system-password";

const mockFs = vi.mocked(fs);
const mockExecFile = vi.mocked(childProcess.execFile);

/** `systemctl is-active ssh` answers `state` (exit non-zero unless active). */
function sshState(state: "active" | "inactive") {
  mockExecFile.mockImplementation(((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
  ) => {
    if (state === "active") cb(null, { stdout: "active\n", stderr: "" });
    else cb(Object.assign(new Error("exit 3"), { code: 3, stdout: "inactive\n" }));
  }) as unknown as typeof childProcess.execFile);
}

const post = (body: unknown) =>
  POST(new Request("http://clawbox.local/setup-api/system/ssh", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://clawbox.local" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
const get = () => GET(new Request("http://clawbox.local/setup-api/system/ssh"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasOwnerSession).mockResolvedValue(true);
  vi.mocked(isSameOriginRequest).mockReturnValue(true);
  vi.mocked(hasOwnerPassword).mockResolvedValue(true);
  vi.mocked(reproveOwnerPassword).mockResolvedValue(null);
  vi.mocked(checkReproveLockout).mockResolvedValue(null);
  sshState("inactive");
});

describe("GET /setup-api/system/ssh", () => {
  it("reports whether sshd runs and whether an owner password exists", async () => {
    sshState("active");
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, ownerPassword: true });
    expect(mockExecFile).toHaveBeenCalledWith("/usr/bin/systemctl", ["is-active", "ssh"], expect.anything(), expect.any(Function));
  });

  it("answers ownerPassword false when the account has none (or the state is unknown)", async () => {
    for (const v of [false, null]) {
      vi.mocked(hasOwnerPassword).mockResolvedValueOnce(v);
      expect(await (await get()).json()).toEqual({ enabled: false, ownerPassword: false });
    }
  });

  it("is owner-only", async () => {
    vi.mocked(hasOwnerSession).mockResolvedValueOnce(false);
    const res = await get();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
  });
});

describe("POST /setup-api/system/ssh", () => {
  it("enables SSH after re-proving the password, through the root step", async () => {
    const res = await post({ enabled: true, currentPassword: "pw" });
    expect(res.status).toBe(200);
    expect(reproveOwnerPassword).toHaveBeenCalledWith("pw", expect.anything(), expect.any(Number));
    const write = mockFs.writeFile.mock.calls.find(([p]) => String(p).endsWith(".ssh-policy-request"));
    expect(write?.[1]).toBe("enable");
    expect((write?.[2] as { mode: number }).mode).toBe(0o600);
    expect(startRootStep).toHaveBeenCalledWith("ssh_policy", expect.anything());
  });

  it("disables SSH the same way", async () => {
    const res = await post({ enabled: false, currentPassword: "pw" });
    expect(res.status).toBe(200);
    const write = mockFs.writeFile.mock.calls.find(([p]) => String(p).endsWith(".ssh-policy-request"));
    expect(write?.[1]).toBe("disable");
  });

  it("refuses to enable without an owner password", async () => {
    vi.mocked(hasOwnerPassword).mockResolvedValueOnce(false);
    const res = await post({ enabled: true, currentPassword: "pw" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("no_owner_password");
    expect(startRootStep).not.toHaveBeenCalled();
  });

  it("refuses a wrong password and changes nothing", async () => {
    vi.mocked(reproveOwnerPassword).mockResolvedValueOnce(
      NextResponse.json({ error: "Incorrect password" }, { status: 401 }),
    );
    const res = await post({ enabled: true, currentPassword: "nope" });
    expect(res.status).toBe(401);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(startRootStep).not.toHaveBeenCalled();
  });

  it("turns a locked-out caller away before reading the body", async () => {
    vi.mocked(checkReproveLockout).mockResolvedValueOnce(
      NextResponse.json({ error: "locked" }, { status: 429 }),
    );
    const res = await post({ enabled: true, currentPassword: "pw" });
    expect(res.status).toBe(429);
    expect(reproveOwnerPassword).not.toHaveBeenCalled();
  });

  it("is owner-only and same-origin", async () => {
    vi.mocked(hasOwnerSession).mockResolvedValueOnce(false);
    expect((await post({ enabled: true, currentPassword: "pw" })).status).toBe(403);
    vi.mocked(isSameOriginRequest).mockReturnValueOnce(false);
    const res = await post({ enabled: true, currentPassword: "pw" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(startRootStep).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ enabled: "yes", currentPassword: "pw" })).status).toBe(400);
    expect(reproveOwnerPassword).not.toHaveBeenCalled();
  });

  it("answers 500 and removes the request when the root step fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(startRootStep).mockRejectedValueOnce(new Error("exit 65"));
    const res = await post({ enabled: true, currentPassword: "pw" });
    expect(res.status).toBe(500);
    expect(mockFs.unlink).toHaveBeenCalledWith(expect.stringMatching(/\.ssh-policy-request$/));
    errSpy.mockRestore();
  });
});
