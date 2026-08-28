import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "../helpers/env";

/**
 * TASK-434 — the selection has to survive a reboot, and a damaged state file
 * must cost an "unproven" badge rather than the Voice panel. Validation happens
 * per FIELD, not per envelope: a check entry whose shape is half-right would
 * otherwise reach a render that reads a sibling it never checked, which is the
 * failure that took the whole ClawKeep window down on TASK-398.
 */

let dir: string;
let restore: () => void;

async function store() {
  return await import("@/lib/voice-output-store");
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_ROOT", "CLAWBOX_TTS_VOICE_FILE");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-voice-state-"));
  process.env.CLAWBOX_ROOT = dir;
  process.env.CLAWBOX_TTS_VOICE_FILE = path.join(dir, "openclaw", "clawbox-tts-voice");
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  // config-store reads CLAWBOX_ROOT at import time.
  const { vi } = await import("vitest");
  vi.resetModules();
});

afterEach(async () => {
  restore();
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeRaw(contents: string) {
  await fs.writeFile(path.join(dir, "data", "voice-output.json"), contents);
}

describe("voice-output-store", () => {
  it("defaults to Auto when the box has never been asked", async () => {
    const { readVoiceState } = await store();
    const state = await readVoiceState();
    expect(state.choice).toBe("auto");
    expect(state.lastCheck).toBeNull();
    expect(state.engineChecks).toEqual({});
  });

  it("round-trips a selection and a check", async () => {
    const { readVoiceState, writeVoiceState } = await store();
    await writeVoiceState({
      choice: "local",
      engineChecks: {
        local: { providerId: "tts-local-cli", engine: "local", ok: true, message: null, latencyMs: 900, at: 7 },
      },
      lastCheck: {
        at: 7, ok: true, servedByProviderId: "tts-local-cli", servedEngine: "local",
        attempts: [{ providerId: "tts-local-cli", engine: "local", ok: true, message: null, latencyMs: 900 }],
        message: null,
      },
    });
    const state = await readVoiceState();
    expect(state.choice).toBe("local");
    expect(state.engineChecks.local?.ok).toBe(true);
    expect(state.lastCheck?.servedEngine).toBe("local");
  });

  it("writes the state file so only the box's own user can read it", async () => {
    const { writeVoiceState } = await store();
    await writeVoiceState({ choice: "cloud", engineChecks: {}, lastCheck: null });
    const stat = await fs.stat(path.join(dir, "data", "voice-output.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("falls back to Auto rather than throwing on a truncated file", async () => {
    await writeRaw('{"choice": "loc');
    const { readVoiceState } = await store();
    expect((await readVoiceState()).choice).toBe("auto");
  });

  it("ignores a choice nobody can honour", async () => {
    await writeRaw(JSON.stringify({ choice: "fastest" }));
    const { readVoiceState } = await store();
    expect((await readVoiceState()).choice).toBe("auto");
  });

  it("drops a check entry that is missing the fields the panel reads", async () => {
    await writeRaw(JSON.stringify({
      choice: "local",
      engineChecks: { local: { ok: true } },      // no providerId, no timestamp
      lastCheck: { ok: true },                     // no `at`
    }));
    const { readVoiceState } = await store();
    const state = await readVoiceState();
    expect(state.choice).toBe("local");
    expect(state.engineChecks.local).toBeUndefined();
    expect(state.lastCheck).toBeNull();
  });

  it("leaves no temp file behind after a write", async () => {
    const { writeVoiceState } = await store();
    await writeVoiceState({ choice: "auto", engineChecks: {}, lastCheck: null });
    const entries = await fs.readdir(path.join(dir, "data"));
    expect(entries.filter(f => f.includes(".tmp"))).toEqual([]);
  });
});

describe("the local voice file", () => {
  it("is whole the moment the write returns, where the speech script reads it", async () => {
    // `clawbox-tts.sh` reads this file on every utterance; a truncate-then-
    // write would hand a read in that window an empty file and the default
    // voice. So: the old file or the new one, never nothing.
    const file = process.env.CLAWBOX_TTS_VOICE_FILE!;
    const { readLocalVoice, writeLocalVoice } = await store();
    expect(await readLocalVoice()).toBeNull();

    await writeLocalVoice("bm_george");
    expect(await fs.readFile(file, "utf8")).toBe("bm_george\n");
    expect(await readLocalVoice()).toBe("bm_george");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    await writeLocalVoice("af_bella");
    expect(await fs.readFile(file, "utf8")).toBe("af_bella\n");
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("refuses a voice the box does not have, and leaves the saved one alone", async () => {
    const file = process.env.CLAWBOX_TTS_VOICE_FILE!;
    const { readLocalVoice, writeLocalVoice } = await store();
    await writeLocalVoice("bm_george");
    await expect(writeLocalVoice("../../etc/passwd")).rejects.toThrow(/Unknown local voice/);
    await expect(writeLocalVoice("")).rejects.toThrow(/Unknown local voice/);
    expect(await fs.readFile(file, "utf8")).toBe("bm_george\n");
    expect(await readLocalVoice()).toBe("bm_george");
  });
});

/**
 * rename() is a write to the DIRECTORY, durable only once the directory is
 * synced: without that, a power cut can leave the old name pointing at the
 * old file — the write "succeeded" and was gone after the reboot.
 */
describe("durability of the swap", () => {
  /**
   * Every handle the store opens, with its sync() watched — and, for a
   * directory, answered the way `refuse` says. The file handles are left
   * alone: their sync is the part that already worked.
   */
  function watchSyncs(refuse?: NodeJS.ErrnoException) {
    const synced: string[] = [];
    const realOpen = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen.apply(fs, args);
      const target = String(args[0]);
      const isDirectory = (await fs.stat(target)).isDirectory();
      const realSync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        synced.push(target);
        if (isDirectory && refuse) throw refuse;
        await realSync();
      });
      return handle;
    });
    return { synced, restore: () => spy.mockRestore() };
  }

  it("syncs the folder after both writers' renames", async () => {
    const watch = watchSyncs();
    try {
      const { readVoiceState, writeVoiceState, readLocalVoice, writeLocalVoice } = await store();
      await writeVoiceState({ choice: "local", engineChecks: {}, lastCheck: null });
      expect(watch.synced).toContain(path.join(dir, "data"));
      expect((await readVoiceState()).choice).toBe("local");

      const voiceFile = process.env.CLAWBOX_TTS_VOICE_FILE!;
      await writeLocalVoice("bm_george");
      expect(watch.synced).toContain(path.dirname(voiceFile));
      expect(await readLocalVoice()).toBe("bm_george");
    } finally {
      watch.restore();
    }
  });

  it("still lands the write on a filesystem that refuses to sync a directory", async () => {
    // Some FUSE and network mounts answer EINVAL to fsync on a directory. The
    // bytes were synced and swapped in; the swap's durability is best effort.
    const refusal = Object.assign(new Error("fsync: invalid argument"), { code: "EINVAL" });
    const watch = watchSyncs(refusal);
    try {
      const { readVoiceState, writeVoiceState } = await store();
      await expect(writeVoiceState({ choice: "cloud", engineChecks: {}, lastCheck: null })).resolves.toBeUndefined();
      expect(watch.synced).toContain(path.join(dir, "data"));
      expect((await readVoiceState()).choice).toBe("cloud");
      expect((await fs.readdir(path.join(dir, "data"))).filter((f) => f.includes(".tmp"))).toEqual([]);
    } finally {
      watch.restore();
    }
  });
});
