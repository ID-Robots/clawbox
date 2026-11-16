import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { UpdateHost } from "@/lib/update-channel";

/**
 * TASK-2602: the update channel, end to end through the updater, against real
 * git repositories — a bare "origin" with `main`, `beta` and (when a case says
 * so) `workstation`, and a device checkout cloned from it. No network, no
 * device, no systemd.
 *
 * The machine is the one seam: `probeUpdateHost` answers the host a case
 * describes (a Jetson, a DGX Spark, an x86 PC), everything else is the real
 * updater. Every case asks the three questions an update asks — which branch
 * the run resets to (`resolveUpdateBranch`), what the version check compares
 * against (`getPinnedBranchTarget`), and what an install-x64.sh PC's step 1
 * fetches (`fetchUpdateBranchAsOwner`) — so a Jetson that still targets beta
 * is proven by the same calls that put a Workstation on `workstation`.
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { hostState } = vi.hoisted(() => ({ hostState: { current: null as UpdateHost | null } }));
vi.mock("@/lib/update-channel", async (orig) => {
  const actual = await orig<typeof import("@/lib/update-channel")>();
  return {
    ...actual,
    probeUpdateHost: vi.fn((dir: string) => hostState.current ?? actual.probeUpdateHost(dir)),
  };
});

const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const d = HAS_GIT ? describe : describe.skip;

const JETSON: UpdateHost = { jetson: true, arch: "arm64", x64Install: false, desktopIntegration: false };
const WORKSTATION: UpdateHost = { jetson: false, arch: "arm64", x64Install: true, desktopIntegration: false };
const X86_PC: UpdateHost = { jetson: false, arch: "x64", x64Install: true, desktopIntegration: false };

const RELEASE_URL = "https://github.com/ID-Robots/clawbox.git";

let root: string;
let originDir: string;
let seedDir: string;
let device: string;

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const seed = (...args: string[]) => gitIn(seedDir, ...args);
const dev = (...args: string[]) => gitIn(device, ...args);

function commit(file: string, text: string, message: string): string {
  fs.writeFileSync(path.join(seedDir, file), text);
  seed("add", "-A");
  seed("commit", "-qm", message);
  return seed("rev-parse", "HEAD");
}

/** origin: main (tagged v9.9.9 one commit later), beta ahead of main. */
function seedOrigin(): { main: string; beta: string } {
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", originDir]);
  execFileSync("git", ["init", "-q", "-b", "main", seedDir]);
  seed("config", "user.email", "test@example.com");
  seed("config", "user.name", "Test");
  fs.writeFileSync(path.join(seedDir, ".gitignore"), ".update-branch\n.env\n");
  fs.writeFileSync(path.join(seedDir, "package.json"), JSON.stringify({ name: "clawbox", version: "4.0.0" }));
  commit("README.md", "one\n", "one");
  const main = commit("README.md", "release\n", "release");
  seed("tag", "v9.9.9");
  seed("checkout", "-qb", "beta");
  const beta = commit("README.md", "beta\n", "beta work");
  seed("remote", "add", "origin", originDir);
  seed("push", "-q", "origin", "main", "beta", "v9.9.9");
  return { main, beta };
}

/** Move origin's `workstation` branch, the way scripts/promote-workstation.sh does. */
function promote(sha: string): void {
  seed("push", "-q", "--force", "origin", `${sha}:refs/heads/workstation`);
}

/**
 * The device: cloned on `beta` from origin and pinned to beta, the state
 * install.sh (and install-x64.sh) leave behind. Its origin is named by the
 * release URL and rewritten to the bare repository, as a real box's is GitHub.
 */
function cloneDevice(branch = "beta", pin: string | null = "beta"): void {
  execFileSync("git", ["clone", "-q", "-b", branch, originDir, device]);
  dev("config", "user.email", "test@example.com");
  dev("config", "user.name", "Test");
  dev("remote", "set-url", "origin", RELEASE_URL);
  dev("config", `url.${originDir}.insteadOf`, RELEASE_URL);
  if (pin !== null) fs.writeFileSync(path.join(device, ".update-branch"), `${pin}\n`);
}

let saved: { channel: string | undefined; root: string | undefined };
let mod: typeof import("@/lib/updater");
let shas: { main: string; beta: string };

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-ws-channel-"));
  originDir = path.join(root, "origin.git");
  seedDir = path.join(root, "seed");
  device = path.join(root, "device");
  shas = seedOrigin();
  saved = { channel: process.env.CLAWBOX_UPDATE_CHANNEL, root: process.env.CLAWBOX_ROOT };
  delete process.env.CLAWBOX_UPDATE_CHANNEL;
  process.env.CLAWBOX_ROOT = device;
  hostState.current = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.resetModules();
  mod = await import("@/lib/updater");
});

afterEach(() => {
  if (saved.channel === undefined) delete process.env.CLAWBOX_UPDATE_CHANNEL;
  else process.env.CLAWBOX_UPDATE_CHANNEL = saved.channel;
  if (saved.root === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = saved.root;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

d("a Jetson keeps the branch rules — beta stays beta", () => {
  beforeEach(() => { hostState.current = JETSON; });

  it("a pinned beta box resolves, checks and is offered exactly beta, even with a workstation branch on origin", async () => {
    cloneDevice("beta", "beta");
    dev("reset", "-q", "--hard", "HEAD~1"); // one commit behind beta
    promote(shas.main);

    expect(await mod.resolveUpdateBranch(device)).toEqual({ local: "beta", upstream: "origin/beta", source: "pin-file" });
    expect(await mod.resolveEffectiveUpdateBranch(device)).toEqual({ branch: "beta", source: "pin-file" });
    const check = await mod.getPinnedBranchTarget(device);
    expect(check.channel).toBe("branch");
    expect(check.remote).toEqual({ reachable: true });
    expect(check.target).toEqual({ branch: "beta", currentSha: shas.main, targetSha: shas.beta });
  });

  it("an unpinned box on beta follows its checkout, as before", async () => {
    cloneDevice("beta", null);
    expect(await mod.resolveUpdateBranch(device)).toEqual({ local: "beta", upstream: "origin/beta", source: "checkout-branch" });
    const check = await mod.getPinnedBranchTarget(device);
    expect(check).toEqual({ target: null, remote: { reachable: true }, channel: "branch" });
  });

  it("CLAWBOX_UPDATE_CHANNEL=workstation on a Jetson is refused, never half-honoured", async () => {
    cloneDevice("beta", "beta");
    process.env.CLAWBOX_UPDATE_CHANNEL = "workstation";
    const { UpdateChannelError } = await import("@/lib/update-channel");
    await expect(mod.resolveUpdateBranch(device)).rejects.toBeInstanceOf(UpdateChannelError);
    const check = await mod.getPinnedBranchTarget(device);
    expect(check.target).toBeNull();
    expect(check.channel).toBeNull();
    expect(check.remote).toMatchObject({ reachable: false, cause: "device" });
    expect(check.remote.reason).toMatch(/install\.sh updates from the recorded branch/);
  });

  it("the auto-repin is untouched: an unpinned beta box is pinned to beta", async () => {
    cloneDevice("beta", null);
    const warnings = await mod.repinUpdateBranch("beta", device, "checkout-branch");
    expect(warnings.map((w) => w.code)).toEqual(["repinned"]);
    expect(fs.readFileSync(path.join(device, ".update-branch"), "utf-8")).toBe("beta\n");
  });
});

d("a ClawBox Workstation follows the workstation branch", () => {
  beforeEach(() => { hostState.current = WORKSTATION; });

  it("ahead of the beta pin install-x64.sh wrote: resolve, check and fetch all name workstation", async () => {
    cloneDevice("beta", "beta");
    promote(shas.main);

    expect(await mod.resolveUpdateBranch(device)).toEqual({
      local: "workstation", upstream: "origin/workstation", source: "workstation-channel",
    });
    expect(await mod.resolveEffectiveUpdateBranch(device)).toEqual({ branch: "workstation", source: "workstation-channel" });

    const check = await mod.getPinnedBranchTarget(device);
    expect(check.channel).toBe("workstation");
    expect(check.remote).toEqual({ reachable: true });
    expect(check.target).toEqual({ branch: "workstation", currentSha: shas.beta, targetSha: shas.main });

    const fetched = await mod.fetchUpdateBranchAsOwner(device);
    expect(fetched.upstream).toBe("origin/workstation");
    expect(dev("rev-parse", "refs/remotes/origin/workstation")).toBe(shas.main);
  });

  it("at the promoted commit it is up to date — beta moving on is not an update for it", async () => {
    cloneDevice("beta", "beta");
    promote(shas.beta);
    const check = await mod.getPinnedBranchTarget(device);
    expect(check).toEqual({ target: null, remote: { reachable: true }, channel: "workstation" });
  });

  it("no workstation branch on origin: the check says so and never compares against beta", async () => {
    cloneDevice("beta", "beta");
    dev("reset", "-q", "--hard", "HEAD~1"); // behind beta: beta WOULD be an update
    const check = await mod.getPinnedBranchTarget(device);
    expect(check.target).toBeNull();
    expect(check.channel).toBe("workstation");
    expect(check.remote).toMatchObject({ reachable: false, cause: "device" });
    expect(check.remote.reason).toMatch(/GitHub has no "workstation" branch/);
    expect(check.remote.reason).toMatch(/does not follow beta or main/);
  });

  it("no workstation branch on origin: step 1 refuses before the tree is touched, and the pin is kept", async () => {
    cloneDevice("beta", "beta");
    dev("reset", "-q", "--hard", "HEAD~1");
    const head = dev("rev-parse", "HEAD");
    await expect(mod.fetchUpdateBranchAsOwner(device)).rejects.toThrow(
      /nothing to update to: no version has been released on the ClawBox Workstation update channel yet/,
    );
    await expect(mod.fetchUpdateBranchAsOwner(device)).rejects.toThrow(/never falls back to beta or main/);
    expect(dev("rev-parse", "HEAD")).toBe(head);
    expect(dev("symbolic-ref", "--short", "HEAD")).toBe("beta");
    expect(fs.readFileSync(path.join(device, ".update-branch"), "utf-8")).toBe("beta\n");
  });

  it("a workstation branch deleted on origin is no target, even with a stale local copy of it", async () => {
    cloneDevice("beta", "beta");
    promote(shas.main);
    await mod.fetchUpdateBranchAsOwner(device); // origin/workstation is now on the device
    seed("push", "-q", "origin", ":refs/heads/workstation");
    const check = await mod.getPinnedBranchTarget(device);
    expect(check.target).toBeNull();
    expect(check.remote.reason).toMatch(/GitHub has no "workstation" branch/);
  });

  it("the channel is never written into .update-branch", async () => {
    cloneDevice("beta", null);
    expect(await mod.repinUpdateBranch("workstation", device, "workstation-channel")).toEqual([]);
    expect(fs.existsSync(path.join(device, ".update-branch"))).toBe(false);
  });

  it("CLAWBOX_UPDATE_CHANNEL=branch puts it back on its pin — how a beta build is tested on a Workstation", async () => {
    cloneDevice("beta", "beta");
    promote(shas.main);
    process.env.CLAWBOX_UPDATE_CHANNEL = "branch";
    expect(await mod.resolveUpdateBranch(device)).toEqual({ local: "beta", upstream: "origin/beta", source: "pin-file" });
    expect((await mod.getPinnedBranchTarget(device)).channel).toBe("branch");
    expect((await mod.fetchUpdateBranchAsOwner(device)).upstream).toBe("origin/beta");
  });

  it("an unknown CLAWBOX_UPDATE_CHANNEL fails the run and the check instead of following the pin", async () => {
    cloneDevice("beta", "beta");
    process.env.CLAWBOX_UPDATE_CHANNEL = "beta";
    await expect(mod.resolveUpdateBranch(device)).rejects.toThrow(/not an update channel/);
    await expect(mod.fetchUpdateBranchAsOwner(device)).rejects.toThrow(/not an update channel/);
    const check = await mod.getPinnedBranchTarget(device);
    expect(check).toMatchObject({ target: null, channel: null, remote: { reachable: false, cause: "device" } });
  });

  it("a host whose x64 record cannot be trusted has no channel, and no update to beta either", async () => {
    cloneDevice("beta", "beta");
    const channelModule = await import("@/lib/update-channel");
    vi.mocked(channelModule.probeUpdateHost).mockImplementationOnce(() => {
      throw new channelModule.UpdateChannelError("Could not tell whether this computer is a ClawBox Workstation, so its update channel is unknown: x");
    });
    const check = await mod.getPinnedBranchTarget(device);
    expect(check).toMatchObject({ target: null, channel: null, remote: { reachable: false, cause: "device" } });
  });
});

d("an x86_64 PC installed with install-x64.sh is not a Workstation", () => {
  beforeEach(() => { hostState.current = X86_PC; });

  it("keeps its pin", async () => {
    cloneDevice("beta", "beta");
    promote(shas.main);
    expect(await mod.resolveUpdateBranch(device)).toEqual({ local: "beta", upstream: "origin/beta", source: "pin-file" });
    expect((await mod.fetchUpdateBranchAsOwner(device)).upstream).toBe("origin/beta");
  });

  it("CLAWBOX_UPDATE_CHANNEL=workstation puts it on the channel (a test PC)", async () => {
    cloneDevice("beta", "beta");
    promote(shas.main);
    process.env.CLAWBOX_UPDATE_CHANNEL = "workstation";
    expect((await mod.resolveUpdateBranch(device)).upstream).toBe("origin/workstation");
    expect((await mod.getPinnedBranchTarget(device)).target?.targetSha).toBe(shas.main);
  });
});

d("getVersionInfo — a release tag is the branch rules' offer only", () => {
  it("a Jetson pinned to main is offered the newer tag by name, as before", async () => {
    hostState.current = JETSON;
    cloneDevice("main", "main");
    dev("reset", "-q", "--hard", "HEAD~1");
    const info = await mod.getVersionInfo();
    expect(info.clawbox.current).toBe("v4.0.0");
    expect(info.clawbox.target).toBe("v9.9.9");
  });

  it("a Workstation is never offered main's tag: it installs the workstation branch or nothing", async () => {
    hostState.current = WORKSTATION;
    cloneDevice("main", "main");
    promote(shas.main);
    dev("reset", "-q", "--hard", shas.main);
    const info = await mod.getVersionInfo();
    expect(info.clawbox.target).toBeNull();
  });

  it("a Workstation behind its channel is offered the channel's commit", async () => {
    hostState.current = WORKSTATION;
    cloneDevice("main", "main");
    promote(shas.beta);
    const info = await mod.getVersionInfo();
    expect(info.clawbox.target).toBe(`workstation@${shas.beta.slice(0, 7)}`);
    expect(info.clawbox.updateAvailable).toBe(true);
  });

  it("a Workstation with no channel branch yet is offered nothing", async () => {
    hostState.current = WORKSTATION;
    cloneDevice("main", "main");
    dev("reset", "-q", "--hard", "HEAD~1");
    const info = await mod.getVersionInfo();
    expect(info.clawbox.target).toBeNull();
    expect(info.clawbox.updateAvailable).not.toBe(true);
  });
});
