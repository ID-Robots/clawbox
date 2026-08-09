import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// file-guard reads DATA_DIR from config-store at import time, which resolves
// from CLAWBOX_ROOT — set it before importing so the data-secret paths are
// deterministic under a temp root.
let TEST_ROOT: string;
let DATA_DIR: string;
let guard: typeof import("@/lib/file-guard");

beforeAll(async () => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-fileguard-"));
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  DATA_DIR = path.join(TEST_ROOT, "data");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  guard = await import("@/lib/file-guard");
});

afterAll(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("isProtectedFilePath", () => {
  const home = "/home/clawbox";

  it.each([
    `${home}/.ssh/id_rsa`,
    `${home}/.ssh`,
    `${home}/.openclaw/openclaw.json`,
    `${home}/.openclaw/agents/x/agent/y.sqlite`,
    `${home}/.codex/auth.json`,
    `${home}/.gnupg/secring.gpg`,
    `${home}/.aws/credentials`,
    `${home}/.config/gcloud/credentials.db`,
    `${home}/.config/gh/hosts.yml`,
  ])("flags credential store %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(true);
  });

  it("flags the ClawBox data-dir secrets", () => {
    for (const n of [".session-secret", ".mcp-token", ".local-ai-token", "config.json", "kv.json"]) {
      expect(guard.isProtectedFilePath(path.join(DATA_DIR, n))).toBe(true);
    }
  });

  it.each([
    `${home}/Documents/notes.txt`,
    `${home}/Downloads/photo.png`,
    `${home}/Desktop/config.json`, // a config.json OUTSIDE the data dir is fine
    `${home}/project/src/index.ts`,
  ])("allows ordinary file %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(false);
  });

  it("defeats an in-base symlink pointing at a secret dir (CWE-59)", () => {
    // Real secret dir + an innocuously-named symlink to it. Resolving the link
    // must still classify the target as protected.
    const secretDir = path.join(TEST_ROOT, ".ssh");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "id_rsa"), "KEY");
    const link = path.join(TEST_ROOT, "innocent-link");
    try {
      fs.symlinkSync(secretDir, link, "dir");
    } catch {
      // Some CI filesystems disallow symlinks — skip rather than fail.
      return;
    }
    expect(guard.isProtectedFilePath(path.join(link, "id_rsa"))).toBe(true);
  });
});
