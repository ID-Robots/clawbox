import { describe, it, expect } from "vitest";
import { isAllowedPath, filterAllowedPaths, assertPathAllowed } from "../../../mcp/lib/guard";

// The MCP's file tools (read_file, write_file, edit_file, list_directory, glob,
// grep, notebook_edit) all funnel through isAllowedPath. These tests pin the
// two properties that matter and that a refactor could quietly lose:
//
//   1. The credential directories are matched for DESCENDANTS, not just for an
//      exact root match. A rule that only blocked the directory itself would
//      still let grep/read_file walk straight into the files inside it.
//   2. Dotenv files are covered. The install's own .env is the environment file
//      clawbox-setup.service loads last, so it is both a read and a write
//      concern.
//
// Paths are written as literal POSIX strings rather than built with path.join,
// so the expectations are identical on a developer's machine and on the device.

const HERMES = "/home/clawbox/.hermes";
const OPENCLAW = "/home/clawbox/.openclaw";

describe("mcp path guard — credential directories", () => {
  it("blocks the ~/.hermes directory itself", () => {
    expect(isAllowedPath(HERMES)).toBe(false);
  });

  it.each([
    `${HERMES}/.env`,
    `${HERMES}/auth.json`,
    `${HERMES}/config.yaml`,
    `${HERMES}/skills/pdf/SKILL.md`,
    `${HERMES}/hermes-agent/website/docs/index.md`,
    `${HERMES}/a/b/c/d/e/deeply-nested.txt`,
  ])("blocks the ~/.hermes descendant %s", (p) => {
    expect(isAllowedPath(p)).toBe(false);
  });

  it.each([
    `${OPENCLAW}/openclaw.json`,
    `${OPENCLAW}/state/openclaw.sqlite`,
    "/home/clawbox/.ssh/id_ed25519",
    "/home/clawbox/.ssh/authorized_keys",
    "/home/clawbox/.codex/auth.json",
    "/home/clawbox/.gnupg/private-keys-v1.d/x.key",
    "/home/clawbox/.aws/credentials",
    "/home/clawbox/.config/gh/hosts.yml",
    "/home/clawbox/.netrc",
    "/home/clawbox/.git-credentials",
  ])("blocks the credential store %s", (p) => {
    expect(isAllowedPath(p)).toBe(false);
  });

  it("does not block a directory that merely starts with the same letters", () => {
    expect(isAllowedPath("/home/clawbox/.hermesx/notes.md")).toBe(true);
    expect(isAllowedPath("/home/clawbox/hermes/notes.md")).toBe(true);
  });

  it("blocks a path that reaches a credential directory through a parent segment", () => {
    expect(isAllowedPath("/home/clawbox/.hermes/skills/../.env")).toBe(false);
  });
});

describe("mcp path guard — dotenv files", () => {
  it.each([
    "/home/clawbox/clawbox/.env",
    "/home/clawbox/clawbox/.env.local",
    "/home/clawbox/clawbox/.env.production",
    "/home/clawbox/clawbox/.env.example",
    "/home/clawbox/clawbox/.envrc",
    "/tmp/.env",
  ])("blocks %s", (p) => {
    expect(isAllowedPath(p)).toBe(false);
  });

  it("still allows ordinary files whose name contains env", () => {
    expect(isAllowedPath("/home/clawbox/clawbox/src/lib/environment.ts")).toBe(true);
    expect(isAllowedPath("/home/clawbox/clawbox/env.d.ts")).toBe(true);
    expect(isAllowedPath("/home/clawbox/clawbox/.env.d/readme.md")).toBe(true);
  });
});

describe("mcp path guard — device and kernel paths", () => {
  it.each([
    "/proc/self/environ",
    "/proc/1/cmdline",
    "/dev/urandom",
    "/dev/sda",
    "/sys/class/net/eth0/address",
  ])("blocks %s", (p) => {
    expect(isAllowedPath(p)).toBe(false);
  });
});

describe("mcp path guard — ordinary project paths stay usable", () => {
  it.each([
    "/home/clawbox/clawbox/package.json",
    "/home/clawbox/clawbox/src/app/page.tsx",
    "/home/clawbox/clawbox/data/webapps/demo/index.html",
    "/home/clawbox/Documents/notes.md",
    "/var/log/syslog",
    "/tmp/scratch.txt",
  ])("allows %s", (p) => {
    expect(isAllowedPath(p)).toBe(true);
  });
});

describe("mcp path guard — list filtering", () => {
  it("drops protected entries from a result list and keeps the rest", () => {
    const input = [
      "/home/clawbox/clawbox/README.md",
      "/home/clawbox/.hermes/config.yaml",
      "/home/clawbox/clawbox/.env",
      "/home/clawbox/clawbox/src/index.ts",
      "/home/clawbox/.ssh/id_rsa",
    ];
    expect(filterAllowedPaths(input)).toEqual([
      "/home/clawbox/clawbox/README.md",
      "/home/clawbox/clawbox/src/index.ts",
    ]);
  });

  it("returns an empty list rather than throwing when everything is protected", () => {
    expect(filterAllowedPaths(["/home/clawbox/.hermes/.env", "/home/clawbox/.ssh/id_rsa"])).toEqual([]);
  });
});

describe("mcp path guard — the refusal the agent sees", () => {
  it("throws BLOCKED_PATH and names no path in the message", () => {
    let thrown: unknown;
    try {
      assertPathAllowed("/home/clawbox/.hermes/.env");
    } catch (err) {
      thrown = err;
    }
    const e = thrown as { code?: string; message?: string; next?: string };
    expect(e.code).toBe("BLOCKED_PATH");
    // The tool is reachable from untrusted page content, so the refusal must not
    // double as a map of where the credentials are.
    expect(e.message).not.toContain(".hermes");
    expect(e.message).not.toContain("/home/clawbox");
    expect(e.next).toBeTruthy();
  });

  it("does not throw for an allowed path", () => {
    expect(() => assertPathAllowed("/home/clawbox/clawbox/README.md")).not.toThrow();
  });
});
