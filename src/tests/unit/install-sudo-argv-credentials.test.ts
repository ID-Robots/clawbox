import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARRAY_EXPANSION,
  ARRAY_FILL,
  blankSingleQuoted,
  functionDefs,
  logicalLines,
  ownWords,
  shellFiles,
  sudoWrappers,
  wrapperCalls,
  wrapperPattern,
} from "../helpers/shell-reader";

/**
 * No credential-named variable on a sudo command line in the shipped shell:
 * install.sh, install-x64.sh, and every shell script under scripts/ and
 * config/. sudo records its command line, so a credential reaches a command
 * through a file the command reads itself, or on stdin, and only a path goes on
 * the command line.
 *
 * The rule reads NAMES: a variable or `NAME=` assignment whose name says token,
 * secret, password, key, auth, cookie and the like, unless the name ends in
 * _FILE, _PATH or _DIR and only the path goes on the line: a credential path
 * whose contents are read in place (`"$(cat "$TOKEN_FILE")"`) still counts.
 * A name part TOKENS counts tokens, and NOT_A_CREDENTIAL lists the names read
 * and found to hold no secret, each with what it holds.
 * Every sudo call on a line is read, chained ones included. A value under a
 * name that says nothing is out of its reach, so review still matters. systemd
 * units are not shell and are not read.
 */

const REPO = path.resolve(__dirname, "../../..");

/** Fragments that mean a credential wherever they sit in a name. */
const STRONG_FRAGMENT = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|BEARER|COOKIE|JWT|APIKEY/i;
/** Fragments that mean a credential only as a whole part of a name: KEY, not KEYBOARD. */
const WEAK_PARTS = new Set(["KEY", "AUTH", "PASS", "PSK", "CRED", "CREDS"]);
/** A name for where a credential lives, which is what belongs on a command line. */
const PATH_NAME = /_(?:FILE|PATH|DIR)$|[a-z0-9](?:File|Path|Dir)$/i;

/** A whole name part that counts tokens rather than holding one: `MAX_TOKENS`, `PROMPT_TOKENS`. */
const COUNT_PART = "TOKENS";
/**
 * Names that sound like a credential but were read and hold none. Unlike an
 * ALLOWED entry these never expire: each reason says what the name holds, so
 * reusing the name for a secret is a change a reviewer sees here.
 */
const NOT_A_CREDENTIAL = new Map([
  ["SHIPPED_MAX_TOKENS", "the reply-length cap the local-AI test ships with, a token count"],
  ["PROMPT_TOKENS", "the input-token count a local-AI reply reports in its usage"],
  ["MEMORY_SEARCH_KEY", "a config key path: memory.search or agents.defaults.memorySearch"],
]);

/** A name that speaks of a credential, a path to one included. */
function credentialWords(name: string): boolean {
  if (NOT_A_CREDENTIAL.has(name)) return false;
  const parts = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().split("_");
  const named = parts.filter((part) => part !== COUNT_PART);
  if (STRONG_FRAGMENT.test(named.length === parts.length ? name : named.join("_"))) return true;
  return named.some((part) => WEAK_PARTS.has(part));
}

const credentialName = (name: string): boolean => !PATH_NAME.test(name) && credentialWords(name);

/** `$(cat …)`, `$(< …)` and the like: a file's contents expanded in place, path names included. */
const CONTENT_READ = /\$\(\s*(?:<|(?:cat|head|tail|jq|base64|sed|awk|grep|cut|tr|xxd|od)\s)[^)]*\)/g;

/** `$NAME` and `${NAME…}`; `$(…)` and positional `$1` are not names. */
const VAR_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
/** A variable or array that holds a command: `NAME="cmd …"`, `NAME=(cmd …)`; the name is group 1, the command group 2. */
const COMMAND_HOLDER = /(?:^|[\s;&(])([A-Za-z_][A-Za-z0-9_]*)=\(?\s*["']?(?:\S*\/)?([A-Za-z_][A-Za-z0-9_]*)(?=[\s"')]|$)/g;
const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)=/;

interface Allowed {
  file: string;
  /** A substring of the logical line, not a line number: line numbers move. */
  line: string;
  /** The credential-named variables the line carries, so a new one on it is not waved through. */
  names: string[];
  reason: string;
  /** YYYY-MM-DD; past it the entry fails, so it is fixed or renewed with a reason. */
  expires: string;
}

/** Each entry needs a reason, an expiry date and exactly one live line. */
const ALLOWED: Allowed[] = [];

interface Hit {
  file: string;
  lineNo: number;
  wrapper: string;
  names: string[];
  text: string;
}

/**
 * The credential names a stretch of command text carries: `NAME=` words of its
 * own command, `$NAME` references, and a credential path whose contents are
 * read in place (`"$(cat "$TOKEN_FILE")"`), which puts the credential itself
 * on the line where a bare `"$TOKEN_FILE"` would put only its path.
 */
function credentialsIn(rest: string): string[] {
  const assigned = ownWords(rest)
    .filter((w) => !w.literal)
    .map((w) => ASSIGNMENT_WORD.exec(w.text)?.[1])
    .filter((n): n is string => !!n);
  const expanded = blankSingleQuoted(rest);
  const referenced = [...expanded.matchAll(VAR_REF)].map((m) => m[1]);
  const readInPlace = [...expanded.matchAll(CONTENT_READ)]
    .flatMap((m) => [...m[0].matchAll(VAR_REF)].map((v) => v[1]))
    .filter(credentialWords);
  return [...[...assigned, ...referenced].filter(credentialName), ...readInPlace];
}

function scan(sources: { file: string; text: string }[]): { wrappers: Set<string>; calls: number; hits: Hit[] } {
  const read = sources.map(({ file, text }) => ({ file, lines: logicalLines(text, file) }));
  const all = read.flatMap(({ lines }) => lines);
  const wrappers = sudoWrappers(read.flatMap(({ lines }) => functionDefs(lines)));
  const named = wrapperPattern(wrappers);
  // Variables and arrays that hold a sudo command, and arrays filled with a credential.
  const holders = new Set<string>();
  const credentialArrays = new Map<string, string[]>();
  for (const { text } of all) {
    for (const m of text.matchAll(COMMAND_HOLDER)) if (wrappers.has(m[2]) || m[2] === "su") holders.add(m[1]);
    for (const m of text.matchAll(ARRAY_FILL)) {
      const names = credentialsIn(m[2]);
      if (names.length) credentialArrays.set(m[1], [...(credentialArrays.get(m[1]) ?? []), ...names]);
    }
  }
  const wrapper = holders.size ? wrapperPattern(wrappers, holders) : named;
  const hits: Hit[] = [];
  let calls = 0;
  for (const { file, lines } of read) {
    for (const { lineNo, text } of lines) {
      // Every call on the line, each judged on its own words: a second call
      // chained with `&&`, `;`, `||` or a pipe is a sudo command line too.
      for (const call of wrapperCalls(text, wrapper)) {
        calls += 1;
        const fromArrays = [...call.rest.matchAll(ARRAY_EXPANSION)].flatMap((m) => credentialArrays.get(m[1]) ?? []);
        const names = [...new Set([...credentialsIn(call.rest), ...fromArrays])];
        if (names.length) hits.push({ file, lineNo, wrapper: call.name, names, text: text.trim() });
      }
    }
  }
  return { wrappers, calls, hits };
}

const tree = (): { wrappers: Set<string>; calls: number; hits: Hit[] } =>
  scan(shellFiles().map((file) => ({ file, text: fs.readFileSync(path.join(REPO, file), "utf-8") })));

const allowedFor = (hit: Hit): Allowed | undefined =>
  ALLOWED.find((a) => a.file === hit.file && hit.text.includes(a.line));

describe("no credential-named variable reaches a sudo command line in the shipped shell", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-shell-files-"));
  });

  afterEach(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it("reads install.sh, install-x64.sh and the shell under scripts/ and config/, named .sh or not", () => {
    const put = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
      fs.writeFileSync(path.join(fixture, rel), text);
    };
    put("install.sh", "#!/bin/bash\n");
    put("scripts/a.sh", "true\n");
    put("scripts/deep/b", "#!/usr/bin/env bash\n");
    put("scripts/c", "#!/usr/bin/python3\n");
    put("scripts/d.py", "#!/bin/sh\n");
    put("config/e.sh", "true\n");
    put("config/f.service", "[Unit]\n");
    put("other/g.sh", "true\n");

    expect(shellFiles(fixture).sort()).toEqual(["config/e.sh", "install.sh", "scripts/a.sh", "scripts/deep/b"]);
  });

  it("finds sudo calls in the tree, so an empty result means something", () => {
    const { calls, wrappers } = tree();
    expect(shellFiles()).toEqual(expect.arrayContaining(["install.sh", "install-x64.sh"]));
    expect(calls).toBeGreaterThan(100);
    expect(wrappers.has("as_clawbox")).toBe(true);
  });

  it("finds the shapes it exists for", () => {
    const sample = [
      `as_clawbox env TG_TOKEN="$TG_TOKEN" CFG="$CFG" node - <<'NODE'`,
      "console.log(process.env.TG_TOKEN)",
      "NODE",
      'as_user "$BIN" config set gateway.auth.token "${GW_TOKEN}"',
      "sudo -u clawbox env \\",
      '  API_KEY="$api_key" tool',
      'su - clawbox -c "tool --password $PASSWORD"',
      'oc_config_set some.path "$CLAWBOX_AI_KEY"',
      "x=$(as_clawbox python3 -c '",
      "print(1)",
      `' "$TG_TOKEN")`,
      'bash -c "sudo -u clawbox tool $BOT_TOKEN"',
      '/usr/bin/sudo -u clawbox env SESSION_SECRET="$SESSION_SECRET" tool',
      "# a comment that ends in a backslash does not continue \\",
      'as_clawbox tool "$OTHER_SECRET"',
      'echo "a <<NODE inside a string opens nothing"',
      'as_clawbox tool "$THIRD_SECRET"',
      'v="$(sed -n \'s/"\\{0,1\\}x//p\' "$f")"',
      'as_clawbox tool "$FOURTH_SECRET"',
      "pass_on() {",
      '  as_clawbox tool "$@"',
      "}",
      'pass_on "$DB_PASSWORD"',
      'one_line() { as_clawbox env HOME="$HOME" tool "$@"; }',
      'one_line "$SIGNING_KEY"',
      'su clawbox -c "tool $ROOT_PASS"',
      'as_clawbox env TG_TOKEN="$tg" tool',
      'as_clawbox env TG_TOKEN="$(cat "$f")" tool',
      "function braced {",
      '  sudo -u clawbox tool "${@:2}"',
      "}",
      'braced x "$API_TOKEN"',
      "through_array() {",
      '  local args=("$@")',
      '  as_clawbox tool "${args[@]}"',
      "}",
      'through_array "$WIFI_PSK"',
      'as_clawbox env "QUOTED_TOKEN=$tg" node -',
      'first_arg() { as_clawbox tool "$1"; }',
      'first_arg "$FIRST_SECRET"',
      'cmd=(env ARRAY_TOKEN="$t" node -)',
      'as_clawbox "${cmd[@]}"',
      'SUDO="sudo -u clawbox"',
      '$SUDO tool "$HELD_SECRET"',
      "run=(sudo -u clawbox)",
      '"${run[@]}" tool "$HELD_ARRAY_SECRET"',
      '\\sudo -u clawbox tool "$ESCAPED_SECRET"',
      "next_line_brace()",
      "{",
      '  as_clawbox tool "$@"',
      "}",
      'next_line_brace "$BRACE_SECRET"',
      "subshell_body() (",
      '  as_clawbox tool "$@"',
      ")",
      'subshell_body "$SUBSHELL_SECRET"',
      "bash <<EOF",
      "sudo -u clawbox tool $HEREDOC_SECRET",
      "EOF",
      "n=$(( 1 << bits ))",
      'as_clawbox tool "$AFTER_SHIFT_SECRET"',
      "bits",
      "cat <<'END-SCRIPT'",
      "it's a body with an apostrophe",
      "END-SCRIPT",
      'as_clawbox tool "$AFTER_DASHED_SECRET"',
      'as_clawbox mkdir -p "$d" && as_clawbox env AND_TOKEN="$(cat "$f")" tool',
      'as_clawbox true; as_clawbox env SEMI_TOKEN="$v" tool',
      'as_clawbox true || as_clawbox env OR_TOKEN="$v" tool',
      'as_clawbox cat "$f" | as_clawbox env PIPE_TOKEN="$v" tool',
      'two_calls() { as_clawbox true && as_clawbox tool "$@"; }',
      'two_calls "$CHAINED_SECRET"',
      'as_clawbox tool --token "$(cat "$TOKEN_FILE")"',
      'as_clawbox tool "$(< "$KEY_FILE")"',
      // Clean: a comment, paths only, a key on stdin, an option name, a
      // separate command, an array of the function's own, a function that only
      // defines a forwarder inside itself, names for where a credential lives,
      // names that only look like one, and a single-quoted program.
      '# as_clawbox env TG_TOKEN="$TG_TOKEN"',
      'as_clawbox env CFG="$CLAWBOX_CONFIG" node -',
      'printf "%s\\n" "$KEY" | as_clawbox tool --from-stdin',
      "as_clawbox tool --api-key=from-a-file",
      "as_clawbox tool; SESSION_TOKEN=x other",
      "own_array() {",
      "  local opts=(--quiet)",
      '  as_clawbox tool "${opts[@]}"',
      "}",
      'own_array "$WIFI_PASS"',
      "outer() {",
      "  inner() {",
      '    as_clawbox tool "$@"',
      "  }",
      "  inner fixed",
      "}",
      'outer "$SESSION_COOKIE"',
      'as_clawbox openclaw config set --batch-file "$KEY_FILE"',
      'as_clawbox tool --token-file "$TOKEN_FILE" --dir "$AUTH_DIR"',
      'as_clawbox env KEYBOARD_LAYOUT=us tool "$PASSTHROUGH_ARGS" --author="$AUTHOR"',
      "as_clawbox python3 -c 'KEY=1; print($KEY)'",
    ].join("\n");
    const { wrappers, hits } = scan([{ file: "sample.sh", text: sample }]);
    for (const name of ["pass_on", "one_line", "braced", "through_array", "first_arg", "next_line_brace", "subshell_body", "inner", "two_calls"]) {
      expect(wrappers.has(name), name).toBe(true);
    }
    expect(wrappers.has("own_array")).toBe(false);
    expect(wrappers.has("outer")).toBe(false);
    expect(hits.map((h) => [h.lineNo, h.wrapper, h.names])).toEqual([
      [1, "as_clawbox", ["TG_TOKEN"]],
      [4, "as_user", ["GW_TOKEN"]],
      [5, "sudo", ["API_KEY", "api_key"]],
      [7, "su", ["PASSWORD"]],
      [8, "oc_config_set", ["CLAWBOX_AI_KEY"]],
      [9, "as_clawbox", ["TG_TOKEN"]],
      [12, "sudo", ["BOT_TOKEN"]],
      [13, "sudo", ["SESSION_SECRET"]],
      [15, "as_clawbox", ["OTHER_SECRET"]],
      [17, "as_clawbox", ["THIRD_SECRET"]],
      [19, "as_clawbox", ["FOURTH_SECRET"]],
      [23, "pass_on", ["DB_PASSWORD"]],
      [25, "one_line", ["SIGNING_KEY"]],
      [26, "su", ["ROOT_PASS"]],
      [27, "as_clawbox", ["TG_TOKEN"]],
      [28, "as_clawbox", ["TG_TOKEN"]],
      [32, "braced", ["API_TOKEN"]],
      [37, "through_array", ["WIFI_PSK"]],
      [38, "as_clawbox", ["QUOTED_TOKEN"]],
      [40, "first_arg", ["FIRST_SECRET"]],
      [42, "as_clawbox", ["ARRAY_TOKEN"]],
      [44, "$SUDO", ["HELD_SECRET"]],
      [46, "${run[@]}", ["HELD_ARRAY_SECRET"]],
      [47, "sudo", ["ESCAPED_SECRET"]],
      [52, "next_line_brace", ["BRACE_SECRET"]],
      [56, "subshell_body", ["SUBSHELL_SECRET"]],
      [58, "sudo", ["HEREDOC_SECRET"]],
      [61, "as_clawbox", ["AFTER_SHIFT_SECRET"]],
      [66, "as_clawbox", ["AFTER_DASHED_SECRET"]],
      [67, "as_clawbox", ["AND_TOKEN"]],
      [68, "as_clawbox", ["SEMI_TOKEN"]],
      [69, "as_clawbox", ["OR_TOKEN"]],
      [70, "as_clawbox", ["PIPE_TOKEN"]],
      [72, "two_calls", ["CHAINED_SECRET"]],
      [73, "as_clawbox", ["TOKEN_FILE"]],
      [74, "as_clawbox", ["KEY_FILE"]],
    ]);
  });

  it("reads a wrapper name inside a single-quoted program as text, not as a second call", () => {
    const sample = [
      `as_clawbox sh -c 'sudo true' sh "$API_KEY"`,
      `as_clawbox bash -c 'as_clawbox x; echo' -- "$API_KEY"`,
      `as_clawbox tool 'a sudo b' "$API_KEY"`,
      'as_clawbox tool "a sudo b" "$API_KEY"',
    ].join("\n");
    expect(scan([{ file: "sample.sh", text: sample }]).hits.map((h) => [h.lineNo, h.wrapper, h.names])).toEqual([
      [1, "as_clawbox", ["API_KEY"]],
      [2, "as_clawbox", ["API_KEY"]],
      [3, "as_clawbox", ["API_KEY"]],
      [4, "sudo", ["API_KEY"]],
    ]);
  });

  it("reads a token count and a config key path as no credential", () => {
    const sample = [
      'as_clawbox llama-server --n-predict "$MAX_TOKENS"',
      'oc_config_set "$MEMORY_SEARCH_KEY" x',
      'as_clawbox x "$API_TOKEN"',
    ].join("\n");
    expect(scan([{ file: "sample.sh", text: sample }]).hits.map((h) => [h.lineNo, h.wrapper, h.names])).toEqual([
      [3, "as_clawbox", ["API_TOKEN"]],
    ]);
  });

  it("says what to do when it cannot see the end of a construct", () => {
    expect(() => scan([{ file: "sample.sh", text: "echo 'never closed\n" }])).toThrow(
      "sample.sh:1: ' never closes for this reader: check the quoting there, or teach src/tests/helpers/shell-reader.ts the construct",
    );
  });

  it.each([
    ["a heredoc", "cat <<'EOF'\nnever closed\n", /heredoc EOF never closes/],
    ["a quote", "echo 'never closed\n", /' never closes/],
    ["a heredoc fed to a shell", "bash <<EOF\necho 'never closed\nEOF\n", /' never closes/],
  ])("fails closed on %s it cannot see the end of", (_name, text, error) => {
    expect(() => scan([{ file: "sample.sh", text }])).toThrow(error);
  });

  it("finds no credential-named variable on a sudo, su or sudo-wrapper line", () => {
    const unexpected = tree()
      .hits.filter((hit) => !allowedFor(hit))
      .map((h) => `${h.file}:${h.lineNo} ${h.wrapper} carries $${h.names.join(", $")}: ${h.text}`);
    expect(unexpected).toEqual([]);
  });

  it("keeps every allowlist entry live, exact, reasoned and unexpired", () => {
    const today = new Date().toISOString().slice(0, 10);
    const { hits } = tree();
    for (const entry of ALLOWED) {
      const where = `${entry.file}: ${entry.line}`;
      expect(entry.reason.trim().length, where).toBeGreaterThan(40);
      expect(entry.expires, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.expires >= today, `${where}: expired ${entry.expires}: ${entry.reason}`).toBe(true);
      // Exactly one live line: an entry that matches nothing hides the next line
      // that reuses its text, and one that matches two waves a copy through.
      const matched = hits.filter((h) => allowedFor(h) === entry);
      expect(matched.map((h) => h.names), where).toEqual([entry.names]);
    }
  });
});
