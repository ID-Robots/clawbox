/**
 * Step 3 (Security), and the two ways it used to strand an owner.
 *
 * The hotspot password and its confirmation are the only fields on this screen
 * with no working default read back from the device, and Connect waits for
 * both. They sat behind a collapsed disclosure whose entire signal was a grey
 * "Minimum 8 characters" — so an owner who filled in the system password twice
 * saw a button that would not move and nothing on screen saying why.
 *
 * Two things are pinned here: the panel holding those fields is OPEN on
 * arrival, and while the button is unavailable the reason for it is rendered
 * beside the button in words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CredentialsStep from "@/components/CredentialsStep";

// The shipped English catalogue, not a hand-written table: a reason string
// that never reached `translations.en` must fail here rather than render its
// own key next to the button on a real box.
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") return { ok: true, json: async () => ({}) } as Response;
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
});

/** Render the step and wait out the two reads it does on mount. */
async function mountStep() {
  const utils = render(<CredentialsStep onNext={vi.fn()} />);
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/hostname", expect.any(Object));
  });
  return utils;
}

const connect = () => screen.getByRole("button", { name: "Connect" });
const reason = () => screen.queryByTestId("credentials-blocked-reason");
const discloser = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[aria-controls="hotspot-secret-panel"]')!;

function fillSystemPassword(container: HTMLElement) {
  fireEvent.change(container.querySelector("#cred-password")!, { target: { value: SYSTEM_PASSWORD } });
  fireEvent.change(container.querySelector("#cred-confirm")!, { target: { value: SYSTEM_PASSWORD } });
}

function fillHotspotPassword(container: HTMLElement) {
  fireEvent.change(container.querySelector("#hotspot-password")!, { target: { value: HOTSPOT_PASSWORD } });
  fireEvent.change(container.querySelector("#hotspot-confirm")!, { target: { value: HOTSPOT_PASSWORD } });
}

describe("Step 3 — the hotspot secret is not hidden behind a chevron", () => {
  it("renders both hotspot password fields without anything being clicked", async () => {
    const { container } = await mountStep();

    expect(container.querySelector("#hotspot-password")).toBeInTheDocument();
    expect(container.querySelector("#hotspot-confirm")).toBeInTheDocument();
    expect(discloser(container)).toHaveAttribute("aria-expanded", "true");
  });

  it("still lets the owner collapse it — it is a disclosure, not a fixture", async () => {
    const { container } = await mountStep();

    fireEvent.click(discloser(container));
    expect(container.querySelector("#hotspot-password")).not.toBeInTheDocument();
    expect(discloser(container)).toHaveAttribute("aria-expanded", "false");
  });

  it("re-opens it once both system passwords are in and it is the last field left", async () => {
    const { container } = await mountStep();
    fireEvent.click(discloser(container));
    expect(container.querySelector("#hotspot-password")).not.toBeInTheDocument();

    fillSystemPassword(container);

    // The only outstanding requirement is now behind that panel, so the panel
    // comes back rather than leaving the button unavailable for a reason the
    // owner would have to go looking for.
    expect(container.querySelector("#hotspot-password")).toBeInTheDocument();
    expect(discloser(container)).toHaveAttribute("aria-expanded", "true");
  });
});

describe("Step 3 — Connect says why it will not move", () => {
  it("names both secrets on an untouched screen", async () => {
    await mountStep();

    expect(connect()).toBeDisabled();
    expect(reason()).toHaveTextContent(translations.en["credentials.blockedBoth"]);
    // The reason is wired to the button, not floating somewhere above it.
    expect(connect()).toHaveAttribute("aria-describedby", "credentials-blocked-reason");
  });

  it("names only the hotspot secret once the system password is in", async () => {
    const { container } = await mountStep();
    fillSystemPassword(container);

    expect(connect()).toBeDisabled();
    expect(reason()).toHaveTextContent(translations.en["credentials.blockedHotspot"]);
  });

  it("names only the system password once the hotspot secret is in", async () => {
    const { container } = await mountStep();
    fillHotspotPassword(container);

    expect(connect()).toBeDisabled();
    expect(reason()).toHaveTextContent(translations.en["credentials.blockedSystem"]);
  });

  it("drops the reason and releases the button when nothing is outstanding", async () => {
    const { container } = await mountStep();
    fillSystemPassword(container);
    fillHotspotPassword(container);

    expect(connect()).not.toBeDisabled();
    expect(reason()).toBeNull();
    expect(connect()).not.toHaveAttribute("aria-describedby");
  });

  it("asks for the system password alone when the hotspot is switched off", async () => {
    const { container } = await mountStep();
    fireEvent.click(screen.getByRole("switch", { name: /enable hotspot/i }));

    // No hotspot means no hotspot secret to ask for — the reason must not name
    // a field the screen is no longer showing.
    expect(reason()).toHaveTextContent(translations.en["credentials.blockedSystem"]);

    fillSystemPassword(container);
    expect(connect()).not.toBeDisabled();
    expect(reason()).toBeNull();
  });
});
