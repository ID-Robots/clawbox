/**
 * Step 3 and the device reads that answer after the owner has already acted.
 *
 * On mount the step asks the box whether its hotspot is on, what the hotspot
 * is called and what the device is called, and fills the form from the
 * answers. The hotspot read probes the radio and can take seconds; the owner
 * does not wait for it. An answer that landed after the owner had switched
 * the hotspot OFF switched it back on, made the hotspot password required
 * again and left Save & Continue disabled with nothing the owner had done to
 * explain it.
 *
 * Pinned here: a late answer still fills every control the owner has not
 * touched, and never undoes one they have.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CredentialsStep from "@/components/CredentialsStep";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

const SYSTEM_PASSWORD = "system-secret-1";
const HOTSPOT_PASSWORD = "hotspot-secret-1";

type HeldRead = PromiseWithResolvers<Record<string, unknown>>;
type HeldPost = { url: string; body: Record<string, unknown> };

let hotspotRead: HeldRead;
let hostnameRead: HeldRead;
let posts: HeldPost[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  hotspotRead = Promise.withResolvers();
  hostnameRead = Promise.withResolvers();
  posts = [];
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      // Never answered: the save stays on its first request, so the progress
      // line it shows for that request can be read.
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Promise<Response>(() => {});
    }
    // The reads answer only when a test lands them.
    if (url === "/setup-api/system/hotspot") {
      return Promise.resolve({ ok: true, json: () => hotspotRead.promise } as unknown as Response);
    }
    if (url === "/setup-api/system/hostname") {
      return Promise.resolve({ ok: true, json: () => hostnameRead.promise } as unknown as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Render the step with both device reads asked and neither answered. */
async function mountStep() {
  const utils = render(<CredentialsStep onNext={vi.fn()} />);
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/hotspot", expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/hostname", expect.any(Object));
  });
  return utils;
}

/** Let a held read answer, and everything it sets render. */
async function land(read: HeldRead, body: Record<string, unknown>) {
  await act(async () => {
    read.resolve(body);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function field(container: HTMLElement, selector: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`missing field: ${selector}`);
  return el;
}

function opener(container: HTMLElement, panelId: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[aria-controls="${panelId}"]`);
  if (!el) throw new Error(`missing opener for ${panelId}`);
  return el;
}

function fillSystemPassword(container: HTMLElement) {
  fireEvent.change(field(container, "#cred-password"), { target: { value: SYSTEM_PASSWORD } });
  fireEvent.change(field(container, "#cred-confirm"), { target: { value: SYSTEM_PASSWORD } });
}

function fillHotspotPassword(container: HTMLElement) {
  fireEvent.change(field(container, "#hotspot-password"), { target: { value: HOTSPOT_PASSWORD } });
  fireEvent.change(field(container, "#hotspot-confirm"), { target: { value: HOTSPOT_PASSWORD } });
}

const hotspotSwitch = () => screen.getByRole("switch");
const connect = () => screen.getByRole("button", { name: "Save & Continue" });

describe("Step 3 — a device read that answers after the owner acted", () => {
  it("leaves the hotspot off when the answer says on, and Save & Continue available", async () => {
    const { container } = await mountStep();
    fillSystemPassword(container);
    fireEvent.click(hotspotSwitch());
    expect(hotspotSwitch()).toHaveAttribute("aria-checked", "false");
    expect(connect()).toBeEnabled();

    // Asked before the click, answered after it.
    await land(hotspotRead, { ssid: "Kitchen-AP", enabled: true, active: true });
    // It did land: the hotspot name, which the owner never touched, is the
    // box's now.
    expect(screen.getByText("Kitchen-AP")).toBeInTheDocument();

    expect(hotspotSwitch()).toHaveAttribute("aria-checked", "false");
    expect(container.querySelector("#hotspot-password")).not.toBeInTheDocument();
    expect(connect()).toBeEnabled();
  });

  it("keeps a hotspot name the owner typed when the box's name arrives", async () => {
    const { container } = await mountStep();
    fireEvent.click(opener(container, "hotspot-name-panel"));
    fireEvent.change(field(container, "#hotspot-name"), { target: { value: "Owner-AP" } });

    await land(hotspotRead, { ssid: "Kitchen-AP", enabled: true, active: true });

    expect(field(container, "#hotspot-name").value).toBe("Owner-AP");
    expect(screen.queryByText("Kitchen-AP")).not.toBeInTheDocument();
  });

  it("keeps a device name the owner typed, and still judges the save against the box's name", async () => {
    const { container } = await mountStep();
    fireEvent.click(opener(container, "cred-hostname-panel"));
    fireEvent.change(field(container, "#cred-hostname"), { target: { value: "kitchen" } });

    await land(hostnameRead, { hostname: "clawbox" });
    await land(hotspotRead, { ssid: "ClawBox-Setup", enabled: true, active: true });

    expect(field(container, "#cred-hostname").value).toBe("kitchen");

    fillSystemPassword(container);
    fillHotspotPassword(container);
    fireEvent.click(connect());
    fireEvent.click(screen.getByTestId("writedown-ack"));
    fireEvent.click(screen.getByTestId("writedown-continue"));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/setup-api/system/hostname", body: { hostname: "kitchen" } });
    // The box said "clawbox", so saving "kitchen" is a rename, and the line
    // beside the button says the gateway restarts for it.
    expect(screen.getByTestId("credentials-save-progress")).toHaveTextContent(
      translations.en["credentials.progressRenameRestart"],
    );
  });

  it("still fills every control the owner has not touched", async () => {
    const { container } = await mountStep();
    // Typing a password is not touching the hotspot or the device name.
    fillSystemPassword(container);

    await land(hotspotRead, { ssid: "Kitchen-AP", enabled: false, active: false });
    await land(hostnameRead, { hostname: "kitchen-box" });

    expect(hotspotSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Kitchen-AP")).toBeInTheDocument();
    expect(opener(container, "cred-hostname-panel")).toHaveAccessibleName(/http:\/\/kitchen-box\.local$/);
  });
});
