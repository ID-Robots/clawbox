import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import GoogleConnectPanel from "@/components/GoogleConnectPanel";

/**
 * "Connect Google" in Settings → Harness: the owner's Calendar + Drive for the
 * Hermes assistant, behind CLAWBOX_GOOGLE_CONNECT. With the flag off the route
 * is a 404 and the card must draw nothing — the box looks exactly as before.
 */

const CALENDAR = "https://www.googleapis.com/auth/calendar.events";
const DRIVE = "https://www.googleapis.com/auth/drive.file";
const DISCONNECTED = { configured: true, hermes: true, connected: false, ownClient: false, scopes: [], pending: false };
const CONNECTED = { ...DISCONNECTED, connected: true, scopes: [CALENDAR, DRIVE] };
const CONSENT_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=s1";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

type FetchMock = ReturnType<typeof vi.fn>;

function stubRoutes(routes: Record<string, () => Response>): FetchMock {
  const mock = vi.fn(async (input: string | URL) => {
    const route = routes[String(input)];
    return route ? route() : json({ error: "Not found." }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  stubRoutes({ "/setup-api/google/connect": () => json(DISCONNECTED) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GoogleConnectPanel", () => {
  it("draws nothing while the flag is off (the route is a 404)", async () => {
    stubRoutes({});
    const { container } = render(<GoogleConnectPanel />);
    await settle();
    expect(container.innerHTML).toBe("");
  });

  it("draws nothing for a body that is not the status", async () => {
    stubRoutes({ "/setup-api/google/connect": () => json({ connected: "yes" }) });
    const { container } = render(<GoogleConnectPanel />);
    await settle();
    expect(container.innerHTML).toBe("");
  });

  it("says when the box has no ClawBox Google client yet, and offers no button", async () => {
    stubRoutes({ "/setup-api/google/connect": () => json({ ...DISCONNECTED, configured: false }) });
    render(<GoogleConnectPanel />);
    expect(await screen.findByTestId("google-connect-not-configured")).toBeTruthy();
    expect(screen.queryByTestId("google-connect-start")).toBeNull();
  });

  it("says when this edition does not run Hermes", async () => {
    stubRoutes({ "/setup-api/google/connect": () => json({ ...DISCONNECTED, hermes: false }) });
    render(<GoogleConnectPanel />);
    expect(await screen.findByTestId("google-connect-no-hermes")).toBeTruthy();
    expect(screen.queryByTestId("google-connect-start")).toBeNull();
  });

  it("starts a sign-in, takes the pasted address and shows the account connected", async () => {
    const mock = stubRoutes({
      "/setup-api/google/connect": () => json(DISCONNECTED),
      "/setup-api/google/connect/start": () => json({ url: CONSENT_URL }),
      "/setup-api/google/connect/exchange": () => json({ ...CONNECTED, applied: true }),
    });
    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByTestId("google-connect-start"));

    const open = await screen.findByTestId("google-connect-open");
    expect(open.getAttribute("href")).toBe(CONSENT_URL);
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toContain("noopener");
    const finish = screen.getByTestId("google-connect-finish");
    expect(finish.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByTestId("google-connect-paste"), {
      target: { value: "http://127.0.0.1:1/?state=s1&code=c1" },
    });
    expect(finish.hasAttribute("disabled")).toBe(false);
    fireEvent.click(finish);

    await waitFor(() => expect(screen.getByTestId("google-connect-state").textContent).toBe("settings.googleConnect.connected"));
    expect(screen.getByTestId("google-connect-scopes").textContent).toBe("settings.googleConnect.scopeCalendar · settings.googleConnect.scopeDrive");
    expect(screen.queryByTestId("google-connect-steps")).toBeNull();
    const exchange = mock.mock.calls.find(([input]) => String(input) === "/setup-api/google/connect/exchange");
    expect(JSON.parse(String((exchange?.[1] as RequestInit).body))).toEqual({ redirect: "http://127.0.0.1:1/?state=s1&code=c1" });
    expect(screen.getByTestId("google-connect-disconnect")).toBeTruthy();
  });

  it("shows the route's reason when the pasted address is refused, and keeps the steps open", async () => {
    stubRoutes({
      "/setup-api/google/connect": () => json(DISCONNECTED),
      "/setup-api/google/connect/start": () => json({ url: CONSENT_URL }),
      "/setup-api/google/connect/exchange": () => json({ error: "That address belongs to a different sign-in.", code: "state_mismatch" }, 403),
    });
    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByTestId("google-connect-start"));
    fireEvent.change(await screen.findByTestId("google-connect-paste"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("google-connect-finish"));
    const failed = await screen.findByTestId("google-connect-failed");
    expect(failed.textContent).toContain("That address belongs to a different sign-in.");
    expect(screen.getByTestId("google-connect-steps")).toBeTruthy();
  });

  it("reports a start the box refused", async () => {
    stubRoutes({
      "/setup-api/google/connect": () => json(DISCONNECTED),
      "/setup-api/google/connect/start": () => json({ error: "Not set up.", code: "not_configured" }, 503),
    });
    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByTestId("google-connect-start"));
    expect((await screen.findByTestId("google-connect-failed")).textContent).toContain("Not set up.");
    expect(screen.queryByTestId("google-connect-steps")).toBeNull();
  });

  it("cancels a started sign-in back to the Connect button", async () => {
    stubRoutes({
      "/setup-api/google/connect": () => json(DISCONNECTED),
      "/setup-api/google/connect/start": () => json({ url: CONSENT_URL }),
    });
    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByTestId("google-connect-start"));
    fireEvent.click(await screen.findByTestId("google-connect-cancel"));
    expect(screen.queryByTestId("google-connect-steps")).toBeNull();
    expect(screen.getByTestId("google-connect-start")).toBeTruthy();
  });

  it("disconnects", async () => {
    stubRoutes({
      "/setup-api/google/connect": () => json(CONNECTED),
      "/setup-api/google/connect/disconnect": () => json({ ...DISCONNECTED, revoked: true, applied: true }),
    });
    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByTestId("google-connect-disconnect"));
    await waitFor(() => expect(screen.getByTestId("google-connect-state").textContent).toBe("settings.googleConnect.disconnected"));
    expect(screen.getByTestId("google-connect-start")).toBeTruthy();
  });

  it("offers no disconnect for a grant made with the owner's own client", async () => {
    stubRoutes({ "/setup-api/google/connect": () => json({ ...CONNECTED, ownClient: true }) });
    render(<GoogleConnectPanel />);
    expect(await screen.findByTestId("google-connect-own-client")).toBeTruthy();
    expect(screen.queryByTestId("google-connect-disconnect")).toBeNull();
    expect(screen.queryByTestId("google-connect-start")).toBeNull();
  });

  it("survives a network failure with the catalogue line alone", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return json(DISCONNECTED);
      throw new TypeError("network down");
    }));
    render(<GoogleConnectPanel />);
    fireEvent.click(await screen.findByTestId("google-connect-start"));
    expect((await screen.findByTestId("google-connect-failed")).textContent).toBe("settings.googleConnect.failed");
  });
});
