// Unit tests for scripts/public-hygiene.mjs (TASK-1366). No dependencies:
//
//   node --test scripts/public-hygiene.test.mjs
//
// Run by the `public-hygiene` check (.github/workflows/public-hygiene.yml) and
// by `npm test` through src/tests/unit/public-hygiene.test.ts.
//
// Every value a finding is about is ASSEMBLED here (`ip(10, 1, 2, 3)`), never
// written out: this file is scanned by the very check it tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DiffReader,
  INTERNAL_NAME_SHA256,
  SUPPORT_CONTACT,
  allowReason,
  inspectLine,
  isLockfile,
  redactText,
  sha256,
} from "./public-hygiene.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "public-hygiene.mjs");

const ip = (...octets) => octets.join(".");
const v6 = (...groups) => groups.join(":");
const home = (user, dir = "home") => ["", dir, user].join("/");
const email = (local, domain) => [local, domain].join("@");

const categories = (line, options) => inspectLine(line, options).categories;
const NONE = new Set();
const NAMES = new Set([sha256("labhost7"), sha256("lab.example.net")]);

describe("private-ip", () => {
  it("finds 10/8, 172.16/12 and 192.168/16", () => {
    for (const address of [ip(10, 1, 2, 3), ip(172, 16, 5, 4), ip(172, 31, 255, 1), ip(192, 168, 50, 7)]) {
      assert.deepEqual(categories(`ssh clawbox@${address} -p 22`), ["private-ip"], address);
      assert.deepEqual(categories(`http://${address}:3000/`), ["private-ip"], address);
      assert.deepEqual(categories(`ip=${address}.`), ["private-ip"], address);
    }
  });

  it("finds a lab subnet written as a range", () => {
    assert.deepEqual(categories(`allow ${ip(192, 168, 50, 0)}/24`), ["private-ip"]);
  });

  it("finds fc00::/7 and fe80::/10 hosts", () => {
    for (const address of [v6("fd12", "3456", "", "1"), v6("fe80", "", "1"), v6("FE80", "", "1ff", "fe23"), v6("fc00", "", "7"), v6("febf", "", "2")]) {
      assert.deepEqual(categories(`addr ${address}/64`), ["private-ip"], address);
    }
  });

  it("leaves public, loopback and documentation addresses alone", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", ip(172, 15, 0, 1), ip(172, 32, 0, 1), ip(11, 0, 0, 1), "127.0.0.1", "127.53.1.9", "0.0.0.0", "192.0.2.10", "198.51.100.4", "203.0.113.200", "2001:db8::1", "::1"]) {
      assert.deepEqual(categories(`host ${address}`), [], address);
    }
  });

  it("leaves the product's own setup hotspot alone", () => {
    for (const address of ["10.42.0.1", "10.43.0.1", "10.42.0.12", "10.42.0.0/24"]) assert.deepEqual(categories(`AP ${address}`), [], address);
    assert.deepEqual(categories(`AP ${ip(10, 42, 1, 1)}`), ["private-ip"]);
  });

  it("leaves a private range named by its base address alone", () => {
    assert.deepEqual(categories("PRIVATE_V4=\"10.0.0.0/8 172.16.0.0/12 192.168.0.0/16\""), []);
    assert.deepEqual(categories("PRIVATE_V6=\"fc00::/7 fd00::/8 fe80::/10\" and link-local fe80::"), []);
  });

  it("is not fooled by versions and other dotted numbers", () => {
    assert.deepEqual(categories("v10.1.2.3 and 1.10.0.1 and 10.1.2.3.4 and 10.0.0.256 and fd12"), []);
    assert.deepEqual(categories("cafe80::1 and feed::1 and fd12:3456"), []);
  });
});

describe("home-path", () => {
  it("finds /home/<name> and /Users/<name>", () => {
    assert.deepEqual(categories(`cd ${home("station1")}/clawbox`), ["home-path"]);
    assert.deepEqual(categories(`open ${home("bob", "Users")}/Projects`), ["home-path"]);
    assert.deepEqual(categories(`"${home("clawbox2")}/x"`), ["home-path"]);
  });

  it("leaves /home/clawbox, placeholders and relative paths alone", () => {
    for (const line of ["/home/clawbox/clawbox", "under /home/clawbox.", "/home/<user>/x", "/home/$USER/x", "/home/${USER}", "~/.openclaw", "src/home/x", "/Users/Shared/x", "/home/"]) {
      assert.deepEqual(categories(line), [], line);
    }
  });
});

describe("staff-email", () => {
  it("finds addresses at the company's domains", () => {
    assert.deepEqual(categories(`mail ${email("someone", "idrobots.com")}`), ["staff-email"]);
    assert.deepEqual(categories(`mailto:${email("Someone", "Lab.IDRobots.com")}`), ["staff-email"]);
    assert.deepEqual(categories(`<${email("ops", "clawbox.com")}>`), ["staff-email"]);
  });

  it("leaves the published support contact alone, in any case", () => {
    assert.equal(SUPPORT_CONTACT, "yanko@idrobots.com");
    assert.deepEqual(categories("Email yanko@idrobots.com or Yanko@IDRobots.com"), []);
  });

  it("leaves other domains alone", () => {
    assert.deepEqual(categories("owner@example.com git@github.com yanko@idrobots.com.example coding-agent@clawbox.local"), []);
  });
});

describe("internal-name", () => {
  it("finds a listed name as a word, in a compound and in any case", () => {
    assert.deepEqual(categories("ssh labhost7 uptime", { names: NAMES }), ["internal-name"]);
    assert.deepEqual(categories("runner labhost7-nano-lab-2", { names: NAMES }), ["internal-name"]);
    assert.deepEqual(categories("on LabHost7", { names: NAMES }), ["internal-name"]);
    assert.deepEqual(categories("https://dash.lab.example.net/x", { names: NAMES }), ["internal-name"]);
  });

  it("does not match a longer word", () => {
    assert.deepEqual(categories("labhost77 and labhost", { names: NAMES }), []);
  });

  it("keeps the built-in list as SHA-256 hashes only", () => {
    assert.ok(INTERNAL_NAME_SHA256.size > 0);
    for (const hash of INTERNAL_NAME_SHA256) assert.match(hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(categories("the lab host, a nano-lab runner, beta and main"), []);
  });
});

describe("token", () => {
  it("finds the shapes of real credentials", () => {
    const tokens = [
      "ghp_" + "a1".repeat(18),
      "github_pat_" + "A".repeat(22) + "_" + "b".repeat(59),
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "xoxb-" + "1234567890-1234567890-" + "a".repeat(24),
      "sk-ant-api03-" + "x".repeat(93),
      "sk-" + "a".repeat(48),
      "AIza" + "b".repeat(35),
      "glpat-" + "c".repeat(20),
      "hf_" + "d".repeat(34),
      "123456789:AA" + "e".repeat(33),
      "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
    ];
    for (const token of tokens) assert.deepEqual(categories(`value ${token}`, { names: NONE }), ["token"], token.slice(0, 12));
  });

  it("leaves the tests' short made-up keys alone", () => {
    assert.deepEqual(categories('const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";'), []);
    assert.deepEqual(categories("posted with xoxb-11111111-2222222222"), []);
  });
});

describe("the allow marker", () => {
  const line = `const LAN = "${ip(192, 168, 1, 20)}";`;

  it("exempts a line when it gives a reason", () => {
    assert.deepEqual(inspectLine(`${line} // public-hygiene: allow a generic LAN example`), { categories: [], allowed: true, markerWithoutReason: false });
    assert.equal(inspectLine(`${line} <!-- public-hygiene: allow (a generic LAN example) -->`).allowed, true);
    assert.equal(inspectLine(`${line} # public-hygiene: allow — a generic LAN example`).allowed, true);
  });

  it("does not count without a reason", () => {
    for (const marker of ["// public-hygiene: allow", "<!-- public-hygiene: allow -->", "# public-hygiene: allow: ok"]) {
      assert.deepEqual(inspectLine(`${line} ${marker}`), { categories: ["private-ip"], allowed: false, markerWithoutReason: true }, marker);
    }
  });

  it("reads the reason", () => {
    assert.equal(allowReason("x"), null);
    assert.equal(allowReason("x # public-hygiene: allow"), "");
    assert.equal(allowReason("x /* public-hygiene: allow: the AP's address */"), "the AP's address");
  });
});

describe("redactText", () => {
  it("replaces each finding with a placeholder and keeps the rest", () => {
    const counts = {};
    const text = `board ${ip(192, 168, 50, 183)} log ${home("station1")}/x.log by ${email("someone", "idrobots.com")} on labhost7\nok - done`;
    assert.equal(
      redactText(text, { names: NAMES }, counts),
      "board <private-ip> log /home/<user>/x.log by <email> on <internal-name>\nok - done",
    );
    assert.deepEqual(counts, { "private-ip": 1, "home-path": 1, "staff-email": 1, "internal-name": 1 });
  });

  it("masks a given value first, as a whole address only", () => {
    const board = ip(192, 168, 50, 18);
    const masks = [{ value: board, placeholder: "<board-ip>" }];
    assert.equal(redactText(`a ${board} b ${board}3 c ${board}:22`, { masks }), "a <board-ip> b <private-ip> c <board-ip>:22");
    assert.equal(redactText("lab at 203.0.113.9", { masks: [{ value: "203.0.113.9", placeholder: "<board-ip>" }] }), "lab at <board-ip>");
    assert.equal(redactText("nothing", { masks: [{ value: "", placeholder: "<board-ip>" }] }), "nothing");
  });

  it("masks and redacts an address glued to a word", () => {
    const board = ip(192, 168, 50, 18);
    const masks = [{ value: board, placeholder: "<board-ip>" }];
    assert.equal(redactText(`known_hosts_${board} host${board}x`, { masks }), "known_hosts_<board-ip> host<board-ip>x");
    assert.equal(redactText(`eth0_${ip(10, 9, 8, 7)} up`), "eth0_<private-ip> up");
    // A scan stays strict: a word glued to digits is not taken for an address.
    assert.deepEqual(categories(`v${ip(10, 1, 2, 3)}`), []);
  });

  it("honours no allow marker", () => {
    assert.equal(redactText(`${ip(10, 9, 8, 7)} # public-hygiene: allow a reason`), "<private-ip> # public-hygiene: allow a reason");
  });

  it("leaves what is allowed as it is", () => {
    const text = "AP 10.42.0.1, docs 192.0.2.10, /home/clawbox, yanko@idrobots.com, 10.0.0.0/8";
    assert.equal(redactText(text), text);
  });
});

describe("DiffReader", () => {
  it("numbers the added lines of each file", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,0 +2,2 @@ heading",
      "+second",
      "++++ third, starting with plus signs",
      "@@ -9 +11 @@",
      "-gone",
      "+eleventh",
      "\\ No newline at end of file",
      'diff --git "a/sp ace\\tx" "b/sp ace\\tx"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/sp ace\\tx"',
      "@@ -0,0 +1 @@",
      "+tabbed",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-was here",
    ];
    const reader = new DiffReader();
    const added = diff.map((line) => reader.feed(line)).filter(Boolean);
    assert.deepEqual(added, [
      { file: "a.txt", line: 2, text: "second" },
      { file: "a.txt", line: 3, text: "+++ third, starting with plus signs" },
      { file: "a.txt", line: 11, text: "eleventh" },
      { file: "sp ace\tx", line: 1, text: "tabbed" },
    ]);
  });

  it("knows a lockfile", () => {
    for (const file of ["package-lock.json", "web/bun.lock", "Cargo.lock", "pnpm-lock.yaml"]) assert.equal(isLockfile(file), true, file);
    assert.equal(isLockfile("src/lock.ts"), false);
  });
});

const run = (args, options = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...options });

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-hygiene-"));
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  return { dir, git, write: (file, text) => fs.writeFileSync(path.join(dir, file), text) };
}

describe("the CLI", () => {
  it("scan-diff reports file:line and category of added lines only, never the value", () => {
    const { dir, git, write } = repo();
    const secret = ip(192, 168, 50, 183);
    write("a.txt", "one\n");
    write("moved.txt", `old ${secret}\n`);
    write("gone.txt", `gone ${secret}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    write("a.txt", `one\nboard ${secret}\nAP 10.42.0.1\nlan ${ip(10, 1, 1, 1)} # public-hygiene: allow a generic example\nhome ${home("station1")}\n`);
    write("package-lock.json", `{"x": "${secret}"}\n`);
    git("mv", "moved.txt", "renamed.txt");
    git("rm", "-q", "gone.txt");
    git("add", "-A");
    git("commit", "-q", "-m", "head");

    const r = run(["scan-diff", base, "HEAD"], { cwd: dir, env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" } });
    assert.equal(r.status, 1, r.stderr);
    const findings = r.stdout.split("\n").filter((l) => /^\S+:\d+: /.test(l));
    assert.deepEqual(findings, ["a.txt:2: private-ip", "a.txt:5: home-path"]);
    assert.match(r.stdout, /2 of 4 added lines \(in 1 file\)/);
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));
    assert.ok(!r.stdout.includes("station1"));
  });

  it("scan-diff annotates and summarizes on GitHub Actions, still without values", () => {
    const { dir, git, write } = repo();
    write("a.md", "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    write("a.md", `x\n${email("someone", "idrobots.com")}\n`);
    git("commit", "-q", "-am", "head");
    const summary = path.join(dir, "summary.md");
    const r = run(["scan-diff", base], { cwd: dir, env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^::error file=a\.md,line=2,title=public-hygiene::staff-email$/m);
    const md = fs.readFileSync(summary, "utf8");
    assert.match(md, /\| <code>a\.md<\/code> \| 2 \| staff-email \|/);
    assert.ok(!md.includes("someone") && !r.stdout.includes("someone"));
  });

  it("scan-diff passes a clean change and refuses a bad ref", () => {
    const { dir, git, write } = repo();
    write("a.txt", "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    write("a.txt", "one\ntwo at 192.0.2.10 and /home/clawbox\n");
    git("commit", "-q", "-am", "head");
    const clean = run(["scan-diff", base], { cwd: dir, env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" } });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /1 added lines checked, nothing to report/);
    assert.equal(run(["scan-diff", "no-such-ref"], { cwd: dir }).status, 2);
    assert.equal(run(["scan-diff", "--output=x"], { cwd: dir }).status, 2);
  });

  it("scan-files checks every line", () => {
    const { dir, write } = repo();
    write("notes.md", `fine\nalso fine\nboard ${ip(172, 20, 0, 9)}\n`);
    const r = run(["scan-files", path.join(dir, "notes.md")], { env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /notes\.md:3: private-ip/);
  });

  it("redact copies stdin to stdout with placeholders, masking an env value", () => {
    const board = ip(192, 168, 50, 183);
    const r = run(["redact", "--mask-env", "BOARD=<board-ip>"], {
      input: `ssh ${board}\nother ${ip(10, 0, 0, 5)}\nno newline at the end`,
      env: { ...process.env, BOARD: board },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "ssh <board-ip>\nother <private-ip>\nno newline at the end");
  });

  it("redact-files rewrites text in place and deletes what is not text", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-hygiene-files-"));
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ reason: `failed on ${ip(192, 168, 50, 9)}` }));
    fs.writeFileSync(path.join(dir, "sub", "10-x.log"), `log in ${home("station1")}/w\n`);
    fs.writeFileSync(path.join(dir, "core.bin"), Buffer.from([1, 0, 2]));
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "public-hygiene-outside-")), "host.txt");
    fs.writeFileSync(outside, `host ${ip(10, 9, 8, 7)}\n`);
    fs.symlinkSync(outside, path.join(dir, "linked.log"));
    const r = run(["redact-files", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")), { reason: "failed on <private-ip>" });
    assert.equal(fs.readFileSync(path.join(dir, "sub", "10-x.log"), "utf8"), "log in /home/<user>/w\n");
    assert.equal(fs.existsSync(path.join(dir, "core.bin")), false);
    // A link would be uploaded as what it points at: it goes, its target stays as it was.
    assert.equal(fs.existsSync(path.join(dir, "linked.log")), false);
    assert.equal(fs.readFileSync(outside, "utf8"), `host ${ip(10, 9, 8, 7)}\n`);
    assert.match(r.stderr, /removed linked\.log: not a regular file/);
    assert.match(r.stderr, /redacted 1 private-ip, 1 home-path in 2 files/);
  });

  it("works when run through a linked folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-hygiene-link-"));
    fs.symlinkSync(path.dirname(SCRIPT), path.join(dir, "linked"));
    const linked = path.join(dir, "linked", path.basename(SCRIPT));
    fs.writeFileSync(path.join(dir, "notes.md"), `board ${ip(10, 9, 8, 7)}\n`);
    const scan = spawnSync(process.execPath, [linked, "scan-files", path.join(dir, "notes.md")], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" } });
    assert.equal(scan.status, 1, scan.stdout + scan.stderr);
    assert.match(scan.stdout, /notes\.md:1: private-ip/);
    const redact = spawnSync(process.execPath, [linked, "redact"], { input: `x ${ip(10, 9, 8, 7)}\n`, encoding: "utf8" });
    assert.equal(redact.stdout, "x <private-ip>\n");
  });

  it("refuses bad usage", () => {
    assert.equal(run([]).status, 2);
    assert.equal(run(["scan-files"]).status, 2);
    assert.equal(run(["redact", "--mask-env", "1BAD"], { input: "" }).status, 2);
    assert.equal(run(["--help"]).status, 0);
  });
});
