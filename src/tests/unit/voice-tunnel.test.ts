import { describe, expect, it, vi } from "vitest";
import { classifyTunnelDestination, fetchTunnelDestination } from "@/lib/voice-tunnel";

/**
 * The mic popup's offer is only honest when it is backed by the LIVE tunnel
 * state: Quick Tunnel hostnames change on every restart, so a stale or
 * guessed URL is exactly the dead link Yanko's TASK-470 acceptance forbids.
 * These tests pin the classification that decides whether a "Take me there"
 * button may exist at all.
 */
describe("classifyTunnelDestination", () => {
  it("offers the tunnel only when the service is active AND published an https URL", () => {
    expect(
      classifyTunnelDestination({
        tunnel: { installed: true, service: "active", url: "https://lively-crab.trycloudflare.com" },
      }),
    ).toEqual({ kind: "ready", url: "https://lively-crab.trycloudflare.com/" });
  });

  it("treats a stopped service as off even when a stale URL is still readable", () => {
    // The URL survives in the journal after cloudflared stops, but the next
    // start negotiates a NEW hostname — redirecting to the old one is a dead
    // link, which is worse than saying the tunnel is off.
    expect(
      classifyTunnelDestination({
        tunnel: { installed: true, service: "inactive", url: "https://stale.trycloudflare.com" },
      }),
    ).toEqual({ kind: "off" });
  });

  it("treats an active service that has not published a URL yet as off", () => {
    expect(
      classifyTunnelDestination({ tunnel: { installed: true, service: "active", url: null } }),
    ).toEqual({ kind: "off" });
  });

  it("treats a not-installed tunnel as off", () => {
    expect(
      classifyTunnelDestination({ tunnel: { installed: false, service: "unknown", url: null } }),
    ).toEqual({ kind: "off" });
  });

  it("never redirects to a non-https address", () => {
    // The popup exists because the current origin is insecure; sending the
    // customer to another insecure address would recreate the same dead end.
    expect(
      classifyTunnelDestination({ tunnel: { installed: true, service: "active", url: "http://plain.example" } }),
    ).toEqual({ kind: "off" });
    expect(
      classifyTunnelDestination({ tunnel: { installed: true, service: "active", url: "not a url" } }),
    ).toEqual({ kind: "off" });
  });

  it("reports failed on a payload with no tunnel in it", () => {
    expect(classifyTunnelDestination({})).toEqual({ kind: "failed" });
    expect(classifyTunnelDestination(null)).toEqual({ kind: "failed" });
    expect(classifyTunnelDestination("error")).toEqual({ kind: "failed" });
  });
});

describe("fetchTunnelDestination", () => {
  it("asks the live status endpoint with caching disabled", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tunnel: { installed: true, service: "active", url: "https://x.trycloudflare.com" } }),
    })) as unknown as typeof fetch;

    const result = await fetchTunnelDestination(fetchImpl);

    expect(result).toEqual({ kind: "ready", url: "https://x.trycloudflare.com/" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/setup-api/portal/status",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it("maps a network failure to failed, not to a claim the tunnel is off", async () => {
    // "Turn it on in Settings" is a statement about the box. A fetch that
    // never reached the box cannot back it.
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await fetchTunnelDestination(fetchImpl)).toEqual({ kind: "failed" });
  });

  it("maps a non-2xx status to failed", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchTunnelDestination(fetchImpl)).toEqual({ kind: "failed" });
  });
});
