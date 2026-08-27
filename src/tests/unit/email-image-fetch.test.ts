// "Load images" is the one place this feature makes an outbound request on
// purpose. The URL always comes from the message rather than from the caller,
// so this is not an open proxy — but a stranger still chose that URL, and the
// device sits on a home LAN with a router, a printer and its own loopback
// services on it. These tests are about what must never be reachable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));

const { fetchRemoteImages, isPrivateAddress } = await import("@/lib/email-image-fetch");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A Response carrying image bytes, as a well-behaved image host would send. */
function imageResponse(bytes: Buffer = PNG, type = "image/png"): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": type, "content-length": String(bytes.length) },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lookup.mockReset();
  // Everything resolves to a public address unless a test says otherwise.
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  // A fresh Response per call: a body can only be read once, and the real
  // `fetch` hands back a new one every time.
  fetchMock = vi.fn().mockImplementation(async () => imageResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("addresses that are not the public internet", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback, other octet", "127.99.1.5"],
    ["this network", "0.0.0.0"],
    ["private 10/8", "10.0.0.1"],
    ["private 172.16/12", "172.16.5.4"],
    ["private 172.31/12", "172.31.255.255"],
    ["private 192.168/16", "192.168.1.1"],
    ["link-local / cloud metadata", "169.254.169.254"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["multicast", "239.1.1.1"],
    ["broadcast/reserved", "255.255.255.255"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 unique local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv6 multicast", "ff02::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped private", "::ffff:192.168.0.1"],
    ["not an address at all", "definitely-not-an-ip"],
  ])("refuses %s", (_label, ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    ["a public IPv4", "93.184.216.34"],
    ["another public IPv4", "1.1.1.1"],
    ["172.15 is NOT in the private range", "172.15.0.1"],
    ["172.32 is NOT in the private range", "172.32.0.1"],
    ["a public IPv6", "2606:2800:220:1:248:1893:25c8:1946"],
  ])("allows %s", (_label, ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("what gets fetched", () => {
  it("fetches a public image and returns it as a data: URI", async () => {
    const out = await fetchRemoteImages(["https://cdn.example/logo.png"]);
    expect(out.get("https://cdn.example/logo.png")).toBe(
      `data:image/png;base64,${PNG.toString("base64")}`,
    );
  });

  it("sends no cookies and no referer, so the fetch says as little as possible", async () => {
    await fetchRemoteImages(["https://cdn.example/logo.png"]);
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.referer).toBeUndefined();
    expect(init.headers.cookie).toBeUndefined();
    expect(init.cache).toBe("no-store");
  });

  it("refuses a host that resolves to a LAN address", async () => {
    lookup.mockResolvedValue([{ address: "192.168.1.1", family: 4 }]);
    const out = await fetchRemoteImages(["http://router.example/reboot.png"]);
    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to BOTH a public and a private address", async () => {
    // DNS rebinding: validating only the first answer is what makes the check
    // useless, so every address has to pass.
    lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const out = await fetchRemoteImages(["https://rebind.example/x.png"]);
    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a literal private IP in the URL without consulting DNS", async () => {
    const out = await fetchRemoteImages(["http://127.0.0.1:8080/admin.png"]);
    expect(out.size).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a host that does not resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    expect((await fetchRemoteImages(["https://nowhere.example/x.png"])).size).toBe(0);
  });

  it.each(["file:///etc/passwd", "ftp://a.example/x.png", "gopher://a.example/x"])(
    "refuses the %s scheme",
    async (url) => {
      expect((await fetchRemoteImages([url])).size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a URL carrying credentials, which would sign the device in somewhere", async () => {
    expect((await fetchRemoteImages(["https://user:pw@cdn.example/x.png"])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a malformed URL instead of throwing", async () => {
    await expect(fetchRemoteImages(["http://["])).resolves.toEqual(new Map());
  });
});

describe("redirects", () => {
  it("follows a redirect to another public host", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://other.example/real.png" } }),
      )
      .mockResolvedValueOnce(imageResponse());
    const out = await fetchRemoteImages(["https://cdn.example/a.png"]);
    expect(out.size).toBe(1);
  });

  it("refuses a redirect that lands on a private address", async () => {
    // The built-in follower would walk here happily, because the guard only
    // ever saw the first URL. Every hop is re-validated instead.
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    );
    const out = await fetchRemoteImages(["https://cdn.example/a.png"]);
    expect(out.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than following a redirect loop", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://cdn.example/loop.png" } }),
    );
    const out = await fetchRemoteImages(["https://cdn.example/loop.png"]);
    expect(out.size).toBe(0);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("what comes back", () => {
  it("refuses a response that is not an image, whatever the bytes look like", async () => {
    fetchMock.mockResolvedValue(
      new Response("<script>alert(1)</script>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    expect((await fetchRemoteImages(["https://cdn.example/x.png"])).size).toBe(0);
  });

  it("refuses an SVG, which is a scriptable document", async () => {
    fetchMock.mockResolvedValue(
      new Response("<svg onload=\"alert(1)\"/>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      }),
    );
    expect((await fetchRemoteImages(["https://cdn.example/x.svg"])).size).toBe(0);
  });

  it("refuses an image that declares itself too large", async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array(PNG), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(10 * 1024 * 1024) },
      }),
    );
    expect((await fetchRemoteImages(["https://cdn.example/huge.png"])).size).toBe(0);
  });

  it("stops a server that lied about its size", async () => {
    const big = Buffer.alloc(600 * 1024, 1);
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array(big), {
        status: 200,
        // Understated on purpose — the cap has to hold on the stream too.
        headers: { "content-type": "image/png", "content-length": "10" },
      }),
    );
    expect((await fetchRemoteImages(["https://cdn.example/liar.png"])).size).toBe(0);
  });

  it("skips a failed fetch without failing the whole message", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(imageResponse());
    const out = await fetchRemoteImages([
      "https://down.example/a.png",
      "https://cdn.example/b.png",
    ]);
    expect(out.size).toBe(1);
    expect(out.has("https://cdn.example/b.png")).toBe(true);
  });

  it("skips a 404 rather than inlining the error page", async () => {
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
    expect((await fetchRemoteImages(["https://cdn.example/gone.png"])).size).toBe(0);
  });
});

describe("bounds", () => {
  it("fetches at most twenty images from one message", async () => {
    const urls = Array.from({ length: 50 }, (_, i) => `https://cdn.example/${i}.png`);
    await fetchRemoteImages(urls);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("does nothing at all when the message references no images", async () => {
    expect(await fetchRemoteImages([])).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
