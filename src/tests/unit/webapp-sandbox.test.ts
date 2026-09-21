/**
 * The webapp sandbox contract, header side.
 *
 * The iframe attribute boxes a webapp only while a page of ours frames it. The
 * same document opened top-level — `launch: "window"`, a chat link, a share
 * link pasted into a tab — is boxed by the RESPONSE's `sandbox` directive
 * instead, and that directive is derived from the attribute so the two cannot
 * drift: a token added to one is added to the other, and allow-same-origin
 * can never appear in either.
 */
import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../../../next.config";
import { WEBAPP_DOCUMENT_CSP, WEBAPP_IFRAME_SANDBOX } from "@/lib/webapp-sandbox";

describe("WEBAPP_DOCUMENT_CSP", () => {
  it("is the iframe sandbox as a CSP directive, plus pointer lock", () => {
    expect(WEBAPP_DOCUMENT_CSP).toBe(`sandbox ${WEBAPP_IFRAME_SANDBOX} allow-pointer-lock`);
  });

  it("never hands a top-level document the origin or a way out of the box", () => {
    const tokens = WEBAPP_DOCUMENT_CSP.split(/\s+/);
    expect(tokens[0]).toBe("sandbox");
    expect(tokens).toContain("allow-scripts");
    expect(tokens).not.toContain("allow-same-origin");
    // A popup opened from a top-level sandboxed document has nothing outside
    // the box to escape to; the frame's attribute does not carry it either.
    expect(tokens).not.toContain("allow-popups-to-escape-sandbox");
    expect(WEBAPP_IFRAME_SANDBOX.split(/\s+/)).not.toContain("allow-same-origin");
  });

  it("is what next.config.ts ships for the webapp document path", async () => {
    // A route handler's Content-Security-Policy is dropped in production when
    // the config already sets one for the path, so the header that reaches
    // the wire is the config's — this entry, which must carry the constant
    // verbatim rather than a hand-typed copy of it.
    //
    // The entry is found the way the router finds it — by compiling each
    // source with Next's own matcher under the router's `strict: true` — and
    // for BOTH forms of the path, because the handler answers the trailing
    // slash too and a source that names only one of them leaves the other
    // under the desktop policy (the ordering test in
    // desktop-csp-header.test.ts pins why the last match is the one that
    // lands).
    const groups = await nextConfig.headers!();
    for (const pathname of ["/setup-api/webapps", "/setup-api/webapps/"]) {
      const matching = groups.filter((g) =>
        Boolean(getPathMatch(g.source, { strict: true, removeUnnamedParams: true })(pathname)));
      const entry = matching.at(-1);
      expect(entry, `next.config.ts must carry a headers() entry covering ${pathname}`).toBeTruthy();
      const csp = entry!.headers.find((h) => h.key.toLowerCase() === "content-security-policy")?.value ?? "";
      const directives = csp.split(";").map((d) => d.trim());
      expect(directives, pathname).toContain(WEBAPP_DOCUMENT_CSP);
    }
  });
});
