// Step 3 saves in three requests — device name, system password, hotspot — and
// the password is the second. When the hotspot request after it fails, the
// owner is still on this screen and the box already holds the password they
// typed. From then on the route asks for the current password, which this step
// has no field for: a second Save sent the same body as the first, was answered
// "Current password is required", and the wizard could not be finished.
//
// Held here: a retry does not set a password this mount already set, and when
// the owner changed the field in between it re-proves the one that was saved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import CredentialsStep from "@/components/CredentialsStep";

const STRINGS: Record<string, string> = {
  "credentials.settingsSaved": "Settings saved! Continuing...",
  "credentials.failedSaveHotspot": "Failed to save hotspot settings",
  "credentials.writeDownContinue": "I've saved them — continue",
  "credentials.saveAndContinue": "Save & Continue",
};

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => STRINGS[key] ?? key }),
}));

const SYSTEM_PASSWORD = "Probe1234!";
const OTHER_PASSWORD = "Second5678!";
const HOTSPOT_PASSWORD = "Hotspot-9876";
const HOTSPOT_ERROR = "Hotspot could not be saved";

let fetchMock: ReturnType<typeof vi.fn>;
let hotspotFails: boolean;
let passwordOnBox: string | null;

const jsonBody = (init?: RequestInit) =>
  JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

beforeEach(() => {
  vi.useRealTimers();
  hotspotFails = true;
  passwordOnBox = null;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      if (url === "/setup-api/system/credentials") {
        // The route's own rule: once a password exists, the current one is
        // required and has to match.
        const body = jsonBody(init);
        if (passwordOnBox !== null) {
          if (!body.currentPassword) {
            return { ok: false, status: 400, json: async () => ({ error: "Current password is required" }) } as Response;
          }
          if (body.currentPassword !== passwordOnBox) {
            return { ok: false, status: 401, json: async () => ({ error: "Current password is incorrect" }) } as Response;
          }
        }
        passwordOnBox = String(body.password);
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (url === "/setup-api/system/hotspot") {
        return hotspotFails
          ? ({ ok: false, status: 500, json: async () => ({ error: HOTSPOT_ERROR }) } as Response)
          : ({ ok: true, json: async () => ({ success: true, apRestarted: false }) } as Response);
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
});

function field(container: HTMLElement, selector: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`missing field: ${selector}`);
  return el;
}

function setSystemPassword(container: HTMLElement, value: string) {
  fireEvent.change(field(container, "#cred-password"), { target: { value } });
  fireEvent.change(field(container, "#cred-confirm"), { target: { value } });
}

const posts = (path: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => String(input) === path && (init as RequestInit | undefined)?.method === "POST",
  );

/** Press Save, confirm the write-down, and wait for the n-th hotspot request. */
async function save(hotspotPostNumber: number) {
  fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));
  fireEvent.click(screen.getByTestId("writedown-ack"));
  fireEvent.click(screen.getByTestId("writedown-continue"));
  await waitFor(() => expect(posts("/setup-api/system/hotspot")).toHaveLength(hotspotPostNumber));
}

/** Mount the step, fill it, and run the save whose hotspot request fails. */
async function failFirstSave() {
  const utils = render(<CredentialsStep onNext={vi.fn()} />);
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/hostname", expect.any(Object));
  });
  setSystemPassword(utils.container, SYSTEM_PASSWORD);
  if (!utils.container.querySelector("#hotspot-password")) {
    fireEvent.click(utils.container.querySelector<HTMLButtonElement>('[aria-controls="hotspot-secret-panel"]')!);
  }
  fireEvent.change(field(utils.container, "#hotspot-password"), { target: { value: HOTSPOT_PASSWORD } });
  fireEvent.change(field(utils.container, "#hotspot-confirm"), { target: { value: HOTSPOT_PASSWORD } });

  await save(1);
  await waitFor(() => expect(screen.getByText(HOTSPOT_ERROR)).toBeInTheDocument());
  expect(passwordOnBox).toBe(SYSTEM_PASSWORD);
  return utils;
}

describe("Step 3 — saving again after the password went through", () => {
  it("does not set the same password a second time", async () => {
    await failFirstSave();
    hotspotFails = false;

    await save(2);

    await waitFor(() => expect(screen.getByText("Settings saved! Continuing...")).toBeInTheDocument());
    expect(posts("/setup-api/system/credentials")).toHaveLength(1);
    expect(screen.queryByText("Current password is required")).toBeNull();
  });

  it("re-proves the saved password when the owner changed the field", async () => {
    const { container } = await failFirstSave();
    hotspotFails = false;
    setSystemPassword(container, OTHER_PASSWORD);

    await save(2);

    await waitFor(() => expect(screen.getByText("Settings saved! Continuing...")).toBeInTheDocument());
    const credentialPosts = posts("/setup-api/system/credentials");
    expect(credentialPosts).toHaveLength(2);
    expect(jsonBody(credentialPosts[1][1] as RequestInit)).toEqual({
      password: OTHER_PASSWORD,
      currentPassword: SYSTEM_PASSWORD,
    });
    expect(passwordOnBox).toBe(OTHER_PASSWORD);
  });

  it("still sends a first password on its own", async () => {
    await failFirstSave();

    expect(jsonBody(posts("/setup-api/system/credentials")[0][1] as RequestInit)).toEqual({
      password: SYSTEM_PASSWORD,
    });
  });
});
