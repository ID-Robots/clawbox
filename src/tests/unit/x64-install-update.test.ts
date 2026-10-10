/**
 * The pieces of the install-x64.sh update path that are not step routing
 * (src/lib/x64-install-update.ts): which root-helper answers are a skip and
 * which are a failure, the card that names the repair, the clean environment
 * the owner's build runs in — and the rebuild itself, driven for real against
 * a scratch checkout with a stand-in `bun`, because what it promises is about
 * directories on disk: the serving build survives every failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  X64_ROOT_STEPS_SKIPPED,
  classifyX64RootStepExit,
  classifyX64RootStepGap,
  ownerBuildEnv,
  rebuildAsOwner,
  restartUiProcess,
  x64RootContractRepairCommand,
  x64SkippedStepsWarning,
} from "@/lib/x64-install-update";

// The rebuild cases start real processes (bash, node) through the module under
// test; give them the ceilings test-timeout-hygiene.test.ts asks of such files.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("what the installed root helper said", () => {
  it.each([
    ["clawbox-root-step: step 'set_timezone' has no implementation on the x64 install", "not-implemented"],
    ["clawbox-root-step: /usr/local/libexec/clawbox/clawbox-x64-install.sh not found", "installer-missing"],
    ["Error: could not resolve an unprivileged install user. Set CLAWBOX_USER=<user>.", "installer-user"],
    ["Unknown step: gateway_setup", "installer-step"],
  ])("reads %j as a step it cannot run", (line, gap) => {
    expect(classifyX64RootStepGap(`Starting step...\n${line}\n`)).toBe(gap);
  });

  it.each([
    // A step that RAN and failed is the update's to report.
    "Error: apt-get update failed (exit 100)",
    "npm ERR! code ETARGET",
    // Quoting the refusal is not making it.
    "  previous run said: clawbox-root-step: step 'x' has no implementation on the x64 install (fixed)",
    "",
  ])("leaves a real failure alone: %j", (journal) => {
    expect(classifyX64RootStepGap(journal)).toBeNull();
  });

  it("falls back to the dispatcher's exit codes only for the two refusals it owns", () => {
    expect(classifyX64RootStepExit("64")).toBe("not-implemented");
    expect(classifyX64RootStepExit("69")).toBe("installer-missing");
    expect(classifyX64RootStepExit("1")).toBeNull();
    expect(classifyX64RootStepExit("100")).toBeNull();
    expect(classifyX64RootStepExit(null)).toBeNull();
  });
});

describe("the skipped-steps card", () => {
  it("names every skipped step and the one command that installs a newer helper", () => {
    const message = x64SkippedStepsWarning(["Updating system packages", "Applying system fixups"], "/home/clawbox/clawbox");
    expect(message).toContain("could not run 2 system steps, so they were skipped");
    expect(message).toContain("“Updating system packages”, “Applying system fixups”");
    expect(message).toContain("sudo bash /home/clawbox/clawbox/install-x64.sh --step root_step_contract");
    expect(x64RootContractRepairCommand("/home/clawbox/clawbox")).toBe(
      "sudo bash /home/clawbox/clawbox/install-x64.sh --step root_step_contract",
    );
    expect(X64_ROOT_STEPS_SKIPPED).toBe("x64-root-steps-skipped");
  });

  it("speaks of one step as one step", () => {
    const message = x64SkippedStepsWarning(["Configuring gateway service"], "/p");
    expect(message).toContain("could not run one system step, so it was skipped: “Configuring gateway service”");
    expect(message).toContain("To let future updates run it,");
  });
});

describe("the owner's build environment", () => {
  it("starts from an allow-list, so the running server's build identity cannot leak into the new build", () => {
    const env = ownerBuildEnv({
      HOME: "/home/clawbox",
      USER: "clawbox",
      PATH: "/usr/bin:/bin",
      NODE_ENV: "production",
      BUN_ENV: "production",
      __NEXT_PRIVATE_STANDALONE_CONFIG: "{\"old\":true}",
      __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:3005",
      PORT: "3005",
      OPENAI_API_KEY: "sk-test",
    } as unknown as NodeJS.ProcessEnv, "/home/clawbox/clawbox");
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.BUN_ENV).toBeUndefined();
    expect(env.__NEXT_PRIVATE_STANDALONE_CONFIG).toBeUndefined();
    expect(env.__NEXT_PRIVATE_ORIGIN).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HOME).toBe("/home/clawbox");
    expect(env.USER).toBe("clawbox");
    expect(env.CLAWBOX_ROOT).toBe("/home/clawbox/clawbox");
    expect(env.PATH?.split(":")).toEqual([
      path.dirname(process.execPath),
      "/home/clawbox/.bun/bin",
      "/usr/bin",
      "/bin",
    ]);
  });
});

describe("rebuildAsOwner", () => {
  let project: string;
  let bun: string;

  /**
   * A stand-in `bun`: `install` records itself, `run build` does what
   * `.fake-build` says — `ok`, `fail`, `race-once` (the traced-file race once,
   * then a good build) or `empty` (exit 0 with nothing written).
   */
  function writeFakeBun(dir: string): string {
    const file = path.join(dir, "fake-bun");
    fs.writeFileSync(file, `#!/bin/bash
set -u
echo "$*" >> .bun-calls
case "$1" in
  install) [ -f .fail-install ] && { echo "error: lockfile had changes" >&2; exit 1; }; exit 0 ;;
  run)
    mode="$(cat .fake-build 2>/dev/null || echo ok)"
    good() { mkdir -p .next/standalone; echo new-build > .next/BUILD_ID; echo 'server' > .next/standalone/server.js; }
    case "$mode" in
      ok) good ;;
      empty) mkdir -p .next ;;
      fail) mkdir -p .next/server; echo "Type error: Property 'x' does not exist" >&2; echo "Error: Build failed because of webpack errors" >&2; exit 1 ;;
      race-once)
        if [ -f .raced ]; then good; else
          touch .raced; mkdir -p .next
          echo "Error: ENOENT: no such file or directory, copyfile '/p/.next/x.js' -> '/p/.next/standalone/x.js'" >&2
          exit 1
        fi ;;
    esac ;;
esac
`, { mode: 0o755 });
    return file;
  }

  /** The build the PC is serving before the update. */
  function writeServingBuild(): void {
    fs.mkdirSync(path.join(project, ".next", "standalone"), { recursive: true });
    fs.writeFileSync(path.join(project, ".next", "BUILD_ID"), "old-build\n");
    fs.writeFileSync(path.join(project, ".next", "standalone", "server.js"), "old server");
  }

  const read = (rel: string) => fs.readFileSync(path.join(project, rel), "utf8").trim();
  const env = () => ({ HOME: project, PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv);

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-x64-rebuild-"));
    bun = writeFakeBun(project);
    // node-pty loads, so the native rebuild is never reached — it would run a
    // real npm.
    fs.mkdirSync(path.join(project, "node_modules", "node-pty"), { recursive: true });
    fs.writeFileSync(path.join(project, "node_modules", "node-pty", "index.js"), "module.exports = {};");
    writeServingBuild();
  });
  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("installs, builds, proves the new build and removes the parked one", async () => {
    const progress: string[] = [];
    await rebuildAsOwner(project, { bun, env: env(), onProgress: (d) => progress.push(d) });
    expect(read(".next/BUILD_ID")).toBe("new-build");
    expect(read(".bun-calls").split("\n")).toEqual(["install", "run build"]);
    expect(fs.existsSync(path.join(project, ".next-old"))).toBe(false);
    expect(progress).toEqual(["Installing packages", "Building ClawBox"]);
  });

  it("puts the serving build back when the build fails, and says which stage failed and why", async () => {
    fs.writeFileSync(path.join(project, ".fake-build"), "fail");
    const err = await rebuildAsOwner(project, { bun, env: env() }).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe(
      "bun run build did not succeed: Error: Build failed because of webpack errors. The previous build was put back.",
    );
    expect(read(".next/BUILD_ID")).toBe("old-build");
    expect(read(".next/standalone/server.js")).toBe("old server");
    expect(fs.existsSync(path.join(project, ".next", "server"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".next-old"))).toBe(false);
  });

  it("refuses a build that exited 0 without a BUILD_ID, keeping the serving one", async () => {
    fs.writeFileSync(path.join(project, ".fake-build"), "empty");
    await expect(rebuildAsOwner(project, { bun, env: env() })).rejects.toThrow(
      "checking the new build did not succeed: the build exited 0 but left no .next/BUILD_ID",
    );
    expect(read(".next/BUILD_ID")).toBe("old-build");
  });

  it("builds once more after the traced-file race, and only then", async () => {
    fs.writeFileSync(path.join(project, ".fake-build"), "race-once");
    await rebuildAsOwner(project, { bun, env: env() });
    expect(read(".next/BUILD_ID")).toBe("new-build");
    expect(read(".bun-calls").split("\n")).toEqual(["install", "run build", "run build"]);
  });

  it("never touches the serving build when bun install fails", async () => {
    fs.writeFileSync(path.join(project, ".fail-install"), "");
    await expect(rebuildAsOwner(project, { bun, env: env() })).rejects.toThrow(
      "bun install did not succeed: error: lockfile had changes",
    );
    expect(read(".next/BUILD_ID")).toBe("old-build");
    expect(read(".bun-calls")).toBe("install");
  });

  it("clears a stale parked tree before parking, so it never builds inside one", async () => {
    fs.mkdirSync(path.join(project, ".next-old", "junk"), { recursive: true });
    await rebuildAsOwner(project, { bun, env: env() });
    expect(read(".next/BUILD_ID")).toBe("new-build");
    expect(fs.existsSync(path.join(project, ".next-old"))).toBe(false);
  });
});

describe("restartUiProcess", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends this process with SIGTERM so systemd's Restart=always brings the UI back — and never a reboot", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const outcome: Promise<Error> = restartUiProcess().then(
      () => new Error("restartUiProcess returned normally"),
      (e: unknown) => e as Error,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(kill).toHaveBeenCalledTimes(1);
    // Still here a minute later: systemd did not replace it, and that is said.
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await outcome).message).toContain("sudo systemctl restart clawbox-setup");
  });
});
