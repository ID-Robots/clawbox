// A hotspot save whose AP toggle THREW is saved, not applied. The route used to
// answer that with the same bytes as a deliberate deferral —
// `{ success: true, apRestarted: false }` — so Step 3 showed "Settings saved!"
// and walked the customer on to the next step, leaving a box whose hotspot is
// not in the state they just asked for and nothing anywhere that says so.
//
// These hold the two halves in place: the failure is SHOWN, in the route's own
// words, and the step does not advance past it on a timer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import CredentialsStep from "@/components/CredentialsStep";

const STRINGS: Record<string, string> = {
  "credentials.handoffTitle": "Applying your settings",
  "credentials.handoffDesc": "Waiting for this ClawBox to answer again",
  "credentials.handoffApplying": "Applying",
  "settings.waitingOnline": "Waiting",
  "settings.backOnline": "Back online",
  "credentials.settingsSaved": "Settings saved! Continuing...",
  "credentials.failedSaveHotspot": "Failed to save hotspot settings",
  "credentials.writeDownContinue": "I've saved them — continue",
  "settings.connect": "Connect",
  continue: "Continue",
};

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => STRINGS[key] ?? key }),
}));

const SYSTEM_PASSWORD = "Probe1234!";
const HOTSPOT_PASSWORD = "Hotspot-9876";
const AP_WARNING =
  "Your hotspot settings were saved, but this ClawBox could not restart its "
  + "hotspot. The new settings apply the next time it starts.";

let fetchMock: ReturnType<typeof vi.fn>;
let originalLocation: PropertyDescriptor | null = null;
let hotspotPostBody: Record<string, unknown>;

beforeEach(() => {
  vi.useRealTimers();
  hotspotPostBody = { success: true, apRestarted: false, apAction: "failed", warning: AP_WARNING };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      if (url === "/setup-api/system/hotspot") {
        return { ok: true, json: async () => hotspotPostBody } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }
    if (url === "/setup-api/system/hotspot") {
      return { ok: true, json: async () => ({ ssid: "ClawBox-Setup", enabled: true }) } as Response;
    }
    if (url === "/setup-api/system/hostname") {
      return { ok: true, json: async () => ({ hostname: "clawbox" }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // `vi.unstubAllGlobals` does not reach a defineProperty on window.location,
  // and a leaked origin would silently change what the NEXT test's save decides.
  if (originalLocation) Object.defineProperty(window, "location", originalLocation);
  originalLocation = null;
});

function field(container: HTMLElement, selector: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`missing field: ${selector}`);
  return el;
}

/** Fill Step 3 and take it all the way through the write-down dialog. */
async function saveStep(onNext: () => void, hostname?: string) {
  const { container } = render(<CredentialsStep onNext={onNext} />);
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/hostname", expect.any(Object));
  });

  if (hostname) {
    const nameDiscloser = container.querySelector<HTMLButtonElement>('[aria-controls="cred-hostname-panel"]');
    if (nameDiscloser) fireEvent.click(nameDiscloser);
    const nameField = container.querySelector<HTMLInputElement>("#cred-hostname");
    if (nameField) fireEvent.change(nameField, { target: { value: hostname } });
  }
  fireEvent.change(field(container, "#cred-password"), { target: { value: SYSTEM_PASSWORD } });
  fireEvent.change(field(container, "#cred-confirm"), { target: { value: SYSTEM_PASSWORD } });
  const discloser = container.querySelector<HTMLButtonElement>('[aria-controls="hotspot-secret-panel"]');
  if (!discloser) throw new Error("hotspot secret disclosure missing");
  fireEvent.click(discloser);
  fireEvent.change(field(container, "#hotspot-password"), { target: { value: HOTSPOT_PASSWORD } });
  fireEvent.change(field(container, "#hotspot-confirm"), { target: { value: HOTSPOT_PASSWORD } });

  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByTestId("writedown-ack"));
  fireEvent.click(screen.getByTestId("writedown-continue"));

  await waitFor(() => {
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/setup-api/system/hotspot"
          && (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(true);
  });
}

describe("Step 3 — a hotspot save whose AP toggle failed", () => {
  it("shows the route's warning instead of 'Settings saved!'", async () => {
    await saveStep(vi.fn());
    await waitFor(() => expect(screen.getByText(AP_WARNING)).toBeInTheDocument());
    expect(screen.queryByText("Settings saved! Continuing...")).toBeNull();
  });

  it("does not walk the customer past the message", async () => {
    const onNext = vi.fn();
    await saveStep(onNext);
    await waitFor(() => expect(screen.getByText(AP_WARNING)).toBeInTheDocument());
    // The success path advances on a 1.5s timer; this one must not.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(onNext).not.toHaveBeenCalled();
  });

  it("carries the warning into the reconnect when the device was also renamed", async () => {
    // The one combination where the message would otherwise be lost: this
    // origin is about to stop answering, so the reconnect cannot wait for the
    // customer to read something on a page the box is leaving. It rides along
    // in the overlay instead — the instruction slot is free precisely here,
    // because a toggle that threw restarted no AP and there is no network to
    // rejoin.
    // The step only offers a handoff for a same-scheme, same-port *.local
    // rename, so every field that guard reads has to be present.
    originalLocation = Object.getOwnPropertyDescriptor(window, "location") ?? null;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        protocol: "http:",
        port: "",
        hostname: "clawbox.local",
        host: "clawbox.local",
        origin: "http://clawbox.local",
        href: "http://clawbox.local/setup",
        replace: vi.fn(),
        assign: vi.fn(),
      },
    });
    await saveStep(vi.fn(), "newname");
    // The overlay, not the inline status: proof this went down the handoff path
    // rather than passing for the ordinary reason.
    await waitFor(() => expect(screen.getByText("Applying your settings")).toBeInTheDocument());
    expect(screen.getByText(AP_WARNING)).toBeInTheDocument();
  });

  it("still reports a deferral as a clean save", async () => {
    // The deliberate hold-off — the radio is a client, so bouncing the AP would
    // sever this very connection — is not a failure and must not read as one.
    hotspotPostBody = { success: true, apRestarted: false, apAction: "deferred" };
    await saveStep(vi.fn());
    await waitFor(() =>
      expect(screen.getByText("Settings saved! Continuing...")).toBeInTheDocument(),
    );
  });
});
