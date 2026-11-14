import { describe, expect, test } from "bun:test";
import {
  defaultEntryName,
  entryMatchUrl,
  isFillAllowedUrl,
  matchUrl,
  rankMatches,
  registrableDomain,
} from "../src/shared/domain";

describe("registrable domain (eTLD+1)", () => {
  test("plain and multi-label public suffixes", () => {
    expect(registrableDomain("www.example.com")).toBe("example.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("portal.example.com.au")).toBe("example.com.au");
  });
  test("private suffixes count as suffixes", () => {
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("bob.github.io")).toBe("bob.github.io");
  });
  test("localhost and IPs are their own site", () => {
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("matching", () => {
  test("exact host", () => {
    expect(matchUrl("https://billing.example.com/login", "https://billing.example.com/account?x=1")).toBe("exact");
  });
  test("subdomains share the registrable domain", () => {
    expect(matchUrl("https://example.com", "https://login.example.com/")).toBe("domain");
    expect(matchUrl("https://accounts.example.com", "https://billing.example.com")).toBe("domain");
    expect(matchUrl("https://a.example.co.uk", "https://b.example.co.uk")).toBe("domain");
  });
  test("different sites never match", () => {
    expect(matchUrl("https://example.com", "https://example.net")).toBeNull();
    expect(matchUrl("https://example.co.uk", "https://other.co.uk")).toBeNull();
    expect(matchUrl("https://example.com", "https://example.com.evil.test")).toBeNull();
    expect(matchUrl("https://example.com", "https://notexample.com")).toBeNull();
    expect(matchUrl("https://alice.github.io", "https://bob.github.io")).toBeNull();
  });
  test("http pages are refused except localhost", () => {
    expect(isFillAllowedUrl("http://example.com/login")).toBe(false);
    expect(matchUrl("https://example.com", "http://example.com/login")).toBeNull();
    expect(matchUrl("http://example.com", "http://example.com/login")).toBeNull();
    expect(isFillAllowedUrl("https://example.com")).toBe(true);
    expect(isFillAllowedUrl("http://localhost:3000/login")).toBe(true);
    expect(isFillAllowedUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isFillAllowedUrl("http://app.localhost")).toBe(true);
    expect(matchUrl("http://localhost:3000", "http://localhost:3000/login")).toBe("exact");
    expect(matchUrl("http://localhost:3000", "http://localhost:4000/login")).toBeNull();
  });
  test("non-web schemes are refused", () => {
    expect(isFillAllowedUrl("ftp://example.com")).toBe(false);
    expect(isFillAllowedUrl("javascript:alert(1)")).toBe(false);
    expect(isFillAllowedUrl("file:///etc/passwd")).toBe(false);
    expect(matchUrl("https://example.com", "data:text/html,<form>")).toBeNull();
  });
  test("IDN: Unicode entry matches punycode page", () => {
    expect(matchUrl("https://bücher.de", "https://www.xn--bcher-kva.de/login")).toBe("domain");
    expect(matchUrl("https://xn--bcher-kva.de", "https://bücher.de/")).toBe("exact");
    expect(registrableDomain(new URL("https://shop.bücher.de").hostname)).toBe("xn--bcher-kva.de");
  });
  test("IDN: look-alike host does not match", () => {
    // Cyrillic "а" (U+0430) instead of Latin "a"
    expect(matchUrl("https://apple.com", "https://аpple.com/")).toBeNull();
    expect(matchUrl("https://paypal.com", "https://pаypаl.com/")).toBeNull();
  });
  test("explicit ports must agree", () => {
    expect(matchUrl("https://example.com:8443", "https://example.com/")).toBeNull();
    expect(matchUrl("https://example.com:8443", "https://example.com:8443/")).toBe("exact");
  });
});

describe("ranking and names", () => {
  const entries = [
    { name: "example.com/root", url: "https://example.com" },
    { name: "billing/admin", url: "https://billing.example.com/login" },
    { name: "other/one", url: "https://other.test" },
    { name: "github.com/alice", url: "" },
  ];
  test("exact host first, then the rest of the domain", () => {
    const ranked = rankMatches(entries, "https://billing.example.com/invoices");
    expect(ranked.map((e) => [e.name, e.match])).toEqual([
      ["billing/admin", "exact"],
      ["example.com/root", "domain"],
    ]);
  });
  test("a domain-like name stands in for a missing url field", () => {
    expect(entryMatchUrl({ name: "github.com/alice", url: "" })).toBe("https://github.com");
    expect(entryMatchUrl({ name: "hetzner/admin", url: "" })).toBeNull();
    expect(rankMatches(entries, "https://github.com/login").map((e) => e.name)).toEqual(["github.com/alice"]);
  });
  test("default entry name is <domain>/<login>", () => {
    expect(defaultEntryName("https://portal.billing.example.co.uk/login", "ops@example.com")).toBe("example.co.uk/ops@example.com");
    expect(defaultEntryName("http://localhost:3000/", "admin")).toBe("localhost/admin");
    expect(defaultEntryName("https://example.com", "../x/y")).toBe("example.com/_x_y");
  });
});
