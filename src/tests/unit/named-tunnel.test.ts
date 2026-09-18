import fs from "fs/promises";
import { statSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * data/cloudflared/named-tunnel — the credential scripts/run-tunnel.sh runs the
 * named tunnel with — and the URL shapes the rest of the box accepts from
 * tunnel.url once that tunnel is up.
 */

const HOST = "amber-otter-k7m2p9qx4w3n.clawbox.tech";
const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";

let root: string;
let named: typeof import("@/lib/named-tunnel");
let cloudflared: typeof import("@/lib/cloudflared");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-named-tunnel-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  named = await import("@/lib/named-tunnel");
  cloudflared = await import("@/lib/cloudflared");
});

afterEach(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(root, { recursive: true, force: true });
});

const cfFile = (name: string) => path.join(root, "data", "cloudflared", name);

describe("named-tunnel credential", () => {
  it("round-trips through a 0600 file, written by rename", async () => {
    await named.writeNamedTunnelCredential({ hostname: HOST, token: TOKEN });
    expect(statSync(cfFile("named-tunnel")).mode & 0o777).toBe(0o600);
    expect(await named.readNamedTunnelCredential()).toEqual({ hostname: HOST, token: TOKEN });
    expect(named.readNamedTunnelHostnameSync()).toBe(HOST);
    expect(await fs.readdir(path.dirname(cfFile("named-tunnel")))).toEqual(["named-tunnel"]);
  });

  it("refuses to write anything a shell parser could be confused by", async () => {
    await expect(named.writeNamedTunnelCredential({ hostname: "evil.example.com", token: TOKEN })).rejects.toThrow();
    await expect(named.writeNamedTunnelCredential({ hostname: "x.y.clawbox.tech", token: TOKEN })).rejects.toThrow();
    await expect(named.writeNamedTunnelCredential({ hostname: HOST, token: `${TOKEN}\ntoken=x` })).rejects.toThrow();
    await expect(named.writeNamedTunnelCredential({ hostname: HOST, token: "short" })).rejects.toThrow();
    expect(await named.readNamedTunnelCredential()).toBeNull();
  });

  it("reads a file with either line missing as no credential", async () => {
    await fs.mkdir(path.dirname(cfFile("named-tunnel")), { recursive: true });
    await fs.writeFile(cfFile("named-tunnel"), `hostname=${HOST}\n`);
    expect(await named.readNamedTunnelCredential()).toBeNull();
    expect(named.readNamedTunnelHostnameSync()).toBeNull();
  });

  it("clears the credential and says whether there was one", async () => {
    expect(await named.clearNamedTunnelCredential()).toBe(false);
    await named.writeNamedTunnelCredential({ hostname: HOST, token: TOKEN });
    expect(await named.clearNamedTunnelCredential()).toBe(true);
    expect(await named.readNamedTunnelCredential()).toBeNull();
  });

  it("reads the mode run-tunnel.sh wrote, and nothing else", async () => {
    await fs.mkdir(path.dirname(cfFile("tunnel.mode")), { recursive: true });
    expect(await named.readTunnelMode()).toBeNull();
    await fs.writeFile(cfFile("tunnel.mode"), "named\n");
    expect(await named.readTunnelMode()).toBe("named");
    await fs.writeFile(cfFile("tunnel.mode"), "quick\n");
    expect(await named.readTunnelMode()).toBe("quick");
    await fs.writeFile(cfFile("tunnel.mode"), "bogus\n");
    expect(await named.readTunnelMode()).toBeNull();
  });
});

describe("tunnel.url accepts the named hostname", () => {
  async function publish(url: string) {
    await fs.mkdir(path.dirname(cfFile("tunnel.url")), { recursive: true });
    await fs.writeFile(cfFile("tunnel.url"), `${url}\n`);
    return cloudflared.readTunnelUrl();
  }

  it("returns the named URL and the quick URL", async () => {
    expect(await publish(`https://${HOST}`)).toBe(`https://${HOST}`);
    expect(await publish("https://abc-def.trycloudflare.com")).toBe("https://abc-def.trycloudflare.com");
  });

  it("still refuses anything else", async () => {
    for (const bad of [
      "https://a.b.clawbox.tech",
      "http://" + HOST,
      "https://clawbox.tech",
      "https://evil.example.com",
      `https://${HOST}.evil.example.com`,
    ]) {
      expect(await publish(bad), bad).toBeNull();
    }
  });

  it("keeps named entries in the URL history", async () => {
    await fs.mkdir(path.dirname(cfFile("tunnel-url.log")), { recursive: true });
    await fs.writeFile(
      cfFile("tunnel-url.log"),
      `2026-09-01T00:00:00Z https://abc.trycloudflare.com\n2026-09-02T00:00:00Z https://${HOST}\n`,
    );
    expect((await cloudflared.readTunnelUrlHistory()).map((r) => r.url)).toEqual([
      `https://${HOST}`,
      "https://abc.trycloudflare.com",
    ]);
  });
});
