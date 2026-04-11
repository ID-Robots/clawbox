import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("VNC desktop config", () => {
  it("does not bind client-area left clicks in the generated Openbox config", () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), "scripts", "start-vnc.sh"),
      "utf8",
    );

    expect(script).not.toContain('<context name="Client">\n      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>');
    expect(script).not.toContain('<context name="Frame">\n      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>');
  });

  it("uses xset readiness checks instead of requiring xdpyinfo on fresh installs", () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), "scripts", "start-vnc.sh"),
      "utf8",
    );

    expect(script).toContain("xset -display");
    expect(script).not.toContain("xdpyinfo");
  });

  it("restarts the VNC services during the vnc_install step so config changes apply immediately", () => {
    const installScript = fs.readFileSync(
      path.join(process.cwd(), "install.sh"),
      "utf8",
    );

    expect(installScript).toContain("systemctl restart clawbox-vnc.service clawbox-websockify.service || true");
  });

  it("schedules a one-time VNC bring-up on the first reboot after install", () => {
    const installScript = fs.readFileSync(
      path.join(process.cwd(), "install.sh"),
      "utf8",
    );

    expect(installScript).toContain("clawbox-firstboot-vnc.service");
    expect(installScript).toContain("ensure-vnc-on-first-boot.pending");
    expect(installScript).toContain("systemctl enable clawbox-vnc.service clawbox-websockify.service clawbox-firstboot-vnc.service");
  });
});
