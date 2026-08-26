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
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
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
  "credentials.writeDownTitle": "Write these down before you continue",
  "credentials.writeDownLead": "ClawBox shows these in full once — right here.",
  "credentials.writeDownSystem": "System password (sudo & SSH)",
  "credentials.writeDownHotspot": "Hotspot password",
  "credentials.writeDownNetwork": "Network: {ssid}",
  "credentials.writeDownWhy": "Forget it and only a factory reset gets you back in.",
  "credentials.writeDownAck": "I have written these passwords down somewhere safe",
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

function postCalls() {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );
}

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

async function mountStep(hermes = false) {
  const utils = render(<CredentialsStep onNext={vi.fn()} hermes={hermes} />);
  // The step reads the device's current hotspot + hostname on mount; wait for
  // both so the "no POST fired" assertions below can't race the GETs.
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/hostname", expect.any(Object));
  });
  return utils;
}

function field(container: HTMLElement, selector: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`missing field: ${selector}`);
  return el;
}

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
    // The hotspot password is meaningless without the network it opens.
    expect(screen.getByText("Network: ClawBox-Setup")).toBeInTheDocument();
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

  it("wears coral on OpenClaw and the agent's green on Hermes", async () => {
    const openclaw = await mountStep(false);
    fillForm(openclaw.container);
    fireEvent.click(connect());
    let plate = screen.getByTestId("writedown-system-plate");
    expect(plate.className).toContain("--coral-bright");
    expect(plate.className).not.toContain("--agent-live");
    expect(dialog()?.hasAttribute("data-agent")).toBe(false);
    openclaw.unmount();

    const hermes = await mountStep(true);
    fillForm(hermes.container);
    fireEvent.click(connect());
    plate = screen.getByTestId("writedown-system-plate");
    expect(plate.className).toContain("--agent-live");
    expect(plate.className).not.toContain("--coral-bright");
    expect(dialog()?.getAttribute("data-agent")).toBe("hermes");
  });
});
