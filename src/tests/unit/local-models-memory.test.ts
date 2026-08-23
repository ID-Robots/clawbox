import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-504 — whose memory is it?
 *
 * `processMemoryBytes` finds processes with `pgrep -f`, which matches the whole
 * command line. Ollama ships its own inference server literally named
 * `llama-server`, so the pattern that finds llama.cpp finds Ollama's too, and a
 * box running both engines showed Ollama's memory twice: once on the Ollama row
 * and once added to the Local LLM row. On the 8 GB box where this was measured
 * that turned a real 5.3 GB into a claimed 7.6 GB.
 *
 * The numbers below are the ones measured on 192.168.50.177 on 2026-08-23.
 */

let pgrepStdout = "";

vi.mock("child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => cb(null, { stdout: pgrepStdout, stderr: "" }),
}));

const PROC: Record<string, string> = {
  // llama.cpp's own server — the Local LLM row's process.
  "/proc/29942/cmdline": "/usr/local/bin/llama-server\u0000--host\u0000127.0.0.1\u0000--port\u00008080\u0000",
  "/proc/29942/status": "Name:\tllama-server\nVmRSS:\t2682652 kB\n",
  // Ollama's bundled server, same file name, different directory.
  "/proc/30519/cmdline": "/usr/local/lib/ollama/llama-server\u0000--model\u0000/usr/share/ollama/blob\u0000",
  "/proc/30519/status": "Name:\tllama-server\nVmRSS:\t2592936 kB\n",
  // A shell that merely mentions the name, which `pgrep -f` also matches.
  "/proc/30821/cmdline": "bash\u0000-c\u0000pgrep -af llama-server\u0000",
  "/proc/30821/status": "Name:\tbash\nVmRSS:\t2600 kB\n",
};

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(async (p: string) => {
      if (p in PROC) return PROC[p];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    readdir: vi.fn(async () => []),
    stat: vi.fn(async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }),
    access: vi.fn(async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }),
  },
}));

let processMemoryBytes: typeof import("@/lib/local-models")["processMemoryBytes"];

beforeEach(async () => {
  vi.resetModules();
  ({ processMemoryBytes } = await import("@/lib/local-models"));
});

const MB = 1024;

describe("processMemoryBytes", () => {
  it("sums every match when nothing is excluded", async () => {
    pgrepStdout = "29942\n30519\n30821\n";

    expect(await processMemoryBytes("llama-server")).toBe(
      (2682652 + 2592936 + 2600) * MB,
    );
  });

  it("leaves Ollama's server out of the llama.cpp total", async () => {
    // The defect: without this filter the Local LLM row reported 5.0 GB for a
    // process using 2.68 GB, and the missing 2.54 GB was Ollama's — already
    // reported on its own row.
    pgrepStdout = "29942\n30519\n30821\n";

    expect(await processMemoryBytes("llama-server", /[/\\]ollama[/\\]/)).toBe(
      (2682652 + 2600) * MB,
    );
  });

  it("returns null when nothing matched at all", async () => {
    pgrepStdout = "";

    expect(await processMemoryBytes("llama-server")).toBeNull();
  });

  it("returns null when every match was excluded", async () => {
    // Not zero: "no llama.cpp process" and "a llama.cpp process using no
    // memory" are different claims, and the row renders the second one.
    pgrepStdout = "30519\n";

    expect(await processMemoryBytes("llama-server", /[/\\]ollama[/\\]/)).toBeNull();
  });

  it("skips a process whose files vanished mid-read rather than failing the row", async () => {
    pgrepStdout = "29942\n99999\n";

    expect(await processMemoryBytes("llama-server", /[/\\]ollama[/\\]/)).toBe(2682652 * MB);
  });
});
