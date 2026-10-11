/**
 * May a pasted PICTURE go to whatever has this terminal right now?
 *
 * The Terminal asks before a plain Ctrl+V becomes a pasted picture's path
 * (src/lib/terminal-paste.ts): that key is vim's block select, nano's and
 * less's next page, readline's quoted insert. The browser cannot tell those
 * programs from one that wants the picture — vim and nano turn bracketed paste
 * on exactly as a prompt does, and Claude Code runs on the alternate screen
 * exactly as vim does — so the box says, from what it can see: the processes.
 *
 * The answer is `claude` or `shell` only when ONE process is reading this
 * terminal and it is that program:
 *
 *   - the terminal's FOREGROUND process group is found from the kernel
 *     (`tpgid` of the PTY's own shell), not from a name;
 *   - of that group's live members, exactly one has the terminal as its
 *     standard input. Claude Code's own children (MCP servers, the commands it
 *     runs) are in its group and read sockets and pipes; an editor it opens
 *     reads the terminal, and then there are two. A wrapper script and the
 *     editor it started are two. `cmd | less` and `cmd | vi -` read a pipe and
 *     open the terminal themselves: none, so no;
 *   - that one process is Claude Code, or a shell AT ITS PROMPT — started
 *     with nothing but flags, so a script and `sh -c …` are not one.
 *
 * Everything else, and everything that cannot be read, is `null`: the shell
 * gets the ^V it was always given. node-pty's own `process` name is not used
 * for this: it is the group LEADER's argv[0], and where that process has
 * exited it answers the name of the shell the PTY was started with.
 *
 * Plain ESM with `/proc` as a parameter, so the rule is tested on a fake tree.
 * Linux only — the box. Anywhere else there is no `/proc` and the answer is no.
 */

import fs from "node:fs";

/** @typedef {"claude" | "shell" | null} PictureTaker */

const SHELLS = new Set(["bash", "zsh", "sh", "dash", "fish", "ksh"]);

/**
 * `/usr/bin/bash` and a login shell's `-bash` are both `bash`. Rebuilt from a
 * small alphabet: the name is whatever the process chose to call itself.
 *
 * @param {string | undefined} arg
 * @returns {string}
 */
export function programName(arg) {
  if (typeof arg !== "string") return "";
  const leaf = arg.trim().split("/").pop() ?? "";
  return leaf.replace(/^-+/, "").replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 64);
}

/**
 * The fields of `/proc/<pid>/stat` this needs. The second field is the
 * command in parentheses and may itself hold spaces and parentheses, so the
 * rest is read from after the LAST `)`.
 *
 * @param {string} text
 * @returns {{ state: string, pgrp: number, tpgid: number } | null}
 */
export function parseProcStat(text) {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  // state ppid pgrp session tty_nr tpgid …
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const pgrp = Number(rest[2]);
  const tpgid = Number(rest[5]);
  if (!rest[0] || !Number.isInteger(pgrp) || !Number.isInteger(tpgid)) return null;
  return { state: rest[0], pgrp, tpgid };
}

/**
 * @param {string[]} argv
 * @returns {PictureTaker}
 */
export function takerOf(argv) {
  const name = programName(argv[0]).toLowerCase();
  if (name === "claude") return "claude";
  // A shell is a PROMPT only when it was started with nothing but flags: a
  // script path or `-c command` is a program that happens to be written in sh.
  if (!SHELLS.has(name)) return null;
  const rest = argv.slice(1);
  if (rest.some((arg) => !arg.startsWith("-") || arg === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) return null;
  return "shell";
}

/**
 * @param {{ pid?: number }} pty      the PTY; `pid` is the shell it started
 * @param {string} [procRoot]
 * @returns {{ taker: PictureTaker, name: string | null }}
 */
export function foregroundTaker(pty, procRoot = "/proc") {
  const none = { taker: /** @type {PictureTaker} */ (null), name: null };
  try {
    const shellPid = pty?.pid;
    if (!Number.isInteger(shellPid) || /** @type {number} */ (shellPid) <= 0) return none;
    const shell = parseProcStat(fs.readFileSync(`${procRoot}/${shellPid}/stat`, "utf8"));
    if (!shell || shell.tpgid <= 0) return none;
    // The terminal itself, as the shell it was made for knows it.
    const terminal = fs.readlinkSync(`${procRoot}/${shellPid}/fd/0`);
    if (!terminal) return none;

    /** @type {string[]} */
    const readers = [];
    for (const entry of fs.readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try {
        stat = parseProcStat(fs.readFileSync(`${procRoot}/${entry}/stat`, "utf8"));
      } catch {
        continue; // gone between the listing and the read
      }
      // A zombie reads nothing: a pipeline's first command that has finished
      // and not yet been collected.
      if (!stat || stat.pgrp !== shell.tpgid || stat.state === "Z") continue;
      let stdin;
      try {
        stdin = fs.readlinkSync(`${procRoot}/${entry}/fd/0`);
      } catch {
        // In front, and not ours to look at (another account's, or exiting):
        // what is reading the terminal cannot be said, so nothing is claimed.
        return none;
      }
      if (stdin === terminal) readers.push(entry);
    }
    if (readers.length !== 1) return none;

    const argv = fs.readFileSync(`${procRoot}/${readers[0]}/cmdline`, "utf8").split("\0").filter((arg, i) => i === 0 || arg !== "");
    const name = programName(argv[0]) || null;
    if (!name) return none;
    return { taker: takerOf(argv), name };
  } catch {
    return none;
  }
}
