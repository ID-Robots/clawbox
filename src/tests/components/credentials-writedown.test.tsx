// Step 3 sets two write-only secrets: the box's system password (sudo and SSH)
// and the setup hotspot's password. Nothing on the device can read either back
// afterwards, so a customer who forgets one is locked out with only a factory
// reset to recover. The save therefore does not fire off the button any more —
// it fires off a deliberate acknowledgement in a dialog that reads the exact
// typed values back.
//
// What these tests hold in place: the dialog stands between a VALID form and
// the FIRST request (cancel must leave the network silent), it shows the exact
// characters typed, it only shows the hotspot secret when the hotspot is on,
// Continue is unavailable until the acknowledgement is given, confirming fires
// the same requests the button used to fire directly, Escape cancels, and the
// accent follows the edition.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import CredentialsStep from "@/components/CredentialsStep";

const STRINGS: Record<string, string> = {
  "credentials.title": "Security",
  "credentials.description": "Set a system password and configure your hotspot.",
  "credentials.systemPassword": "System Password",
  "credentials.newPassword": "New Password",
  "credentials.confirmPassword": "Confirm Password",
  "credentials.hotspotSettings": "Hotspot Settings",
  "credentials.hotspotPassword": "Hotspot Password",
  "credentials.confirmHotspotPassword": "Confirm Hotspot Password",
  "credentials.minChars": "Minimum 8 characters",
  "credentials.passwordsDontMatch": "System passwords do not match",
  "credentials.writeDownTitle": "This is your only key",
  "credentials.writeDownSubline": "Lose it and the box must be factory-reset",
  "credentials.writeDownSystem": "System / sudo password",
  "credentials.writeDownHotspot": "Hotspot",
  "credentials.writeDownAck": "I've stored these somewhere safe",
  "credentials.writeDownContinue": "I've saved them — continue",
  "settings.connect": "Connect",
  back: "Back",
  continue: "Continue",
  copy: "Copy",
  copied: "Copied!",
};

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const raw = STRINGS[key] ?? key;
      if (!params) return raw;
      return Object.entries(params).reduce(
        (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
        raw,
      );
    },
  }),
}));

const SYSTEM_PASSWORD = "Probe1234!";
const HOTSPOT_PASSWORD = "Hotspot-9876";

let fetchMock: ReturnType<typeof vi.fn>;

/** Every request the component actually sent — GETs on mount don't count. */
function postCalls() {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );
}

/** The JSON body the component POSTed to `url`, or null if it never did. */
function postBody(url: string): Record<string, unknown> | null {
  const call = postCalls().find(([input]) => String(input) === url);
  if (!call) return null;
  return JSON.parse(String((call[1] as RequestInit).body));
}

beforeEach(() => {
  vi.useRealTimers();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
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

/** Render Step 3 and wait out the two reads it does on mount. */
async function mountStep(hermes = false) {
  const utils = render(<CredentialsStep onNext={vi.fn()} hermes={hermes} />);
  // The step reads the device's current hotspot + hostname on mount; wait for
  // both so the "no POST fired" assertions below can't race the GETs.
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/hostname", expect.any(Object));
  });
  return utils;
}

/** One of the step's inputs by id, loudly rather than as `null`. */
function field(container: HTMLElement, selector: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`missing field: ${selector}`);
  return el;
}

/** Fill the step the way a customer does, hotspot on unless asked otherwise. */
function fillForm(container: HTMLElement, { hotspot = true } = {}) {
  if (!hotspot) {
    fireEvent.click(screen.getByRole("switch", { name: /enable hotspot/i }));
  }
  fireEvent.change(field(container, "#cred-password"), { target: { value: SYSTEM_PASSWORD } });
  fireEvent.change(field(container, "#cred-confirm"), { target: { value: SYSTEM_PASSWORD } });
  if (hotspot) {
    const discloser = container.querySelector<HTMLButtonElement>(
      '[aria-controls="hotspot-secret-panel"]',
    );
    if (!discloser) throw new Error("hotspot secret disclosure missing");
    fireEvent.click(discloser);
    fireEvent.change(field(container, "#hotspot-password"), {
      target: { value: HOTSPOT_PASSWORD },
    });
    fireEvent.change(field(container, "#hotspot-confirm"), {
      target: { value: HOTSPOT_PASSWORD },
    });
  }
}

const connect = () => screen.getByRole("button", { name: "Connect" });
const dialog = () => screen.queryByTestId("credentials-writedown-dialog");

describe("CredentialsStep write-down confirmation", () => {
  it("interposes the dialog on Connect and sends nothing yet", async () => {
    const { container } = await mountStep();
    fillForm(container);
    fireEvent.click(connect());

    const panel = dialog();
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    expect(panel?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(postCalls()).toHaveLength(0);
  });

  it("reads back the exact characters that were typed", async () => {
    const { container } = await mountStep();
    fillForm(container);
    fireEvent.click(connect());

    expect(screen.getByTestId("writedown-system-value").textContent).toBe(SYSTEM_PASSWORD);
    expect(screen.getByTestId("writedown-hotspot-value").textContent).toBe(HOTSPOT_PASSWORD);
    // The hotspot password is meaningless without the network it opens, so the
    // SSID rides on the card's own label.
    expect(screen.getByTestId("writedown-hotspot-plate")).toHaveTextContent(
      "Hotspot · ClawBox-Setup",
    );
  });

  it("shows the hotspot password only while the hotspot is enabled", async () => {
    const { container } = await mountStep();
    fillForm(container, { hotspot: false });
    fireEvent.click(connect());

    expect(screen.getByTestId("writedown-system-value").textContent).toBe(SYSTEM_PASSWORD);
    expect(screen.queryByTestId("writedown-hotspot-value")).toBeNull();
  });

  it("keeps an invalid form failing at the field, with no dialog in the way", async () => {
    const { container } = await mountStep();
    fillForm(container);
    fireEvent.change(field(container, "#cred-confirm"), { target: { value: "different" } });
    fireEvent.click(connect());

    expect(dialog()).toBeNull();
    expect(screen.getByText("System passwords do not match")).toBeInTheDocument();
    expect(postCalls()).toHaveLength(0);
  });

  it("holds Continue closed until the acknowledgement is given", async () => {
    const { container } = await mountStep();
    fillForm(container);
    fireEvent.click(connect());

    const proceed = screen.getByTestId("writedown-continue") as HTMLButtonElement;
    expect(proceed.disabled).toBe(true);
    // A click on the unavailable button must not slip a request out.
    fireEvent.click(proceed);
    expect(postCalls()).toHaveLength(0);

    fireEvent.click(screen.getByTestId("writedown-ack"));
    expect(proceed.disabled).toBe(false);
  });

  it("cancel returns to the untouched form and fires nothing", async () => {
    const { container } = await mountStep();
    fillForm(container);
    fireEvent.click(connect());
    fireEvent.click(screen.getByTestId("writedown-cancel"));

    expect(dialog()).toBeNull();
    expect(postCalls()).toHaveLength(0);
    expect(field(container, "#cred-password").value).toBe(SYSTEM_PASSWORD);
    expect(field(container, "#hotspot-password").value).toBe(HOTSPOT_PASSWORD);
    // And the form is still submittable: cancelling is not a dead end.
    expect(connect()).toBeEnabled();
  });

  it("Escape cancels the dialog without saving", async () => {
    const { container } = await mountStep();
    fillForm(container);
    fireEvent.click(connect());
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(dialog()).toBeNull());
    expect(postCalls()).toHaveLength(0);
  });

  it("continuing fires exactly the requests the button used to fire", async () => {
    const { container } = await mountStep();
    fillForm(container);
    fireEvent.click(connect());
    fireEvent.click(screen.getByTestId("writedown-ack"));
    fireEvent.click(screen.getByTestId("writedown-continue"));

    await waitFor(() => {
      expect(postBody("/setup-api/system/credentials")).toEqual({ password: SYSTEM_PASSWORD });
    });
    await waitFor(() => {
      expect(postBody("/setup-api/system/hotspot")).toEqual({
        ssid: "ClawBox-Setup",
        password: HOTSPOT_PASSWORD,
        enabled: true,
      });
    });
    expect(postBody("/setup-api/system/hostname")).toEqual({ hostname: "clawbox" });
    expect(dialog()).toBeNull();
  });

  it("saves what was acknowledged, not a device read that lands mid-dialog", async () => {
    // The step reads the box's real hotspot settings on mount. That read is the
    // one writer of this state the customer does not control, and the dialog
    // puts a human-length pause in front of the save — so a slow read could
    // land between "here is your hotspot password for ClawBox-Setup" and the
    // request, and rename the network or switch the hotspot off entirely.
    let landDeviceRead!: (value: unknown) => void;
    const deviceRead = new Promise((resolve) => {
      landDeviceRead = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") return { ok: true, json: async () => ({}) } as Response;
      if (url === "/setup-api/system/hotspot") {
        return { ok: true, json: () => deviceRead } as unknown as Response;
      }
      if (url === "/setup-api/system/hostname") {
        return { ok: true, json: async () => ({ hostname: "clawbox" }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });

    const { container } = await mountStep();
    fillForm(container);
    fireEvent.click(connect());
    expect(screen.getByTestId("writedown-hotspot-plate")).toHaveTextContent(
      "Hotspot · ClawBox-Setup",
    );

    // The read lands while the customer is still writing things down.
    await act(async () => {
      landDeviceRead({ ssid: "Renamed-AP", enabled: false });
    });

    fireEvent.click(screen.getByTestId("writedown-ack"));
    fireEvent.click(screen.getByTestId("writedown-continue"));

    await waitFor(() => {
      expect(postBody("/setup-api/system/hotspot")).toEqual({
        ssid: "ClawBox-Setup",
        password: HOTSPOT_PASSWORD,
        enabled: true,
      });
    });
  });

  it("wears coral on OpenClaw and the agent's green on Hermes", async () => {
    const openclaw = await mountStep(false);
    fillForm(openclaw.container);
    fireEvent.click(connect());
    expect(dialog()?.hasAttribute("data-agent")).toBe(false);
    let proceed = screen.getByTestId("writedown-continue");
    expect(proceed.getAttribute("style")).toContain("--coral-bright");
    expect(proceed.getAttribute("style")).not.toContain("rgb(18, 214, 164)");
    openclaw.unmount();

    const hermes = await mountStep(true);
    fillForm(hermes.container);
    fireEvent.click(connect());
    expect(dialog()?.getAttribute("data-agent")).toBe("hermes");
    proceed = screen.getByTestId("writedown-continue");
    expect(proceed.getAttribute("style")).toContain("rgb(18, 214, 164)");
    expect(proceed.getAttribute("style")).not.toContain("--coral-bright");
  });

  it("tells a screen reader when a password has been copied", async () => {
    // The button's label flipping to "Copied!" is a visual confirmation only:
    // nothing announces a text change inside a control the reader is not on.
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    const { container } = await mountStep();
    fillForm(container);
    fireEvent.click(connect());

    const live = screen
      .getByTestId("writedown-system-plate")
      .querySelector('[role="status"]');
    expect(live).not.toBeNull();
    expect(live?.getAttribute("aria-live")).toBe("polite");
    // Mounted and empty before the copy — a region that appears with its
    // message already in it is not reliably announced.
    expect(live?.textContent).toBe("");

    fireEvent.click(screen.getByTestId("writedown-system-copy"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(SYSTEM_PASSWORD);
    });
    await waitFor(() => {
      expect(live?.textContent).toContain("Copied!");
    });
  });

  it("keeps the danger band red on both editions — it is not the brand accent", async () => {
    // The band names the stake. Repainting it in the SKU's colour would make it
    // read as decoration, which is the one thing this screen must not be.
    const openclaw = await mountStep(false);
    fillForm(openclaw.container);
    fireEvent.click(connect());
    const coralBand = screen.getByTestId("writedown-danger-band").getAttribute("style") ?? "";
    expect(coralBand).toContain("255, 95, 82");
    openclaw.unmount();

    const hermes = await mountStep(true);
    fillForm(hermes.container);
    fireEvent.click(connect());
    const hermesBand = screen.getByTestId("writedown-danger-band").getAttribute("style") ?? "";
    expect(hermesBand).toContain("255, 95, 82");
    expect(hermesBand).not.toContain("rgb(18, 214, 164)");
  });
});
