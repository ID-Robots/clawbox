import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fs from "fs/promises";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    readdir: vi.fn(),
    rm: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    chown: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock("@/lib/updater", () => ({
  resetUpdateState: vi.fn(),
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/test/data",
}));

vi.mock("@/lib/auth", () => ({
  getSystemUsername: vi.fn(() => "clawbox"),
}));

import { resetUpdateState } from "@/lib/updater";
import { getSystemUsername } from "@/lib/auth";

type ReaddirResult = Awaited<ReturnType<typeof fs.readdir>>;

const mockResetUpdateState = vi.mocked(resetUpdateState);
const mockExecFile = vi.mocked(childProcess.execFile);
const mockFs = vi.mocked(fs);

function setupExecFileMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    _opts: object,
    callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    // Full args so a key like "systemctl start clawbox-root-update@chpasswd"
    // can target a specific service via substring match in `includes()` below.
    const key = `${cmd} ${args.join(" ")}`;

    let result: { stdout: string; stderr: string } | Error | undefined;
    for (const k of Object.keys(results)) {
      if (key.includes(k)) {
        result = results[k];
        break;
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

describe("POST /setup-api/setup/reset", () => {
  let resetPost: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Mock fetch for Ollama
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    }));

    // Mock process.getuid/getgid
    vi.stubGlobal("process", {
      ...process,
      getuid: () => 1000,
      getgid: () => 1000,
    });

    mockFs.readdir.mockResolvedValue([]);
    mockFs.rm.mockResolvedValue();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue();
    mockFs.chown.mockResolvedValue();
    mockFs.unlink.mockResolvedValue();
    mockResetUpdateState.mockReturnValue();
    setupExecFileMock({
      nmcli: { stdout: "", stderr: "" },
      systemctl: { stdout: "", stderr: "" },
    });

    const mod = await import("@/app/setup-api/setup/reset/route");
    resetPost = mod.POST;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("performs factory reset successfully", async () => {
    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockResetUpdateState).toHaveBeenCalled();
  });

  it("clears the session cookie in the reset response", async () => {
    const res = await resetPost();
    const setCookie = res.headers.get("set-cookie");

    expect(setCookie).toContain("clawbox_session=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Path=/");
  });

  it("resets update state", async () => {
    await resetPost();
    expect(mockResetUpdateState).toHaveBeenCalled();
  });

  it("deletes data directory contents except preserved files", async () => {
    mockFs.readdir.mockResolvedValueOnce(
      ["config.json", "oauth-state.json", "network.env"] as unknown as ReaddirResult,
    );

    await resetPost();

    // Should delete config.json and oauth-state.json but not network.env
    expect(mockFs.rm).toHaveBeenCalled();
  });

  it("handles ENOENT error for data directory gracefully", async () => {
    const enoent = new Error("ENOENT") as Error & { code: string };
    enoent.code = "ENOENT";
    mockFs.readdir.mockRejectedValueOnce(enoent);

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("deletes Ollama models", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: "llama2" }, { name: "mistral" }] }),
      })
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await resetPost();

    // Should have called delete for each model
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/delete",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("continues when Ollama is not available", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    // The route retries the Ollama API briefly after starting the service;
    // drive those (fake-timer) sleeps so the retry loop can give up.
    const resPromise = resetPost();
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await resPromise;
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("starts the Ollama service before deleting models", async () => {
    // Local AI exclusive mode routinely leaves Ollama STOPPED, and its models
    // live under /usr/share/ollama — unreachable by the home wipe. The reset
    // must start the service so the API deletes can actually run.
    await resetPost();

    const call = mockExecFile.mock.calls.find(
      ([cmd, args]) => cmd === "/usr/bin/systemctl" && args?.[0] === "start" && args?.[1] === "ollama",
    );
    expect(call).toBeDefined();
  });

  it("deletes WiFi connections", async () => {
    setupExecFileMock({
      nmcli: { stdout: "HomeWifi:802-11-wireless\nWorkWifi:802-11-wireless\n", stderr: "" },
      systemctl: { stdout: "", stderr: "" },
    });

    await resetPost();

    // Should have called nmcli to list and delete connections
    expect(mockExecFile).toHaveBeenCalled();
  });

  it("seeds openclaw.json with token auth", async () => {
    await resetPost();

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("openclaw.json"),
      expect.stringContaining('"mode": "token"'),
      expect.any(Object)
    );
  });

  it("schedules reboot after reset", async () => {
    await resetPost();

    // Fast-forward timers to trigger the reboot
    await vi.advanceTimersByTimeAsync(1500);

    // systemctl reboot should have been called
    expect(mockExecFile).toHaveBeenCalled();
  });

  it("returns 500 and skips reboot on partial file-deletion failure", async () => {
    // First readdir = DATA_DIR, then OPENCLAW_DIR. Make DATA_DIR's rm reject
    // so we hit the partial-failure path; OPENCLAW_DIR returns empty so we
    // don't recurse into the retry pass.
    mockFs.readdir
      .mockResolvedValueOnce(["file1.json", "file2.json"] as unknown as ReaddirResult)
      .mockResolvedValue([] as unknown as ReaddirResult);
    mockFs.rm
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("Permission denied"));

    const res = await resetPost();
    const body = await res.json();

    // No silent reboot — surface the failure so the user can retry or escalate.
    expect(res.status).toBe(500);
    expect(body.error).toContain("incomplete");
    expect(body.failures).toBeDefined();
  });

  it("returns 500 on unexpected error", async () => {
    mockResetUpdateState.mockImplementation(() => {
      throw new Error("Unexpected failure");
    });

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Unexpected failure");
  });

  it("returns generic error for non-Error throws", async () => {
    mockResetUpdateState.mockImplementation(() => {
      throw "unknown error";
    });

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Factory reset failed");
  });

  it("continues when WiFi cleanup fails", async () => {
    setupExecFileMock({
      nmcli: new Error("nmcli not found"),
      systemctl: { stdout: "", stderr: "" },
    });

    const res = await resetPost();
    const body = await res.json();

    // Should still succeed
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("continues when openclaw.json seeding fails", async () => {
    mockFs.writeFile.mockRejectedValue(new Error("Write failed"));

    const res = await resetPost();
    const body = await res.json();

    // Should still succeed (seeding is non-fatal)
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("resets the system password to the default 'clawbox' after wiping data", async () => {
    await resetPost();

    // chpasswd input must be `clawbox:clawbox\n` (chpasswd parses line by
    // line; a missing newline drops the entry on some impls).
    const chpasswdCall = mockFs.writeFile.mock.calls.find(
      ([p]) => typeof p === "string" && p.endsWith(".chpasswd-input"),
    );
    expect(chpasswdCall).toBeDefined();
    expect(chpasswdCall![1]).toBe("clawbox:clawbox\n");
    expect((chpasswdCall![2] as { mode: number }).mode).toBe(0o600);

    // The root systemd service must have been started — without it, the
    // file we just wrote is just an inert text file.
    const startCall = mockExecFile.mock.calls.find(
      ([cmd, args]) =>
        cmd === "/usr/bin/sudo" &&
        args?.[0] === "/usr/bin/systemctl" &&
        args?.[1] === "start" &&
        args?.[2] === "clawbox-root-update@chpasswd.service",
    );
    expect(startCall).toBeDefined();
  });

  it("continues the reset when the password reset fails (non-fatal)", async () => {
    // chpasswd service failure must not strand the user on a half-reset box;
    // the wizard's CredentialsStep on first boot re-prompts and overwrites.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setupExecFileMock({
      "systemctl start clawbox-root-update@chpasswd": new Error("polkit denied"),
      systemctl: { stdout: "", stderr: "" },
      nmcli: { stdout: "", stderr: "" },
    });

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The security regression must be loudly logged for journalctl.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Reset][SECURITY]"),
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it("refuses to write a chpasswd record for an unsafe username", async () => {
    // The username comes from env vars; a value with ":" or a newline would
    // inject extra entries into the colon/newline-delimited chpasswd format.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getSystemUsername).mockReturnValueOnce("evil:root\nroot");

    const res = await resetPost();
    const body = await res.json();

    // Reset still completes (password reset is best-effort)…
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // …but no chpasswd input was ever written.
    const chpasswdCall = mockFs.writeFile.mock.calls.find(
      ([p]) => typeof p === "string" && p.endsWith(".chpasswd-input"),
    );
    expect(chpasswdCall).toBeUndefined();
    errSpy.mockRestore();
  });

  it("wipes previous-owner state from the home directory", async () => {
    await resetPost();

    // The security-critical set: SSH keys (authorized_keys would readmit
    // the previous owner even after the password reset), codex OAuth tokens,
    // the AI-browser profile (cookies/sessions), credential-bearing dotfiles,
    // and the HuggingFace login token.
    for (const suffix of [".ssh", ".codex", "clawbox-browser", ".netrc", "huggingface/token"]) {
      const call = mockFs.rm.mock.calls.find(
        ([p]) => typeof p === "string" && p.endsWith(suffix),
      );
      expect(call, `expected fs.rm for path ending '${suffix}'`).toBeDefined();
      expect(call![1]).toMatchObject({ recursive: true, force: true });
    }
  });

  it("wipes user file folders but keeps the directories", async () => {
    await resetPost();

    // Documents/Downloads/Desktop are content-wiped via readdir+rm (the
    // Files app expects the dirs to exist), not rm'd wholesale.
    for (const dir of ["Documents", "Downloads", "Desktop"]) {
      const call = mockFs.readdir.mock.calls.find(
        ([p]) => typeof p === "string" && p.endsWith(dir),
      );
      expect(call, `expected readdir on '${dir}'`).toBeDefined();
    }
  });

  it("clears the user crontab", async () => {
    await resetPost();

    const call = mockExecFile.mock.calls.find(([cmd, args]) => cmd === "crontab" && args?.[0] === "-r");
    expect(call).toBeDefined();
  });

  it("aborts the reboot when the SSH key wipe fails", async () => {
    // A survivor in ~/.ssh means the previous owner can still get in —
    // that must surface as a failed reset, not a silent reboot.
    mockFs.rm.mockImplementation((p: unknown) =>
      typeof p === "string" && p.endsWith(".ssh")
        ? Promise.reject(new Error("EPERM"))
        : Promise.resolve(),
    );

    const res = await resetPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body.failures)).toContain(".ssh");
  });

  it("scrubs the plaintext chpasswd input file if the password reset fails", async () => {
    // writeFile succeeds but the service start fails: the plaintext credential
    // must be unlinked so it isn't left readable on disk.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setupExecFileMock({
      "systemctl start clawbox-root-update@chpasswd": new Error("polkit denied"),
      systemctl: { stdout: "", stderr: "" },
      nmcli: { stdout: "", stderr: "" },
    });

    await resetPost();
    errSpy.mockRestore();

    const unlinkInputCall = mockFs.unlink.mock.calls.find(
      ([p]) => typeof p === "string" && p.endsWith(".chpasswd-input"),
    );
    expect(unlinkInputCall).toBeDefined();
  });
});
