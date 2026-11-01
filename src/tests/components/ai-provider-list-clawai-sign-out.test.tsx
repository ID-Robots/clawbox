/**
 * Signing out of ClawBox AI from the provider list (src/components/AiProviderList.tsx):
 * a two-tap button on the ClawBox AI row while it is signed in — the default's
 * row too, the account the box had no way out of — that posts the sign-out,
 * re-reads the box and tells every other surface, and draws the signed-out
 * state from the box's own answer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import AiProviderList from "@/components/AiProviderList";
import { PROVIDERS_CHANGED_EVENT } from "@/lib/ui-events";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
vi.mock("@/components/AIProviderIcon", () => ({ default: () => <span data-testid="icon" /> }));

const SIGNED_IN = [
  { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai", enabled: true },
  { id: "openai", label: "OpenAI", state: "connected", isDefault: false, section: "ai", enabled: true },
];
/** What the box answers once ClawBox AI is signed out: still the default, with no credential. */
const SIGNED_OUT = [{ ...SIGNED_IN[0], state: "needs-reauth" }, SIGNED_IN[1]];

let signOuts = 0;

function stubBox(opts: { harness?: "openclaw" | "hermes"; refuse?: { status: number; error: string } } = {}) {
  signOuts = 0;
  let signedOut = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("/setup-api/preferences")) return json({});
    if (url.startsWith("/setup-api/providers/status")) {
      return json({ harness: opts.harness ?? "openclaw", providers: signedOut ? SIGNED_OUT : SIGNED_IN, defaultProvider: "clawai", unrunnable: [], degraded: false });
    }
    if (url === "/setup-api/ai-models/clawai/sign-out" && init?.method === "POST") {
      signOuts += 1;
      if (opts.refuse) return json({ error: opts.refuse.error, kind: "still_signed_in" }, opts.refuse.status);
      signedOut = true;
      return json({ signedOut: true, changed: true, gatewayRestarting: false });
    }
    return json({ error: "unexpected" }, 404);
  }));
}

const renderList = () => render(<I18nProvider><AiProviderList /></I18nProvider>);

/** The ClawBox AI row's button, once the English table (a chunk of its own) has named it. */
async function signOutButton(): Promise<HTMLElement> {
  const button = await screen.findByTestId("ai-provider-sign-out-clawai");
  await waitFor(() => expect(button).toHaveTextContent("Sign out of ClawBox AI"));
  return button;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AiProviderList — signing out of ClawBox AI", () => {
  it("offers it on the signed-in ClawBox AI row, the default's included, and on no other row", async () => {
    stubBox();
    renderList();
    await signOutButton();
    expect(screen.getByTestId("ai-provider-default-clawai")).toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-controls-openai").textContent).not.toMatch(/Sign out/);
  });

  it("asks for a second tap, then signs out, re-reads the box, tells the other surfaces, and shows the signed-out row", async () => {
    stubBox();
    const changed = vi.fn();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, changed);
    try {
      renderList();
      const button = await signOutButton();
      fireEvent.click(button);
      expect(button).toHaveTextContent("Sign out — tap again");
      expect(signOuts).toBe(0);
      fireEvent.click(button);
      await waitFor(() => expect(signOuts).toBe(1));
      // The row is the box's answer: still the default, signed out, no button.
      await waitFor(() => expect(screen.queryByTestId("ai-provider-sign-out-clawai")).not.toBeInTheDocument());
      expect(screen.getByTestId("ai-provider-default-clawai")).toBeInTheDocument();
      expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("Signed out of ClawBox AI. Sign in again below to use it.");
      expect(changed).toHaveBeenCalled();
    } finally {
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, changed);
    }
  });

  it("disarms by itself when the second tap does not come", async () => {
    stubBox();
    renderList();
    const button = await signOutButton();
    vi.useFakeTimers();
    fireEvent.click(button);
    expect(button).toHaveTextContent("Sign out — tap again");
    act(() => { vi.advanceTimersByTime(5_100); });
    expect(button).toHaveTextContent("Sign out of ClawBox AI");
    expect(signOuts).toBe(0);
  });

  it("shows the box's refusal in its own words and keeps the row signed in", async () => {
    stubBox({ refuse: { status: 500, error: "The ClawBox AI sign-in could not be removed from the gateway's auth store." } });
    renderList();
    const button = await signOutButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be removed from the gateway's auth store");
    expect(screen.getByTestId("ai-provider-sign-out-clawai")).toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("");
  });

  it("is not offered on the Hermes edition, whose sign-out is not built", async () => {
    stubBox({ harness: "hermes" });
    renderList();
    expect(await screen.findByTestId("ai-provider-clawai")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-sign-out-clawai")).not.toBeInTheDocument();
  });
});
