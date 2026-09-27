import { describe, expect, it } from "vitest";
import { nonOwnerVerdict, NON_OWNER_APP_IDS } from "@/lib/non-owner-scope";

// TASK-1256: a ClawBox user who is not the owner reaches only what is scoped
// per user. An allow-list — every other route stays the owner's.

function verdict(url: string, method = "GET", isDocument = false) {
  const u = new URL(url, "http://clawbox.local");
  return nonOwnerVerdict({ pathname: u.pathname, method, searchParams: u.searchParams, isDocument });
}

describe("nonOwnerVerdict", () => {
  it.each([
    "/setup-api/users/me",
    "/setup-api/setup/status",
    "/setup-api/terminal/shells",
    "/setup-api/update/status",
    "/setup-api/preferences?keys=ui_language",
    "/setup-api/preferences?keys=terminal_settings",
    "/setup-api/preferences?keys=ui_language,terminal_settings",
  ])("allows GET %s", (url) => {
    expect(verdict(url)).toBe("allow");
  });

  it.each([
    "/setup-api/users",
    "/setup-api/preferences?all=1",
    "/setup-api/preferences?keys=ui_language,installed_meta",
    "/setup-api/preferences?keys=ui_language&all=1",
    "/setup-api/preferences",
    "/setup-api/files",
    "/setup-api/files/etc/passwd",
    "/setup-api/kv",
    "/setup-api/coding-agent/enable",
    "/setup-api/system/credentials",
    "/setup-api/gateway/token",
    "/setup-api/install/run-step",
    "/Setup-API/users/me",
    "/setup-api/users/me/",
  ])("denies GET %s", (url) => {
    expect(verdict(url)).toBe("deny");
  });

  it.each([
    ["POST", "/setup-api/users"],
    ["DELETE", "/setup-api/users"],
    ["POST", "/setup-api/preferences"],
    ["POST", "/setup-api/users/me"],
    ["POST", "/setup-api/coding-agent/enable"],
    ["POST", "/setup-api/system/power"],
  ])("denies %s %s", (method, url) => {
    expect(verdict(url, method)).toBe("deny");
  });

  it("denies the gateway, however the path ends", () => {
    for (const url of ["/api/chat", "/assets/index.js", "/assets/logo.png", "/__openclaw__/plugin-icon/x.png", "/avatar/main"]) {
      expect(verdict(url), url).toBe("deny");
    }
  });

  it("opens the desktop, the updating page and a standalone Terminal", () => {
    for (const url of ["/", "/updating", "/app/terminal"]) {
      expect(verdict(url, "GET", true), url).toBe("allow");
    }
  });

  it("sends any other page back to the desktop", () => {
    for (const url of ["/setup", "/setup/settings", "/app/settings", "/app/files", "/chat", "/sessions"]) {
      expect(verdict(url, "GET", true), url).toBe("redirect-home");
    }
  });

  it("lets the desktop's own media through and nothing script-like", () => {
    expect(verdict("/clawbox-wallpaper.jpeg")).toBe("allow");
    expect(verdict("/pets/crab/sheet.png")).toBe("allow");
    expect(verdict("/fonts/geist.woff2")).toBe("allow");
    expect(verdict("/control-ui-config.json")).toBe("deny");
    expect(verdict("/health")).toBe("deny");
    expect(verdict("/something.js")).toBe("deny");
  });

  it("shows a non-owner the Terminal and nothing else", () => {
    expect(NON_OWNER_APP_IDS).toEqual(["terminal"]);
  });
});
