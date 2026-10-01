import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import nextConfig from "../../../next.config";
import { bakedPreserveScript, preserveLocalEdits } from "@/lib/local-edits";
import { saveEnv, testEnv } from "@/tests/helpers/env";

/**
 * The updater's own save before its `reset --hard` + `clean -fd` (TASK-1316):
 * src/lib/local-edits.ts running scripts/preserve-local-edits.sh against a real
 * git fixture, and updater.ts calling it before the reset.
 *
 * The fixture tree has NO scripts/ directory, which is the point: by the time
 * the restart step saves, step 1 has moved the tree to the update target, and
 * `main`, an older release or a downgrade has no preserve-local-edits.sh. So
 * the script that runs is the copy the BUILD carries (next.config.ts bakes its
 * text in), the tree's copy is only the next source, and with neither the
 * edits still go to git stash. E2E Install's switch to main failed at exactly
 * that step while the updater read the tree's copy.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "preserve-local-edits.sh");
const SCRIPT_TEXT = fs.readFileSync(SCRIPT, "utf-8");
const UPDATER_TS = fs.readFileSync(path.join(REPO, "src", "lib", "updater.ts"), "utf-8");
const LOCAL_EDITS_TS = fs.readFileSync(path.join(REPO, "src", "lib", "local-edits.ts"), "utf-8");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

let tmp: string;
let checkout: string;
let saves: string;
let restoreEnv: () => void;

function git(...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd: checkout,
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" }),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A `git` on PATH that refuses `stash`: with the copy impossible too, the edits fit nowhere. */
function refuseStash(): void {
  const shims = path.join(tmp, "shims");
  fs.mkdirSync(shims);
  const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
  fs.writeFileSync(path.join(shims, "git"), `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = stash ] && exit 1; done\nexec ${real} "$@"\n`);
  fs.chmodSync(path.join(shims, "git"), 0o755);
  process.env.PATH = `${shims}:${process.env.PATH ?? ""}`;
}

function edit(): void {
  fs.writeFileSync(path.join(checkout, "app.ts"), "export const v = 2;\n");
  fs.writeFileSync(path.join(checkout, "new.ts"), "x\n");
}

beforeEach(() => {
  restoreEnv = saveEnv("CLAWBOX_LOCAL_EDITS_DIR", "CLAWBOX_PRESERVE_LOCAL_EDITS_SH", "PATH", "GIT_CONFIG_NOSYSTEM");
  delete process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-local-edits-ts-")));
  checkout = path.join(tmp, "clawbox");
  saves = path.join(tmp, "saves");
  process.env.CLAWBOX_LOCAL_EDITS_DIR = saves;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  if (!CAN_RUN) return;
  fs.mkdirSync(checkout);
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(checkout, "app.ts"), "export const v = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the build carries its own copy of the script", () => {
  it("next.config.ts bakes scripts/preserve-local-edits.sh into the build, byte for byte", () => {
    expect(nextConfig.env?.CLAWBOX_PRESERVE_LOCAL_EDITS_SH).toBe(SCRIPT_TEXT);
  });

  it("is read as the literal member expression Next replaces at build time", () => {
    // `process.env[name]`, a destructure or an alias would compile to a runtime
    // read of a variable nothing sets, and the build would carry nothing.
    expect(LOCAL_EDITS_TS).toContain("const text = process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH;");
  });

  it("answers the baked text, and null when a build carries none", () => {
    expect(bakedPreserveScript()).toBeNull();
    process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH = "  \n";
    expect(bakedPreserveScript()).toBeNull();
    process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH = SCRIPT_TEXT;
    expect(bakedPreserveScript()).toBe(SCRIPT_TEXT);
  });

  it("never locates itself, so it runs the same as `bash -c <text>` as from the file", () => {
    expect(SCRIPT_TEXT).not.toMatch(/BASH_SOURCE|dirname "\$0"|\$\(dirname \$0\)/);
  });
});

d("preserveLocalEdits over a tree with no scripts/ directory", () => {
  beforeEach(() => {
    expect(fs.existsSync(path.join(checkout, "scripts"))).toBe(false);
  });

  it("resolves null over a clean tree and writes nothing — E2E Install's switch to main", async () => {
    process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH = SCRIPT_TEXT;
    await expect(preserveLocalEdits(checkout)).resolves.toBeNull();
    expect(fs.existsSync(saves)).toBe(false);
  });

  it("saves with the build's copy by default, and says where in the sentence the owner is shown", async () => {
    process.env.CLAWBOX_PRESERVE_LOCAL_EDITS_SH = SCRIPT_TEXT;
    edit();
    const saved = await preserveLocalEdits(checkout);
    expect(saved).not.toBeNull();
    expect(saved!.savedTo.startsWith(saves)).toBe(true);
    expect(fs.existsSync(path.join(saved!.savedTo, "tracked.patch"))).toBe(true);
    expect(fs.readFileSync(path.join(saved!.savedTo, "untracked", "new.ts"), "utf-8")).toBe("x\n");
    expect(fs.readFileSync(path.join(saved!.savedTo, "README.txt"), "utf-8")).toContain("git apply --3way");
    expect(saved!.message).toContain("1 changed file, 1 new file");
    expect(saved!.message).toContain(saved!.savedTo);
    // It only saves: the reset is the caller's.
    expect(fs.readFileSync(path.join(checkout, "app.ts"), "utf-8")).toBe("export const v = 2;\n");
  });

  it("runs the build's copy even when the tree has one of its own", async () => {
    fs.mkdirSync(path.join(checkout, "scripts"));
    fs.writeFileSync(path.join(checkout, "scripts", "preserve-local-edits.sh"), 'echo "Error: the tree copy ran" >&2; exit 3\n');
    git("add", "-A");
    git("commit", "-q", "-m", "a tree copy that must not run");
    edit();
    const saved = await preserveLocalEdits(checkout, { buildCopy: SCRIPT_TEXT });
    expect(saved?.savedTo.startsWith(saves)).toBe(true);
  });

  it("falls back to the tree's copy when the build carries none", async () => {
    edit();
    const saved = await preserveLocalEdits(checkout, { buildCopy: null, treeCopy: SCRIPT });
    expect(saved?.savedTo.startsWith(saves)).toBe(true);
    expect(fs.readFileSync(path.join(saved!.savedTo, "untracked", "new.ts"), "utf-8")).toBe("x\n");
  });

  it("with no copy anywhere, a clean tree has nothing to lose and nothing stops", async () => {
    await expect(preserveLocalEdits(checkout, { buildCopy: null })).resolves.toBeNull();
    expect(git("stash", "list")).toBe("");
  });

  it("with no copy anywhere, keeps the edits in the checkout's git stash and says so", async () => {
    edit();
    const saved = await preserveLocalEdits(checkout, { buildCopy: null });
    expect(saved?.savedTo).toBe("git-stash");
    expect(saved?.message).toMatch(/git stash \("clawbox-update \d{8}T\d{6}Z"\)/);
    expect(git("stash", "list")).toContain("clawbox-update");
    // The stash holds the new file as well as the change.
    expect(git("show", "--name-only", "--format=", "stash@{0}^3")).toContain("new.ts");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("with no copy anywhere, REJECTS only when the stash cannot take the edits either", async () => {
    edit();
    refuseStash();
    await expect(preserveLocalEdits(checkout, { buildCopy: null })).rejects.toThrow(/^Error: .*could not be saved to git stash/);
    expect(fs.readFileSync(path.join(checkout, "app.ts"), "utf-8")).toBe("export const v = 2;\n");
  });

  it("REJECTS with the script's own reason when the edits cannot be saved anywhere", async () => {
    edit();
    fs.writeFileSync(saves, "a file where the directory should be");
    refuseStash();
    await expect(preserveLocalEdits(checkout, { buildCopy: SCRIPT_TEXT })).rejects.toThrow(/^Error: .*could not be saved/);
    expect(fs.readFileSync(path.join(checkout, "app.ts"), "utf-8")).toBe("export const v = 2;\n");
  });

  it("never quotes the script text in a failure — it would land on the owner's result card", async () => {
    const err = await preserveLocalEdits(checkout, { buildCopy: "# SENTINEL-TEXT\nexit 7\n" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/stopped before resetting them: exit status 7$/);
    expect((err as Error).message).not.toContain("SENTINEL-TEXT");
  });

  it("names the save step 1 already made instead of writing a second", async () => {
    edit();
    const first = await preserveLocalEdits(checkout, { buildCopy: SCRIPT_TEXT });
    // What install.sh's bootstrap reset leaves: tracked changes gone, new file still there.
    git("reset", "-q", "--hard", "HEAD");
    const again = await preserveLocalEdits(checkout, { buildCopy: SCRIPT_TEXT });
    expect(again?.savedTo).toBe(first?.savedTo);
    expect(fs.readdirSync(saves)).toHaveLength(1);
  });
});

describe("updateClawBoxAndReboot saves before it resets and cleans", () => {
  it("calls preserveLocalEdits before its first reset, and raises the saved-to card", () => {
    const start = UPDATER_TS.indexOf("async function updateClawBoxAndReboot()");
    const body = UPDATER_TS.slice(start, UPDATER_TS.indexOf("\n}\n", start));
    const saveAt = body.indexOf("await preserveLocalEdits(PROJECT_DIR)");
    expect(saveAt).toBeGreaterThan(-1);
    expect(saveAt).toBeLessThan(body.indexOf('["reset", "--hard", "HEAD"]'));
    expect(saveAt).toBeLessThan(body.indexOf('["clean", "-fd"]'));
    expect(body).toContain("warnUpdate(LOCAL_EDITS_SAVED_BEFORE_RESTART, saved.message)");
    // A card code of its own: step 1's save arrives as `local-edits-saved`, and
    // warnUpdate keeps the first card per code.
    expect(UPDATER_TS).toMatch(/const LOCAL_EDITS_SAVED_BEFORE_RESTART = "local-edits-saved:[a-z]+"/);
  });
});
