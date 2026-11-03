import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import LocalHttpsPanel from "@/components/LocalHttpsPanel";

/**
 * Settings → Network → Secure local address (docs/design/local-https.md).
 * Pinned: the privacy disclosure stands above the switch before anything is
 * on; the switch posts the owner's choice and follows the answer; while the
 * certificate is on its way the card polls; once served it asks whether THIS
 * browser reaches the address; and every problem and DNS verdict is worded
 * from the catalogue. Rendered without a provider, so `t()` answers keys.
 */

const HOST = "k3x9q2m7v4t8p1rz.lan.clawbox.com";
const URL_ = `https://${HOST}`;

const OFF = {
  enabled: false, hostname: null, url: null, lanIp: null, serving: false, certNotAfter: null, renewAt: null,
  issuing: false, problem: null, dns: null, portal: "portal", unregisterPending: false, lastCheckAt: null,
};
const ISSUING = { ...OFF, enabled: true, hostname: HOST, url: URL_, lanIp: "192.168.1.20", issuing: true };
const SERVING = { ...ISSUING, issuing: false, serving: true, certNotAfter: Date.UTC(2027, 1, 1), dns: "ok" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
function route(handler: Handler) {
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  route(async () => json(OFF));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LocalHttpsPanel", () => {
  it("shows the disclosure above an unchecked switch before anything is on", async () => {
    render(<LocalHttpsPanel />);
    await waitFor(() => expect(screen.getByTestId("local-https-panel")).toBeTruthy());
    expect(screen.getByTestId("local-https-privacy").textContent).toBe("settings.localHttps.privacy");
    const sw = screen.getByTestId("local-https-switch");
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("local-https-url")).toBeNull();
  });

  it("draws nothing for a refusal or a body of the wrong shape", async () => {
    route(async () => json({ error: "Only the box owner…", code: "owner_only" }, 403));
    const { container, unmount } = render(<LocalHttpsPanel />);
    await settle();
    expect(container.innerHTML).toBe("");
    unmount();
    route(async () => json({}));
    const second = render(<LocalHttpsPanel />);
    await settle();
    expect(second.container.innerHTML).toBe("");
  });

  it("posts the owner's choice and follows the answer", async () => {
    const fetchMock = route(async (url, init) => (init?.method === "POST" ? json(ISSUING) : json(OFF)));
    render(<LocalHttpsPanel />);
    await waitFor(() => expect(screen.getByTestId("local-https-switch")).toBeTruthy());
    fireEvent.click(screen.getByTestId("local-https-switch"));
    await waitFor(() => expect(screen.getByTestId("local-https-switch").getAttribute("aria-checked")).toBe("true"));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/setup-api/local-https");
    expect(JSON.parse(String(post[1]!.body))).toEqual({ enabled: true });
    expect(screen.getByTestId("local-https-url").textContent).toBe(URL_);
    expect(screen.getByTestId("local-https-cert").textContent).toBe("settings.localHttps.preparing");
  });

  it("says when the switch could not be saved", async () => {
    route(async (_url, init) => (init?.method === "POST" ? json({ code: "store_write_failed" }, 500) : json(OFF)));
    render(<LocalHttpsPanel />);
    await waitFor(() => expect(screen.getByTestId("local-https-switch")).toBeTruthy());
    fireEvent.click(screen.getByTestId("local-https-switch"));
    await waitFor(() => expect(screen.getByTestId("local-https-failed")).toBeTruthy());
    expect(screen.getByTestId("local-https-switch").getAttribute("aria-checked")).toBe("false");
  });

  it("polls while the certificate is on its way, then reads it served", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: unknown = ISSUING;
    route(async (url) => (url.startsWith("https://") ? new Response(null, { status: 200 }) : json(answer)));
    render(<LocalHttpsPanel />);
    await waitFor(() => expect(screen.getByTestId("local-https-cert").textContent).toBe("settings.localHttps.preparing"));
    answer = SERVING;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    await waitFor(() => expect(screen.getByTestId("local-https-cert").textContent).toBe("settings.localHttps.ready"));
    expect(screen.getByTestId("local-https-open").getAttribute("href")).toBe(URL_);
  });

  it("asks whether this browser reaches the served address", async () => {
    const fetchMock = route(async (url) => (url.startsWith("https://") ? new Response(null, { status: 200 }) : json(SERVING)));
    render(<LocalHttpsPanel />);
    await waitFor(() => expect(screen.getByTestId("local-https-browser").getAttribute("data-state")).toBe("ok"));
    expect(screen.getByTestId("local-https-browser").textContent).toBe("settings.localHttps.browserOk");
    const probe = fetchMock.mock.calls.find(([url]) => String(url).startsWith("https://"))!;
    expect(probe[0]).toBe(`${URL_}/setup-api/local-https/hint`);
    expect(probe[1]).toMatchObject({ mode: "no-cors" });
  });

  it("says so when this browser cannot reach it", async () => {
    route(async (url) => {
      if (url.startsWith("https://")) throw new TypeError("Failed to fetch");
      return json(SERVING);
    });
    render(<LocalHttpsPanel />);
    await waitFor(() => expect(screen.getByTestId("local-https-browser").getAttribute("data-state")).toBe("blocked"));
    expect(screen.getByTestId("local-https-browser").textContent).toBe("settings.localHttps.browserBlocked");
  });

  it("explains DNS-rebind protection, which then speaks for the blocked browser", async () => {
    route(async (url) => {
      if (url.startsWith("https://")) throw new TypeError("Failed to fetch");
      return json({ ...SERVING, dns: "rebind_blocked" });
    });
    render(<LocalHttpsPanel />);
    await waitFor(() => expect(screen.getByTestId("local-https-dns").getAttribute("data-state")).toBe("rebind_blocked"));
    expect(screen.getByTestId("local-https-dns").textContent).toBe("settings.localHttps.dnsRebind");
    await settle();
    expect(screen.queryByTestId("local-https-browser")).toBeNull();
  });

  it.each([
    ["not_paired", "settings.localHttps.problemNotPaired"],
    ["portal_unavailable", "settings.localHttps.problemPortalUnavailable"],
    ["portal_error", "settings.localHttps.problemPortalError"],
    ["rate_limited", "settings.localHttps.problemRateLimited"],
    ["no_lan_ip", "settings.localHttps.problemNoLanIp"],
    ["order_failed", "settings.localHttps.problemOrderFailed"],
    ["bad_certificate", "settings.localHttps.problemBadCertificate"],
    ["write_failed", "settings.localHttps.problemWriteFailed"],
  ])("words the problem %s from the catalogue", async (code, key) => {
    route(async () => json({ ...ISSUING, issuing: false, problem: { code, detail: "internal words", since: 1 } }));
    render(<LocalHttpsPanel />);
    await waitFor(() => expect(screen.getByTestId("local-https-problem").getAttribute("data-code")).toBe(code));
    expect(screen.getByTestId("local-https-problem").textContent).toBe(key);
  });

  it("marks the stub portal's test mode", async () => {
    route(async (url) => (url.startsWith("https://") ? new Response(null) : json({ ...SERVING, portal: "stub" })));
    render(<LocalHttpsPanel />);
    await waitFor(() => expect(screen.getByTestId("local-https-stub").textContent).toBe("settings.localHttps.stubMode"));
  });
});
