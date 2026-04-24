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

  it("records the active VNC display and reapplies the ClawBox desktop theme", () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), "scripts", "start-vnc.sh"),
      "utf8",
    );

    expect(script).toContain("vnc-display.env");
    expect(script).toContain("record_vnc_display");
    expect(script).toContain("apply-desktop-theme.sh");
  });

  it("restarts the VNC services during the vnc_install step so config changes apply immediately", () => {
    const installScript = fs.readFileSync(
      path.join(process.cwd(), "install.sh"),
      "utf8",
    );

    // Validate vnc_install still wraps the apt prerequisite + service restart,
    // AND the restart sits inside the function body. The trailing `\n}\n`
    // anchors the closing brace so the regex can't stretch across the whole
    // script and accidentally match a restart in some other function.
    expect(installScript).toMatch(
      /step_vnc_install\(\) \{[\s\S]*?wait_for_apt[\s\S]*?systemctl restart clawbox-vnc\.service clawbox-websockify\.service[\s\S]*?\n\}\n/,
    );
  });

  it("exposes the updater bootstrap step through the root step dispatcher", () => {
    const installScript = fs.readFileSync(
      path.join(process.cwd(), "install.sh"),
      "utf8",
    );

    expect(installScript).toContain("step_bootstrap_updater()");
    expect(installScript).toContain("bootstrap_updater apt_update nvidia_jetpack");
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

  it("installs the ClawBox desktop theme during the main installer flow", () => {
    const installScript = fs.readFileSync(
      path.join(process.cwd(), "install.sh"),
      "utf8",
    );

    expect(installScript).toContain("step_desktop_theme");
    expect(installScript).toContain("Applying ClawBox desktop theme");
    expect(installScript).toContain("clawbox-desktop-theme.desktop");
  });
});
