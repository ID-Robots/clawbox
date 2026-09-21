import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `verifySkillRemoval` is shared by the install route's rollback and the
 * uninstall route precisely so the two surfaces cannot describe one device
 * state differently (PR #517, then the shared extraction). That only holds if
 * the verdict carries everything a message needs — and one of its three values
 * did not.
 *
 * `dir: 'unknown'` had TWO causes:
 *
 *   1. the lock entry named no `install_path`, so nothing ever looked at a
 *      directory, and
 *   2. the removal was believed to have worked and the `stat` that would have
 *      confirmed it failed with something other than ENOENT — EACCES on the
 *      root-owned subtree this device family produces, EIO, a stalled mount.
 *
 * One label, two causes, so a consumer that wants to name the cause has to
 * GUESS which one it was. The install route guessed (1) and said so as fact.
 * The fix is here rather than in the sentence: the verdict distinguishes the
 * two, and no consumer has to guess again.
 */

let hermesHome: string;

function skillsDir(): string {
  return path.join(hermesHome, "skills");
}

async function writeLock(installed: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(skillsDir(), ".hub"), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir(), ".hub", "lock.json"),
    JSON.stringify({ version: 1, installed }),
  );
}

async function verify(lockKey: string, entry: Record<string, unknown> | undefined) {
  const mod = await import("@/lib/hermes-skills-server");
  return await mod.verifySkillRemoval(
    lockKey,
    entry as unknown as Parameters<typeof mod.verifySkillRemoval>[1],
  );
}

beforeEach(async () => {
  vi.resetModules();
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-removal-"));
  process.env.HERMES_HOME = hermesHome;
  await fs.mkdir(skillsDir(), { recursive: true });
  await writeLock({});
});

afterEach(async () => {
  delete process.env.HERMES_HOME;
  await fs.rm(hermesHome, { recursive: true, force: true });
});

describe("the removal verdict says which question went unanswered", () => {
  it("reports 'unchecked' when the entry names no location, because nothing looked", async () => {
    await writeLock({ "simple-english": {} });

    const left = await verify("simple-english", {});

    // Not 'unknown': "nobody asked" and "the device would not answer" are
    // different facts, and a caller that wants to explain itself needs to know
    // which of them happened.
    expect(left.dir).toBe("unchecked");
    expect(left.lockEntry).toBe(true);
    // The behaviour that must NOT change: neither value is a failure on its
    // own — a vanished lock entry means the store lists nothing to act on.
    expect(left.clean).toBe(false);
  });

  it("reports 'unknown' when something looked and the device would not say", async () => {
    const rel = "creative/simple-english";
    const abs = path.join(skillsDir(), "creative", "simple-english");
    await fs.mkdir(abs, { recursive: true });
    await fs.writeFile(path.join(abs, "SKILL.md"), "---\nname: simple-english\n---\n");
    await writeLock({ "simple-english": { install_path: rel } });

    // The removal believes it worked; the confirming stat cannot answer. This
    // is the second cause the single 'unknown' label used to hide.
    const realStat = fs.stat;
    vi.spyOn(fs, "stat").mockImplementation((async (p: Parameters<typeof fs.stat>[0]) => {
      if (path.resolve(String(p)) === path.resolve(abs)) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return realStat(p);
    }) as typeof fs.stat);

    const left = await verify("simple-english", { install_path: rel });

    expect(left.dir).toBe("unknown");
    expect(left.dir).not.toBe("unchecked");
    expect(left.clean).toBe(false);
  });

  it("still reports the two answers a stat CAN give", async () => {
    const rel = "creative/simple-english";
    const abs = path.join(skillsDir(), "creative", "simple-english");
    await fs.mkdir(abs, { recursive: true });
    await fs.writeFile(path.join(abs, "SKILL.md"), "---\nname: simple-english\n---\n");
    await writeLock({});

    const gone = await verify("simple-english", { install_path: rel });

    expect(gone).toMatchObject({ dir: "absent", lockEntry: false, clean: true });

    // …and a path the validator refuses is removed by nobody, so it is there.
    await fs.mkdir(abs, { recursive: true });
    const escaped = await verify("simple-english", { install_path: "creative/../../escape" });
    expect(escaped.dir).toBe("present");
    expect(escaped.clean).toBe(false);
  });
});
