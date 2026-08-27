import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
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

vi.mock("@/lib/local-ai-runtime", () => ({
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
  startOllamaService: vi.fn(async () => {}),
}));

import { resetUpdateState } from "@/lib/updater";
import { getSystemUsername } from "@/lib/auth";
import { startOllamaService } from "@/lib/local-ai-runtime";

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
    // can target a specific service via substring match below. Pick the most
    // specific (longest) matching key, not the first — otherwise a broad key
    // like "systemctl" listed earlier would shadow the service-specific stubs.
    const key = `${cmd} ${args.join(" ")}`;

    const matchedKey = Object.keys(results)
      .filter((k) => key.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    const result = matchedKey !== undefined ? results[matchedKey] : undefined;

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
  let session: SessionFixture;

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

    session = installSessionFixture();
    const mod = await import("@/app/setup-api/setup/reset/route");
    // The handler now requires a session (TASK-443), so every call in this
    // file goes through an authenticated request. `reset-requires-auth.test.ts`
    // covers the unauthenticated case.
    resetPost = () => mod.POST(new Request("http://localhost/setup-api/setup/reset", {
      method: "POST",
      headers: { Cookie: session.cookie },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    session.cleanup();
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
    //
    // Through the shared startOllamaService(), not a hand-rolled systemctl call:
    // that helper is the one place the argv is pinned to the `start
    // ollama.service` Cmnd_Spec in config/clawbox-sudoers, and it is the only
    // caller that passes `-n` and keeps the unprivileged dev fallback. The bare
    // `systemctl start ollama` this used to issue matched no sudoers rule and
    // worked only through the unscoped polkit grant. TASK-445.
    await resetPost();

    expect(vi.mocked(startOllamaService)).toHaveBeenCalled();
    const bareCall = mockExecFile.mock.calls.find(
      ([cmd, args]) => typeof cmd === "string" && cmd.endsWith("systemctl") && args?.includes("ollama"),
    );
    expect(bareCall, "the reset must not talk to systemd about ollama itself").toBeUndefined();
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

/**
 * A factory reset on a Hermes-edition device used to brick it.
 *
 * `.hermes` was in HOME_REMOVE_PATHS as a whole directory, on the (wrong)
 * belief that it held only owner state. `~/.hermes/hermes-agent/` is the AGENT
 * INSTALL — the upstream checkout plus the Python venv that the 4-line
 * `~/.local/bin/hermes` shim execs. The shim lives outside the wipe and
 * survived it, so the box came up with a `hermes` command whose interpreter was
 * gone and clawbox-hermes-dashboard.service (Restart=always) crash-looping on
 * exit 127 forever. The same reset emptied data/, taking the 3.2 GB offline
 * Gemma GGUF with it — on a device that reboots into AP mode with no internet
 * to re-download either.
 *
 * These tests pin both exceptions, and — just as importantly — pin that
 * carving them out did not turn the wipe into a keep-list: every
 * secret-bearing sibling under ~/.hermes must still be removed.
 */
describe("POST /setup-api/setup/reset — Hermes agent + offline model survive", () => {
  let resetPost: () => Promise<Response>;
  let session: SessionFixture;
  const HOME = process.env.HOME || "/home/clawbox";
  const HERMES = `${HOME}/.hermes`;

  // What a used Hermes box actually has under ~/.hermes.
  const HERMES_ENTRIES = [
    "hermes-agent",
    "config.yaml",
    "config.yaml.bak-20260813",
    ".env",
    "auth.json",
    "memories",
    "logs",
    "cron",
    "pairing",
    "sessions",
    "skills",
    "state.db",
    "projects.db",
  ];
  const SECRET_ENTRIES = HERMES_ENTRIES.filter((e) => e !== "hermes-agent");

  const rmTargets = () =>
    mockFs.rm.mock.calls.map(([p]) => p).filter((p): p is string => typeof p === "string");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models: [] }),
    }));
    vi.stubGlobal("process", { ...process, getuid: () => 1000, getgid: () => 1000 });

    mockFs.readdir.mockImplementation(((p: string) => {
      if (p === HERMES) return Promise.resolve(HERMES_ENTRIES);
      if (p === "/test/data") return Promise.resolve(["config.json", "network.env", "llamacpp", ".session-secret"]);
      // llama-server's runtime scratch sits beside the weights.
      if (p === "/test/data/llamacpp") return Promise.resolve(["models", "server.pid", "server.log"]);
      return Promise.resolve([]);
    }) as unknown as typeof fs.readdir);
    mockFs.rm.mockResolvedValue();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue();
    mockFs.chown.mockResolvedValue();
    mockFs.unlink.mockResolvedValue();
    mockResetUpdateState.mockReturnValue();
    setupExecFileMock({ nmcli: { stdout: "", stderr: "" }, systemctl: { stdout: "", stderr: "" } });

    session = installSessionFixture();
    const mod = await import("@/app/setup-api/setup/reset/route");
    // The handler now requires a session (TASK-443), so every call in this
    // file goes through an authenticated request. `reset-requires-auth.test.ts`
    // covers the unauthenticated case.
    resetPost = () => mod.POST(new Request("http://localhost/setup-api/setup/reset", {
      method: "POST",
      headers: { Cookie: session.cookie },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    session.cleanup();
  });

  it("never removes ~/.hermes/hermes-agent, directly or via its parent", async () => {
    await resetPost();
    const targets = rmTargets();

    // The agent install itself.
    expect(targets).not.toContain(`${HERMES}/hermes-agent`);
    // And not by taking the whole directory out from under it — the exact
    // shape of the original defect.
    expect(targets).not.toContain(HERMES);
  });

  it("still removes every secret-bearing entry under ~/.hermes", async () => {
    await resetPost();
    const targets = rmTargets();

    for (const entry of SECRET_ENTRIES) {
      expect(targets, `expected ~/.hermes/${entry} to be removed`).toContain(`${HERMES}/${entry}`);
    }
  });

  it("removes unknown new entries under ~/.hermes by default", async () => {
    // The exception is a named allow-list of one. Anything Hermes starts
    // writing tomorrow must be wiped without a code change, or the fix quietly
    // becomes a keep-list and the next secret leaks to the next owner.
    mockFs.readdir.mockImplementation(((p: string) =>
      Promise.resolve(p === HERMES ? ["hermes-agent", "some-future-token-store"] : [])
    ) as unknown as typeof fs.readdir);

    await resetPost();

    expect(rmTargets()).toContain(`${HERMES}/some-future-token-store`);
  });

  it("keeps data/llamacpp (the offline GGUF) while wiping the rest of data/", async () => {
    await resetPost();
    const targets = rmTargets();

    expect(targets).not.toContain("/test/data/llamacpp");
    expect(targets).toContain("/test/data/config.json");
    expect(targets).toContain("/test/data/.session-secret");
    // network.env was already preserved; assert it stayed that way.
    expect(targets).not.toContain("/test/data/network.env");
  });

  it("wipes the chat transcripts, which hold the customer's own words", async () => {
    // The most sensitive thing the durable transcript introduced: whatever the
    // owner typed at the agent, and whatever was in the pictures they attached.
    // It survives a reset only if somebody ADDS it to the keep-list, which is
    // the right default — but a resold box handing its next owner the previous
    // one's conversations is the failure that matters most here, so it is
    // pinned rather than left to that default holding.
    mockFs.readdir.mockImplementation(((p: string) => {
      if (p === "/test/data") {
        return Promise.resolve(["config.json", "chat-transcripts", "chat-media", "network.env"]);
      }
      return Promise.resolve([]);
    }) as unknown as typeof fs.readdir);

    await resetPost();
    const targets = rmTargets();

    expect(targets).toContain("/test/data/chat-transcripts");
    // Staged attachments and generated pictures go with them, for the same
    // reason and by the same default.
    expect(targets).toContain("/test/data/chat-media");
  });

  it("keeps only the weights inside data/llamacpp — runtime scratch still goes", async () => {
    // The keep is for the 3.2 GB download a reset device cannot re-fetch, not
    // for the directory it happens to live in. llamacpp/ is also llama-server's
    // working directory: server.log is a log of what the previous owner asked
    // the LOCAL model, which a resold box must not carry. Keeping models/
    // rather than the subtree means that holds by construction instead of
    // depending on the current llama-server logging config.
    await resetPost();
    const targets = rmTargets();

    expect(targets).toContain("/test/data/llamacpp/server.pid");
    expect(targets).toContain("/test/data/llamacpp/server.log");
    expect(targets).not.toContain("/test/data/llamacpp/models");
  });

  it("removes anything new that appears next to the weights, by default", async () => {
    // Same property as the ~/.hermes exception: a named allow-list of one, so
    // whatever llama.cpp starts writing tomorrow is wiped without a code
    // change rather than inherited by the next owner.
    mockFs.readdir.mockImplementation(((p: string) => {
      if (p === "/test/data") return Promise.resolve(["llamacpp"]);
      if (p === "/test/data/llamacpp") return Promise.resolve(["models", "sessions.jsonl"]);
      return Promise.resolve([]);
    }) as unknown as typeof fs.readdir);

    await resetPost();

    expect(rmTargets()).toContain("/test/data/llamacpp/sessions.jsonl");
  });

  it("one undeletable entry under ~/.hermes does not stop the rest of the wipe", async () => {
    // Root-owned __pycache__ under ~/.hermes (written by a root-run `hermes
    // --version`) made `rm -rf ~/.hermes` fail as ONE call, aborting the whole
    // subtree with the agent already half deleted. Per-entry removal means one
    // EACCES is reported and the other entries still go.
    mockFs.rm.mockImplementation(((p: unknown) =>
      typeof p === "string" && p === `${HERMES}/auth.json`
        ? Promise.reject(new Error("EACCES: permission denied"))
        : Promise.resolve()) as unknown as typeof fs.rm);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await resetPost();
    const body = await res.json();
    warnSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body.failures)).toContain("auth.json");
    // Everything else still got removed.
    const targets = rmTargets();
    for (const entry of SECRET_ENTRIES.filter((e) => e !== "auth.json")) {
      expect(targets, `expected ~/.hermes/${entry} to still be removed`).toContain(`${HERMES}/${entry}`);
    }
  });

  it("a failed wipe leaves the owner able to get back in", async () => {
    // The abort path does NOT reboot, and the AP only returns on reboot. So a
    // reset that failed must not have already deleted the WiFi profiles or
    // reset the login password — that would strand a WiFi-only device offline
    // with credentials the owner does not have.
    mockFs.rm.mockImplementation(((p: unknown) =>
      typeof p === "string" && p.endsWith("auth.json")
        ? Promise.reject(new Error("EACCES: permission denied"))
        : Promise.resolve()) as unknown as typeof fs.rm);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await resetPost();
    warnSpy.mockRestore();

    expect(res.status).toBe(500);
    const calls = mockExecFile.mock.calls.map(([cmd, args]) => `${cmd} ${(args as string[])?.join(" ")}`);
    expect(calls.some((c) => c.includes("connection delete"))).toBe(false);
    expect(calls.some((c) => c.includes("clawbox-root-update@chpasswd"))).toBe(false);
    expect(calls.some((c) => c.includes("systemctl reboot"))).toBe(false);
  });
});
