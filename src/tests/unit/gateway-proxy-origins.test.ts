import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

// gateway-proxy.ts's redirectToSetup() reflects the request's own origin
// back into the /setup redirect URL when the host is trusted, instead of
// always falling back to CANONICAL_ORIGIN. This exercises the NEW trusted
// control-UI origins path: unlike the pre-existing ALLOWED_HOSTS/mDNS/IP
// matching (host-only, scheme/port-agnostic), a configured origin from
// control-ui-origins.json must match scheme+host+port EXACTLY.

const ENV_VAR = "CLAWBOX_CONTROL_UI_ORIGINS_FILE";

describe("gateway-proxy trusted control UI origin reflection", () => {
  let dir: string;
  let originalEnv: string | undefined;
  let gatewayProxy: typeof import("@/lib/gateway-proxy");

  function createRequest(url: string, headers?: Record<string, string>): NextRequest {
    return new NextRequest(new URL(url), { headers: new Headers(headers) });
  }

  function writeOrigins(entries: string[]) {
    const file = path.join(dir, "origins.json");
    writeFileSync(file, JSON.stringify(entries));
    process.env[ENV_VAR] = file;
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "gateway-proxy-origins-"));
    originalEnv = process.env[ENV_VAR];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalEnv;
  });

  async function importFresh() {
    vi.resetModules();
    gatewayProxy = await import("@/lib/gateway-proxy");
  }

  it("reflects a configured origin on an exact scheme+host+port match", async () => {
    writeOrigins(["http://custom.example.com:8080"]);
    await importFresh();

    const request = createRequest("http://custom.example.com:8080/", {
      host: "custom.example.com:8080",
    });
    const response = gatewayProxy.redirectToSetup(request);

    expect(response.headers.get("location")).toBe("http://custom.example.com:8080/setup");
  });

  it("does NOT reflect the same configured hostname on a different port", async () => {
    writeOrigins(["http://custom.example.com:8080"]);
    await importFresh();

    const request = createRequest("http://custom.example.com:9999/", {
      host: "custom.example.com:9999",
    });
    const response = gatewayProxy.redirectToSetup(request);

    // Falls through to CANONICAL_ORIGIN default, not the request's own host.
    expect(response.headers.get("location")).not.toContain("custom.example.com:9999");
    expect(response.headers.get("location")).toContain("clawbox.local");
  });

  it("does NOT reflect the same configured hostname on a different scheme", async () => {
    writeOrigins(["http://custom.example.com"]);
    await importFresh();

    const request = createRequest("http://custom.example.com/", {
      host: "custom.example.com",
      "x-forwarded-proto": "https",
    });
    const response = gatewayProxy.redirectToSetup(request);

    expect(response.headers.get("location")).not.toContain("custom.example.com");
    expect(response.headers.get("location")).toContain("clawbox.local");
  });

  it("reflects when the exact scheme is also configured separately", async () => {
    writeOrigins(["http://custom.example.com", "https://custom.example.com"]);
    await importFresh();

    const request = createRequest("http://custom.example.com/", {
      host: "custom.example.com",
      "x-forwarded-proto": "https",
    });
    const response = gatewayProxy.redirectToSetup(request);

    expect(response.headers.get("location")).toBe("https://custom.example.com/setup");
  });

  it("reflects a configured origin at the default port with no port in the Host header", async () => {
    writeOrigins(["http://custom.example.com"]);
    await importFresh();

    const request = createRequest("http://custom.example.com/", {
      host: "custom.example.com",
    });
    const response = gatewayProxy.redirectToSetup(request);

    expect(response.headers.get("location")).toBe("http://custom.example.com/setup");
  });

  it("does not reflect an origin absent from the configured list", async () => {
    writeOrigins(["http://trusted.example.com"]);
    await importFresh();

    const request = createRequest("http://untrusted.example.com/", {
      host: "untrusted.example.com",
    });
    const response = gatewayProxy.redirectToSetup(request);

    expect(response.headers.get("location")).not.toContain("untrusted.example.com");
    expect(response.headers.get("location")).toContain("clawbox.local");
  });

  it("enforces exact scheme and port for a configured non-default origin", async () => {
    writeOrigins(["http://box.example.com:8080"]);
    await importFresh();

    const exact = gatewayProxy.redirectToSetup(
      createRequest("http://box.example.com:8080/", { host: "box.example.com:8080" }),
    );
    expect(exact.headers.get("location")).toBe("http://box.example.com:8080/setup");

    const wrongPort = gatewayProxy.redirectToSetup(
      createRequest("http://box.example.com:9999/", { host: "box.example.com:9999" }),
    );
    expect(wrongPort.headers.get("location")).toContain("clawbox.local");

    const wrongScheme = gatewayProxy.redirectToSetup(
      createRequest("http://box.example.com:8080/", {
        host: "box.example.com:8080",
        "x-forwarded-proto": "https",
      }),
    );
    expect(wrongScheme.headers.get("location")).toContain("clawbox.local");
  });

  it("keeps broad reflection for a default host even when a matching origin is configured", async () => {
    // Regression: configuring https://10.42.0.1 must not stop plain
    // http://10.42.0.1 (a default-reflectable LAN IP) from reflecting on the
    // SoftAP — otherwise the user dead-ends at the unresolvable clawbox.local.
    writeOrigins(["https://10.42.0.1"]);
    await importFresh();

    const plainHttp = gatewayProxy.redirectToSetup(
      createRequest("http://10.42.0.1/", { host: "10.42.0.1" }),
    );
    expect(plainHttp.headers.get("location")).toBe("http://10.42.0.1/setup");

    const otherPort = gatewayProxy.redirectToSetup(
      createRequest("http://10.42.0.1:9999/", { host: "10.42.0.1:9999" }),
    );
    expect(otherPort.headers.get("location")).toBe("http://10.42.0.1:9999/setup");
  });

  it("refreshes configured origins after the source file changes", async () => {
    writeOrigins(["http://first.example.com"]);
    await importFresh();

    const first = gatewayProxy.redirectToSetup(
      createRequest("http://first.example.com/", { host: "first.example.com" }),
    );
    expect(first.headers.get("location")).toContain("first.example.com");

    writeOrigins(["http://replacement.example.com:8080"]);
    const replacement = gatewayProxy.redirectToSetup(
      createRequest("http://replacement.example.com:8080/", {
        host: "replacement.example.com:8080",
      }),
    );
    expect(replacement.headers.get("location")).toBe(
      "http://replacement.example.com:8080/setup",
    );

    const stale = gatewayProxy.redirectToSetup(
      createRequest("http://first.example.com/", { host: "first.example.com" }),
    );
    expect(stale.headers.get("location")).toContain("clawbox.local");
  });

  it("retains existing ALLOWED_HOSTS/IP reflection when no origins are configured", async () => {
    process.env[ENV_VAR] = path.join(dir, "absent.json");
    await importFresh();

    const request = createRequest("http://clawbox.local/", { host: "clawbox.local" });
    const response = gatewayProxy.redirectToSetup(request);

    expect(response.headers.get("location")).toContain("clawbox.local");

    const ipRequest = createRequest("http://192.0.2.3/", { host: "192.0.2.3" });
    const ipResponse = gatewayProxy.redirectToSetup(ipRequest);
    expect(ipResponse.headers.get("location")).toContain("192.0.2.3");
  });

  it("an invalid origins file yields no extras and does not affect existing host reflection", async () => {
    const file = path.join(dir, "origins.json");
    writeFileSync(file, "{not json");
    process.env[ENV_VAR] = file;
    await importFresh();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const request = createRequest("http://clawbox.local/", { host: "clawbox.local" });
    const response = gatewayProxy.redirectToSetup(request);
    expect(response.headers.get("location")).toContain("clawbox.local");

    const untrustedRequest = createRequest("http://untrusted.example.com/", {
      host: "untrusted.example.com",
    });
    const untrustedResponse = gatewayProxy.redirectToSetup(untrustedRequest);
    expect(untrustedResponse.headers.get("location")).not.toContain("untrusted.example.com");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"));
  });
});
