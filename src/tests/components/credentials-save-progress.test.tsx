// What the Security step says WHILE it saves (TASK-1198).
//
// It used to say "Saving..." and nothing else, through a gateway restart and a
// hotspot restart that took the owner's connection with it — and through saves
// that restarted nothing at all. So each request now names what it is doing,
// and a restart is named only when the save really makes one: a device that is
// actually renamed (the hostname route leaves the gateway alone otherwise), and
// a hotspot the radio is actually hosting (the hotspot route defers the
// restart while the radio is a Wi-Fi client).
//
// The strings are the translation keys themselves, so what is asserted is
// which line was chosen, not how English words it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import CredentialsStep from "@/components/CredentialsStep";

const STRINGS: Record<string, string> = {
  "credentials.saveAndContinue": "Save & Continue",
  "credentials.writeDownContinue": "I've saved them — continue",
};

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => STRINGS[key] ?? key }),
}));

const SYSTEM_PASSWORD = "Probe1234!";
const HOTSPOT_PASSWORD = "Hotspot-9876";

type Pending = { url: string; resolve: (body: Record<string, unknown>) => void };

let pending: Pending[];
let hotspotRead: Record<string, unknown>;
let hostnameRead: Record<string, unknown>;

beforeEach(() => {
  vi.useRealTimers();
  pending = [];
  hotspotRead = { ssid: "ClawBox-Setup", enabled: true, active: true, blockedBy: null };
  hostnameRead = { hostname: "clawbox" };
  // Every POST waits for the test to answer it, so the line on screen can be
  // read while each request is in flight.
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      return new Promise<Response>((resolve) => {
        pending.push({
          url,
          resolve: (body) => resolve({ ok: true, json: async () => body } as Response),
        });
      });
    }
    if (url === "/setup-api/system/hotspot") {
      return Promise.resolve({ ok: true, json: async () => hotspotRead } as Response);
    }
    if (url === "/setup-api/system/hostname") {
      return Promise.resolve({ ok: true, json: async () => hostnameRead } as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function field(container: HTMLElement, selector: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`missing field: ${selector}`);
  return el;
}

/** Fill the step, confirm the write-down, and stop at the first request. */
async function startSave(options: { hostname?: string; hermes?: boolean; hotspotOff?: boolean } = {}) {
  const { container } = render(<CredentialsStep onNext={vi.fn()} hermes={options.hermes} />);
  // Both mount-time reads have landed before anything is typed: what the save
  // says is judged against them.
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  if (options.hostname) {
    const nameDiscloser = container.querySelector<HTMLButtonElement>('[aria-controls="cred-hostname-panel"]');
    if (nameDiscloser) fireEvent.click(nameDiscloser);
    fireEvent.change(field(container, "#cred-hostname"), { target: { value: options.hostname } });
  }
  fireEvent.change(field(container, "#cred-password"), { target: { value: SYSTEM_PASSWORD } });
  fireEvent.change(field(container, "#cred-confirm"), { target: { value: SYSTEM_PASSWORD } });
  if (options.hotspotOff) {
    fireEvent.click(screen.getByRole("switch"));
  } else {
    if (!container.querySelector("#hotspot-password")) {
      const discloser = container.querySelector<HTMLButtonElement>('[aria-controls="hotspot-secret-panel"]');
      if (discloser) fireEvent.click(discloser);
    }
    fireEvent.change(field(container, "#hotspot-password"), { target: { value: HOTSPOT_PASSWORD } });
    fireEvent.change(field(container, "#hotspot-confirm"), { target: { value: HOTSPOT_PASSWORD } });
  }

  fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));
  fireEvent.click(screen.getByTestId("writedown-ack"));
  fireEvent.click(screen.getByTestId("writedown-continue"));
  await waitFor(() => expect(pending).toHaveLength(1));
}

/** The progress line, once it says `key`. */
async function expectProgress(key: string) {
  await waitFor(() => expect(screen.getByTestId("credentials-save-progress")).toHaveTextContent(key));
  expect(screen.getByTestId("credentials-save-progress")).toHaveAttribute("role", "status");
}

/** Answer the request in flight, and wait for the next one to start. */
async function answer(url: string, body: Record<string, unknown>, next = true) {
  const request = pending.shift();
  expect(request?.url).toBe(url);
  request?.resolve(body);
  if (next) await waitFor(() => expect(pending).toHaveLength(1));
}

describe("Security step — what it says while it saves", () => {
  it("names each request in turn, and a restart only where one happens", async () => {
    await startSave({ hostname: "kitchen" });

    // Renamed: the gateway really restarts for the new origin.
    await expectProgress("credentials.progressRenameRestart");
    await answer("/setup-api/system/hostname", { success: true, changed: true, gatewayRestarted: true });

    await expectProgress("credentials.progressPassword");
    await answer("/setup-api/system/credentials", { success: true });

    // The radio is hosting the hotspot right now, so the save restarts it.
    await expectProgress("credentials.progressHotspotRestart");
    await answer("/setup-api/system/hotspot", { success: true, apRestarted: false, apAction: "deferred" }, false);

    // Done: the line goes with the spinner.
    await waitFor(() => expect(screen.queryByTestId("credentials-save-progress")).toBeNull());
  });

  it("does not claim a gateway restart for the name the device already has", async () => {
    await startSave();
    await expectProgress("credentials.progressHostname");
  });

  it("does not claim a gateway restart on Hermes, which has no OpenClaw gateway", async () => {
    await startSave({ hostname: "kitchen", hermes: true });
    await expectProgress("credentials.progressHostname");
  });

  it("does not claim a rename it cannot judge, when the name could not be read", async () => {
    hostnameRead = {};
    await startSave({ hostname: "kitchen" });
    await expectProgress("credentials.progressHostname");
  });

  it("says the hotspot settings wait for the next start while the radio is a Wi-Fi client", async () => {
    hotspotRead = { ssid: "ClawBox-Setup", enabled: true, active: false, blockedBy: "HomeWiFi" };
    await startSave();
    await answer("/setup-api/system/hostname", { success: true });
    await answer("/setup-api/system/credentials", { success: true });
    await expectProgress("credentials.progressHotspotDeferred");
  });

  it("says only 'saving' for a hotspot whose radio state it could not read", async () => {
    // An older server's read: no `active` field, so no restart is promised.
    hotspotRead = { ssid: "ClawBox-Setup", enabled: true };
    await startSave();
    await answer("/setup-api/system/hostname", { success: true });
    await answer("/setup-api/system/credentials", { success: true });
    await expectProgress("credentials.progressHotspot");
  });

  it("says the hotspot is being turned off when the owner switched it off", async () => {
    await startSave({ hotspotOff: true });
    await answer("/setup-api/system/hostname", { success: true });
    await answer("/setup-api/system/credentials", { success: true });
    await expectProgress("credentials.progressHotspotStop");
  });
});
