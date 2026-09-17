/**
 * The files a coding run is GIVEN (src/lib/coding-run-inputs.ts), and the
 * permission matrix around them.
 *
 * The reported failure: the assistant generated four pictures for a coding task
 * into its own media folder, and the run could read none of them — "denied by
 * permission settings for all routes, Bash cp and Read both refused" — so it
 * drew them again. The fix is a copy into a folder every run may read, and the
 * properties that matter are what it will and will not copy:
 *
 *   - the assistant's media folder is a SOURCE the box copies out of, and stays
 *     denied to the run itself, read and write alike;
 *   - the inputs folder is readable — no deny rule covers it and the run is
 *     started with a rule that allows it;
 *   - nothing outside the named source roots is ever staged, however it is
 *     spelled: another home path, a symlink planted inside the media folder, a
 *     relative path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

type Lib = typeof import("@/lib/coding-run-inputs");

let lib: Lib;
let base: string;
let root: string;
let mediaDir: string;
let restore: () => void;

const RUN_ID = "run-abc12345";

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "OPENCLAW_HOME", "CLAWBOX_OPENCLAW_HOME");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-inputs-"));
  root = path.join(base, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = root;
  delete process.env.OPENCLAW_HOME;
  delete process.env.CLAWBOX_OPENCLAW_HOME;
  mediaDir = path.join(base, ".openclaw", "media", "tool-image-generation");
  fs.mkdirSync(mediaDir, { recursive: true });
  vi.resetModules();
  lib = await import("@/lib/coding-run-inputs");
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

/** One generated picture, where the assistant would have written it. */
function generated(name: string, body = "png-bytes"): string {
  const p = path.join(mediaDir, name);
  fs.writeFileSync(p, body);
  return p;
}

describe("where inputs live", () => {
  it("puts the run's folder and the shared folder inside data/, not inside the harness's home", () => {
    expect(lib.runInputsDir(RUN_ID)).toBe(path.join(root, "data", "coding-agent-inputs", RUN_ID));
    expect(lib.sharedInputsDir()).toBe(path.join(root, "data", "coding-agent-inputs", "shared"));
  });

  it("names the assistant's media tree as a source on both editions", () => {
    expect(lib.assistantMediaRoots()).toEqual([
      path.join(base, ".openclaw", "media"),
      path.join(root, "data", "chat-media"),
    ]);
    // The inputs tree itself is a source too, which is what makes "drop it in
    // shared and hand the path over" work with no second mechanism.
    expect(lib.inputSourceRoots()).toContain(lib.inputsRoot());
  });

  it("resolves the OpenClaw media root the way openclaw-config resolves that home", async () => {
    // Two spellings of one path is how the wrong-directory bugs in this
    // codebase start; the module resolves it itself only to stay a leaf.
    const { OPENCLAW_HOME } = await import("@/lib/openclaw-config");
    expect(lib.assistantMediaRoots()[0]).toBe(path.join(OPENCLAW_HOME, "media"));
  });

  it("refuses a run id it did not write", () => {
    expect(() => lib.runInputsDir("../escape")).toThrow();
  });
});

describe("staging", () => {
  it("copies a generated picture out of the assistant's media folder", async () => {
    const src = generated("chart.png");
    const result = await lib.stageRunInputs(RUN_ID, [src]);
    expect(result.refused).toEqual([]);
    expect(result.staged).toEqual([{ name: "chart.png", bytes: fs.statSync(src).size }]);
    expect(fs.readFileSync(path.join(result.dir, "chart.png"), "utf8")).toBe("png-bytes");
    // The original is left where it was: the assistant's tree is a source, not
    // something this may empty.
    expect(fs.existsSync(src)).toBe(true);
  });

  it("stages a file the owner dropped in the shared folder", async () => {
    fs.mkdirSync(lib.sharedInputsDir(), { recursive: true });
    const src = path.join(lib.sharedInputsDir(), "logo.svg");
    fs.writeFileSync(src, "<svg/>");
    const result = await lib.stageRunInputs(RUN_ID, [src]);
    expect(result.staged.map((f) => f.name)).toEqual(["logo.svg"]);
  });

  it("judges every path on its own, so one bad entry does not lose the rest", async () => {
    const good = generated("a.png");
    const result = await lib.stageRunInputs(RUN_ID, [good, path.join(base, ".ssh", "id_ed25519"), "relative.png"]);
    expect(result.staged.map((f) => f.name)).toEqual(["a.png"]);
    expect(result.refused.map((r) => r.code)).toEqual(["not_a_file", "not_absolute"]);
  });

  it("never copies a credential out of the home directory", async () => {
    const ssh = path.join(base, ".ssh");
    fs.mkdirSync(ssh, { recursive: true });
    const key = path.join(ssh, "id_ed25519");
    fs.writeFileSync(key, "PRIVATE KEY");
    const result = await lib.stageRunInputs(RUN_ID, [key]);
    expect(result.staged).toEqual([]);
    expect(result.refused).toEqual([{ path: key, code: "outside_roots" }]);
    expect(fs.existsSync(path.join(lib.runInputsDir(RUN_ID), "id_ed25519"))).toBe(false);
  });

  it("refuses a symlink planted inside the media folder, wherever it points", async () => {
    const secret = path.join(base, ".openclaw", "openclaw.json");
    fs.writeFileSync(secret, '{"token":"claw_secret"}');
    const link = path.join(mediaDir, "picture.png");
    fs.symlinkSync(secret, link);
    const result = await lib.stageRunInputs(RUN_ID, [link]);
    expect(result.staged).toEqual([]);
    expect(result.refused).toEqual([{ path: link, code: "not_a_file" }]);
  });

  it("refuses a file bigger than the cap, and stops at the count cap", async () => {
    // Sparse, so the cap is tested without spending 64 MB of a CI runner's disk.
    const big = generated("big.png");
    fs.truncateSync(big, lib.MAX_INPUT_BYTES + 1);
    expect((await lib.stageRunInputs(RUN_ID, [big])).refused).toEqual([{ path: big, code: "too_large" }]);

    const many = Array.from({ length: lib.MAX_RUN_INPUTS + 2 }, (_, i) => generated(`m${i}.png`));
    const result = await lib.stageRunInputs("run-bbb22222", many);
    expect(result.staged).toHaveLength(lib.MAX_RUN_INPUTS);
    expect(result.refused.every((r) => r.code === "too_many")).toBe(true);
  });

  it("rebuilds the destination name from a fixed alphabet and never writes a dotfile", async () => {
    expect(lib.safeInputName("/a/b/../weird name;rm -rf.png")).toBe("weird name_rm -rf.png");
    expect(lib.safeInputName("/a/b/.env")).toBe("env");
    const src = generated("re;port.png");
    const result = await lib.stageRunInputs(RUN_ID, [src]);
    expect(result.staged[0].name).toBe("re_port.png");
  });

  it("keeps two sources of the same name apart", async () => {
    const one = generated("shot.png", "first");
    fs.mkdirSync(path.join(base, ".openclaw", "media", "outbound"), { recursive: true });
    const two = path.join(base, ".openclaw", "media", "outbound", "shot.png");
    fs.writeFileSync(two, "second");
    const result = await lib.stageRunInputs(RUN_ID, [one, two]);
    expect(result.staged.map((f) => f.name)).toEqual(["shot.png", "shot-2.png"]);
  });
});

describe("listing and removal", () => {
  it("lists what is in the folder now and drops it with the run", async () => {
    await lib.stageRunInputs(RUN_ID, [generated("a.png")]);
    // A file the owner dropped in after the run started is listed too — the
    // folder is the truth, not the hand-over record.
    fs.writeFileSync(path.join(lib.runInputsDir(RUN_ID), "later.txt"), "hi");
    expect(lib.listRunInputs(RUN_ID).map((f) => f.name).sort()).toEqual(["a.png", "later.txt"]);

    lib.removeRunInputs(RUN_ID);
    expect(fs.existsSync(lib.runInputsDir(RUN_ID))).toBe(false);
    expect(lib.listRunInputs(RUN_ID)).toEqual([]);
  });

  it("removes nothing for a malformed id", () => {
    expect(() => lib.removeRunInputs("../../etc")).not.toThrow();
  });
});

describe("reading the caller's list", () => {
  it("takes an array or a comma-separated string, bounded and de-duplicated", () => {
    expect(lib.readInputPaths(["/a/x.png", " /a/y.png ", "/a/x.png", 7])).toEqual(["/a/x.png", "/a/y.png"]);
    expect(lib.readInputPaths("/a/x.png, /a/y.png")).toEqual(["/a/x.png", "/a/y.png"]);
    expect(lib.readInputPaths(null)).toEqual([]);
    expect(lib.readInputPaths(Array.from({ length: 50 }, (_, i) => `/a/${i}.png`))).toHaveLength(lib.MAX_RUN_INPUTS);
  });
});

describe("refusal codes", () => {
  it("recognises only the codes this build words", () => {
    for (const code of lib.INPUT_REFUSAL_CODES) expect(lib.isInputRefusalCode(code)).toBe(true);
    expect(lib.isInputRefusalCode("something_new")).toBe(false);
    expect(lib.isInputRefusalCode(undefined)).toBe(false);
  });
});
