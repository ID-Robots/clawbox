import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Taking the box's own voice off (src/lib/kokoro-uninstall.ts).
 *
 * Real files under a temp home, because the ORDER is the point: the unit
 * first, then the stamp, then the weights — a failure at the unit leaves a row
 * that still says installed with everything in place to retry from, and never
 * the other way round.
 */

let home: string;
const removeUnit = vi.fn(async (unit: string) => {
  fs.rmSync(path.join(home, ".config/systemd/user", unit), { force: true });
  return { ok: true as boolean, error: undefined as string | undefined };
});

vi.mock("@/lib/local-models", () => ({
  KOKORO_UNIT: "kokoro-server.service",
  get KOKORO_STAMP() { return path.join(home, ".cache/clawbox/kokoro-installed"); },
  removeUserUnit: (unit: string) => removeUnit(unit),
}));

async function load() {
  vi.resetModules();
  return import("@/lib/kokoro-uninstall");
}

function stamp() {
  const file = path.join(home, ".cache/clawbox/kokoro-installed");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "2\n");
  return file;
}

function unit() {
  const dir = path.join(home, ".config/systemd/user");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "kokoro-server.service"), "[Unit]\n");
  return path.join(dir, "kokoro-server.service");
}

/** The Hub cache the way KPipeline leaves it: a snapshot of links into blobs. */
function weights() {
  const root = path.join(home, ".cache/huggingface/hub/models--hexgrad--Kokoro-82M");
  const blobs = path.join(root, "blobs");
  const snapshot = path.join(root, "snapshots", "abc123");
  fs.mkdirSync(blobs, { recursive: true });
  fs.mkdirSync(snapshot, { recursive: true });
  const blob = path.join(blobs, "kokoro-v1_0.pth");
  fs.writeFileSync(blob, "x".repeat(1024));
  fs.symlinkSync(blob, path.join(snapshot, "kokoro-v1_0.pth"));
  return root;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-kokoro-"));
  process.env.CLAWBOX_HOME = home;
  removeUnit.mockClear().mockImplementation(async (name: string) => {
    fs.rmSync(path.join(home, ".config/systemd/user", name), { force: true });
    return { ok: true, error: undefined };
  });
});

afterEach(() => {
  delete process.env.CLAWBOX_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("uninstallKokoro", () => {
  it("removes the unit, the stamp and the weights, and says what came back", async () => {
    const unitFile = unit();
    const stampFile = stamp();
    const root = weights();
    const { uninstallKokoro, KOKORO_HUB_DIR } = await load();

    expect(KOKORO_HUB_DIR).toBe(root);
    const answer = await uninstallKokoro();
    expect(answer.ok).toBe(true);
    expect(answer.freedBytes).toBeGreaterThanOrEqual(1024);
    expect(removeUnit).toHaveBeenCalledWith("kokoro-server.service");
    expect(fs.existsSync(unitFile)).toBe(false);
    expect(fs.existsSync(stampFile)).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("leaves the stamp and the weights when the unit could not be removed", async () => {
    unit();
    const stampFile = stamp();
    const root = weights();
    removeUnit.mockResolvedValue({ ok: false, error: "Could not remove the service file." });
    const { uninstallKokoro } = await load();

    expect(await uninstallKokoro()).toEqual({ ok: false, freedBytes: null, error: "Could not remove the service file.", code: "remove_failed" });
    expect(fs.existsSync(stampFile)).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("succeeds on a box that has only the stamp left, with no figure to report", async () => {
    stamp();
    const { uninstallKokoro } = await load();
    expect(await uninstallKokoro()).toEqual({ ok: true, freedBytes: null });
  });
});
