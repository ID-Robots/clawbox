import { describe, expect, it } from "vitest";
// Next's OWN source compiler, with the options its router uses for a
// headers() entry (router-utils/filesystem.js `buildCustomRoute`): a source is
// path-to-regexp under `strict: true`, so what a hand-written RegExp says about
// a path and what the box's router says can differ — and did, on the trailing
// slash. Every "does this entry cover that path" question below is asked of
// this compiler, never of a regex the test built itself.
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../../../next.config";
import { WEBAPP_DOCUMENT_CSP, WEBAPP_IFRAME_SANDBOX } from "@/lib/webapp-sandbox";

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

type HeaderGroup = { source: string; headers: { key: string; value: string }[] };

/** The CSP of the entry with this `source`, as a directive → value map. */
async function directivesOf(source: string): Promise<Map<string, string>> {
  const groups = (await nextConfig.headers!()) as HeaderGroup[];
  const group = groups.find(g => g.source === source);
  expect(group, `next.config.ts must carry a headers() entry for ${source}`).toBeTruthy();
  const header = group!.headers.find(h => h.key.toLowerCase() === "content-security-policy");
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

/** Does a headers() `source` cover this path, the way Next's router decides it? */
function covers(source: string, pathname: string): boolean {
  return Boolean(getPathMatch(source, { strict: true, removeUnnamedParams: true })(pathname));
}

/** The general desktop entry: everything but /apps/<id>/…. */
const DESKTOP_SOURCE = "/((?!apps/).*)";
const directives = () => directivesOf(DESKTOP_SOURCE);

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
    // Bound to whole TOKENS. `not.toMatch(/https:(\s|$)/)` only rejects the
    // bare scheme, so `https://*` and `https://*:*` — every origin on the
    // internet — would have passed it. The lookahead is what keeps
    // `https://*.local`, which is a host pattern and the LAN entry this
    // directive exists for.
    expect(connect).not.toMatch(/(?:^|\s)https:\/\/\*(?::\*)?(?=\s|$)/);
  });

  it("still refuses to run anything it did not serve", async () => {
    // The neighbouring directives, so a widening here cannot ride along with a
    // connect-src edit.
    const d = await directives();
    expect(d.get("default-src")).toBe("'self'");
    expect(d.get("script-src")).not.toMatch(/https?:/);
  });
});

// The webapp DOCUMENT — HTML the agent wrote, served by GET /setup-api/webapps.
// A Content-Security-Policy set by the route handler never reaches the wire
// in production: the desktop entry above matches the path too, is written
// before the handler runs, and a handler's copy of a key already present is
// dropped. So the sandbox that boxes a top-level open of that document is
// delivered as a SECOND entry here, after the general one, whose value
// replaces the general policy for this path alone.
describe("the webapp document Content-Security-Policy", () => {
  const WEBAPP_SOURCE = "/setup-api/webapps{/}?";

  it("is a second entry AFTER the desktop one, so its value is the one that lands", async () => {
    const groups = (await nextConfig.headers!()) as HeaderGroup[];
    const sources = groups.map(g => g.source);
    expect(sources.indexOf(WEBAPP_SOURCE)).toBeGreaterThan(sources.indexOf(DESKTOP_SOURCE));
    // The desktop entry must still cover the path — the webapp entry is a
    // REPLACEMENT of one key, not an exemption like /apps/.
    expect(covers(DESKTOP_SOURCE, "/setup-api/webapps")).toBe(true);
    expect(covers(DESKTOP_SOURCE, "/setup-api/webapps/")).toBe(true);
  });

  it("covers the trailing-slash form of the path too, and nothing deeper", async () => {
    // The route handler answers `/setup-api/webapps/?app=x` as well: the
    // middleware's canonicaliser leaves an API path as typed (a redirect
    // must not let `/setup-api/gateway/` dodge the exact-match list), and
    // Next compiles a headers() source under `strict: true`, where a bare
    // `/setup-api/webapps` matches ONLY the slash-less form. That left the
    // slash form under the desktop policy alone — the whole exploit back
    // with one extra character — which is why the source names both.
    // Compiled through Next's own matcher, because a RegExp built here from
    // the source string is exactly the kind of check that let it slip.
    const groups = (await nextConfig.headers!()) as HeaderGroup[];
    const entry = groups.find(g => g.source === WEBAPP_SOURCE)!;
    expect(covers(entry.source, "/setup-api/webapps")).toBe(true);
    expect(covers(entry.source, "/setup-api/webapps/")).toBe(true);
    expect(covers(entry.source, "/setup-api/webapps/x")).toBe(false);
    expect(covers(entry.source, "/setup-api/webappsx")).toBe(false);
    // The failure mode this guards against, on the record: the bare source
    // does NOT cover the slash form under Next's strict matching.
    expect(covers("/setup-api/webapps", "/setup-api/webapps/")).toBe(false);
    // And no OTHER entry after the desktop one covers either form with a
    // different policy — a later match would replace this one's CSP.
    const later = groups.slice(groups.indexOf(entry) + 1);
    for (const path of ["/setup-api/webapps", "/setup-api/webapps/"]) {
      expect(later.filter(g => covers(g.source, path)).map(g => g.source)).toEqual([]);
    }
  });

  it("sandboxes the document without allow-same-origin, derived from the iframe attribute", async () => {
    const d = await directivesOf(WEBAPP_SOURCE);
    expect(d.has("sandbox")).toBe(true);
    const tokens = (d.get("sandbox") ?? "").split(/\s+/);
    expect(tokens).toContain("allow-scripts");
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-popups-to-escape-sandbox");
    for (const token of WEBAPP_IFRAME_SANDBOX.split(/\s+/)) expect(tokens).toContain(token);
    expect(`sandbox ${d.get("sandbox")}`).toBe(WEBAPP_DOCUMENT_CSP);
  });

  it("keeps every desktop directive, so nothing is lost by the replacement", async () => {
    const desktop = await directives();
    const webapp = await directivesOf(WEBAPP_SOURCE);
    for (const [name, value] of desktop) expect(webapp.get(name), name).toBe(value);
    expect(webapp.get("frame-ancestors")).toBeTruthy();
  });

  it("restates nosniff on the entry", async () => {
    const groups = (await nextConfig.headers!()) as HeaderGroup[];
    const entry = groups.find(g => g.source === WEBAPP_SOURCE)!;
    expect(entry.headers.find(h => h.key === "X-Content-Type-Options")?.value).toBe("nosniff");
  });
});
