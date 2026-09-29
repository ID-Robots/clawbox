import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { preserveLocalEdits } from "@/lib/local-edits";
import { saveEnv, testEnv } from "@/tests/helpers/env";

/**
 * The updater's own save before its `reset --hard` + `clean -fd` (TASK-1316):
 * src/lib/local-edits.ts running the shipped scripts/preserve-local-edits.sh
 * against a real git fixture, and updater.ts calling it before the reset.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "preserve-local-edits.sh");
const UPDATER_TS = fs.readFileSync(path.join(REPO, "src", "lib", "updater.ts"), "utf-8");

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

beforeEach(() => {
  restoreEnv = saveEnv("CLAWBOX_LOCAL_EDITS_DIR", "PATH", "GIT_CONFIG_NOSYSTEM");
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

d("preserveLocalEdits", () => {
  it("resolves null over a clean tree and writes nothing", async () => {
    await expect(preserveLocalEdits(checkout, SCRIPT)).resolves.toBeNull();
    expect(fs.existsSync(saves)).toBe(false);
  });

  it("says where it saved the edits, in the sentence the owner is shown", async () => {
    fs.writeFileSync(path.join(checkout, "app.ts"), "export const v = 2;\n");
    fs.writeFileSync(path.join(checkout, "new.ts"), "x\n");
    const saved = await preserveLocalEdits(checkout, SCRIPT);
    expect(saved).not.toBeNull();
    expect(saved!.savedTo.startsWith(saves)).toBe(true);
    expect(fs.existsSync(path.join(saved!.savedTo, "tracked.patch"))).toBe(true);
    expect(fs.readFileSync(path.join(saved!.savedTo, "untracked", "new.ts"), "utf-8")).toBe("x\n");
    expect(saved!.message).toContain("1 changed file, 1 new file");
    expect(saved!.message).toContain(saved!.savedTo);
    // It only saves: the reset is the caller's.
    expect(fs.readFileSync(path.join(checkout, "app.ts"), "utf-8")).toBe("export const v = 2;\n");
  });

  it("REJECTS with the script's own reason when the edits cannot be saved anywhere", async () => {
    fs.writeFileSync(path.join(checkout, "app.ts"), "export const v = 2;\n");
    fs.writeFileSync(saves, "a file where the directory should be");
    const shims = path.join(tmp, "shims");
    fs.mkdirSync(shims);
    const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();
    fs.writeFileSync(path.join(shims, "git"), `#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = stash ] && exit 1; done\nexec ${real} "$@"\n`);
    fs.chmodSync(path.join(shims, "git"), 0o755);
    process.env.PATH = `${shims}:${process.env.PATH ?? ""}`;
    await expect(preserveLocalEdits(checkout, SCRIPT)).rejects.toThrow(/^Error: .*could not be saved/);
    expect(fs.readFileSync(path.join(checkout, "app.ts"), "utf-8")).toBe("export const v = 2;\n");
  });

  it("rejects rather than resets when the script is not there to ask", async () => {
    fs.writeFileSync(path.join(checkout, "app.ts"), "export const v = 2;\n");
    await expect(preserveLocalEdits(checkout, path.join(tmp, "missing.sh"))).rejects.toThrow(/stopped before resetting/);
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
