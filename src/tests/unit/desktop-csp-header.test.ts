import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

// The Content-Security-Policy the box serves with every page but /apps/<id>/…
// — which includes the OpenClaw Control UI, since /chat/* is proxied to the
// gateway through the fallback rewrite and inherits this header.
//
// Its `connect-src` is a list of DESTINATIONS a script may open, and what is
// missing from it fails silently in a console nobody reads: every load of the
// OpenClaw window logged "Connecting to data:image/svg+xml,… violates the
// Content Security Policy" because the Control UI's Font Awesome fetches its
// icons rather than assigning them to an <img>, and img-src's `data:` does not
// reach fetch().

async function directives(): Promise<Map<string, string>> {
  const groups = await nextConfig.headers!();
  const header = groups.flatMap(g => g.headers).find(h => h.key.toLowerCase() === "content-security-policy");
  expect(header, "the box must send a Content-Security-Policy").toBeTruthy();
  const map = new Map<string, string>();
  for (const part of header!.value.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    map.set(space === -1 ? trimmed : trimmed.slice(0, space), space === -1 ? "" : trimmed.slice(space + 1));
  }
  return map;
}

describe("the desktop Content-Security-Policy", () => {
  it("lets a page fetch a data: URL", async () => {
    expect((await directives()).get("connect-src")).toMatch(/(^|\s)data:(\s|$)/);
  });

  it("keeps connect-src to this origin, the websocket and the LAN otherwise", async () => {
    // `data:` carries its own bytes and reaches nothing, so it opens no channel
    // out of the box. A wildcard would, and is what this must not become.
    const connect = (await directives()).get("connect-src") ?? "";
    expect(connect).toContain("'self'");
    expect(connect.split(/\s+/)).not.toContain("*");
    expect(connect).not.toMatch(/https:(\s|$)/);
  });

  it("still refuses to run anything it did not serve", async () => {
    // The neighbouring directives, so a widening here cannot ride along with a
    // connect-src edit.
    const d = await directives();
    expect(d.get("default-src")).toBe("'self'");
    expect(d.get("script-src")).not.toMatch(/https?:/);
  });
});
