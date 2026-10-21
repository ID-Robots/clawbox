import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { PhonesState } from "@/lib/phone-pairing-shared";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) => (params ? `${key}${JSON.stringify(params)}` : key),
  }),
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr" data-value={value} />,
}));

import PhonesPanel from "@/components/PhonesPanel";

const BASE: PhonesState = {
  available: true,
  enabled: true,
  host: "box-handle.clawbox.tech",
  invites: [],
  requests: [],
  approved: [],
  paired: [],
  pending: [],
};

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

let current: PhonesState;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  current = { ...BASE };
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/setup-api/nodes" && method === "GET") return json(200, current);
    if (url === "/setup-api/nodes/invite") {
      const invite = "I".repeat(22);
      const view = { invite, url: `https://box-handle.clawbox.tech/phone-pair#${invite}`, expiresAtMs: Date.now() + 600_000 };
      current = { ...current, invites: [view] };
      return json(200, view);
    }
    if (url === "/setup-api/nodes/approve") return json(200, { ok: true });
    if (url === "/setup-api/nodes/reject") return json(200, { ok: true });
    if (url === "/setup-api/nodes/revoke") {
      current = { ...current, paired: [] };
      return json(200, { ok: true });
    }
    if (url === "/setup-api/nodes/settings") {
      const enabled = JSON.parse(String(init?.body)).enabled;
      current = { ...current, enabled };
      return json(200, { ok: true, enabled });
    }
    return json(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function posts(url: string) {
  return fetchMock.mock.calls.filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === "POST");
}

describe("Settings → Phones", () => {
  it("shows the switch off and offers nothing to pair while it is off", async () => {
    current = { ...BASE, enabled: false };
    render(<PhonesPanel />);
    const toggle = await screen.findByTestId("phones-switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("phones-add")).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => expect(posts("/setup-api/nodes/settings")).toHaveLength(1));
    expect(JSON.parse(String((posts("/setup-api/nodes/settings")[0][1] as RequestInit).body))).toEqual({ enabled: true });
    expect(await screen.findByTestId("phones-add")).toBeInTheDocument();
  });

  it("says a permanent link is needed when the named tunnel is not running", async () => {
    current = { ...BASE, host: null };
    render(<PhonesPanel />);
    expect(await screen.findByTestId("phones-needs-link")).toBeInTheDocument();
    expect(screen.queryByTestId("phones-add")).toBeNull();
  });

  it("shows a one-phone QR invite for the phone's camera", async () => {
    render(<PhonesPanel />);
    fireEvent.click(await screen.findByTestId("phones-add"));
    const qr = await screen.findByTestId("qr");
    expect(qr.getAttribute("data-value")).toBe(`https://box-handle.clawbox.tech/phone-pair#${"I".repeat(22)}`);

    fireEvent.click(screen.getByTestId("phones-invite-close"));
    await waitFor(() => expect(posts("/setup-api/nodes/reject")).toHaveLength(1));
    expect(JSON.parse(String((posts("/setup-api/nodes/reject")[0][1] as RequestInit).body))).toEqual({ invite: "I".repeat(22) });
  });

  it("lets the owner approve or reject each phone that asked", async () => {
    current = {
      ...BASE,
      requests: [{ invite: "R".repeat(22), name: "Pixel 9", platform: "android", address: "203.0.113.7", requestedAtMs: Date.now(), expiresAtMs: Date.now() + 600_000 }],
      pending: [{ requestId: "req-1", deviceId: "phone-2", name: "Ana's iPhone", platform: "ios", address: null, requestedAtMs: null }],
    };
    render(<PhonesPanel />);
    const rows = await screen.findAllByTestId(/phones-(request|pending)$/);
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Pixel 9")).toBeInTheDocument();
    expect(screen.getByText(/Android/)).toBeInTheDocument();
    // Each row's buttons are named after its phone, not the same "Approve" twice.
    expect(screen.getByRole("button", { name: "settings.phones.approve Pixel 9" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "settings.phones.reject Ana's iPhone" })).toBeInTheDocument();

    fireEvent.click(screen.getAllByText("settings.phones.approve")[0]);
    await waitFor(() => expect(posts("/setup-api/nodes/approve")).toHaveLength(1));
    expect(JSON.parse(String((posts("/setup-api/nodes/approve")[0][1] as RequestInit).body))).toEqual({ invite: "R".repeat(22) });

    fireEvent.click(screen.getAllByText("settings.phones.reject")[1]);
    await waitFor(() => expect(posts("/setup-api/nodes/reject")).toHaveLength(1));
    expect(JSON.parse(String((posts("/setup-api/nodes/reject")[0][1] as RequestInit).body))).toEqual({ requestId: "req-1" });
  });

  it("asks before revoking a paired phone, then revokes that one phone", async () => {
    current = {
      ...BASE,
      enabled: false,
      paired: [{ deviceId: "phone-1", name: "Pixel 9", platform: "android", connected: true, lastSeenAtMs: null, approvedAtMs: 1 }],
    };
    render(<PhonesPanel />);
    fireEvent.click(await screen.findByText("settings.phones.revoke"));
    expect(screen.getByTestId("phones-revoke-confirm")).toHaveTextContent('settings.phones.revokeConfirm{"name":"Pixel 9"}');
    expect(posts("/setup-api/nodes/revoke")).toHaveLength(0);

    fireEvent.click(screen.getByText("settings.phones.revokeConfirmButton"));
    await waitFor(() => expect(posts("/setup-api/nodes/revoke")).toHaveLength(1));
    expect(JSON.parse(String((posts("/setup-api/nodes/revoke")[0][1] as RequestInit).body))).toEqual({ deviceId: "phone-1" });
    expect(await screen.findByTestId("phones-notice")).toHaveTextContent('settings.phones.revoked{"name":"Pixel 9"}');
  });

  it("says when the assistant could not list its phones instead of showing none", async () => {
    current = { ...BASE, paired: null, pending: null, gatewayError: "gateway closed the connection" };
    render(<PhonesPanel />);
    expect(await screen.findByTestId("phones-gateway-error")).toHaveTextContent("gateway closed the connection");
  });

  it("shows a refusal from a route rather than a success", async () => {
    current = {
      ...BASE,
      requests: [{ invite: "R".repeat(22), name: "Pixel 9", platform: "android", address: null, requestedAtMs: 1, expiresAtMs: Date.now() + 600_000 }],
    };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/setup-api/nodes/approve") return json(500, { error: "refused to hand out the code", code: "unsafe_setup_code" });
      if (url === "/setup-api/nodes" && (init?.method ?? "GET") === "GET") return json(200, current);
      return json(404, {});
    });
    // jsdom lays nothing out and has no scrollIntoView; a stand-in records the call.
    const original = Element.prototype.scrollIntoView;
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      render(<PhonesPanel />);
      fireEvent.click(await screen.findByText("settings.phones.approve"));
      const notice = await screen.findByTestId("phones-notice");
      expect(notice).toHaveTextContent("refused to hand out the code");
      // The notice sits at the foot of the pane: it is brought into view, not left below the fold.
      await waitFor(() => expect(scrolled.mock.contexts).toContain(notice));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("explains that a box without OpenClaw has no phones to pair", async () => {
    current = { ...BASE, available: false };
    render(<PhonesPanel />);
    expect(await screen.findByTestId("phones-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("phones-switch")).toBeNull();
  });
});
