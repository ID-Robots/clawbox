import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The speech-model size picker's device half.
 *
 * Real files under a temp home, because the two things it writes are the two
 * things that go wrong: a user unit rewritten from what was read (not
 * regenerated — install-voice.sh owns that template) and a Hugging Face cache
 * whose snapshots are symlinks into `blobs/`.
 */

let home: string;
const unitState = { present: true, active: true, enabled: true, failed: false, answered: true };
const restart = vi.fn(async () => ({ ok: true }));

vi.mock("@/lib/local-models", () => ({
  WHISPER_UNIT: "whisper-server.service",
  get SYSTEMD_USER_DIR() { return path.join(home, ".config/systemd/user"); },
  readUnitState: async () => unitState,
  reloadAndRestartUserEngine: (...args: unknown[]) => restart(...(args as [])),
}));

const UNIT = `[Unit]
Description=Whisper STT Server (GPU)

[Service]
Type=simple
Environment=LD_LIBRARY_PATH=/opt/cuda
Environment=WHISPER_MODEL=base
ExecStart=/usr/bin/python3 /home/clawbox/.openclaw/workspace/scripts/whisper-server.py
Restart=no
`;

function writeUnit(body = UNIT) {
  const dir = path.join(home, ".config/systemd/user");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "whisper-server.service"), body);
}

/** A complete Hub cache for one size, snapshots as symlinks into blobs the way the Hub writes them. */
function cacheSize(size: string, { whole = true } = {}) {
  const root = path.join(home, ".cache/huggingface/hub", `models--Systran--faster-whisper-${size}`);
  const blobs = path.join(root, "blobs");
  const snapshot = path.join(root, "snapshots", "abc123");
  fs.mkdirSync(blobs, { recursive: true });
  fs.mkdirSync(snapshot, { recursive: true });
  const artifacts = whole ? ["config.json", "model.bin", "tokenizer.json"] : ["model.bin"];
  for (const name of artifacts) {
    const blob = path.join(blobs, `${name}-blob`);
    fs.writeFileSync(blob, "x".repeat(64));
    fs.symlinkSync(blob, path.join(snapshot, name));
  }
  return root;
}

async function load() {
  vi.resetModules();
  return import("@/lib/whisper-models");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-whisper-"));
  process.env.CLAWBOX_HOME = home;
  restart.mockClear();
  unitState.present = true;
});

afterEach(() => {
  delete process.env.CLAWBOX_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("readWhisperState", () => {
  it("reads the size the unit is pointed at and which sizes are here", async () => {
    writeUnit();
    cacheSize("base");
    const { readWhisperState } = await load();
    const state = await readWhisperState();

    expect(state.installed).toBe(true);
    expect(state.active).toBe("base");
    expect(state.sizes.find((s) => s.id === "base")?.cached).toBe(true);
    expect(state.sizes.find((s) => s.id === "small")?.cached).toBe(false);
  });

  it("counts a half-downloaded cache as absent", async () => {
    // Weights with no tokenizer pass a naive existence check and then pay for
    // the missing file at the first transcription — the cost the pre-download
    // exists to avoid, moved to the worst possible moment.
    writeUnit();
    cacheSize("small", { whole: false });
    const { readWhisperState } = await load();
    const state = await readWhisperState();
    expect(state.sizes.find((s) => s.id === "small")?.cached).toBe(false);
  });

  it("counts a dangling snapshot link as absent", async () => {
    writeUnit();
    const root = cacheSize("tiny");
    fs.rmSync(path.join(root, "blobs"), { recursive: true, force: true });
    const { readWhisperState } = await load();
    const state = await readWhisperState();
    expect(state.sizes.find((s) => s.id === "tiny")?.cached).toBe(false);
  });

  it("says base for a unit that names no size, because that is what the server loads", async () => {
    writeUnit(UNIT.replace("Environment=WHISPER_MODEL=base\n", ""));
    const { readActiveWhisperSize } = await load();
    expect(await readActiveWhisperSize()).toBe("base");
  });

  it("reports a size nobody here offers rather than pretending otherwise", async () => {
    writeUnit(UNIT.replace("WHISPER_MODEL=base", "WHISPER_MODEL=large-v3"));
    const { readActiveWhisperSize } = await load();
    expect(await readActiveWhisperSize()).toBe("large-v3");
  });

  it("has no size to name when there is no unit", async () => {
    const { readActiveWhisperSize } = await load();
    expect(await readActiveWhisperSize()).toBeNull();
  });
});

describe("setActiveWhisperSize", () => {
  it("replaces only the model line and leaves the rest of the unit alone", async () => {
    writeUnit();
    const { setActiveWhisperSize } = await load();
    expect(await setActiveWhisperSize("small")).toEqual({ ok: true });

    const written = fs.readFileSync(path.join(home, ".config/systemd/user/whisper-server.service"), "utf-8");
    expect(written).toContain("Environment=WHISPER_MODEL=small");
    expect(written).not.toContain("WHISPER_MODEL=base");
    // install-voice.sh owns the template; two writers of one unit is how a box
    // ends up with an LD_LIBRARY_PATH nobody meant to change.
    expect(written).toContain("Environment=LD_LIBRARY_PATH=/opt/cuda");
    expect(written).toContain("ExecStart=/usr/bin/python3");
  });

  it("adds the line to a unit that predates it", async () => {
    writeUnit(UNIT.replace("Environment=WHISPER_MODEL=base\n", ""));
    const { setActiveWhisperSize } = await load();
    expect(await setActiveWhisperSize("tiny")).toEqual({ ok: true });
    const written = fs.readFileSync(path.join(home, ".config/systemd/user/whisper-server.service"), "utf-8");
    expect(written).toContain("Environment=WHISPER_MODEL=tiny");
    expect(written).toContain("[Service]");
  });

  it("refuses a size it does not offer, and a box with no unit", async () => {
    writeUnit();
    const { setActiveWhisperSize } = await load();
    expect((await setActiveWhisperSize("large-v3")).ok).toBe(false);

    fs.rmSync(path.join(home, ".config/systemd/user/whisper-server.service"));
    expect((await setActiveWhisperSize("tiny")).ok).toBe(false);
  });

  it("leaves no temp file behind", async () => {
    writeUnit();
    const { setActiveWhisperSize } = await load();
    await setActiveWhisperSize("small");
    const left = fs.readdirSync(path.join(home, ".config/systemd/user"));
    expect(left).toEqual(["whisper-server.service"]);
  });
});

describe("removeWhisperSize", () => {
  it("frees the weights of a size that is not in use", async () => {
    writeUnit();
    const root = cacheSize("small");
    const { removeWhisperSize } = await load();
    expect(await removeWhisperSize("small")).toEqual({ ok: true });
    expect(fs.existsSync(root)).toBe(false);
  });

  it("refuses the size the box transcribes with", async () => {
    // The next transcription would download it again inside somebody's request.
    writeUnit();
    const root = cacheSize("base");
    const { removeWhisperSize } = await load();
    const answer = await removeWhisperSize("base");
    expect(answer.ok).toBe(false);
    expect(answer.code).toBe("in_use");
    expect(fs.existsSync(root)).toBe(true);
  });

  it("refuses a name that is not one of the four", async () => {
    const { removeWhisperSize } = await load();
    expect((await removeWhisperSize("../../etc")).code).toBe("invalid");
  });
});

describe("restartWhisper", () => {
  it("goes through the allow-listed user-unit helper", async () => {
    const { restartWhisper } = await load();
    expect(await restartWhisper()).toEqual({ ok: true });
    expect(restart).toHaveBeenCalledWith("whisper-server.service");
  });
});
