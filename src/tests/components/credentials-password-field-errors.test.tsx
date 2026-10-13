/**
 * Step 3 (Security): a password that is WRONG says so under its own field.
 *
 * `validate` only speaks when Save is pressed, and Save is unavailable while
 * any other field is still empty. So an owner who typed `abc` / `abd` as the
 * system password — too short AND not matching — saw a coloured border and,
 * beside the button, a hint about the HOTSPOT password, which they had not
 * reached yet. Nothing said what was wrong with what they had typed
 * (2026-10-13 smoke test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CredentialsStep from "@/components/CredentialsStep";

// The shipped English catalogue: a message that never reached it must fail
// here rather than render its own key on a real box.
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

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

async function mountStep() {
  const utils = render(<CredentialsStep onNext={vi.fn()} />);
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/system/hostname", expect.any(Object));
  });
  return utils;
}

const type = (container: HTMLElement, id: string, value: string) =>
  fireEvent.change(container.querySelector(`#${id}`)!, { target: { value } });
const reason = () => screen.queryByTestId("credentials-blocked-reason");

const TOO_SHORT = "System password must be at least 8 characters";
const MISMATCH = "System passwords do not match";

describe("Step 3 — a wrong system password is named where it is wrong", () => {
  it("says too short under the password and no match under the repeat", async () => {
    const { container } = await mountStep();
    type(container, "cred-password", "abc");
    type(container, "cred-confirm", "abd");

    expect(screen.getByTestId("cred-password-error").textContent).toBe(TOO_SHORT);
    expect(screen.getByTestId("cred-confirm-error").textContent).toBe(MISMATCH);
    expect(container.querySelector("#cred-password")!.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector("#cred-confirm")!.getAttribute("aria-describedby")).toBe("cred-confirm-error");
  });

  it("talks about the system password beside the button, not the hotspot one", async () => {
    // The hotspot password is still empty, and that used to be the only thing
    // the hint mentioned.
    const { container } = await mountStep();
    type(container, "cred-password", "abc");
    type(container, "cred-confirm", "abd");

    expect(reason()?.textContent).toBe(TOO_SHORT);
    expect(reason()?.textContent).not.toMatch(/hotspot/i);

    // Long enough now, still not matching: the hint follows.
    type(container, "cred-password", "long-enough-1");
    type(container, "cred-confirm", "long-enough-2");
    expect(screen.queryByTestId("cred-password-error")).toBeNull();
    expect(reason()?.textContent).toBe(MISMATCH);
  });

  it("does not call a repeat that is still being typed a mismatch", async () => {
    const { container } = await mountStep();
    type(container, "cred-password", "long-enough-1");
    type(container, "cred-confirm", "long-en");
    expect(screen.queryByTestId("cred-confirm-error")).toBeNull();
    type(container, "cred-confirm", "long-ex");
    expect(screen.getByTestId("cred-confirm-error").textContent).toBe(MISMATCH);
  });

  it("clears every message once the passwords are right, and goes back to the hotspot hint", async () => {
    const { container } = await mountStep();
    type(container, "cred-password", "abc");
    type(container, "cred-confirm", "abd");
    type(container, "cred-password", "system-secret-1");
    type(container, "cred-confirm", "system-secret-1");

    expect(screen.queryByTestId("cred-password-error")).toBeNull();
    expect(screen.queryByTestId("cred-confirm-error")).toBeNull();
    expect(reason()?.textContent).toMatch(/hotspot password/i);
  });

  it("says the same under the hotspot fields", async () => {
    const { container } = await mountStep();
    type(container, "hotspot-password", "abc");
    type(container, "hotspot-confirm", "abd");
    expect(screen.getByTestId("hotspot-password-error").textContent).toBe("Hotspot password must be at least 8 characters");
    expect(screen.getByTestId("hotspot-confirm-error").textContent).toBe("Hotspot passwords do not match");
  });
});
