import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Runs the real guard script under bash: both ceilings, see test-timeout-hygiene.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

/**
 * TASK-1636: after an update a box did not boot because its NVMe entry had
 * slid to the BOTTOM of the UEFI BootOrder. The guard puts it back on top and
 * the network entries at the end. TASK-2175: it leaves those ACTIVE and new
 * devices on top, because the L4T firmware re-creates a deactivated or deleted
 * network entry on every boot, and with new devices at the bottom an NVMe entry
 * it re-creates lands under the UEFI Shell. Driven against a fake efibootmgr
 * that keeps its state in a file, the way the real one keeps it in NVRAM.
 */
const REPO = path.resolve(__dirname, "../../..");
const GUARD = path.join(REPO, "scripts/uefi-boot-order/clawbox-nvme-boot-order.sh");
const NDH = "NewDeviceHierarchy-781e084c-a330-417c-b678-38e696380cb9";

const FAKE_EFIBOOTMGR = `#!/bin/bash
state="$FAKE_STATE"
if [ "$1" = "-v" ]; then cat "$state"; exit 0; fi
[ "$1" = "-q" ] && shift
echo "$*" >> "$FAKE_STATE.writes"
if [ "$1" = "-o" ]; then sed -i "s/^BootOrder: .*/BootOrder: $2/" "$state"; exit 0; fi
if [ "$1" = "-b" ] && [ "$3" = "-A" ]; then sed -i "s/^Boot$2\\* /Boot$2  /" "$state"; exit 0; fi
if [ "$1" = "-b" ] && [ "$3" = "-a" ]; then
  [ -n "\${FAKE_FAIL_ACTIVATE:-}" ] && exit 1
  sed -i "s/^Boot$2  /Boot$2* /" "$state"; exit 0
fi
exit 1
`;

// The customer's state: NVMe re-created by the firmware, appended last.
const DRIFTED = [
  "BootCurrent: 0009",
  "Timeout: 5 seconds",
  "BootOrder: 0000,0001,0002,0003,0004,0005,0009",
  "Boot0000* UEFI PXEv4 (MAC:48B02DAABBCC)\tPciRoot(0x0)/Pci(0x0,0x0)/MAC(48b02daabbcc,0x0)/IPv4(0.0.0.00.0.0.0,0x0,0x0)",
  "Boot0001* UEFI PXEv6 (MAC:48B02DAABBCC)\tPciRoot(0x0)/Pci(0x0,0x0)/MAC(48b02daabbcc,0x0)/IPv6([::]:<->[::]:,0x0)",
  "Boot0002* UEFI HTTPv4 (MAC:48B02DAABBCC)\tPciRoot(0x0)/Pci(0x0,0x0)/MAC(48b02daabbcc,0x0)/IPv4(0.0.0.00.0.0.0,0x0,0x0)/Uri()",
  "Boot0003* UEFI HTTPv6 (MAC:48B02DAABBCC)\tPciRoot(0x0)/Pci(0x0,0x0)/MAC(48b02daabbcc,0x0)/IPv6([::]:<->[::]:,0x0)/Uri()",
  "Boot0004* UEFI Shell\tFvVol(7e374e25-8e01-4fee-87f2-390c23c606cd)/FvFile(7c04a583-9e3e-4f1c-ad65-e05268d0b4d1)",
  "Boot0005* Enter Setup\tFvVol(7e374e25-8e01-4fee-87f2-390c23c606cd)/FvFile(462caa21-7614-4503-836e-8ab6f4662331)",
  "Boot0009* UEFI Samsung SSD 990 1TB\tPciRoot(0x1)/Pci(0x0,0x0)/Pci(0x0,0x0)/NVMe(0x1,00-00-00-00-00-00-00-00)/HD(1,GPT,0,0x0,0x0)",
  "",
].join("\n");

// What the previous guard left on every box it ran on: the same entries with
// the network ones inactive at the end, and new devices at the bottom.
const OLD_GUARD = [
  "BootCurrent: 0009",
  "Timeout: 5 seconds",
  "BootOrder: 0009,0004,0005,0000,0001,0002,0003",
  ...DRIFTED.split("\n")
    .filter((l) => l.startsWith("Boot0"))
    .map((l) => l.replace(/^(Boot000[0-3])\* /, "$1  ")),
  "",
].join("\n");

let dir: string;
let state: string;
let efivars: string;

function run(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync("bash", [GUARD, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_STATE: state,
      EFIVARS_DIR: efivars,
      ...env,
    },
  });
}

const ndh = () => [...readFileSync(path.join(efivars, NDH))];
const writes = () => {
  try {
    return readFileSync(`${state}.writes`, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * The part of the L4T firmware's boot (Quick Boot off, so on every power-on)
 * the guard has to live with, as measured on Orin Nano boards (TASK-2175) and
 * in edk2 EfiBootManagerRefreshAllBootOption: an auto-created entry that does
 * not match the device the firmware enumerated (an inactive one never does,
 * the attributes are compared too; a missing device has no match at all) is
 * deleted, and each enumerated device without a match gets a new, active entry
 * at the top (NewDeviceHierarchy 1) or the bottom (0). Returns the next state.
 */
function firmwareBoot(text: string, newDevicesOnTop: boolean, missing: string[] = []) {
  const lines = text.split("\n");
  let order = lines.find((l) => l.startsWith("BootOrder: "))!.slice(11).split(",");
  const auto = (l: string) => /PXEv|HTTPv|NVMe\(/.test(l);
  const recreated: string[] = [];
  const out = lines.map((l) => {
    const m = /^Boot([0-9A-F]{4})(\*| ) (.*)$/.exec(l);
    if (!m || !auto(l)) return l;
    const n = m[1];
    // Deleted; the line stays so a later boot that finds the device again can re-create it.
    if (missing.includes(n)) {
      order = order.filter((o) => o !== n);
      return l;
    }
    if (m[2] === "*" && order.includes(n)) return l; // matches: left where it is
    order = order.filter((o) => o !== n);
    recreated.push(n);
    return `Boot${n}* ${m[3]}`;
  });
  // On top each one goes to position 0, so the last one created ends up first.
  order = newDevicesOnTop ? [...recreated.reverse(), ...order] : [...order, ...recreated];
  return out.map((l) => (l.startsWith("BootOrder: ") ? `BootOrder: ${order.join(",")}` : l)).join("\n");
}

/** What the boot manager starts: the first active entry in BootOrder (the setup apps are hidden ones). */
function firstBoot(text: string) {
  const order = text.split("\n").find((l) => l.startsWith("BootOrder: "))!.slice(11).split(",");
  for (const n of order) {
    const l = text.split("\n").find((x) => x.startsWith(`Boot${n}`)) ?? "";
    if (l.startsWith(`Boot${n}* `) && !/Enter Setup/.test(l)) return l.slice(10).split("\t")[0];
  }
  return "nothing";
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "uefi-order-"));
  state = path.join(dir, "state");
  efivars = path.join(dir, "efivars");
  mkdirSync(efivars);
  writeFileSync(state, DRIFTED);
  writeFileSync(path.join(dir, "efibootmgr"), FAKE_EFIBOOTMGR);
  chmodSync(path.join(dir, "efibootmgr"), 0o755);
  // NVIDIA's attributes (BS|NV|RT) + 1 = "add new devices at the top".
  writeFileSync(path.join(efivars, NDH), Buffer.from([7, 0, 0, 0, 1]));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("clawbox-nvme-boot-order", () => {
  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", GUARD])).not.toThrow();
  });

  it("flags the drifted order the customer found (NVMe last)", () => {
    expect(run(["--check"]).status).toBe(1);
  });

  it("moves NVMe to the top and network last, leaves network active and new devices on top", () => {
    expect(run().status).toBe(0);
    const after = readFileSync(state, "utf8");
    expect(after).toMatch(/^BootOrder: 0009,0004,0005,0000,0001,0002,0003$/m);
    for (const n of ["0000", "0001", "0002", "0003", "0009"]) expect(after).toMatch(new RegExp(`^Boot${n}\\* `, "m"));
    expect(writes()).toEqual(["-o 0009,0004,0005,0000,0001,0002,0003"]);
    expect(ndh()).toEqual([7, 0, 0, 0, 1]);
    expect(run(["--check"]).status).toBe(0);
  });

  it("undoes what the previous guard left: network entries active again, new devices on top", () => {
    writeFileSync(state, OLD_GUARD);
    writeFileSync(path.join(efivars, NDH), Buffer.from([7, 0, 0, 0, 0]));
    expect(run(["--check"]).status).toBe(1);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/reactivating network boot entry Boot0000/);
    const after = readFileSync(state, "utf8");
    expect(after).toMatch(/^BootOrder: 0009,0004,0005,0000,0001,0002,0003$/m);
    for (const n of ["0000", "0001", "0002", "0003"]) expect(after).toMatch(new RegExp(`^Boot${n}\\* `, "m"));
    expect(writes()).toEqual(["-b 0000 -a", "-b 0001 -a", "-b 0002 -a", "-b 0003 -a"]);
    expect(ndh()).toEqual([7, 0, 0, 0, 1]);
    expect(run(["--check"]).status).toBe(0);
  });

  it("keeps new devices at the bottom while a network entry could not be made active", () => {
    // Inactive network entries plus new devices on top: the next boot would
    // re-create them, at the top, ahead of the NVMe.
    writeFileSync(state, OLD_GUARD);
    writeFileSync(path.join(efivars, NDH), Buffer.from([7, 0, 0, 0, 0]));
    const r = run([], { FAKE_FAIL_ACTIVATE: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/WARNING: did not set NewDeviceHierarchy to 1/);
    expect(ndh()).toEqual([7, 0, 0, 0, 0]);
  });

  it("creates NewDeviceHierarchy with NVIDIA's attributes when it is absent", () => {
    rmSync(path.join(efivars, NDH));
    expect(run().status).toBe(0);
    expect(ndh()).toEqual([7, 0, 0, 0, 1]);
  });

  it("writes nothing when the order is already right", () => {
    run();
    const once = readFileSync(state, "utf8");
    rmSync(`${state}.writes`, { force: true });
    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).not.toMatch(/->|reactivating/);
    expect(writes()).toEqual([]);
    expect(readFileSync(state, "utf8")).toBe(once);
  });

  it("never fails the boot when there is no NVMe entry, and leaves the firmware settings alone", () => {
    writeFileSync(state, DRIFTED.replace(/^Boot0009.*\n/m, "").replace(",0009", ""));
    writeFileSync(path.join(efivars, NDH), Buffer.from([7, 0, 0, 0, 0]));
    expect(run().status).toBe(0);
    expect(writes()).toEqual([]);
    expect(ndh()).toEqual([7, 0, 0, 0, 0]);
    expect(run(["--check"]).status).toBe(2);
  });
});

describe("what the firmware does with the order the guard leaves (TASK-2175)", () => {
  it("the old guard's inactive network entries come back active on every boot", () => {
    const booted = firmwareBoot(OLD_GUARD, false);
    for (const n of ["0000", "0001", "0002", "0003"]) expect(booted).toMatch(new RegExp(`^Boot${n}\\* `, "m"));
    // ...and with new devices on top they come back ahead of the NVMe (TASK-1289).
    expect(firstBoot(firmwareBoot(OLD_GUARD, true))).toMatch(/PXE|HTTP/);
  });

  it("the old guard: a boot that misses the SSD leaves it under the UEFI Shell for good", () => {
    const missed = firmwareBoot(OLD_GUARD, false, ["0009"]);
    expect(firstBoot(missed)).toBe("UEFI Shell");
    const next = firmwareBoot(missed, false);
    expect(next).toMatch(/^BootOrder: .*,0009$/m);
    expect(firstBoot(next)).toBe("UEFI Shell");
  });

  it("this guard's order is left alone by the firmware, boot after boot", () => {
    expect(run().status).toBe(0);
    const guarded = readFileSync(state, "utf8");
    expect(firmwareBoot(guarded, true)).toBe(guarded);
    expect(firstBoot(guarded)).toBe("UEFI Samsung SSD 990 1TB");
  });

  it("this guard: after a boot that missed the SSD, the next one boots it again", () => {
    expect(run().status).toBe(0);
    const missed = firmwareBoot(readFileSync(state, "utf8"), true, ["0009"]);
    expect(firstBoot(missed)).toBe("UEFI Shell"); // the firmware's own dead end, nothing on disk changes it
    const next = firmwareBoot(missed, true);
    expect(next).toMatch(/^BootOrder: 0009,/m);
    expect(firstBoot(next)).toBe("UEFI Samsung SSD 990 1TB");
  });
});

describe("install.sh wiring", () => {
  const SH = readFileSync(path.join(REPO, "install.sh"), "utf8");

  it("every in-app update installs and runs the guard", () => {
    const postUpdate = SH.slice(SH.indexOf("step_post_update() {"));
    expect(postUpdate.slice(0, postUpdate.indexOf("\n}\n"))).toContain(
      "optional_step uefi_boot_order step_uefi_boot_order",
    );
  });

  it("a fresh install does too, non-fatally", () => {
    expect(SH).toContain('step_uefi_boot_order || echo "  Warning: UEFI boot order step failed (non-fatal)"');
  });

  it("stays off non-Jetson hosts", () => {
    const step = SH.slice(SH.indexOf("step_uefi_boot_order() {"));
    expect(step.slice(0, step.indexOf("\n}\n"))).toContain("/etc/nv_tegra_release");
  });
});
