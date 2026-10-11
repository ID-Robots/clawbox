/**
 * "May a pasted picture go to what has this terminal?" (scripts/terminal-foreground.mjs).
 *
 * The Terminal asks before a plain Ctrl+V becomes a pasted picture's path.
 * That key is vim's block select and nano's next page, and both take pastes
 * exactly as a prompt does — so the box answers from the processes: yes only
 * when ONE process is reading the terminal and it is Claude Code or a shell at
 * its prompt. Every case here is a real shape, on a fake /proc.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { foregroundTaker, parseProcStat, programName, takerOf } from "../../../scripts/terminal-foreground.mjs";

const proc = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-fake-proc-"));
const TTY = "/dev/pts/7";
const SHELL = 100;

interface Proc {
  pid: number;
  /** argv; argv[0] is the name the process goes by. */
  argv: string[];
  pgrp: number;
  /** What its standard input is. `null`: cannot be read (another account's). */
  stdin?: string | null;
  state?: string;
  /** The foreground group of the terminal, as every process on it reports it. */
  tpgid: number;
  comm?: string;
}

function put(p: Proc) {
  const dir = path.join(proc, String(p.pid));
  fs.mkdirSync(path.join(dir, "fd"), { recursive: true });
  const comm = p.comm ?? path.basename(p.argv[0] ?? "x");
  // pid (comm) state ppid pgrp session tty_nr tpgid …
  fs.writeFileSync(path.join(dir, "stat"), `${p.pid} (${comm}) ${p.state ?? "S"} 1 ${p.pgrp} ${SHELL} 34823 ${p.tpgid} 4194304 0 0\n`);
  fs.writeFileSync(path.join(dir, "cmdline"), p.argv.map((a) => `${a}\0`).join(""));
  const stdin = p.stdin === undefined ? TTY : p.stdin;
  if (stdin !== null) fs.symlinkSync(stdin, path.join(dir, "fd", "0"));
}

/** The PTY's own login shell, with `tpgid` saying which group is in front. */
function shell(tpgid: number, argv = ["-bash"]) {
  put({ pid: SHELL, argv, pgrp: SHELL, tpgid });
}

const ask = () => foregroundTaker({ pid: SHELL }, proc);

beforeEach(() => {
  fs.rmSync(proc, { recursive: true, force: true });
  fs.mkdirSync(proc, { recursive: true });
  // What a real /proc also holds: entries that are not processes.
  fs.writeFileSync(path.join(proc, "uptime"), "1 1\n");
  fs.mkdirSync(path.join(proc, "self"));
  // A process on another terminal, in a group of its own.
  put({ pid: 900, argv: ["vim", "notes.txt"], pgrp: 900, tpgid: 900, stdin: "/dev/pts/3" });
});

afterAll(() => fs.rmSync(proc, { recursive: true, force: true }));

describe("a picture may go to", () => {
  it("a shell sitting at its prompt", () => {
    shell(SHELL);
    expect(ask()).toEqual({ taker: "shell", name: "bash" });
  });

  it.each([
    [["/usr/bin/zsh", "-l"], "zsh"],
    [["bash", "--login", "-i"], "bash"],
    [["fish"], "fish"],
  ])("an interactive shell started inside it: %j", (argv, name) => {
    shell(200);
    put({ pid: 200, argv, pgrp: 200, tpgid: 200 });
    expect(ask()).toEqual({ taker: "shell", name });
  });

  it("Claude Code", () => {
    shell(200);
    put({ pid: 200, argv: ["claude", "--effort", "high"], pgrp: 200, tpgid: 200, comm: "2.1.296" });
    expect(ask()).toEqual({ taker: "claude", name: "claude" });
  });

  it("Claude Code with its own children around it: they read sockets and pipes, not the terminal", () => {
    shell(200);
    put({ pid: 200, argv: ["claude"], pgrp: 200, tpgid: 200 });
    put({ pid: 201, argv: ["bun", "run", "mcp/clawbox-mcp.ts"], pgrp: 200, tpgid: 200, stdin: "socket:[1346560]" });
    put({ pid: 202, argv: ["/bin/bash", "-c", "npm test"], pgrp: 200, tpgid: 200, stdin: "pipe:[88121]" });
    put({ pid: 203, argv: ["rg", "TODO"], pgrp: 200, tpgid: 200, stdin: "/dev/null" });
    expect(ask()).toEqual({ taker: "claude", name: "claude" });
  });

  it("Claude Code by its full path", () => {
    shell(200);
    put({ pid: 200, argv: ["/home/clawbox/.local/bin/claude"], pgrp: 200, tpgid: 200 });
    expect(ask().taker).toBe("claude");
  });
});

describe("Ctrl+V stays the program's own key in", () => {
  it.each(["vi", "vim", "nvim", "nano", "emacs", "less", "htop", "python3", "man", "tmux", "ssh", "sudo", "cat"])("%s", (program) => {
    shell(200);
    put({ pid: 200, argv: [program, "file"], pgrp: 200, tpgid: 200 });
    expect(ask()).toEqual({ taker: null, name: program });
  });

  it("a pager at the end of a pipeline whose first command has finished and gone", () => {
    // `seq 1 3000 | less`: the group LEADER (seq) is gone. less reads a pipe
    // and opens the terminal itself. node-pty's own name for this is the shell
    // the PTY was started with — which is how a path once got typed into less.
    shell(200);
    put({ pid: 201, argv: ["less"], pgrp: 200, tpgid: 200, stdin: "pipe:[5012]" });
    expect(ask()).toEqual({ taker: null, name: null });
  });

  it("an editor reading a pipeline, its first command still a zombie", () => {
    // `git diff | vi -`
    shell(200);
    put({ pid: 200, argv: ["git", "diff"], pgrp: 200, tpgid: 200, state: "Z", stdin: null });
    put({ pid: 201, argv: ["vi", "-"], pgrp: 200, tpgid: 200, stdin: "pipe:[5013]" });
    expect(ask().taker).toBeNull();
  });

  it("an editor started by a wrapper script that does not exec", () => {
    // Debian's sensible-editor, vimtutor, the owner's own edit.sh: the leader
    // is a shell BY NAME, and the editor beside it is what reads the keys.
    shell(200);
    put({ pid: 200, argv: ["/bin/sh", "/usr/bin/sensible-editor", "notes.txt"], pgrp: 200, tpgid: 200 });
    put({ pid: 201, argv: ["nano", "notes.txt"], pgrp: 200, tpgid: 200 });
    expect(ask()).toEqual({ taker: null, name: null });
  });

  it("an editor started with sh -c", () => {
    shell(200);
    put({ pid: 200, argv: ["sh", "-c", "vi file; true"], pgrp: 200, tpgid: 200 });
    put({ pid: 201, argv: ["vi", "file"], pgrp: 200, tpgid: 200 });
    expect(ask().taker).toBeNull();
  });

  it("an editor Claude Code opened for the owner: two programs read the terminal now", () => {
    shell(200);
    put({ pid: 200, argv: ["claude"], pgrp: 200, tpgid: 200 });
    put({ pid: 201, argv: ["bun", "run", "mcp/clawbox-mcp.ts"], pgrp: 200, tpgid: 200, stdin: "socket:[1]" });
    put({ pid: 204, argv: ["vim", "/tmp/prompt.md"], pgrp: 200, tpgid: 200 });
    expect(ask().taker).toBeNull();
  });

  it.each([
    [["/bin/bash", "./deploy.sh"]],
    [["bash", "-c", "read -p 'continue? ' x"]],
    [["sh", "-lc", "read x"]],
    [["bash", "--rcfile", "/tmp/rc"]],
    [["zsh", "script.zsh", "--flag"]],
  ])("a script that happens to be written in shell, waiting on the terminal: %j", (argv) => {
    shell(200);
    put({ pid: 200, argv, pgrp: 200, tpgid: 200 });
    expect(ask().taker).toBeNull();
  });

  it.each(["claude-code-router", "claudette", "bashtop", "zshdb", "notclaude"])("a program that only sounds like one: %s", (program) => {
    shell(200);
    put({ pid: 200, argv: [program], pgrp: 200, tpgid: 200 });
    expect(ask().taker).toBeNull();
  });
});

describe("what cannot be read is a no", () => {
  it("a program in front that belongs to another account", () => {
    // `sudo -u other bash`, a non-owner's shell behind the helper: its files
    // are not ours to look at, so what is reading the terminal is unknown.
    shell(200);
    put({ pid: 200, argv: ["bash"], pgrp: 200, tpgid: 200, stdin: null });
    expect(ask()).toEqual({ taker: null, name: null });
  });

  it("a terminal with nothing in front", () => {
    shell(-1);
    expect(ask().taker).toBeNull();
  });

  it("a PTY whose shell is gone", () => {
    expect(foregroundTaker({ pid: 4242 }, proc)).toEqual({ taker: null, name: null });
  });

  it.each([undefined, null, 0, -5, 1.5, "100"])("a PTY with no usable pid: %s", (pid) => {
    shell(SHELL);
    expect(foregroundTaker({ pid } as never, proc)).toEqual({ taker: null, name: null });
    expect(foregroundTaker(undefined as never, proc)).toEqual({ taker: null, name: null });
  });

  it("a machine with no /proc at all", () => {
    expect(foregroundTaker({ pid: SHELL }, path.join(proc, "nope"))).toEqual({ taker: null, name: null });
  });

  it("a process with no name", () => {
    shell(200);
    put({ pid: 200, argv: [""], pgrp: 200, tpgid: 200 });
    expect(ask()).toEqual({ taker: null, name: null });
  });
});

describe("parseProcStat", () => {
  it("reads past a command name that holds spaces and parentheses", () => {
    expect(parseProcStat("77 (tmux: server (1)) S 1 77 77 34823 4321 0 0")).toEqual({ state: "S", pgrp: 77, tpgid: 4321 });
    expect(parseProcStat("78 (a) b) c) R 1 5 5 0 -1 0")).toEqual({ state: "R", pgrp: 5, tpgid: -1 });
  });

  it.each(["", "12 bash S 1 2", "12 (bash) S 1 x 2 3 y"])("answers nothing for %j", (text) => {
    expect(parseProcStat(text)).toBeNull();
  });
});

describe("programName and takerOf", () => {
  it.each([
    ["/usr/bin/bash", "bash"],
    ["-bash", "bash"],
    ["  zsh  ", "zsh"],
    ["python3.12", "python3.12"],
    ["evil\x1b[2J\"name", "evil2Jname"],
    ["", ""],
    [undefined, ""],
  ])("names %j as %j", (raw, name) => {
    expect(programName(raw)).toBe(name);
  });

  it("keeps a name short", () => {
    expect(programName("x".repeat(500))).toHaveLength(64);
  });

  it("knows the two takers by what they were started as", () => {
    expect(takerOf(["claude"])).toBe("claude");
    expect(takerOf(["Claude", "-p"])).toBe("claude");
    expect(takerOf(["-bash"])).toBe("shell");
    expect(takerOf(["bash", "-l", "-i"])).toBe("shell");
    expect(takerOf(["bash", "-ic", "x"])).toBeNull();
    expect(takerOf(["bash", "script.sh"])).toBeNull();
    expect(takerOf(["node", "cli.js"])).toBeNull();
    expect(takerOf([])).toBeNull();
  });
});
