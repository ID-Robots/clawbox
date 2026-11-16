import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  isWorkstationHost,
  probeUpdateHost,
  resolveUpdateChannel,
  UPDATE_CHANNEL_ENV,
  UpdateChannelError,
  WORKSTATION_UPDATE_REF,
  workstationRefMissingReason,
  workstationRefMissingUpdateError,
  type UpdateHost,
} from "@/lib/update-channel";

/**
 * TASK-2602: a ClawBox Workstation (DGX Spark) follows its own update channel,
 * the `workstation` branch, while every Jetson keeps the branch rules it has
 * always had. The pure decision, per platform and override; the updater's use
 * of it against real git repositories is updater-workstation-channel.test.ts.
 */

const JETSON: UpdateHost = { jetson: true, arch: "arm64", x64Install: false, desktopIntegration: false };
const WORKSTATION: UpdateHost = { jetson: false, arch: "arm64", x64Install: true, desktopIntegration: false };
const X86_PC: UpdateHost = { jetson: false, arch: "x64", x64Install: true, desktopIntegration: false };
const ARM_DESKTOP_INTEGRATION: UpdateHost = { jetson: false, arch: "arm64", x64Install: false, desktopIntegration: true };
/** An arm64 machine nothing installed: a dev board, a CI runner. */
const BARE_ARM: UpdateHost = { jetson: false, arch: "arm64", x64Install: false, desktopIntegration: false };

const noEnv = {};
const env = (value: string) => ({ [UPDATE_CHANNEL_ENV]: value });

describe("resolveUpdateChannel — the hardware decides when nothing overrides it", () => {
  it("a Jetson follows the branch rules", () => {
    expect(resolveUpdateChannel(JETSON, noEnv)).toEqual({ kind: "branch", source: "hardware" });
  });

  it("a Workstation (arm64, not a Jetson, installed with install-x64.sh) follows the workstation branch", () => {
    expect(resolveUpdateChannel(WORKSTATION, noEnv)).toEqual({
      kind: "workstation", ref: "workstation", source: "hardware",
    });
    expect(WORKSTATION_UPDATE_REF).toBe("workstation");
  });

  it("an x86_64 PC installed with the same installer is not a Workstation", () => {
    expect(resolveUpdateChannel(X86_PC, noEnv)).toEqual({ kind: "branch", source: "hardware" });
  });

  it("an arm64 desktop with the integration package keeps the branch its root step fetches", () => {
    expect(resolveUpdateChannel(ARM_DESKTOP_INTEGRATION, noEnv)).toEqual({ kind: "branch", source: "hardware" });
  });

  it("an arm64 machine install-x64.sh did not install is not a Workstation", () => {
    expect(resolveUpdateChannel(BARE_ARM, noEnv)).toEqual({ kind: "branch", source: "hardware" });
  });

  it("an empty value, blanks and `auto` mean the same as unset", () => {
    for (const value of ["", "   ", "auto", " AUTO "]) {
      expect(resolveUpdateChannel(JETSON, env(value))).toEqual({ kind: "branch", source: "hardware" });
      expect(resolveUpdateChannel(WORKSTATION, env(value)).kind).toBe("workstation");
    }
  });

  it("isWorkstationHost names the same machines", () => {
    expect([JETSON, WORKSTATION, X86_PC, ARM_DESKTOP_INTEGRATION, BARE_ARM].map(isWorkstationHost))
      .toEqual([false, true, false, false, false]);
    // A Jetson marker wins over everything else the record says.
    expect(isWorkstationHost({ ...WORKSTATION, jetson: true })).toBe(false);
  });
});

describe(`resolveUpdateChannel — ${UPDATE_CHANNEL_ENV} overrides it, for testing`, () => {
  it("`branch` puts a Workstation on the branch rules (testing a beta build before promoting it)", () => {
    expect(resolveUpdateChannel(WORKSTATION, env("branch"))).toEqual({ kind: "branch", source: "override" });
  });

  it("`branch` on a Jetson changes nothing", () => {
    expect(resolveUpdateChannel(JETSON, env("branch")).kind).toBe("branch");
  });

  it("`workstation` puts an install-x64.sh PC that is not a Workstation on the channel", () => {
    expect(resolveUpdateChannel(X86_PC, env("workstation"))).toEqual({
      kind: "workstation", ref: "workstation", source: "override",
    });
    expect(resolveUpdateChannel(WORKSTATION, env(" Workstation ")).source).toBe("override");
  });

  it("`workstation` on a Jetson is refused: install.sh moves that checkout from the recorded branch", () => {
    expect(() => resolveUpdateChannel(JETSON, env("workstation"))).toThrow(UpdateChannelError);
    expect(() => resolveUpdateChannel(JETSON, env("workstation"))).toThrow(/install\.sh updates from the recorded branch/);
  });

  it("`workstation` with the desktop integration is refused: its root step fetches the recorded branch", () => {
    expect(() => resolveUpdateChannel(ARM_DESKTOP_INTEGRATION, env("workstation")))
      .toThrow(/desktop integration's root step/);
    expect(() => resolveUpdateChannel(BARE_ARM, env("workstation"))).toThrow(UpdateChannelError);
  });

  it("an unknown value is refused on every platform — never read as one of the channels", () => {
    for (const host of [JETSON, WORKSTATION, X86_PC]) {
      for (const value of ["beta", "main", "stable", "workstaton"]) {
        expect(() => resolveUpdateChannel(host, env(value))).toThrow(UpdateChannelError);
      }
    }
    expect(() => resolveUpdateChannel(WORKSTATION, env("beta"))).toThrow(/"beta", which is not an update channel/);
  });

  it("reads the real process environment by default", () => {
    const before = process.env[UPDATE_CHANNEL_ENV];
    process.env[UPDATE_CHANNEL_ENV] = "branch";
    try {
      expect(resolveUpdateChannel(WORKSTATION)).toEqual({ kind: "branch", source: "override" });
    } finally {
      if (before === undefined) delete process.env[UPDATE_CHANNEL_ENV];
      else process.env[UPDATE_CHANNEL_ENV] = before;
    }
  });
});

describe("probeUpdateHost", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-channel-"));

  it("a Jetson answers from the Tegra marker without opening any x64 record", () => {
    const dir = tmp();
    const marker = path.join(dir, "nv_tegra_release");
    fs.writeFileSync(marker, "# R36\n");
    const opened: string[] = [];
    const host = probeUpdateHost("/home/clawbox/clawbox", {
      tegraRelease: marker,
      arch: "arm64",
      hasX64Install: () => { opened.push("x64"); throw new Error("must not be read"); },
      hasX64DesktopIntegration: () => { opened.push("integration"); throw new Error("must not be read"); },
    });
    expect(host).toEqual({ jetson: true, arch: "arm64", x64Install: false, desktopIntegration: false });
    expect(opened).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a DGX Spark: no Tegra marker, arm64, the install-x64.sh record names this checkout", () => {
    const host = probeUpdateHost("/opt/clawbox-checkout", {
      tegraRelease: path.join(tmp(), "absent"),
      arch: "arm64",
      hasX64Install: (dir) => dir === "/opt/clawbox-checkout",
      hasX64DesktopIntegration: () => false,
    });
    expect(host).toEqual({ jetson: false, arch: "arm64", x64Install: true, desktopIntegration: false });
    expect(isWorkstationHost(host)).toBe(true);
  });

  it("the integration package is asked first, and its PC is not an install-x64.sh one", () => {
    let askedInstall = false;
    const host = probeUpdateHost("/p", {
      tegraRelease: path.join(tmp(), "absent"),
      arch: "arm64",
      hasX64Install: () => { askedInstall = true; return true; },
      hasX64DesktopIntegration: () => true,
    });
    expect(host.desktopIntegration).toBe(true);
    expect(host.x64Install).toBe(false);
    expect(askedInstall).toBe(false);
  });

  it("an x64 record that cannot be trusted is an UpdateChannelError, not a guess of `not a Workstation`", () => {
    expect(() => probeUpdateHost("/p", {
      tegraRelease: path.join(tmp(), "absent"),
      arch: "arm64",
      hasX64Install: () => { throw new Error("must be a small, root-owned file"); },
      hasX64DesktopIntegration: () => false,
    })).toThrow(/Could not tell whether this computer is a ClawBox Workstation, so its update channel is unknown: .*root-owned/);
  });

  it("an x86 PC never opens the x64 records, so a bad one cannot cost it its branch rules", () => {
    const opened: string[] = [];
    const host = probeUpdateHost("/p", {
      tegraRelease: path.join(tmp(), "absent"),
      arch: "x64",
      hasX64Install: () => { opened.push("x64"); throw new Error("must be a small, root-owned file"); },
      hasX64DesktopIntegration: () => { opened.push("integration"); throw new Error("must be a small, root-owned file"); },
    }, {});
    expect(host).toEqual({ jetson: false, arch: "x64", x64Install: false, desktopIntegration: false });
    expect(opened).toEqual([]);
    expect(resolveUpdateChannel(host, {})).toEqual({ kind: "branch", source: "hardware" });
  });

  it("…unless CLAWBOX_UPDATE_CHANNEL=workstation asks, which only those records can grant", () => {
    const options = {
      tegraRelease: path.join(tmp(), "absent"),
      arch: "x64",
      hasX64Install: () => true,
      hasX64DesktopIntegration: () => false,
    };
    const host = probeUpdateHost("/p", options, env("workstation"));
    expect(host.x64Install).toBe(true);
    expect(resolveUpdateChannel(host, env("workstation")).kind).toBe("workstation");
    expect(() => probeUpdateHost("/p", {
      ...options,
      hasX64Install: () => { throw new Error("must be a small, root-owned file"); },
    }, env("workstation"))).toThrow(UpdateChannelError);
  });

  it("on this test host (no Tegra marker, no x64 records) it names no Workstation", () => {
    const host = probeUpdateHost(path.join(tmp(), "checkout"));
    expect(host.x64Install).toBe(false);
    expect(host.desktopIntegration).toBe(false);
    expect(isWorkstationHost(host)).toBe(false);
  });
});

describe("the missing-ref sentences", () => {
  it("say the box stays where it is and never falls back to beta or main", () => {
    expect(workstationRefMissingReason()).toMatch(/GitHub has no "workstation" branch/);
    expect(workstationRefMissingReason()).toMatch(/stays on the version it has and does not follow beta or main/);
    expect(workstationRefMissingUpdateError()).toMatch(/Nothing was changed/);
    expect(workstationRefMissingUpdateError()).toMatch(/never falls back to beta or main/);
  });
});
