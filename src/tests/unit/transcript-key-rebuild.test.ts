import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * TASK-723 — the session key that becomes a transcript FILENAME.
 *
 * `transcriptPath` joined the CALLER'S string after a `.test()` guard, which is
 * the shape the rest of this tree stopped using: `webapp-icon.ts` (safeAppId),
 * `code-projects.ts` (safeProjectId) and `openclaw-skill-info.ts`
 * (safeSkillName) each REBUILD the id one character at a time out of a constant
 * alphabet before joining, and each says why — a `.test()` leaves the caller's
 * value in play, so every path built from it is still built from request data.
 * CodeQL reported that here as `js/path-injection` (high) twelve times over,
 * once per path this module joins.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, said the way #637 said it. For a STRING
 * the rebuild is semantically identical to the regex it replaces — `$` in
 * JavaScript matches only at the end of input, so not even a trailing newline
 * tells the two apart, and no request can. That half is CodeQL's to report, on
 * the PR ref.
 *
 * What these cases pin is everything a later change could take away and leave
 * green: that the two rules cannot DRIFT (the door the routes call and the
 * rebuild the store joins are one rule, not two), that the store is a real last
 * door rather than a comment about one (a key that is not a string at all is
 * refused instead of coerced into a filename), and — structurally, anchored and
 * bounded to the one function — that what reaches `path.join` is the rebuilt id
 * and not the argument.
 */

let root: string;
let restoreEnv: () => void;
let store: typeof import("@/lib/harness/transcript-store");

const STORE_SOURCE = path.join(process.cwd(), "src/lib/harness/transcript-store.ts");

describe("the transcript key that becomes a filename", () => {
  beforeEach(async () => {
    // RESTORED, not deleted: vitest reuses a worker across files, so an
    // `afterEach` that deletes a variable the worker already had takes it away
    // from every file after this one. `saveEnv` is the repo's own undo.
    restoreEnv = saveEnv("CLAWBOX_ROOT");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-transcript-key-"));
    process.env.CLAWBOX_ROOT = root;
    vi.resetModules();
    store = await import("@/lib/harness/transcript-store");
  });

  afterEach(() => {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const dir = () => path.join(root, "data", "chat-transcripts");
  const filenames = () => (fs.existsSync(dir()) ? fs.readdirSync(dir()).sort() : []);

  it("rebuilds a key the routes accept into exactly itself", async () => {
    const { safeTranscriptKey } = await import("@/lib/harness/transcript-key");

    for (const key of ["desktop", "a", "A9", "tab_2", "tab-2", "Session-9_x", "a".repeat(64)]) {
      expect(safeTranscriptKey(key)).toBe(key);
    }
  });

  it("refuses everything the door refuses, and returns null rather than a partial id", async () => {
    const { safeTranscriptKey } = await import("@/lib/harness/transcript-key");

    for (
      const key of [
        "",
        "..",
        "../../openclaw",
        "desktop/../x",
        "desktop.jsonl",
        "_leading",
        "-leading",
        "has space",
        `desktop${String.fromCharCode(10)}`,
        "a".repeat(65),
      ]
    ) {
      expect(safeTranscriptKey(key)).toBeNull();
    }
  });

  it("keeps the door and the rebuild ONE rule, so neither can drift from the other", async () => {
    // The routes ask `transcriptKeyIsSafe`; the store joins what
    // `safeTranscriptKey` returns. Two separately written rules is how a key a
    // route admits becomes a filename the store spells differently — so the
    // predicate has to be the rebuild, asked whether it produced anything.
    const { safeTranscriptKey, transcriptKeyIsSafe } = await import("@/lib/harness/transcript-key");

    const alphabet = "abzABZ059_-";
    const candidates: string[] = ["", "a", "a".repeat(64), "a".repeat(65)];
    for (const first of alphabet) {
      for (const second of alphabet) {
        candidates.push(first, `${first}${second}`, `${first}${second}${first}`);
      }
    }
    for (const odd of [".", "/", "\\", " ", "é", "…", String.fromCharCode(0), String.fromCharCode(10)]) {
      candidates.push(odd, `a${odd}`, `${odd}a`, `a${odd}b`);
    }

    for (const key of candidates) {
      expect([key, transcriptKeyIsSafe(key)]).toEqual([key, safeTranscriptKey(key) !== null]);
    }
  });

  it("refuses a key that is not a string at all instead of coercing one into a filename", async () => {
    // Every route door checks `typeof … === "string"` first, and each is one
    // `as string` away from not doing so. `/re/.test(7)` coerces and answers
    // true, so the store's own guard used to admit a number and open
    // `7.jsonl`; the rebuild starts by refusing anything that is not a string.
    expect(await store.appendTranscript({ role: "user", text: "hi", timestamp: 1 }, 7 as never)).toBe(false);
    expect(await store.appendTranscript({ role: "user", text: "hi", timestamp: 1 }, null as never)).toBe(false);
    expect(filenames()).toEqual([]);

    expect(await store.readTranscript(50, 7 as never)).toEqual([]);
  });

  it("still writes, reads and clears the conversation a valid key names", async () => {
    // The rebuild is a barrier, not a new refusal: the ordinary path is
    // unchanged, which is the half a taint fix most easily breaks.
    await store.appendTranscript({ role: "user", text: "remember 41", timestamp: 10 }, "tab-2");
    expect(filenames()).toEqual(["tab-2.jsonl"]);
    expect(await store.readTranscript(50, "tab-2")).toEqual([
      { role: "user", text: "remember 41", timestamp: 10 },
    ]);

    await store.clearTranscript("tab-2");
    expect(filenames()).toEqual([]);
  });

  it("joins the rebuilt id, not the argument", async () => {
    // A source pin, ANCHORED and BOUNDED to `transcriptPath`'s own body: sliced
    // to end of file it would happily read some other function's `path.join`
    // and stay green over a `transcriptPath` that had lost the rebuild.
    const source = fs.readFileSync(STORE_SOURCE, "utf8");
    const start = source.indexOf("function transcriptPath(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(`${String.fromCharCode(10)}}`, start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);

    // What reaches `path.join` is the value the rebuild returned…
    expect(body).toMatch(/safeTranscriptKey\(/);
    expect(body).toMatch(/path\.join\(TRANSCRIPT_DIR,\s*`\$\{safe\}\.jsonl`\)/);
    // …and the argument itself never does.
    expect(body).not.toMatch(/path\.join\(TRANSCRIPT_DIR,\s*`\$\{key\}/);
  });
});
