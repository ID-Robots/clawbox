import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("browser boot configuration", () => {
  it("keeps the browser systemd unit out of boot targets", () => {
    const serviceFile = fs.readFileSync(
      path.join(process.cwd(), "config", "clawbox-browser.service"),
      "utf8",
    );

    expect(serviceFile).not.toContain("WantedBy=multi-user.target");
  });

  it("disables the browser service during installer systemd setup", () => {
    const installScript = fs.readFileSync(
      path.join(process.cwd(), "install.sh"),
      "utf8",
    );

    expect(installScript).toContain('[[ "$svc" == "clawbox-browser.service" ]] && continue');
    expect(installScript).toContain("systemctl disable --now clawbox-browser.service");
  });

  it("runs the browser service as clawbox and captures launch logs", () => {
    const serviceFile = fs.readFileSync(
      path.join(process.cwd(), "config", "clawbox-browser.service"),
      "utf8",
    );

    expect(serviceFile).toContain("User=clawbox");
    expect(serviceFile).toContain("WorkingDirectory=/home/clawbox/clawbox");
    expect(serviceFile).toContain("StandardOutput=append:/tmp/clawbox-browser.log");
  });

  it("installs a Playwright Chromium runtime for the desktop browser service", () => {
    const installScript = fs.readFileSync(
      path.join(process.cwd(), "install.sh"),
      "utf8",
    );

    expect(installScript).toContain("ensure_playwright_chromium");
    expect(installScript).toContain("playwright install chromium");
  });
});
