import { describe, expect, it } from "vitest";

import { parsePastedRedirect } from "@/lib/google-connect";
import {
  GOOGLE_WORKSPACE_DEFAULT_REDIRECT_URI,
  GOOGLE_WORKSPACE_SCOPES,
  OAUTH_PROVIDERS,
  googleWorkspaceOAuth,
  isGoogleConnectEnabled,
  isGoogleWorkspaceConfigured,
} from "@/lib/oauth-config";

// "Connect Google" is ClawBox's own Google client for Calendar + Drive, behind
// CLAWBOX_GOOGLE_CONNECT (off by default), with the client id from the box's
// env. Pinned here: the flag reads exactly "1", the client is never the Gemini
// CLI one, it asks for no Gmail scope, and it is not an AI-model provider.

// Placeholders in the shape of a Google client id; never a real client.
const ON = { CLAWBOX_GOOGLE_CONNECT: "1", CLAWBOX_GOOGLE_CLIENT_ID: "000000000000-test.apps.googleusercontent.com" };

describe("the Connect Google flag", () => {
  it("is off unless it is exactly \"1\"", () => {
    expect(isGoogleConnectEnabled({})).toBe(false);
    for (const value of ["", "0", "true", "yes", " 1", "1 "]) {
      expect(isGoogleConnectEnabled({ CLAWBOX_GOOGLE_CONNECT: value })).toBe(false);
    }
    expect(isGoogleConnectEnabled({ CLAWBOX_GOOGLE_CONNECT: "1" })).toBe(true);
  });

  it("leaves the client unconfigured while it is off, whatever the client id", () => {
    expect(googleWorkspaceOAuth({ CLAWBOX_GOOGLE_CLIENT_ID: ON.CLAWBOX_GOOGLE_CLIENT_ID })).toBeNull();
    expect(isGoogleWorkspaceConfigured({ CLAWBOX_GOOGLE_CLIENT_ID: ON.CLAWBOX_GOOGLE_CLIENT_ID })).toBe(false);
  });

  it("needs a client id of its own once on", () => {
    expect(googleWorkspaceOAuth({ CLAWBOX_GOOGLE_CONNECT: "1" })).toBeNull();
    expect(googleWorkspaceOAuth({ CLAWBOX_GOOGLE_CONNECT: "1", CLAWBOX_GOOGLE_CLIENT_ID: "   " })).toBeNull();
    expect(isGoogleWorkspaceConfigured(ON)).toBe(true);
  });

  it("never borrows the Gemini CLI client", () => {
    const env = {
      CLAWBOX_GOOGLE_CONNECT: "1",
      GOOGLE_OAUTH_CLIENT_ID: "gemini-cli-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "gemini-cli-secret",
    };
    expect(googleWorkspaceOAuth(env)).toBeNull();
    const config = googleWorkspaceOAuth({ ...env, ...ON });
    expect(config?.clientId).toBe(ON.CLAWBOX_GOOGLE_CLIENT_ID);
    expect(config?.clientSecret).toBeUndefined();
  });
});

describe("the ClawBox Google client", () => {
  it("asks for Calendar events and drive.file only — no Gmail", () => {
    const config = googleWorkspaceOAuth(ON);
    expect(config?.scopes.split(" ")).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/drive.file",
    ]);
    expect(GOOGLE_WORKSPACE_SCOPES.some((s) => s.includes("gmail") || s.includes("mail.google"))).toBe(false);
    expect(config?.extraParams).toEqual({ access_type: "offline", prompt: "consent" });
    expect(config?.authorizeUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(config?.tokenEndpoint).toBe("https://oauth2.googleapis.com/token");
  });

  it("carries a Desktop client's secret when the box has one", () => {
    expect(googleWorkspaceOAuth({ ...ON, CLAWBOX_GOOGLE_CLIENT_SECRET: "test-secret" })?.clientSecret).toBe("test-secret");
  });

  it("redirects to a loopback port nothing listens on, unless the box says otherwise", () => {
    expect(googleWorkspaceOAuth(ON)?.redirectUri).toBe(GOOGLE_WORKSPACE_DEFAULT_REDIRECT_URI);
    expect(GOOGLE_WORKSPACE_DEFAULT_REDIRECT_URI).toBe("http://127.0.0.1:1");
    expect(googleWorkspaceOAuth({ ...ON, CLAWBOX_GOOGLE_REDIRECT_URI: "https://example.com/google" })?.redirectUri)
      .toBe("https://example.com/google");
    for (const bad of ["not a url", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(googleWorkspaceOAuth({ ...ON, CLAWBOX_GOOGLE_REDIRECT_URI: bad })?.redirectUri)
        .toBe(GOOGLE_WORKSPACE_DEFAULT_REDIRECT_URI);
    }
  });

  it("is not an AI-model provider the ai-models OAuth routes could reach", () => {
    expect(Object.keys(OAUTH_PROVIDERS).sort()).toEqual(["anthropic", "google", "openai"]);
    expect(OAUTH_PROVIDERS.google.scopes).not.toContain("calendar");
    expect(OAUTH_PROVIDERS.google.scopes).not.toContain("drive");
  });
});

describe("parsePastedRedirect", () => {
  it("reads the whole address the browser landed on", () => {
    expect(parsePastedRedirect("http://127.0.0.1:1/?state=abc&code=4%2F0Atest&scope=x")).toEqual({
      ok: true,
      code: "4/0Atest",
      state: "abc",
    });
  });

  it("reads an address without its scheme, or the query alone", () => {
    expect(parsePastedRedirect("127.0.0.1:1/?code=c1&state=s1")).toEqual({ ok: true, code: "c1", state: "s1" });
    expect(parsePastedRedirect("?code=c2&state=s2")).toEqual({ ok: true, code: "c2", state: "s2" });
    expect(parsePastedRedirect("code=c3")).toEqual({ ok: true, code: "c3", state: null });
  });

  it("takes a bare code, decoding what the address bar encoded", () => {
    expect(parsePastedRedirect("  4/0Abare  ")).toEqual({ ok: true, code: "4/0Abare", state: null });
    expect(parsePastedRedirect("4%2F0Abare")).toEqual({ ok: true, code: "4/0Abare", state: null });
  });

  it("reports a refusal on Google's page as denied", () => {
    expect(parsePastedRedirect("http://127.0.0.1:1/?error=access_denied&state=abc")).toEqual({
      ok: false,
      reason: "denied",
      detail: "access_denied",
    });
  });

  it("refuses what is not a sign-in", () => {
    expect(parsePastedRedirect("   ")).toEqual({ ok: false, reason: "empty" });
    expect(parsePastedRedirect("http://127.0.0.1:1/?state=abc")).toEqual({ ok: false, reason: "no_code" });
    expect(parsePastedRedirect("https://accounts.google.com/")).toEqual({ ok: false, reason: "no_code" });
    expect(parsePastedRedirect("some words pasted by mistake")).toEqual({ ok: false, reason: "no_code" });
    expect(parsePastedRedirect("x".repeat(3000))).toEqual({ ok: false, reason: "no_code" });
  });
});
