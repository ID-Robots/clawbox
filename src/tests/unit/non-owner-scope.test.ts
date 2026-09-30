import { describe, expect, it } from "vitest";
import {
  installedAppIdsFor,
  nonOwnerVerdict,
  NON_OWNER_APP_IDS,
  NON_OWNER_HOME,
  requestIntent,
  type RequestIntent,
} from "@/lib/non-owner-scope";

// TASK-1256: a ClawBox user who is not the owner reaches only what is scoped
// per user. An allow-list — every other route stays the owner's.

function verdict(url: string, method = "GET", intent: RequestIntent = "fetch") {
  const u = new URL(url, "http://clawbox.local");
  return nonOwnerVerdict({ pathname: u.pathname, method, searchParams: u.searchParams, intent });
}

describe("nonOwnerVerdict", () => {
  it.each([
    "/setup-api/users/me",
    "/setup-api/setup/status",
    "/setup-api/terminal/shells",
    "/setup-api/update/status",
    "/setup-api/network/internet",
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
    ["POST", "/setup-api/network/internet"],
  ])("denies %s %s", (method, url) => {
    expect(verdict(url, method)).toBe("deny");
  });

  it("opens the connectivity probe only, not the network configuration beside it", () => {
    expect(verdict("/setup-api/network/internet")).toBe("allow");
    for (const url of ["/setup-api/network", "/setup-api/network/internet/x", "/setup-api/wifi/status", "/setup-api/wifi/scan"]) {
      expect(verdict(url), url).toBe("deny");
    }
  });

  it("denies the gateway, however the path ends", () => {
    for (const url of ["/api/chat", "/assets/index.js", "/assets/logo.png", "/__openclaw__/plugin-icon/x.png", "/avatar/main"]) {
      expect(verdict(url), url).toBe("deny");
    }
  });

  it("answers an API path with the 403 even when a person navigates to it", () => {
    for (const intent of ["navigation", "unknown", "fetch"] as const) {
      expect(verdict("/setup-api/users", "GET", intent), intent).toBe("deny");
      expect(verdict("/api/chat", "GET", intent), intent).toBe("deny");
    }
  });

  it("opens the desktop, the updating page and a standalone Terminal", () => {
    for (const url of ["/", "/updating", "/app/terminal", "/?notice=owner-only"]) {
      expect(verdict(url, "GET", "navigation"), url).toBe("allow");
    }
  });

  it("sends any other page back to the desktop", () => {
    for (const url of ["/setup", "/setup/settings", "/app/settings", "/app/files", "/chat", "/sessions", "/settings", "/files", "/hermes", "/novnc", "/apps"]) {
      expect(verdict(url, "GET", "navigation"), url).toBe("redirect-home");
    }
  });

  it("sends a page asked for without Fetch Metadata or Accept (curl, plain-HTTP browsers) to the desktop too", () => {
    for (const url of ["/settings", "/files", "/app/browser", "/hermes", "/novnc", "/setup"]) {
      expect(verdict(url, "GET", "unknown"), url).toBe("redirect-home");
      expect(verdict(url, "HEAD", "unknown"), url).toBe("redirect-home");
    }
  });

  it("keeps the 403 for code that says it is code, and for any write", () => {
    expect(verdict("/settings", "GET", "fetch")).toBe("deny");
    expect(verdict("/settings", "POST", "navigation")).toBe("deny");
    expect(verdict("/settings", "POST", "unknown")).toBe("deny");
  });

  it("lets the desktop's own media through and nothing script-like", () => {
    expect(verdict("/clawbox-wallpaper.jpeg")).toBe("allow");
    expect(verdict("/pets/crab/sheet.png")).toBe("allow");
    expect(verdict("/fonts/geist.woff2")).toBe("allow");
    expect(verdict("/fonts/geist.woff2", "GET", "unknown")).toBe("allow");
    expect(verdict("/control-ui-config.json")).toBe("deny");
    expect(verdict("/control-ui-config.json", "GET", "unknown")).toBe("deny");
    expect(verdict("/health")).toBe("deny");
    expect(verdict("/something.js")).toBe("deny");
    expect(verdict("/something.js", "GET", "unknown")).toBe("deny");
  });

  it("lands a redirected non-owner on the desktop with the owner-only notice", () => {
    expect(NON_OWNER_HOME).toBe("/?notice=owner-only");
  });

  it("shows a non-owner the Terminal and nothing else", () => {
    expect(NON_OWNER_APP_IDS).toEqual(["terminal"]);
  });

  it("offers the owner's installed apps to the owner only", () => {
    expect(installedAppIdsFor(true, ["weather", "notes"])).toEqual(["weather", "notes"]);
    expect(installedAppIdsFor(false, ["weather", "notes"])).toEqual([]);
  });
});

describe("requestIntent", () => {
  const intent = (h: Record<string, string>) => requestIntent(new Headers(h));

  it("trusts Fetch Metadata when the browser sends it", () => {
    for (const dest of ["document", "iframe", "frame", "embed", "object"]) {
      expect(intent({ "sec-fetch-dest": dest, accept: "*/*" }), dest).toBe("navigation");
    }
    for (const dest of ["empty", "image", "script", "style", "font"]) {
      expect(intent({ "sec-fetch-dest": dest, accept: "text/html" }), dest).toBe("fetch");
    }
  });

  it("reads a browser navigation over plain HTTP (no Sec-Fetch-*) from its Accept", () => {
    expect(intent({ accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" })).toBe("navigation");
  });

  it("reads the Next router's RSC requests and JSON callers as code", () => {
    expect(intent({ rsc: "1", accept: "*/*" })).toBe("fetch");
    expect(intent({ "next-router-prefetch": "1" })).toBe("fetch");
    expect(intent({ accept: "application/json" })).toBe("fetch");
  });

  it("calls a request that says nothing unknown", () => {
    expect(intent({})).toBe("unknown");
    expect(intent({ accept: "*/*" })).toBe("unknown");
  });
});
