// "Load images" is the one place this feature makes an outbound request on
// purpose. The URL always comes from the message rather than from the caller,
// so this is not an open proxy — but a stranger still chose that URL, and the
// device sits on a home LAN with a router, a printer and its own loopback
// services on it. These tests are about what must never be reachable.
//
// They mock `node:http`/`node:https` rather than `fetch`, because the PIN is
// the point: the module resolves a hostname itself, refuses it unless every
// address is public, and then forces the socket to that one address through
// the `lookup` hook. Mocking at the transport layer is what lets the pin be
// asserted at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));

const httpsRequest = vi.hoisted(() => vi.fn());
const httpRequest = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ default: { request: httpsRequest }, request: httpsRequest }));
vi.mock("node:http", () => ({ default: { request: httpRequest }, request: httpRequest }));

const { fetchRemoteImages, isPrivateAddress } = await import("@/lib/email-image-fetch");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** One canned HTTP reply, or a transport-level failure. */
type Reply =
  | { status: number; headers: Record<string, string>; body?: Buffer }
  | "error"
  | "timeout";

interface RecordedCall {
  url: URL;
  options: Record<string, unknown>;
  /** Whatever the module's `lookup` hook answered — i.e. the pinned address. */
  pinned: { address: string; family: number } | null;
  destroyed: () => boolean;
}

let calls: RecordedCall[] = [];

/** Ask the recorded `lookup` hook what address it would pin the socket to. */
function askPin(options: Record<string, unknown>): { address: string; family: number } | null {
  const hook = options.lookup as
    | ((h: string, o: { all?: boolean }, cb: (...args: unknown[]) => void) => void)
    | undefined;
  if (!hook) return null;
  let seen: { address: string; family: number } | null = null;
  hook("whatever.example", { all: true }, (...args: unknown[]) => {
    const list = args[1] as { address: string; family: number }[];
    if (Array.isArray(list) && list[0]) seen = list[0];
  });
  if (seen) return seen;
  hook("whatever.example", {}, (...args: unknown[]) => {
    seen = { address: args[1] as string, family: args[2] as number };
  });
  return seen;
}

/** A transport whose every request answers with `reply`. */
function transport(reply: Reply | (() => Reply)) {
  return (url: URL, options: Record<string, unknown>, cb: (res: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
    };
    let responseDestroyed = false;
    calls.push({
      url,
      options,
      pinned: askPin(options),
      destroyed: () => responseDestroyed,
    });
    request.destroy = () => {};
    request.end = () => {
      setImmediate(() => {
        const answer = typeof reply === "function" ? reply() : reply;
        if (answer === "error") {
          request.emit("error", new Error("ECONNRESET"));
          return;
        }
        if (answer === "timeout") {
          request.emit("timeout");
          return;
        }
        const response = new Readable({ read() {} }) as Readable & {
          statusCode: number;
          headers: Record<string, string>;
        };
        response.statusCode = answer.status;
        response.headers = answer.headers;
        const realDestroy = response.destroy.bind(response);
        response.destroy = ((...args: never[]) => {
          responseDestroyed = true;
          return realDestroy(...args);
        }) as typeof response.destroy;
        cb(response);
        setImmediate(() => {
          if (response.destroyed) return;
          if (answer.body) response.push(answer.body);
          response.push(null);
        });
      });
    };
    return request;
  };
}

const imageReply = (body: Buffer = PNG, type = "image/png"): Reply => ({
  status: 200,
  headers: { "content-type": type, "content-length": String(body.length) },
  body,
});

/** Serve the same reply on both transports. */
function serve(reply: Reply | (() => Reply)) {
  httpsRequest.mockImplementation(transport(reply));
  httpRequest.mockImplementation(transport(reply));
}

beforeEach(() => {
  calls = [];
  lookup.mockReset();
  httpsRequest.mockReset();
  httpRequest.mockReset();
  // Everything resolves to a public address unless a test says otherwise.
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  serve(imageReply());
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

describe("the pin", () => {
  it("forces the socket to the address it validated", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await fetchRemoteImages(["https://cdn.example/logo.png"]);

    expect(calls).toHaveLength(1);
    // The hook answers with the address we checked, so the client cannot
    // resolve the name a second time and get a different one.
    expect(calls[0].pinned).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("leaves the URL alone, so TLS still checks the real hostname", async () => {
    await fetchRemoteImages(["https://cdn.example/logo.png"]);
    // Rewriting the URL to the IP would have broken SNI, the Host header and
    // certificate validation all at once. Only the socket is pinned.
    expect(calls[0].url.hostname).toBe("cdn.example");
    expect(calls[0].url.protocol).toBe("https:");
  });

  it("uses the http transport for an http URL and https for https", async () => {
    await fetchRemoteImages(["http://cdn.example/a.png"]);
    expect(httpRequest).toHaveBeenCalledTimes(1);
    expect(httpsRequest).not.toHaveBeenCalled();

    calls = [];
    httpRequest.mockClear();
    await fetchRemoteImages(["https://cdn.example/b.png"]);
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(httpRequest).not.toHaveBeenCalled();
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
    const headers = calls[0].options.headers as Record<string, string>;
    expect(headers.referer).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.accept).toBe("image/*");
  });

  it("refuses a host that resolves to a LAN address", async () => {
    lookup.mockResolvedValue([{ address: "192.168.1.1", family: 4 }]);
    const out = await fetchRemoteImages(["http://router.example/reboot.png"]);
    expect(out.size).toBe(0);
    expect(calls).toHaveLength(0);
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
    expect(calls).toHaveLength(0);
  });

  it("refuses a literal private IP in the URL without consulting DNS", async () => {
    const out = await fetchRemoteImages(["http://127.0.0.1:8080/admin.png"]);
    expect(out.size).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses an IPv6 loopback literal", async () => {
    const out = await fetchRemoteImages(["http://[::1]:8080/admin.png"]);
    expect(out.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("refuses a host that does not resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    expect((await fetchRemoteImages(["https://nowhere.example/x.png"])).size).toBe(0);
  });

  it("refuses a host that resolves to nothing at all", async () => {
    lookup.mockResolvedValue([]);
    expect((await fetchRemoteImages(["https://empty.example/x.png"])).size).toBe(0);
  });

  it.each(["file:///etc/passwd", "ftp://a.example/x.png", "gopher://a.example/x"])(
    "refuses the %s scheme",
    async (url) => {
      expect((await fetchRemoteImages([url])).size).toBe(0);
      expect(calls).toHaveLength(0);
    },
  );

  it("refuses a URL carrying credentials, which would sign the device in somewhere", async () => {
    expect((await fetchRemoteImages(["https://user:pw@cdn.example/x.png"])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("ignores a malformed URL instead of throwing", async () => {
    await expect(fetchRemoteImages(["http://["])).resolves.toEqual(new Map());
  });
});

describe("redirects", () => {
  it("follows a redirect to another public host", async () => {
    let hop = 0;
    serve(() => {
      hop += 1;
      return hop === 1
        ? { status: 302, headers: { location: "https://other.example/real.png" } }
        : imageReply();
    });
    const out = await fetchRemoteImages(["https://cdn.example/a.png"]);
    expect(out.size).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].url.hostname).toBe("other.example");
  });

  it("re-pins every hop rather than trusting the first validation", async () => {
    let hop = 0;
    lookup.mockImplementation(async (host: string) =>
      host === "other.example"
        ? [{ address: "198.41.0.4", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }],
    );
    serve(() => {
      hop += 1;
      return hop === 1
        ? { status: 302, headers: { location: "https://other.example/real.png" } }
        : imageReply();
    });
    await fetchRemoteImages(["https://cdn.example/a.png"]);
    expect(calls[0].pinned?.address).toBe("93.184.216.34");
    expect(calls[1].pinned?.address).toBe("198.41.0.4");
  });

  it("refuses a redirect that lands on a private address", async () => {
    // A follower that only ever saw the first URL would walk here happily.
    lookup.mockImplementation(async (host: string) =>
      host === "metadata.example"
        ? [{ address: "169.254.169.254", family: 4 }]
        : [{ address: "93.184.216.34", family: 4 }],
    );
    serve({ status: 302, headers: { location: "http://metadata.example/latest/meta-data" } });
    const out = await fetchRemoteImages(["https://cdn.example/a.png"]);
    expect(out.size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect to a literal private address", async () => {
    serve({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    expect((await fetchRemoteImages(["https://cdn.example/a.png"])).size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("releases the connection of a hop it is not going to read", async () => {
    serve({ status: 302, headers: { location: "https://other.example/real.png" } });
    await fetchRemoteImages(["https://cdn.example/a.png"]);
    // The redirect's body is never read, so the socket has to be let go
    // explicitly on a device with few to spare.
    expect(calls[0].destroyed()).toBe(true);
  });

  it("gives up rather than following a redirect loop", async () => {
    serve({ status: 302, headers: { location: "https://cdn.example/loop.png" } });
    const out = await fetchRemoteImages(["https://cdn.example/loop.png"]);
    expect(out.size).toBe(0);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("gives up on a redirect with no destination", async () => {
    serve({ status: 302, headers: {} });
    expect((await fetchRemoteImages(["https://cdn.example/a.png"])).size).toBe(0);
  });
});

describe("what comes back", () => {
  it("refuses a response that is not an image, whatever the bytes look like", async () => {
    serve({
      status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from("<script>alert(1)</script>"),
    });
    expect((await fetchRemoteImages(["https://cdn.example/x.png"])).size).toBe(0);
  });

  it("refuses an SVG, which is a scriptable document", async () => {
    serve({
      status: 200,
      headers: { "content-type": "image/svg+xml" },
      body: Buffer.from('<svg onload="alert(1)"/>'),
    });
    expect((await fetchRemoteImages(["https://cdn.example/x.svg"])).size).toBe(0);
  });

  it("accepts image/jpg by normalising it to image/jpeg", async () => {
    const out = await (async () => {
      serve(imageReply(PNG, "image/jpg"));
      return fetchRemoteImages(["https://cdn.example/x.jpg"]);
    })();
    expect(out.get("https://cdn.example/x.jpg")?.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("refuses an image that declares itself too large", async () => {
    serve({
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(10 * 1024 * 1024) },
      body: PNG,
    });
    expect((await fetchRemoteImages(["https://cdn.example/huge.png"])).size).toBe(0);
  });

  it("stops a server that lied about its size", async () => {
    serve({
      status: 200,
      // Understated on purpose — the cap has to hold on the stream too.
      headers: { "content-type": "image/png", "content-length": "10" },
      body: Buffer.alloc(600 * 1024, 1),
    });
    expect((await fetchRemoteImages(["https://cdn.example/liar.png"])).size).toBe(0);
  });

  it("refuses an empty body rather than inlining nothing", async () => {
    serve({ status: 200, headers: { "content-type": "image/png" } });
    expect((await fetchRemoteImages(["https://cdn.example/empty.png"])).size).toBe(0);
  });

  it("skips a transport failure without failing the whole message", async () => {
    let call = 0;
    serve(() => {
      call += 1;
      return call === 1 ? "error" : imageReply();
    });
    const out = await fetchRemoteImages([
      "https://down.example/a.png",
      "https://cdn.example/b.png",
    ]);
    expect(out.size).toBe(1);
    expect(out.has("https://cdn.example/b.png")).toBe(true);
  });

  it("skips a request that times out", async () => {
    serve("timeout");
    expect((await fetchRemoteImages(["https://slow.example/a.png"])).size).toBe(0);
  });

  it("skips a 404 rather than inlining the error page", async () => {
    serve({ status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("nope") });
    expect((await fetchRemoteImages(["https://cdn.example/gone.png"])).size).toBe(0);
  });
});

describe("bounds", () => {
  it("fetches at most twenty images from one message", async () => {
    const urls = Array.from({ length: 50 }, (_, i) => `https://cdn.example/${i}.png`);
    await fetchRemoteImages(urls);
    expect(calls.length).toBeLessThanOrEqual(20);
  });

  it("does nothing at all when the message references no images", async () => {
    expect(await fetchRemoteImages([])).toEqual(new Map());
    expect(calls).toHaveLength(0);
  });

  it("stops when the owner's own request is abandoned", async () => {
    // Closing the panel must stop the outbound work rather than leaving it
    // running against its own deadline.
    const controller = new AbortController();
    controller.abort();
    const out = await fetchRemoteImages(["https://cdn.example/a.png"], controller.signal);
    expect(out.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("reserved ranges are not the public internet either (CodeRabbit #499)", () => {
  it.each([
    ["TEST-NET-1", "192.0.2.5"],
    ["TEST-NET-2", "198.51.100.5"],
    ["TEST-NET-3", "203.0.113.9"],
    ["benchmarking", "198.18.0.1"],
  ])("refuses %s", (_label, ip) => {
    // Nothing legitimate serves an image from one of these — but a LAN is free
    // to use them internally, which is the case this guard exists for.
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it("still allows an ordinary public address in the same neighbourhood", () => {
    expect(isPrivateAddress("198.41.0.4")).toBe(false);
    expect(isPrivateAddress("203.1.113.9")).toBe(false);
  });
});
