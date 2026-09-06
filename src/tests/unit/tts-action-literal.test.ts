import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * TASK-723 — the action name `POST /setup-api/tts` writes into the journal.
 *
 * The route's failure line said `[setup-api/tts] ${action} failed:` with
 * `action` destructured straight off `request.json()`. Four literals is all it
 * can ever be — the handler refuses anything else before reaching this — but
 * the value in the line was still the BODY's copy of one of them, and CodeQL
 * reported it as `js/log-injection`. Neither the `!==` chain that narrowed it
 * nor `logSafe` is a barrier that query recognises; a value taken OUT OF a
 * literal array is not the request's string at all.
 *
 * Semantically identical, therefore, and no request can tell the two apart —
 * that half is CodeQL's to report on the PR ref, the way #637 said it for the
 * apps routes. What is pinned here is the shape a later change could take away
 * and leave green: the accepted set is one list rather than a chain nobody
 * updates, and the logged action is selected out of that list.
 */

const ROUTE = path.join(process.cwd(), "src/app/setup-api/tts/route.ts");

/** One function's own body, anchored at its opening line and bounded at its close. */
function bodyOf(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(`${String.fromCharCode(10)}}`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("POST /setup-api/tts — the action that reaches the journal", () => {
  const source = fs.readFileSync(ROUTE, "utf8");

  it("keeps the four actions as one list", () => {
    // A fifth action added to the switch below but not to this list is refused
    // at the door, which is the failure an operator can see. The reverse — a
    // name added here and handled nowhere — falls through to `handleSelect`,
    // so the list is the door and the door is the list.
    //
    // The CONTENTS, not the formatting: a fifth entry would push the literal
    // past the print width and wrap it, and a pin that went red for that would
    // say nothing about why.
    const start = source.indexOf("const ACTIONS = [");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("]", start);
    expect(end).toBeGreaterThan(start);
    const names = source
      .slice(start + "const ACTIONS = [".length, end)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    expect(names).toEqual(['"select"', '"voice"', '"language"', '"autoReply"']);
    // `as const` is what gives the `.find` below its literal union — without it
    // `action` widens to `string` and the four handlers lose their narrowing.
    expect(source.slice(end, end + 12)).toContain("as const");
  });

  it("selects the action out of that list rather than off the body", () => {
    const post = bodyOf(source, "export async function POST(");

    // The body's own field is read under a name of its own…
    expect(post).toMatch(/action: rawAction/);
    // …and what the rest of the handler uses comes back out of the literals.
    expect(post).toMatch(/const action = ACTIONS\.find\(\(name\) => name === rawAction\);/);
    // The old chain of comparisons against the destructured field is gone, so
    // nothing narrows the request's string into use again.
    expect(post).not.toMatch(/action !== "select"/);
  });

  it("logs the selected action, never the body's copy of it", () => {
    const post = bodyOf(source, "export async function POST(");
    const logLine = post.split(String.fromCharCode(10)).filter((line) => line.includes("console.warn"));

    expect(logLine).toHaveLength(1);
    expect(logLine[0]).toContain("[setup-api/tts] ${action} failed:");
    expect(logLine[0]).not.toContain("rawAction");
  });
});
