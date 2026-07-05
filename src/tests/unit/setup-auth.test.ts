import { describe, expect, it } from "vitest";
import { isAuthExpired, JSON_ACCEPT_HEADERS } from "@/lib/setup-auth";

// Minimal Response-like stub — isAuthExpired only reads status/redirected/url.
function res({ status = 200, redirected = false, url = "http://box.local/setup-api/vnc" } = {}): Response {
  return { status, redirected, url } as Response;
}

describe("isAuthExpired", () => {
  it("flags a 401 (the JSON-client path from middleware)", () => {
    expect(isAuthExpired(res({ status: 401 }))).toBe(true);
  });

  it("flags a followed redirect whose final path is /login (the HTML-client path)", () => {
    expect(isAuthExpired(res({ status: 200, redirected: true, url: "http://box.local/login?redirect=/setup-api/vnc" }))).toBe(true);
  });

  it("treats a normal 200 JSON response as an active session", () => {
    expect(isAuthExpired(res({ status: 200 }))).toBe(false);
  });

  it("ignores a redirect that is not to /login", () => {
    expect(isAuthExpired(res({ status: 200, redirected: true, url: "http://box.local/setup-api/vnc" }))).toBe(false);
  });

  it("does not treat other error statuses as auth expiry", () => {
    expect(isAuthExpired(res({ status: 500 }))).toBe(false);
  });

  it("requests JSON so middleware answers 401 instead of a login redirect", () => {
    expect(JSON_ACCEPT_HEADERS.Accept).toBe("application/json");
  });
});
