import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * The guard a state-changing, owner-only route runs after its owner gate:
 * "did OUR page send this?". Pinned by header, because the rules are about
 * which headers a browser sends when, and a rule that drifted would either
 * lock the owner out of their own box or let a hostile page in.
 */

function request(headers: Record<string, string>, url = "http://clawbox.local/setup-api/x"): Request {
  return new Request(url, { method: "POST", headers });
}

describe("isSameOriginRequest", () => {
  it("allows a request with neither header — curl, the MCP server, anything that is not a browser", () => {
    expect(isSameOriginRequest(request({ host: "clawbox.local" }))).toBe(true);
  });

  it("allows an Origin naming the host the request was sent to, over either scheme", () => {
    // Plain http on the LAN; https through the remote-access tunnel. The
    // page and the request name the same host either way.
    expect(isSameOriginRequest(request({ host: "clawbox.local", origin: "http://clawbox.local" }))).toBe(true);
    expect(isSameOriginRequest(request({ host: "abc.trycloudflare.com", origin: "https://abc.trycloudflare.com" }))).toBe(true);
    expect(isSameOriginRequest(request({ host: "10.42.0.1:3000", origin: "http://10.42.0.1:3000" }))).toBe(true);
  });

  it("compares hosts case-insensitively", () => {
    expect(isSameOriginRequest(request({ host: "ClawBox.local", origin: "http://clawbox.LOCAL" }))).toBe(true);
  });

  it("refuses an Origin naming somewhere else", () => {
    expect(isSameOriginRequest(request({ host: "clawbox.local", origin: "https://evil.example" }))).toBe(false);
    // A port is part of the host: a page on another port is another origin.
    expect(isSameOriginRequest(request({ host: "clawbox.local", origin: "http://clawbox.local:8080" }))).toBe(false);
  });

  it("refuses the opaque origin 'null' and an origin it cannot parse", () => {
    expect(isSameOriginRequest(request({ host: "clawbox.local", origin: "null" }))).toBe(false);
    expect(isSameOriginRequest(request({ host: "clawbox.local", origin: "not a url" }))).toBe(false);
  });

  it("falls back to the URL's host when there is no Host header", () => {
    expect(isSameOriginRequest(request({ origin: "http://clawbox.local" }))).toBe(true);
    expect(isSameOriginRequest(request({ origin: "http://other.local" }))).toBe(false);
  });

  it("reads Sec-Fetch-Site when there is no Origin: cross-site and same-site refused, the rest allowed", () => {
    expect(isSameOriginRequest(request({ host: "clawbox.local", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(request({ host: "clawbox.local", "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameOriginRequest(request({ host: "clawbox.local", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(request({ host: "clawbox.local", "sec-fetch-site": "none" }))).toBe(true);
  });

  it("lets Origin decide when both headers are present", () => {
    // Origin is the header a script cannot forge; the hint does not override it.
    expect(isSameOriginRequest(request({ host: "clawbox.local", origin: "http://clawbox.local", "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isSameOriginRequest(request({ host: "clawbox.local", origin: "https://evil.example", "sec-fetch-site": "same-origin" }))).toBe(false);
  });
});
