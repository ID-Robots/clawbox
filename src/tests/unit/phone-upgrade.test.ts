import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PHONE_PAIRING_CONFIG_KEY, PHONE_WS_PATH } from "@/lib/phone-pairing-shared";

/**
 * scripts/phone-upgrade.js — the gate production-server.js puts in front of
 * the phone link. production-server-phone-upgrade.test.ts drives it through
 * the shipped proxy from loopback; these cases cover what a loopback test
 * socket cannot be: a LAN peer, IPv6, a v4-mapped peer, a TLS socket.
 */

const requireCjs = createRequire(path.join(process.cwd(), "package.json"));
const phone = requireCjs("./scripts/phone-upgrade.js") as {
  PHONE_WS_PATH: string;
  PHONE_PAIRING_CONFIG_KEY: string;
  phonePairingEnabledFromConfig: (config: unknown) => boolean;
  phoneClientAddress: (req: unknown) => string | null;
  authorizePhoneUpgrade: (
    req: unknown,
    enabled: unknown,
  ) => { ok: true; identity: null; forwarded: Record<string, string> } | { ok: false; status: number };
};

function req(remoteAddress: string | undefined, headers: Record<string, string | string[]> = {}, encrypted = false) {
  return { headers, socket: remoteAddress === undefined ? undefined : { remoteAddress, encrypted } };
}

describe("the phone link's names", () => {
  it("are the same on the Next.js side and in production-server.js", () => {
    expect(phone.PHONE_WS_PATH).toBe(PHONE_WS_PATH);
    expect(phone.PHONE_PAIRING_CONFIG_KEY).toBe(PHONE_PAIRING_CONFIG_KEY);
  });
});

describe("phonePairingEnabledFromConfig", () => {
  it("is on only for the boolean true", () => {
    expect(phone.phonePairingEnabledFromConfig({ phone_pairing_enabled: true })).toBe(true);
    for (const value of [false, "true", 1, null, undefined, {}]) {
      expect(phone.phonePairingEnabledFromConfig({ phone_pairing_enabled: value })).toBe(false);
    }
    expect(phone.phonePairingEnabledFromConfig({})).toBe(false);
    expect(phone.phonePairingEnabledFromConfig(null)).toBe(false);
    expect(phone.phonePairingEnabledFromConfig("phone_pairing_enabled")).toBe(false);
  });
});

describe("phoneClientAddress", () => {
  it("takes Cloudflare's address for a tunnel connection (a loopback peer)", () => {
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(phone.phoneClientAddress(req("::ffff:127.0.0.1", { "cf-connecting-ip": " 203.0.113.7 " }))).toBe("203.0.113.7");
    expect(phone.phoneClientAddress(req("::1", { "cf-connecting-ip": "2001:db8::7" }))).toBe("2001:db8::7");
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ipv6": "2001:db8::7" }))).toBe("2001:db8::7");
  });

  it("takes the socket's own address for a LAN peer, ignoring any CF header it claims", () => {
    expect(phone.phoneClientAddress(req("10.42.0.23"))).toBe("10.42.0.23");
    expect(phone.phoneClientAddress(req("::ffff:10.42.0.23", { "cf-connecting-ip": "203.0.113.7" }))).toBe("10.42.0.23");
  });

  it("is null when the proxy cannot say who it is", () => {
    expect(phone.phoneClientAddress(req(undefined))).toBeNull();
    expect(phone.phoneClientAddress(req("127.0.0.1"))).toBeNull();
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": "127.0.0.1" }))).toBeNull();
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": "::1" }))).toBeNull();
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": "0.0.0.0" }))).toBeNull();
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": "box.example" }))).toBeNull();
    // Two values (or Node's joined form of two) are not one address.
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": ["203.0.113.7", "203.0.113.8"] }))).toBeNull();
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7, 203.0.113.8" }))).toBeNull();
    expect(phone.phoneClientAddress({})).toBeNull();
    expect(phone.phoneClientAddress(null)).toBeNull();
  });

  it("refuses loopback and unspecified addresses however they are spelled", () => {
    for (const spelled of ["0:0:0:0:0:0:0:1", "0::1", "::0", "0:0:0:0:0:0:0:0", "0:0:0:0:0:ffff:127.0.0.1", "::FFFF:7f00:1", "::ffff:0.0.0.0"]) {
      expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": spelled })), spelled).toBeNull();
    }
  });

  it("names an address in one canonical spelling", () => {
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": "2001:DB8:0:0:0:0:0:7" }))).toBe("2001:db8::7");
    expect(phone.phoneClientAddress(req("127.0.0.1", { "cf-connecting-ip": "0:0:0:0:0:ffff:203.0.113.7" }))).toBe("203.0.113.7");
    expect(phone.phoneClientAddress(req("fe80::1%wlan0"))).toBe("fe80::1%wlan0"); // public-hygiene: allow link-local test fixture, no real host
  });
});

describe("authorizePhoneUpgrade", () => {
  it("is 404 while phone pairing is off, whoever asks", () => {
    for (const enabled of [false, undefined, "true", 1]) {
      expect(phone.authorizePhoneUpgrade(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" }), enabled)).toEqual({
        ok: false,
        status: 404,
      });
    }
  });

  it("is 403 for a client it cannot attribute", () => {
    expect(phone.authorizePhoneUpgrade(req("127.0.0.1"), true)).toEqual({ ok: false, status: 403 });
  });

  it("names the tunnel client over https", () => {
    expect(phone.authorizePhoneUpgrade(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" }), true)).toEqual({
      ok: true,
      identity: null,
      forwarded: { "X-Forwarded-For": "203.0.113.7", "X-Forwarded-Proto": "https" },
    });
  });

  it("names a LAN client with the scheme it really used", () => {
    expect(phone.authorizePhoneUpgrade(req("10.42.0.23"), true)).toMatchObject({
      ok: true,
      forwarded: { "X-Forwarded-For": "10.42.0.23", "X-Forwarded-Proto": "http" },
    });
    expect(phone.authorizePhoneUpgrade(req("10.42.0.23", {}, true), true)).toMatchObject({
      ok: true,
      forwarded: { "X-Forwarded-For": "10.42.0.23", "X-Forwarded-Proto": "https" },
    });
  });
});
