/**
 * The Coding Agent UI redesign (2026-10-30) deleted whole surfaces: the
 * sidebar, the run page's rail and its Details card, the team tree drawing,
 * the Import panel, the Files tab's Save and the Changes tab's commit
 * `<select>`. Their test ids are what the app's tests still assert ABSENT, so
 * a component that brought one back would pass every `queryByTestId(...)
 * .toBeNull()` the moment it chose a new id — and fail every one the moment
 * it reused the old. This sweep closes the first gap: none of the ids is
 * written anywhere under src/components, in any file, in any form (a literal,
 * a template prefix, a comment that would let the next reader think it still
 * exists). docs/agents/coding-agent-ui.md names what replaced each one.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const COMPONENTS = path.resolve(__dirname, "../../components");

/** An id, or a prefix (ending in `-`) every id under it is gone with. */
const STALE = [
  "coding-agent-sidebar",
  "coding-agent-run-rail",
  "coding-agent-run-details",
  "coding-team-tree",
  "coding-agent-import-",
  "coding-agent-file-save",
  "coding-agent-change-picker",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the redesign's deleted ids stay deleted", () => {
  const files = walk(COMPONENTS);

  it("walks the components", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const id of STALE) {
    it(`${id}${id.endsWith("-") ? "*" : ""} appears nowhere under src/components`, () => {
      const hits: string[] = [];
      for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        let at = text.indexOf(id);
        while (at !== -1) {
          // `coding-agent-run-details` is not `coding-agent-details-<id>`, and a
          // prefix match is exact on purpose; what follows the id does not
          // matter, since the ids that replaced these share no prefix with them.
          const line = text.slice(0, at).split("\n").length;
          hits.push(`${path.relative(COMPONENTS, file)}:${line}`);
          at = text.indexOf(id, at + id.length);
        }
      }
      expect(hits).toEqual([]);
    });
  }
});
