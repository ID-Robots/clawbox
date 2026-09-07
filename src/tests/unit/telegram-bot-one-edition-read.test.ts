import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The panel's "which bot does this box poll?" answer comes from ONE edition
 * read, like every other answer this sweep made single-read.
 *
 * `readActiveTelegramBot` resolves the ACTIVE harness and then asks the edition
 * again to decide whether the ClawBox mirror may stand in for it. Those were two
 * reads of `/etc/clawbox/edition.env`, taken either side of an `await` on the
 * harness's own store — and `install.sh` rewrites that file on every update. A
 * second read landing in the rewrite window answers "openclaw", the `dual` guard
 * is skipped, and the mirror is returned as the ACTIVE harness's bot: a working
 * bot reported on a harness that does not hold it, which is the fail-open this
 * module exists to close.
 *
 * This route is on a 3-second tray poll, so it is the highest-frequency edition
 * read in the tree — and the callers all resolve the harness for their own
 * reasons anyway. They hand the whole resolution over.
 */

const editionReads = vi.hoisted(() => vi.fn<() => string>());
const sourceReads = vi.hoisted(() =>
  vi.fn<() => Promise<{ active: string; defaulted: boolean; edition: string; locked: boolean }>>(),
);

vi.mock("@/lib/harness", () => ({
  getActiveHarnessSource: () => sourceReads(),
  getEdition: () => editionReads(),
  getEditionSource: () => ({ edition: editionReads(), defaulted: false }),
}));
// The harness's own store holds nothing, which is the only state in which the
// mirror question is asked at all.
vi.mock("@/lib/hermes-telegram", () => ({
  readHermesTelegramToken: async () => ({ token: null, known: true }),
}));
vi.mock("@/lib/openclaw-config", () => ({ readConfigStrict: async () => ({}) }));
vi.mock("@/lib/config-store", () => ({ get: async () => "111111:mirror-token" }));

import { readActiveTelegramBot } from "@/lib/telegram-bot-identity";

beforeEach(() => {
  editionReads.mockReset();
  sourceReads.mockReset();
});

describe("readActiveTelegramBot", () => {
  it("takes the edition from the resolution it was handed, not a second read", async () => {
    // The update window: the caller's own read said `dual`, everything after it
    // lands while the lock is truncated and answers the module default.
    editionReads.mockReturnValue("openclaw");

    const answer = await readActiveTelegramBot({
      active: "hermes",
      defaulted: false,
      edition: "dual",
      locked: false,
    });

    // On `dual` the mirror is deliberately NOT offered: it is one value for the
    // whole box and after a switch it names the other harness's bot.
    expect(answer.token).toBeNull();
    expect(editionReads, "the edition must not be read a second time").not.toHaveBeenCalled();
    expect(sourceReads, "nor the harness resolved again").not.toHaveBeenCalled();
  });

  it("still resolves it itself for a caller that has no resolution to hand", async () => {
    sourceReads.mockResolvedValue({
      active: "hermes",
      defaulted: false,
      edition: "dual",
      locked: false,
    });

    expect((await readActiveTelegramBot()).token).toBeNull();
    expect(sourceReads).toHaveBeenCalledTimes(1);
    expect(editionReads).not.toHaveBeenCalled();
  });

  it("falls back to the mirror on the editions that have a legacy box to protect", async () => {
    const answer = await readActiveTelegramBot({
      active: "openclaw",
      defaulted: false,
      edition: "openclaw",
      locked: true,
    });

    expect(answer.token).toBe("111111:mirror-token");
    expect(editionReads).not.toHaveBeenCalled();
  });
});

/**
 * And the property that made the threading worth doing: every production caller
 * actually hands one over. Asserted from the SOURCE rather than through a mock,
 * because the defect it replaces was a parameter that existed and that no real
 * call path passed — a shape no per-caller test would have noticed.
 */
describe("its callers", () => {
  const repo = process.cwd();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "tests" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        files.push(full);
      }
    }
  };
  walk(path.join(repo, "src"));

  it("all hand it a resolution or a fixed harness, never a separately-read one", () => {
    const callers: { file: string; arg: string }[] = [];
    for (const file of files) {
      if (file.endsWith("telegram-bot-identity.ts")) continue;
      const text = fs.readFileSync(file, "utf-8");
      for (const m of text.matchAll(/readActiveTelegramBot\(\s*([^,)\s]*)/g)) {
        callers.push({ file: path.relative(repo, file), arg: m[1] });
      }
    }

    // The import lines are not calls; every real call site is counted.
    expect(callers.length, "no caller found — has the reader been renamed?").toBeGreaterThan(4);
    const wrong = callers.filter(
      (c) =>
        c.arg !== "" &&
        !/^"(openclaw|hermes)"$/.test(c.arg) &&
        !/source$/i.test(c.arg),
    );
    expect(
      wrong,
      `these pass a harness resolved apart from the edition: ${JSON.stringify(wrong)}`,
    ).toEqual([]);
  });
});
