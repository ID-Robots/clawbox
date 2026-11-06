// Step 3 saves in three requests — device name, system password, hotspot — and
// one catch around them read any "Failed to fetch" as "the hotspot restart
// dropped us, the settings are applied", and handed off to the reconnect
// overlay. On the same origin that overlay calls onNext. So a phone on the
// setup hotspot that dropped the PASSWORD request landed on step 4 with no
// owner password and no session: every later call answered 401 and nothing led
// back to step 3.
//
// Held here: a password request that never came back keeps the owner on this
// step with the error and a Save that works again; the drop the overlay was
// written for (the hotspot request, after the password is saved) still hands
// off and continues.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import CredentialsStep from "@/components/CredentialsStep";

const STRINGS: Record<string, string> = {
  "credentials.saveAndContinue": "Save & Continue",
  "credentials.failedSetPassword": "Failed to set password",
};

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string) => STRINGS[key] ?? key }),
}));

vi.setConfig({ testTimeout: 30_000 });

// Overlay grace (4 s) + one probe + the 1.6 s ready delay, with room to spare.
const HANDOFF_SETTLE_MS = 9_000;

let dropPassword: boolean;
let dropHotspot: boolean;
let passwordOnBox: string | null;
let hotspotPosts: number;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  dropPassword = false;
  dropHotspot = false;
  passwordOnBox = null;
  hotspotPosts = 0;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url === "/setup-api/system/credentials") {
      if (dropPassword) throw new TypeError("Failed to fetch");
      passwordOnBox = String(JSON.parse(String(init.body)).password);
      return { ok: true, json: async () => ({ success: true }) } as Response;
    }
    if (init?.method === "POST" && url === "/setup-api/system/hotspot") {
      hotspotPosts++;
      if (dropHotspot) throw new TypeError("Failed to fetch");
      return { ok: true, json: async () => ({ success: true, apRestarted: false }) } as Response;
    }
    if (init?.method === "POST") return { ok: true, json: async () => ({ success: true, changed: false }) } as Response;
    if (init?.method === "HEAD") return { ok: true, status: 200 } as Response;
    if (url === "/setup-api/system/hotspot") {
      return { ok: true, json: async () => ({ ssid: "ClawBox-Setup", enabled: true, active: false, blockedBy: null }) } as Response;
    }
    if (url === "/setup-api/system/hostname") return { ok: true, json: async () => ({ hostname: "clawbox" }) } as Response;
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderAndSave(onNext: () => void) {
  const view = render(<CredentialsStep onNext={onNext} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/hostname", expect.any(Object)));
  const set = (sel: string, value: string) =>
    fireEvent.change(view.container.querySelector(sel)!, { target: { value } });
  set("#cred-password", "Probe1234!");
  set("#cred-confirm", "Probe1234!");
  if (!view.container.querySelector("#hotspot-password")) {
    fireEvent.click(view.container.querySelector('[aria-controls="hotspot-secret-panel"]')!);
  }
  set("#hotspot-password", "Hotspot-9876");
  set("#hotspot-confirm", "Hotspot-9876");
  const save = () => {
    fireEvent.click(screen.getByRole("button", { name: "Save & Continue" }));
    fireEvent.click(screen.getByTestId("writedown-ack"));
    fireEvent.click(screen.getByTestId("writedown-continue"));
  };
  save();
  return { view, save };
}

it("stays on step 3 with the error when the password request never reached the box", async () => {
  dropPassword = true;
  const onNext = vi.fn();
  const { save } = await renderAndSave(onNext);

  await new Promise((r) => setTimeout(r, HANDOFF_SETTLE_MS));
  expect(onNext).not.toHaveBeenCalled();
  expect(screen.getByText("Failed to set password")).toBeTruthy();
  expect(passwordOnBox).toBeNull();
  expect(hotspotPosts).toBe(0);

  // The connection is back: Save sets the password and the step moves on.
  dropPassword = false;
  save();
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  expect(passwordOnBox).toBe("Probe1234!");
  expect(hotspotPosts).toBe(1);
});

it("still hands off and continues when the hotspot request drops after the password is saved", async () => {
  dropHotspot = true;
  const onNext = vi.fn();
  await renderAndSave(onNext);

  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1), { timeout: HANDOFF_SETTLE_MS + 5_000 });
  expect(passwordOnBox).toBe("Probe1234!");
  expect(screen.queryByText("Failed to set password")).toBeNull();
});
