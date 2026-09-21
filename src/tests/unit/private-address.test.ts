/**
 * Is this address one of OURS?
 *
 * Lifted out of the browser route so the delivery pipeline's verification can
 * ask the same question about an address a HOST handed back — which is exactly
 * why it is worth a suite of its own now: two callers, one table, and the
 * failure mode is a box fetching and screenshotting its own internal services
 * because a third party's JSON said `127.0.0.1`.
 */
import { describe, expect, it, vi } from "vitest";
import { isPrivateIp } from "@/lib/private-address";

describe("addresses that are ours", () => {
  it("catches every private IPv4 range", () => {
    for (const ip of [
      "127.0.0.1", "127.53.1.9", "10.0.0.1", "0.0.0.0",
      "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "100.127.255.255", "224.0.0.1", "255.255.255.255",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("lets the public ones through", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "100.63.255.255", "100.128.0.1", "223.255.255.255"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("catches loopback, link-local, unique-local and multicast IPv6", () => {
    for (const ip of ["::1", "::", "fe80::1", "feb0::1", "fc00::1", "fd12::1", "ff02::1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
  });

  it("canonicalises IPv4-mapped IPv6 in BOTH spellings, and fails closed on a third", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    // What the WHATWG URL parser normalises that to.
    expect(isPrivateIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    // A shape this cannot read is not waved through.
    expect(isPrivateIp("::ffff:nonsense")).toBe(true);
  });
});

describe("whether a HOST is public", () => {
  it("refuses this box by name, whatever the resolver says", async () => {
    vi.resetModules();
    vi.doMock("dns/promises", () => ({ lookup: async () => [{ address: "8.8.8.8" }] }));
    const { hostIsPublic } = await import("@/lib/private-address");
    expect(await hostIsPublic("localhost")).toBe(false);
    expect(await hostIsPublic("app.localhost")).toBe(false);
    vi.doUnmock("dns/promises");
  });

  it("checks EVERY answer — one record pointing inside is enough", async () => {
    vi.resetModules();
    vi.doMock("dns/promises", () => ({
      lookup: async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }],
    }));
    const { hostIsPublic } = await import("@/lib/private-address");
    expect(await hostIsPublic("rebind.example")).toBe(false);
    vi.doUnmock("dns/promises");
  });

  it("is not public when it does not resolve at all", async () => {
    vi.resetModules();
    vi.doMock("dns/promises", () => ({ lookup: async () => { throw new Error("ENOTFOUND"); } }));
    const { hostIsPublic } = await import("@/lib/private-address");
    expect(await hostIsPublic("nowhere.example")).toBe(false);
    vi.doUnmock("dns/promises");
  });

  it("is not public when the resolver answers with nothing", async () => {
    vi.resetModules();
    vi.doMock("dns/promises", () => ({ lookup: async () => [] }));
    const { hostIsPublic } = await import("@/lib/private-address");
    expect(await hostIsPublic("empty.example")).toBe(false);
    vi.doUnmock("dns/promises");
  });

  it("answers a literal address without asking DNS", async () => {
    vi.resetModules();
    const asked = vi.fn();
    vi.doMock("dns/promises", () => ({ lookup: asked }));
    const { hostIsPublic } = await import("@/lib/private-address");
    expect(await hostIsPublic("8.8.8.8")).toBe(true);
    expect(await hostIsPublic("[::1]")).toBe(false);
    expect(asked).not.toHaveBeenCalled();
    vi.doUnmock("dns/promises");
  });
});
