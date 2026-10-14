/**
 * Is this box on the per-device-credentials flow (TASK-1572)?
 *
 * Only a box the factory station provisioned (scripts/provision-device.sh)
 * carries the marker below; it lives in /etc next to the device secret, so a
 * factory reset (which wipes data/) keeps it. Every box that was set up before
 * this flow existed has no marker and keeps its behaviour exactly as it was:
 * same hotspot, same captive-probe answers, same password and SSH handling.
 * provision-device.sh refuses a box that already has an owner, so the marker
 * can never appear on a customer's box through an update.
 *
 * When the answer cannot be read the box counts as NOT provisioned, i.e. it
 * keeps the legacy behaviour.
 */
import fs from "fs";
import path from "path";

export function deviceEtcDir(): string {
  return process.env.CLAWBOX_ETC || "/etc/clawbox";
}

export function provisionedMarkerPath(): string {
  return path.join(deviceEtcDir(), "provisioned");
}

export function isProvisionedDevice(): boolean {
  try {
    const st = fs.lstatSync(provisionedMarkerPath());
    return st.isFile();
  } catch {
    return false;
  }
}
