import { describe, it, expect } from "vitest";
import path from "path";
import {
  isAllowedPath,
  filterAllowedPaths,
  assertPathAllowed,
  assertWritePathAllowed,
  commandDeniedByPathGuard,
  SECRET_NAME_RE,
} from "../../../mcp/lib/guard";

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
// Credential-store paths are written as literal POSIX strings rather than built
// with path.join, so the expectations are identical on a developer's machine and
// on the device — those rules are regexes over the string. The data-dir paths
// further down are the exception and say why.

const HERMES = "/home/clawbox/.hermes";
const OPENCLAW = "/home/clawbox/.openclaw";
const CLAWKEEP = "/home/clawbox/.clawkeep";
// Built the way config-store builds DATA_DIR: path.join off CLAWBOX_ROOT,
// which the suite pins to a temp dir (vitest.config.ts keeps tests off the
// real device state), so these expectations follow the SAME root the guard
// resolved. The property under test is descendant-blocking of the data dir,
// wherever it lives. The credential-store paths above stay literal — those
// are matched by regex, not by path arithmetic.
const DATA = path.join(process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox", "data");

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

  it.each([
    CLAWKEEP,
    `${CLAWKEEP}/token`,
    `${CLAWKEEP}/passphrase`,
    `${CLAWKEEP}/config.toml`,
  ])("blocks the backup tool's store %s", (p) => {
    expect(isAllowedPath(p)).toBe(false);
  });

  it("does not block a directory that merely starts with the same letters", () => {
    expect(isAllowedPath("/home/clawbox/.hermesx/notes.md")).toBe(true);
    expect(isAllowedPath("/home/clawbox/hermes/notes.md")).toBe(true);
    expect(isAllowedPath("/home/clawbox/.clawkeep-notes.txt")).toBe(true);
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

// isAllowedPath delegates the data-dir rule to file-guard, whose own suite owns
// the full inventory. These cases pin that the delegation is in place and that
// the tools inherit both halves of the rule — not the inventory again.
describe("mcp path guard — the ClawBox data directory", () => {
  it.each([
    path.join(DATA, "config.json"),
    path.join(DATA, ".session-secret"),
    path.join(DATA, "cloudflared", "cert.pem"),
    // Named at runtime by an atomic write, and a name that does not exist yet:
    // the rule is containment, so neither needs to be listed anywhere.
    path.join(DATA, "oauth-device-tokens.json.tmp.deadbeef"),
    path.join(DATA, "some-future-store.json"),
  ])("blocks the server-state file %s", (p) => {
    expect(isAllowedPath(p)).toBe(false);
  });

  it("leaves the data directory itself reachable", () => {
    expect(isAllowedPath(DATA)).toBe(true);
  });

  it.each([
    path.join(DATA, "webapps", "demo", "index.html"),
    path.join(DATA, "code-projects", "my-app", "app.js"),
  ])("keeps the public subtree entry %s usable", (p) => {
    expect(isAllowedPath(p)).toBe(true);
  });
});

describe("mcp path guard — credential names in a shell string", () => {
  it.each([
    "cat ~/.clawkeep/token",
    "tar czf /tmp/x.tgz $HOME/.clawkeep",
    "cat ~/.ssh/id_rsa",
  ])("recognises %s", (cmd) => {
    expect(SECRET_NAME_RE.test(cmd)).toBe(true);
  });

  it.each([
    "echo clawkeep is a backup tool",
    "cat ~/.clawkeep-notes.txt",
    "ls ~/clawkeep",
  ])("does not fire on %s", (cmd) => {
    expect(SECRET_NAME_RE.test(cmd)).toBe(false);
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

// ── TASK-605: the ClawBox tree and the local-model folders ──────────────────
//
// The deny the two harnesses enforce on their own shells has to hold here too:
// this server gives the agent a SECOND shell (`bash`) and a second set of file
// tools, reached by different tool ids, and a rule with a door in it is not a
// rule. Read stays open — the ruling forbids destroying these paths, not
// looking at them — so the write side is a separate assertion from
// `assertPathAllowed`, and this is where the two are held apart.
//
// Every case below is written so that it answers the same way whatever HOME the
// test machine has: the home-folding half of the rule is exercised against an
// explicit home in src/tests/unit/protected-paths.test.ts.
describe("mcp path guard — protected paths may be read, not written", () => {
  const TREE = "/home/clawbox/clawbox";

  it.each([
    `${TREE}/scripts/gateway-pre-start.sh`,
    `${TREE}/data/llamacpp/models/gemma-4-E2B_q4_0-it.gguf`,
    `${TREE}/data/embed/models/qwen3.gguf`,
    "/mnt/big/check-acbuild/data/llamacpp/models/gemma.gguf",
  ])("refuses a WRITE to %s", (p) => {
    expect(() => assertWritePathAllowed(p)).toThrow();
    // …and still allows the read.
    expect(() => assertPathAllowed(p)).not.toThrow();
  });

  it("says why, because there is nothing secret about where the device keeps its own code", () => {
    let thrown: unknown;
    try {
      assertWritePathAllowed(`${TREE}/README.md`);
    } catch (err) {
      thrown = err;
    }
    const e = thrown as { code?: string; message?: string; next?: string };
    expect(e.code).toBe("BLOCKED_PATH");
    expect(e.message).toContain("protected");
    expect(e.next).toContain("refused it");
  });

  it("leaves ordinary writes alone", () => {
    expect(() => assertWritePathAllowed("/var/tmp/notes.md")).not.toThrow();
  });

  it("still refuses a credential path on the write side", () => {
    expect(() => assertWritePathAllowed("/home/clawbox/.hermes/.env")).toThrow();
  });

  it("recognises a destroying command through the bash pre-flight", () => {
    expect(commandDeniedByPathGuard(`rm -rf ${TREE}/data/llamacpp/models`)).toBeTruthy();
    expect(commandDeniedByPathGuard(`cat ${TREE}/README.md`)).toBeNull();
  });
});
