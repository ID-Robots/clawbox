/**
 * ensureMicrosoftTtsExcluded (src/lib/openclaw-config.ts).
 *
 * Measured on this box: OpenClaw's speech chain was ClawBox AI → Microsoft →
 * Kokoro, because the bundled Microsoft provider outranks the local CLI and
 * nothing in config reorders that. The boot repair writes the one documented
 * switch that removes it — and the properties pinned here are its two guards:
 * an owner's explicit boolean is never overwritten, and a box with no voice of
 * its own is left alone rather than silenced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("fs/promises", () => ({
  // `stat` and `chmod`: writeConfig preserves the mode of the file it replaces
  // (rename swaps the inode), so a mocked filesystem has to answer both.
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    chmod: vi.fn(),
    stat: vi.fn(async () => ({ mode: 0o600 })),
  },
}));
vi.mock("fs", () => ({ default: { readFileSync: vi.fn(), existsSync: vi.fn() } }));

const mockFs = vi.mocked(fs);

function withConfig(config: unknown): void {
  mockFs.readFile.mockResolvedValue(JSON.stringify(config));
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.rename.mockResolvedValue(undefined);
  mockFs.mkdir.mockResolvedValue(undefined);
}

function written(): Record<string, unknown> {
  const call = mockFs.writeFile.mock.calls.at(-1);
  if (!call) throw new Error("nothing was written");
  return JSON.parse(String(call[1]));
}

let lib: typeof import("@/lib/openclaw-config");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  lib = await import("@/lib/openclaw-config");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureMicrosoftTtsExcluded", () => {
  it("switches Microsoft off on a box that has its own voice", async () => {
    withConfig({ messages: { tts: { provider: "openai", providers: { "tts-local-cli": { command: "/x" }, openai: { baseUrl: "u" } } } } });
    expect(await lib.ensureMicrosoftTtsExcluded()).toBe(true);
    const cfg = written() as { messages: { tts: { providers: Record<string, { enabled?: boolean }> } } };
    expect(cfg.messages.tts.providers.microsoft).toEqual({ enabled: false });
    // Everything else rides along untouched.
    expect(cfg.messages.tts.providers["tts-local-cli"]).toEqual({ command: "/x" });
  });

  it("is idempotent once written", async () => {
    withConfig({ messages: { tts: { providers: { "tts-local-cli": {}, microsoft: { enabled: false } } } } });
    expect(await lib.ensureMicrosoftTtsExcluded()).toBe(false);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("leaves an owner's explicit choice alone, in either direction", async () => {
    withConfig({ messages: { tts: { providers: { "tts-local-cli": {}, microsoft: { enabled: true, voice: "en-GB-SoniaNeural" } } } } });
    expect(await lib.ensureMicrosoftTtsExcluded()).toBe(false);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("does not silence a box that has no voice of its own", async () => {
    withConfig({ messages: { tts: { providers: { openai: { baseUrl: "u" } } } } });
    expect(await lib.ensureMicrosoftTtsExcluded()).toBe(false);
    withConfig({});
    expect(await lib.ensureMicrosoftTtsExcluded()).toBe(false);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });
});
