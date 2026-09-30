import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@/tests/helpers/test-utils";
import LoginPage from "@/app/login/page";

/**
 * The login page's error line against the REAL I18nProvider, whose catalogue
 * is a lazy chunk. A password answered before that chunk arrived used to be
 * translated on the spot — into the raw key, since there was no copy yet — and
 * kept that way, so "login.incorrectPassword" stayed on screen while every
 * other line re-rendered in English (the e2e-install login spec caught it on a
 * slow CI box). The line is a key now, translated when it is drawn.
 */
vi.mock("next/image", () => ({
  default: () => null,
}));

// Held until the test lets it through: the wrong password is answered while
// the page still has no copy, the race a fast click on a slow box loses.
const catalogue = vi.hoisted(() => {
  let release = () => {};
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrived, release: () => release() };
});

vi.mock("@/lib/translations", async () => {
  await catalogue.arrived;
  return {
    translations: {
      en: {
        "login.subtitle": "Enter your password to continue",
        "login.incorrectPassword": "Incorrect password",
      },
    },
  };
});

function answer(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function stubServer(login: { body: unknown; status: number }) {
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url === "/setup-api/setup/status") return answer({ setup_complete: true, password_configured: true });
    if (url === "/login-api/users") return answer({ multiUser: false });
    if (url === "/login-api" && init?.method === "POST") return answer(login.body, login.status);
    // The saved-language read: nothing saved, so the browser's English.
    return answer({});
  }));
}

async function submitWrongPassword(container: HTMLElement) {
  const input = await waitFor(() => {
    const el = container.querySelector<HTMLInputElement>("#login-password");
    expect(el).not.toBeNull();
    return el!;
  });
  fireEvent.change(input, { target: { value: "definitely-not-the-password" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => {
    expect(fetch).toHaveBeenCalledWith("/login-api", expect.objectContaining({ method: "POST" }));
  });
}

describe("LoginPage error line", () => {
  beforeEach(() => {
    stubServer({ body: { code: "bad_credentials" }, status: 401 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an error answered before the catalogue arrived is drawn in English once it does", async () => {
    const { container } = render(<LoginPage />);
    await submitWrongPassword(container);

    // Answered with no copy loaded yet: the line is there, as the bare key.
    expect(await screen.findByText("login.incorrectPassword")).toBeTruthy();

    catalogue.release();

    // Shorter than the suite's 5 s so a regression reports the missing copy,
    // not a bare test timeout.
    expect(await screen.findByText("Incorrect password", undefined, { timeout: 2_000 })).toBeTruthy();
    expect(screen.queryByText("login.incorrectPassword")).toBeNull();
    expect(screen.getByText("Enter your password to continue")).toBeTruthy();
  });

  it("the server's own sentence is shown as it came, not looked up", async () => {
    stubServer({ body: { error: "Password check is unavailable right now" }, status: 503 });
    catalogue.release();

    const { container } = render(<LoginPage />);
    await submitWrongPassword(container);

    expect(await screen.findByText("Password check is unavailable right now")).toBeTruthy();
  });
});
