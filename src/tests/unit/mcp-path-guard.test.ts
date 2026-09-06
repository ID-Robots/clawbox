import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  isAllowedPath,
  filterAllowedPaths,
  assertPathAllowed,
  assertWritePathAllowed,
  commandDeniedByPathGuard,
  resolveGuardedPath,
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

  // A RELATIVE redirection names no path at all, so the command text holds no
  // root for a matcher to anchor on — but `bash` is handed the working
  // directory as an argument, and `echo x > config.json` issued from inside the
  // tree truncates a protected file just the same. This is the one assertion
  // that pins `destructiveToken`'s redirection arm; without it the arm could be
  // dropped and every other case here would stay green.
  it.each([
    "echo broken > config.json",
    "echo more >> config.json",
    "ls && echo y > package.json",
    "printf x 2> build.log",
  ])("refuses %s issued from inside the tree", (command) => {
    expect(commandDeniedByPathGuard(command, TREE)).toBeTruthy();
    // …and the identical command from an ordinary directory is not this
    // rule's business: the cwd is what makes it destructive here.
    expect(commandDeniedByPathGuard(command, "/var/tmp")).toBeNull();
  });

  it("does not read a redirection into a command that has none", () => {
    expect(commandDeniedByPathGuard("cat config.json", TREE)).toBeNull();
    expect(commandDeniedByPathGuard("grep -rn 'x' .", TREE)).toBeNull();
  });
});

// ── The two ways a write reaches a protected path without naming one ────────
describe("mcp path guard — a link into the tree is still the tree", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clawbox-link-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a write whose PARENT is a symlink into the model folder", () => {
    // `resolveUserPath` normalises `..` and `~` and does not follow links, so a
    // link the agent planted earlier reaches the guard as a path with no
    // protected root in it at all.
    const models = path.join(dir, "clawbox", "data", "llamacpp", "models");
    mkdirSync(models, { recursive: true });
    const link = path.join(dir, "notes");
    symlinkSync(models, link);

    expect(() => assertWritePathAllowed(path.join(link, "gemma.gguf"))).toThrow();
    // …and the read is still allowed, which is the whole point of the split.
    expect(() => assertPathAllowed(path.join(link, "gemma.gguf"))).not.toThrow();
  });

  it("still allows a write through a link that goes somewhere ordinary", () => {
    const real = path.join(dir, "scratch");
    mkdirSync(real, { recursive: true });
    const link = path.join(dir, "via");
    symlinkSync(real, link);
    expect(() => assertWritePathAllowed(path.join(link, "notes.md"))).not.toThrow();
  });
});

// ── The LEAF link, and the deep path under one ──────────────────────────────
//
// The write rule above resolved the parent; the read rule resolved nothing of
// its own — file-guard's inventory saw the target, the device-node and dotenv
// rules saw the typed name. So a benignly named link to `.env`, to
// `/proc/self/environ` or to `/dev/zero` passed both, and a leaf link into
// the TASK-605 tree passed the write rule that exists to refuse it. Every rule
// now judges the canonical path as well, resolved to the nearest existing
// ancestor so a path two segments below a link is judged where it would land.
describe("mcp path guard — a link is judged by its target", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clawbox-leaf-link-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function link(name: string, target: string): string {
    const p = path.join(dir, name);
    symlinkSync(target, p);
    return p;
  }

  it("refuses a benign name that links to a dotenv file, for read and write", () => {
    const env = path.join(dir, ".env");
    writeFileSync(env, "SECRET=1\n");
    const notes = link("notes.txt", env);
    expect(isAllowedPath(notes)).toBe(false);
    let thrown: unknown;
    try {
      assertPathAllowed(notes);
    } catch (err) {
      thrown = err;
    }
    const e = thrown as { code?: string; message?: string };
    expect(e.code).toBe("BLOCKED_PATH");
    // Still no map of where the secrets are.
    expect(e.message).not.toContain(".env");
    expect(e.message).not.toContain(dir);
    expect(() => assertWritePathAllowed(notes)).toThrow();
  });

  it.skipIf(!existsSync("/proc/self/environ"))("refuses a link to the process environment", () => {
    const readme = link("readme.md", "/proc/self/environ");
    expect(isAllowedPath(readme)).toBe(false);
    expect(() => assertPathAllowed(readme)).toThrow();
    expect(() => assertWritePathAllowed(readme)).toThrow();
  });

  it.skipIf(!existsSync("/dev/zero"))("refuses a link to a device node", () => {
    const z = link("z", "/dev/zero");
    expect(isAllowedPath(z)).toBe(false);
    expect(() => assertPathAllowed(z)).toThrow();
  });

  it("refuses a WRITE through a leaf link into the ClawBox tree, and allows the read", () => {
    const tree = path.join(dir, "clawbox");
    mkdirSync(tree, { recursive: true });
    const readme = path.join(tree, "README.md");
    writeFileSync(readme, "# clawbox\n");
    const pkg = link("pkg.md", readme);
    expect(() => assertWritePathAllowed(pkg)).toThrow();
    expect(() => assertPathAllowed(pkg)).not.toThrow();
  });

  it("refuses a deep new path under a link into the ClawBox tree", () => {
    const tree = path.join(dir, "clawbox");
    mkdirSync(tree, { recursive: true });
    const via = link("tree", tree);
    // Neither the leaf nor its parent exists: both single resolves fail, and
    // the typed spelling names no protected root.
    expect(() => assertWritePathAllowed(path.join(via, "newdir", "x.ts"))).toThrow();
  });

  it("refuses a deep new path under a link into a credential directory", () => {
    const ssh = path.join(dir, ".ssh");
    mkdirSync(ssh, { recursive: true });
    const via = link("sshl", ssh);
    expect(isAllowedPath(path.join(via, "newdir", "k"))).toBe(false);
    expect(() => assertWritePathAllowed(path.join(via, "newdir", "k"))).toThrow();
  });

  it("still reads and writes a link to an ordinary file", () => {
    // A symlinked file inside an ordinary project is legitimate; only its
    // TARGET is judged now, and the target is fine.
    const real = path.join(dir, "scratch", "notes.md");
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, "hello\n");
    const alias = link("alias.md", real);
    expect(isAllowedPath(alias)).toBe(true);
    expect(() => assertPathAllowed(alias)).not.toThrow();
    expect(() => assertWritePathAllowed(alias)).not.toThrow();
  });

  it("refuses a dangling link into a credential directory — the kernel would create the target", () => {
    // `realpathSync` refuses a link whose target is absent exactly as it
    // refuses a missing file, and judging the link by its PARENT said the
    // write landed beside the link. It does not: open(2) follows the link
    // and creates ~/.ssh/authorized_keys. The predicate has to say no here,
    // not leave it to the sink's O_NOFOLLOW with the wrong words.
    const ssh = path.join(dir, ".ssh");
    mkdirSync(ssh, { recursive: true });
    const keys = link("keys.txt", path.join(ssh, "authorized_keys"));
    expect(isAllowedPath(keys)).toBe(false);
    expect(() => assertPathAllowed(keys)).toThrow();
    expect(() => assertWritePathAllowed(keys)).toThrow();
    expect(() => resolveGuardedPath(keys, "write")).toThrow();
  });

  it("refuses a dangling link into the ClawBox tree on the write side", () => {
    const tree = path.join(dir, "clawbox");
    mkdirSync(tree, { recursive: true });
    const draft = link("draft.ts", path.join(tree, "src", "new.ts"));
    expect(() => assertWritePathAllowed(draft)).toThrow();
    expect(() => assertPathAllowed(draft)).not.toThrow();
  });

  it("allows a dangling link into an ordinary place, and hands the sink the target", () => {
    // A legitimate dangling link — a project's `latest.log -> logs/today.log`
    // before the first line is written — is judged where it lands, and the
    // sink is given that name so the file is created there, as open(2) would.
    const target = path.join(dir, "nowhere", "gone.txt");
    const dangling = link("gone.txt", target);
    expect(isAllowedPath(dangling)).toBe(true);
    expect(() => assertWritePathAllowed(dangling)).not.toThrow();
    expect(resolveGuardedPath(dangling, "write")).toBe(path.join(realpathSync(dir), "nowhere", "gone.txt"));
  });

  it("answers a cycle of links by the typed spelling and leaves the refusal to the sink", () => {
    const loop = path.join(dir, "loop");
    symlinkSync(loop, loop);
    // Nothing on disk to judge: the typed name is ordinary, so the predicate
    // passes and resolveGuardedPath hands back the name as typed — which the
    // sinks open with O_NOFOLLOW and refuse (mcp-file-tool-paths.test.ts).
    expect(isAllowedPath(loop)).toBe(true);
    expect(resolveGuardedPath(loop, "read")).toBe(loop);
  });

  it("resolves the path ONCE, so the sink is handed the string the guard judged", () => {
    // Two resolves of one spelling are two walks of the tree, and a link
    // swapped between them would have the sink open a target nobody vetted —
    // the exact window the canonical-path design exists to close. Count the
    // walks: file-guard calls `fs.realpathSync` through the module object, so
    // a spy on it sees every one.
    const real = path.join(dir, "scratch", "once.md");
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, "hello\n");
    // Resolved BEFORE the spy goes in, so this test's own call is not counted.
    const expected = realpathSync(real);
    const spy = vi.spyOn(fs, "realpathSync");
    try {
      expect(resolveGuardedPath(real, "read")).toBe(expected);
      expect(spy.mock.calls.filter(([p]) => p === real)).toHaveLength(1);
      spy.mockClear();
      expect(resolveGuardedPath(real, "write")).toBe(expected);
      expect(spy.mock.calls.filter(([p]) => p === real)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("still refuses a typed dotenv name that links somewhere harmless", () => {
    // Both spellings must pass: to the agent that wrote it, `.env` is a
    // dotenv file whatever it points at.
    const plain = path.join(dir, "plain.txt");
    writeFileSync(plain, "x\n");
    const env = link(".env", plain);
    expect(isAllowedPath(env)).toBe(false);
  });

  it("resolveGuardedPath hands the sinks the canonical path", () => {
    const real = path.join(dir, "scratch", "notes.md");
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, "hello\n");
    const alias = link("alias.md", real);
    expect(resolveGuardedPath(alias, "read")).toBe(realpathSync(real));
    expect(resolveGuardedPath(alias, "write")).toBe(realpathSync(real));
    // A plain path comes back as itself (modulo the tmpdir's own links).
    expect(resolveGuardedPath(real, "read")).toBe(realpathSync(real));
    // …and a refused one never comes back at all.
    const env = path.join(dir, ".env");
    writeFileSync(env, "SECRET=1\n");
    expect(() => resolveGuardedPath(link("notes.txt", env), "read")).toThrow();
  });
});
