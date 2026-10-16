import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * TASK-1636: after an update a box did not boot because its NVMe entry had
 * slid to the BOTTOM of the UEFI BootOrder. The guard puts it back on top and
 * parks the network entries inactive at the end. Driven against a fake
 * efibootmgr that keeps its state in a file, the way the real one keeps it in
 * NVRAM.
 */
const REPO = path.resolve(__dirname, "../../..");
const GUARD = path.join(REPO, "scripts/uefi-boot-order/clawbox-nvme-boot-order.sh");
const NDH = "NewDeviceHierarchy-781e084c-a330-417c-b678-38e696380cb9";

const FAKE_EFIBOOTMGR = `#!/bin/bash
state="$FAKE_STATE"
if [ "$1" = "-v" ]; then cat "$state"; exit 0; fi
[ "$1" = "-q" ] && shift
if [ "$1" = "-o" ]; then sed -i "s/^BootOrder: .*/BootOrder: $2/" "$state"; exit 0; fi
if [ "$1" = "-b" ] && [ "$3" = "-A" ]; then sed -i "s/^Boot$2\\* /Boot$2  /" "$state"; exit 0; fi
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

let dir: string;
let state: string;
let efivars: string;

function run(...args: string[]) {
  return spawnSync("bash", [GUARD, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_STATE: state,
      EFIVARS_DIR: efivars,
    },
  });
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
    expect(run("--check").status).toBe(1);
  });

  it("moves NVMe to the top, network last and inactive, new devices to the bottom", () => {
    expect(run().status).toBe(0);
    const after = readFileSync(state, "utf8");
    expect(after).toMatch(/^BootOrder: 0009,0004,0005,0000,0001,0002,0003$/m);
    for (const n of ["0000", "0001", "0002", "0003"]) expect(after).toMatch(new RegExp(`^Boot${n} `, "m"));
    expect(after).toMatch(/^Boot0009\* /m);
    expect([...readFileSync(path.join(efivars, NDH))]).toEqual([7, 0, 0, 0, 0]);
    expect(run("--check").status).toBe(0);
  });

  it("writes nothing when the order is already right", () => {
    run();
    const once = readFileSync(state, "utf8");
    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).not.toMatch(/->|deactivating/);
    expect(readFileSync(state, "utf8")).toBe(once);
  });

  it("never fails the boot when there is no NVMe entry", () => {
    writeFileSync(state, DRIFTED.replace(/^Boot0009.*\n/m, "").replace(",0009", ""));
    expect(run().status).toBe(0);
    expect(run("--check").status).toBe(2);
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
