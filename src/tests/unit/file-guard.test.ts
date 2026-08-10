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
    `${home}/.hermes/config.yaml`,        // dashboard secret + ClawBox AI token
    `${home}/.hermes/.env`,               // provider keys
    `${home}/.hermes/auth.json`,          // OAuth tokens
    `${home}/.hermes/config.yaml.bak-basicauth`,
    `${home}/.codex/auth.json`,
    `${home}/.gnupg/secring.gpg`,
    `${home}/.aws/credentials`,
    `${home}/.config/gcloud/credentials.db`,
    `${home}/.config/gh/hosts.yml`,
  ])("flags credential store %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(true);
  });

  it("flags the ClawBox data-dir secrets", () => {
    for (const n of [".session-secret", ".mcp-token", ".local-ai-token", ".hermes-dashboard-pw", "config.json", "kv.json"]) {
      expect(guard.isProtectedFilePath(path.join(DATA_DIR, n))).toBe(true);
    }
  });

  it.each([
    `${home}/.kube/config`,
    `${home}/.docker/config.json`,
    `${home}/.config/rclone/rclone.conf`,
    `${home}/.netrc`,
    `${home}/.npmrc`,
    `${home}/.pypirc`,
    `${home}/.pgpass`,
    `${home}/.git-credentials`,
    `${home}/.config/git/credentials`,
  ])("flags dev-box credential store %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(true);
  });

  it.each([
    `${home}/notopenclaw/file.txt`,   // .openclaw pattern must not match without the dot
    `${home}/my.openclaw-backup/x`,   // trailing char is '-', not '/'
    `${home}/.ssh-notes.txt`,         // .ssh must be a full segment
    `${home}/hermes-notes/todo.md`,   // .hermes must be a full dot-segment
    `${home}/.hermes-backup.txt`,
    `${home}/.config/git/config`,     // gitconfig is NOT the credential file
    `${home}/project/.npmrc.example`, // basename must match exactly
  ])("does NOT over-block %s", (p) => {
    expect(guard.isProtectedFilePath(p)).toBe(false);
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
