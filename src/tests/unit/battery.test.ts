/**
 * src/lib/battery.ts against power_supply trees built in a temp dir.
 *
 * Each fixture mirrors sysfs: the supply's attributes live under
 * `devices/<name>/` and `class/<name>` is a SYMLINK to it, the way
 * /sys/class/power_supply links into /sys/devices — so every case also proves
 * the reader follows the links. `arch` is always passed: CI is x64 and the box
 * is arm64, and the answer must not depend on which one runs the suite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBattery } from "@/lib/battery";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-battery-"));
  fs.mkdirSync(path.join(tmp, "class"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function supply(name: string, attrs: Record<string, string | number>): void {
  const dir = path.join(tmp, "devices", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, value] of Object.entries(attrs)) fs.writeFileSync(path.join(dir, key), `${value}\n`);
  fs.symlinkSync(path.join("..", "devices", name), path.join(tmp, "class", name));
}

function battery(name: string, attrs: Record<string, string | number>): void {
  supply(name, { type: "Battery", present: 1, scope: "System", ...attrs });
}

function ac(online: number | string, name = "AC", type = "Mains"): void {
  supply(name, { type, online });
}

function read(arch = "x64") {
  return readBattery({ root: path.join(tmp, "class"), arch });
}

describe("readBattery — one battery, energy family (µWh, µW)", () => {
  it("discharging: minutes to empty, charger offline", async () => {
    battery("BAT0", {
      status: "Discharging",
      capacity: 64,
      energy_now: 32_000_000,
      energy_full: 50_000_000,
      power_now: 8_000_000,
    });
    ac(0);
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 64,
      state: "discharging",
      acOnline: false,
      minutesLeft: 240,
    });
  });

  it("charging: minutes to full, charger online", async () => {
    battery("BAT0", {
      status: "Charging",
      capacity: 40,
      energy_now: 20_000_000,
      energy_full: 50_000_000,
      power_now: 15_000_000,
    });
    ac(1);
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 40,
      state: "charging",
      acOnline: true,
      minutesLeft: 120,
    });
  });

  it("low: a few percent left while discharging", async () => {
    battery("BAT0", {
      status: "Discharging",
      capacity: 7,
      energy_now: 3_500_000,
      energy_full: 50_000_000,
      power_now: 7_000_000,
    });
    ac(0);
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 7,
      state: "discharging",
      acOnline: false,
      minutesLeft: 30,
    });
  });

  it("full: no time left, whatever the rate says", async () => {
    battery("BAT0", { status: "Full", capacity: 100, energy_now: 50_000_000, energy_full: 50_000_000, power_now: 1_000_000 });
    ac(1);
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 100,
      state: "full",
      acOnline: true,
      minutesLeft: null,
    });
  });

  it("not charging (held at a charge threshold)", async () => {
    battery("BAT0", { status: "Not charging", capacity: 80, energy_now: 40_000_000, energy_full: 50_000_000, power_now: 0 });
    ac(1);
    await expect(read()).resolves.toMatchObject({ available: true, percent: 80, state: "not_charging", minutesLeft: null });
  });

  it("unknown status", async () => {
    battery("BAT0", { status: "Unknown", capacity: 55 });
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 55,
      state: "unknown",
      acOnline: null,
      minutesLeft: null,
    });
  });

  it("power_now 0 gives no time left rather than Infinity", async () => {
    battery("BAT0", { status: "Discharging", capacity: 50, energy_now: 25_000_000, energy_full: 50_000_000, power_now: 0 });
    await expect(read()).resolves.toMatchObject({ state: "discharging", minutesLeft: null });
  });

  it("power_now 0 while charging gives no time left either", async () => {
    battery("BAT0", { status: "Charging", capacity: 50, energy_now: 25_000_000, energy_full: 50_000_000, power_now: 0 });
    await expect(read()).resolves.toMatchObject({ state: "charging", minutesLeft: null });
  });

  it("caps the estimate at 48 h: exactly 48 h is shown, past it is null", async () => {
    battery("BAT0", { status: "Discharging", capacity: 96, energy_now: 48_000_000, energy_full: 50_000_000, power_now: 1_000_000 });
    await expect(read()).resolves.toMatchObject({ minutesLeft: 2880 });

    // 48e6 / 990e3 = 48.5 h.
    fs.writeFileSync(path.join(tmp, "devices", "BAT0", "power_now"), "990000\n");
    await expect(read()).resolves.toMatchObject({ state: "discharging", minutesLeft: null });
  });

  it("a negative (direction-signed) power_now counts by its size", async () => {
    battery("BAT0", { status: "Discharging", capacity: 50, energy_now: 25_000_000, energy_full: 50_000_000, power_now: -12_500_000 });
    await expect(read()).resolves.toMatchObject({ minutesLeft: 120 });
  });

  it("a charging battery already at energy_full is 0 minutes from full", async () => {
    battery("BAT0", { status: "Charging", capacity: 100, energy_now: 50_000_000, energy_full: 50_000_000, power_now: 2_000_000 });
    await expect(read()).resolves.toMatchObject({ state: "charging", minutesLeft: 0 });
  });
});

describe("readBattery — one battery, charge family (µAh, µA)", () => {
  it("discharging: charge_now / current_now", async () => {
    battery("BAT1", { status: "Discharging", capacity: 75, charge_now: 3_000_000, charge_full: 4_000_000, current_now: 1_500_000 });
    ac(0, "ADP1");
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 75,
      state: "discharging",
      acOnline: false,
      minutesLeft: 120,
    });
  });

  it("charging: (charge_full - charge_now) / current_now", async () => {
    battery("BAT1", { status: "Charging", capacity: 25, charge_now: 1_000_000, charge_full: 4_000_000, current_now: 2_000_000 });
    ac(1, "ADP1");
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 25,
      state: "charging",
      acOnline: true,
      minutesLeft: 90,
    });
  });

  it("current_now 0 gives no time left", async () => {
    battery("BAT1", { status: "Discharging", capacity: 75, charge_now: 3_000_000, charge_full: 4_000_000, current_now: 0 });
    await expect(read()).resolves.toMatchObject({ minutesLeft: null });
  });

  it("works out the percent from charge_now/charge_full when capacity is missing", async () => {
    battery("BAT1", { status: "Discharging", charge_now: 1_000_000, charge_full: 4_000_000, current_now: 500_000 });
    await expect(read()).resolves.toMatchObject({ available: true, percent: 25, minutesLeft: 120 });
  });
});

describe("readBattery — several batteries", () => {
  it("combines by energy, not by the mean of the capacities", async () => {
    // Idle internal battery and a working bay battery, as a ThinkPad takes turns.
    battery("BAT0", { status: "Unknown", capacity: 50, energy_now: 10_000_000, energy_full: 20_000_000, power_now: 0 });
    battery("BAT1", { status: "Discharging", capacity: 75, energy_now: 30_000_000, energy_full: 40_000_000, power_now: 10_000_000 });
    ac(0);
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 67, // 40 of 60 Wh; the mean of 50 and 75 would be 63
      state: "discharging",
      acOnline: false,
      minutesLeft: 240, // all 40 Wh at the pack's 10 W
    });
  });

  it("charging wins over an idle full battery, and time to full counts both", async () => {
    battery("BAT0", { status: "Full", capacity: 100, energy_now: 20_000_000, energy_full: 20_000_000, power_now: 0 });
    battery("BAT1", { status: "Charging", capacity: 50, energy_now: 20_000_000, energy_full: 40_000_000, power_now: 20_000_000 });
    ac(1);
    await expect(read()).resolves.toMatchObject({ percent: 67, state: "charging", minutesLeft: 60 });
  });

  it("uses the mean capacity when a battery does not report energy", async () => {
    battery("BAT0", { status: "Discharging", capacity: 40 });
    battery("BAT1", { status: "Unknown", capacity: 81 });
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 61, // (40 + 81) / 2 = 60.5
      state: "discharging",
      acOnline: null,
      minutesLeft: null,
    });
  });

  it("full only when every battery that reports says so", async () => {
    battery("BAT0", { status: "Full", capacity: 100 });
    battery("BAT1", { status: "Unknown", capacity: 100 });
    await expect(read()).resolves.toMatchObject({ state: "full" });

    fs.writeFileSync(path.join(tmp, "devices", "BAT1", "status"), "Not charging\n");
    await expect(read()).resolves.toMatchObject({ state: "not_charging" });
  });
});

describe("readBattery — which supplies count", () => {
  it("skips a Device-scope battery (a mouse), so it alone is no battery", async () => {
    battery("hidpp_battery_0", { scope: "Device", status: "Discharging", capacity: 30 });
    await expect(read()).resolves.toEqual({ available: false });
  });

  it("a Device-scope battery beside the laptop's does not change the answer", async () => {
    battery("BAT0", { status: "Discharging", capacity: 90 });
    battery("hidpp_battery_0", { scope: "Device", status: "Discharging", capacity: 10 });
    await expect(read()).resolves.toMatchObject({ available: true, percent: 90 });
  });

  it("skips a battery with present 0 (an empty bay)", async () => {
    battery("BAT0", { status: "Discharging", capacity: 90 });
    battery("BAT1", { present: 0, status: "Unknown", capacity: 0 });
    await expect(read()).resolves.toMatchObject({ available: true, percent: 90 });
  });

  it("treats a missing present or scope as a present system battery", async () => {
    supply("BAT0", { type: "Battery", status: "Charging", capacity: 33 });
    await expect(read()).resolves.toMatchObject({ available: true, percent: 33, state: "charging" });
  });

  it("acOnline is true when any Mains or USB supply is online", async () => {
    battery("BAT0", { status: "Charging", capacity: 50 });
    ac(0, "AC", "Mains");
    ac(1, "ucsi-source-psy-USBC000:001", "USB");
    await expect(read()).resolves.toMatchObject({ acOnline: true });
  });

  it("ignores a Device-scope charger", async () => {
    battery("BAT0", { status: "Discharging", capacity: 50 });
    supply("headset-charger", { type: "USB", scope: "Device", online: 1 });
    await expect(read()).resolves.toMatchObject({ acOnline: null });
  });
});

describe("readBattery — nothing to show", () => {
  it("arm64 (the Jetson) is unavailable even with a battery present", async () => {
    battery("BAT0", { status: "Discharging", capacity: 64 });
    await expect(read("arm64")).resolves.toEqual({ available: false });
  });

  it("a desktop with only a mains supply has no battery", async () => {
    ac(1);
    await expect(read()).resolves.toEqual({ available: false });
  });

  it("an empty power_supply directory has no battery", async () => {
    await expect(read()).resolves.toEqual({ available: false });
  });

  it("a missing root is unavailable, not an error", async () => {
    await expect(readBattery({ root: path.join(tmp, "nope"), arch: "x64" })).resolves.toEqual({ available: false });
  });

  it("a root that is a file is unavailable, not an error", async () => {
    const file = path.join(tmp, "file");
    fs.writeFileSync(file, "x");
    await expect(readBattery({ root: file, arch: "x64" })).resolves.toEqual({ available: false });
  });

  it("stray files and dangling links in the root are skipped", async () => {
    fs.writeFileSync(path.join(tmp, "class", "README"), "not a supply");
    fs.symlinkSync(path.join(tmp, "gone"), path.join(tmp, "class", "BAT9"));
    battery("BAT0", { status: "Full", capacity: 100 });
    await expect(read()).resolves.toMatchObject({ available: true, percent: 100, state: "full" });
  });
});

describe("readBattery — garbage values", () => {
  it("falls back to energy for the percent and reads odd strings as unknown", async () => {
    battery("BAT0", {
      status: "constructor", // must not find Object.prototype's
      capacity: "abc",
      energy_now: 30_000_000,
      energy_full: 40_000_000,
      power_now: "lots",
    });
    ac("yes");
    await expect(read()).resolves.toEqual({
      available: true,
      percent: 75,
      state: "unknown",
      acOnline: null,
      minutesLeft: null,
    });
  });

  it("a non-numeric rate gives no time left", async () => {
    battery("BAT0", { status: "Discharging", capacity: 50, energy_now: 25_000_000, energy_full: 50_000_000, power_now: "12.5W" });
    await expect(read()).resolves.toMatchObject({ state: "discharging", minutesLeft: null });
  });

  it("a battery whose percent cannot be read at all is unavailable", async () => {
    battery("BAT0", { status: "Discharging", capacity: "", energy_now: "-1", energy_full: "0" });
    await expect(read()).resolves.toEqual({ available: false });
  });

  it("clamps an over-reporting capacity to 100", async () => {
    battery("BAT0", { status: "Full", capacity: 104 });
    await expect(read()).resolves.toMatchObject({ percent: 100 });
  });

  it("a negative capacity is garbage, not 0 %", async () => {
    battery("BAT0", { status: "Discharging", capacity: -5, energy_now: 10_000_000, energy_full: 40_000_000 });
    await expect(read()).resolves.toMatchObject({ percent: 25 });
  });

  it("an unreadable type is no supply at all", async () => {
    supply("BAT0", { type: "Batt\u0000ery", status: "Discharging", capacity: 50 });
    await expect(read()).resolves.toEqual({ available: false });
  });
});

describe("readBattery — where it looks", () => {
  it("reads CLAWBOX_POWER_SUPPLY_DIR at call time", async () => {
    battery("BAT0", { status: "Charging", capacity: 12 });
    vi.stubEnv("CLAWBOX_POWER_SUPPLY_DIR", path.join(tmp, "class"));
    try {
      await expect(readBattery({ arch: "x64" })).resolves.toMatchObject({ available: true, percent: 12 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("under the suite's own env the default root is a path that cannot exist", async () => {
    expect(process.env.CLAWBOX_POWER_SUPPLY_DIR).toBe("/nonexistent/clawbox-test-power-supply");
    await expect(readBattery({ arch: "x64" })).resolves.toEqual({ available: false });
  });

  it("decides by os.arch() when no arch is passed", async () => {
    battery("BAT0", { status: "Discharging", capacity: 64 });
    const arch = vi.spyOn(os, "arch");
    arch.mockReturnValue("arm64");
    await expect(readBattery({ root: path.join(tmp, "class") })).resolves.toEqual({ available: false });
    arch.mockReturnValue("x64");
    await expect(readBattery({ root: path.join(tmp, "class") })).resolves.toMatchObject({ available: true, percent: 64 });
  });
});
