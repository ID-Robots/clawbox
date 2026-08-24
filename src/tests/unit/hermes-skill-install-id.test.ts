import { describe, expect, it } from "vitest";
import { checkInstallIdentifier, cliInstallIdentifier } from "@/lib/hermes-skills";

/**
 * TASK-453 round 2 — `skill_search` returned ids `skill_install` could not
 * resolve, which is a guaranteed retry loop: the tool's own `next` says "pass
 * the exact id it returned", and that is precisely what failed.
 *
 *   skill_search "qr code" -> {"id":"qrcode-decode","source":"clawhub"}
 *   skill_install qrcode-decode
 *     -> 502 {"error":"Skill could not be resolved — try the full identifier"}
 *
 * Cause: `hermes skills install <slash-less arg>` goes through
 * `_resolve_short_name()`, which requires an exact match on the catalog NAME.
 * A ClawHub row's name is its display name ("QR Code Decode") and its
 * identifier is the slug ("qrcode-decode"), so nothing ever matched and the CLI
 * exited 0 having installed nothing. ClawHub is the ONLY source in
 * hermes-index.json with unprefixed identifiers — 69 150 of 90 605 rows, i.e.
 * three quarters of the store.
 *
 * The fixture below is a real slice of what browse/skill_search hands out, one
 * row per source, taken from the QA box's index on 2026-08-24.
 */
const SEARCH_FIXTURE = [
  { id: "qrcode-decode", name: "QR Code Decode", source: "clawhub" },
  { id: "english-dictionary", name: '"Dictionary"', source: "clawhub" },
  { id: "official/security/1password", name: "1password", source: "official" },
  { id: "NVIDIA/skills/skills/aiq-deploy", name: "aiq-deploy", source: "github" },
  { id: "skills-sh/getagentseal/founder-playbook/100m-leads", name: "100m-leads", source: "skills.sh" },
  { id: "lobehub/academic-editor-en", name: "academic-editor-en", source: "lobehub" },
  { id: "browse-sh/kmart.com.au/kmart-irwsr8", name: "add-to-cart", source: "browse-sh" },
];

describe("cliInstallIdentifier — every id search returns is installable", () => {
  it("gives the CLI something it can resolve for every fixture row", () => {
    for (const row of SEARCH_FIXTURE) {
      const cliId = cliInstallIdentifier(row.id, row.source);
      // The CLI only skips its name-based short-name resolution when the
      // argument contains a slash. That is the whole property under test.
      expect(cliId, `${row.source} row ${row.id}`).toContain("/");
      // And whatever we hand it still has to pass our own validator.
      expect(checkInstallIdentifier(cliId).ok, `${row.source} row ${row.id}`).toBe(true);
    }
  });

  it("prefixes a bare ClawHub slug with the source its adapter accepts", () => {
    expect(cliInstallIdentifier("qrcode-decode", "clawhub")).toBe("clawhub/qrcode-decode");
  });

  it("leaves an already-prefixed id exactly as search returned it", () => {
    for (const row of SEARCH_FIXTURE.filter((r) => r.source !== "clawhub")) {
      expect(cliInstallIdentifier(row.id, row.source)).toBe(row.id);
    }
  });

  it("maps a bare slug even when the catalog could not be read", () => {
    // The browse route's degraded path (no index yet) returns rows with no
    // record behind them; a bare slug can still only have come from ClawHub.
    expect(cliInstallIdentifier("qrcode-decode")).toBe("clawhub/qrcode-decode");
  });

  it("does not touch a bare id declared as some other source", () => {
    expect(cliInstallIdentifier("pdf", "official")).toBe("pdf");
  });

  it("never invents a slash out of something that is not a slug", () => {
    expect(cliInstallIdentifier("", "clawhub")).toBe("");
    expect(cliInstallIdentifier("  ", "clawhub")).toBe("");
    // A leading dash is flag-smuggling and must not be given a prefix that
    // would sneak it past the CLI's argv handling as a second segment.
    expect(cliInstallIdentifier("-rf", "clawhub")).toBe("-rf");
    expect(checkInstallIdentifier(cliInstallIdentifier("-rf", "clawhub")).ok).toBe(false);
  });
});
