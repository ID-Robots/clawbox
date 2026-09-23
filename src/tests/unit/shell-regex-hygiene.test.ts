import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A bounded repeat — `{n,m}` — inside a bash `[[ =~ ]]` regex is not free.
 *
 * `[[ =~ ]]` hands the pattern to glibc, which compiles a bounded repeat by
 * expanding it into one NFA state per permitted repetition. Measured on this
 * box with `/usr/bin/time -v bash -c …`, max RSS of the whole shell:
 *
 *   baseline `bash -c ':'`                                    3 456 kB
 *   `[[ $t =~ ^[A-Za-z0-9+/_=-]{32,4096}$ ]]`               276 736 kB
 *   length checks + `^[A-Za-z0-9+/_=-]+$`                     3 712 kB
 *   `[[ $h =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]`        3 968 kB
 *
 * The cost scales with the bound, and the arena is not handed back: TASK-1066
 * found `{32,4096}` validating the named-tunnel token in scripts/run-tunnel.sh,
 * where the supervisor bash lives for the whole tunnel lifetime and therefore
 * carried ~260 MB of it — on an 8 GB box, for a length check.
 *
 * The reason this needs a test rather than a comment is that the defect is
 * invisible in review: `^[A-Za-z0-9+/_=-]{32,4096}$` is an ordinary, correct
 * regex, and the next person to write a length bound will write it the same
 * way. The replacement idiom is the one both validators use now — an unbounded
 * character class, with the bound carried by an explicit `${#var}` test, which
 * accepts and rejects exactly the same strings.
 *
 * Only regex context is checked. A `{n,m}` in a comment, in a brace expansion
 * (`{1..40}`) or in an argument to `grep -E` (a fresh, short-lived process) is
 * not what this is about.
 */

const REPO = path.resolve(__dirname, "../../..");
const SKIP = new Set([".git", ".next", ".clawbox", "node_modules", "dist", "build", "out", "coverage"]);
const rel = (p: string) => path.relative(REPO, p).split(path.sep).join("/");

/** Every `.sh` the repository ships, wherever it lives. */
function shellScripts(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) shellScripts(full, found);
    else if (entry.isFile() && entry.name.endsWith(".sh")) found.push(full);
  }
  return found;
}

const BOUNDED_REPEAT = /\{\d+(?:,\d*)?\}/;

/**
 * The part of a line that glibc will see as a regex, or null when the line puts
 * no regex in front of it: everything after `=~`, and the right-hand side of a
 * `SOMETHING_RE=` assignment, since that is how a script names a pattern it
 * expands into `[[ =~ ]]` later (scripts/run-tunnel.sh does exactly this).
 */
export function regexText(line: string): string | null {
  if (line.trimStart().startsWith("#")) return null;
  const operator = /=~(.*)$/.exec(line);
  if (operator) return operator[1] ?? "";
  const assignment = /^\s*(?:local\s+|export\s+|readonly\s+)?[A-Za-z_][A-Za-z0-9_]*_RE=(.*)$/.exec(line);
  if (assignment) return assignment[1] ?? "";
  return null;
}

describe("shell regex hygiene", () => {
  const scripts = shellScripts(REPO);

  it("finds the shell scripts to check", () => {
    // A walker that silently stopped finding files would make the rule below
    // pass for ever without reading anything.
    expect(scripts.length).toBeGreaterThan(20);
    expect(scripts.map(rel)).toContain("scripts/run-tunnel.sh");
    expect(scripts.map(rel)).toContain("install.sh");
  });

  it("reads only the regex part of a line, and reads all of it", () => {
    // Offending, one per shape that has actually appeared in this repo.
    expect(regexText(`  if [[ "$t" =~ ^[A-Za-z0-9+/_=-]{32,4096}$ ]]; then`)).toMatch(BOUNDED_REPEAT);
    expect(regexText(`  if [[ ! "$n" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then`)).toMatch(BOUNDED_REPEAT);
    expect(regexText(`NAMED_TOKEN_RE='^[A-Za-z0-9]{32,4096}$'`)).toMatch(BOUNDED_REPEAT);
    expect(regexText(`  local HOST_RE='^[a-z]{3}$'`)).toMatch(BOUNDED_REPEAT);

    // Not offending: no regex on the line at all.
    expect(regexText(`#   with {32,4096}   max RSS 273920 kB`)).toBeNull();
    expect(regexText(`  printf 'x%.0s' {1..40}`)).toBeNull();
    expect(regexText('  echo "${#token}"')).toBeNull();

    // A regex on the line, but an unbounded one — the idiom being protected.
    const ok = regexText(`  [[ "$token" =~ $NAMED_TOKEN_RE ]]`);
    expect(ok).not.toBeNull();
    expect(ok).not.toMatch(BOUNDED_REPEAT);
    expect(regexText(`NAMED_HOST_LABEL_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`)).not.toMatch(BOUNDED_REPEAT);
  });

  it("no shell script matches a bounded repeat with `[[ =~ ]]`", () => {
    const offenders: string[] = [];
    for (const file of scripts) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const text = regexText(line);
          if (text !== null && BOUNDED_REPEAT.test(text)) {
            offenders.push(`${rel(file)}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    // Carry the bound in a `${#var}` test instead — see the header of this file.
    expect(offenders).toEqual([]);
  });
});
