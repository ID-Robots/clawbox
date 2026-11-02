/**
 * Signing out of a provider from the provider list (src/components/AiProviderList.tsx):
 * a two-tap "Sign out of <Provider>" on EVERY signed-in row, on either
 * harness, that posts the row's sign-out, re-reads the box and tells every
 * other surface, and draws the signed-out state from the box's own answer.
 * The default's sign-out is locked with the switch's hint — except ClawBox
 * AI's, the account a box had no way out of (#1369).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import AiProviderList from "@/components/AiProviderList";
import { PROVIDERS_CHANGED_EVENT } from "@/lib/ui-events";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
vi.mock("@/components/AIProviderIcon", () => ({ default: () => <span data-testid="icon" /> }));

type Row = { id: string; label: string; state: string; isDefault: boolean; section: string; enabled: boolean };

const OPENCLAW_ROWS: Row[] = [
  { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai", enabled: true },
  { id: "openai", label: "OpenAI GPT", state: "connected", isDefault: false, section: "ai", enabled: true },
  { id: "openrouter", label: "OpenRouter", state: "connected", isDefault: false, section: "ai", enabled: false },
  { id: "xai", label: "xAI Grok", state: "connected", isDefault: false, section: "ai", enabled: true },
];
const HERMES_ROWS: Row[] = [
  { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: false, section: "ai", enabled: true },
  { id: "openrouter", label: "OpenRouter", state: "connected", isDefault: true, section: "ai", enabled: true },
  { id: "gemini", label: "Google Gemini", state: "connected", isDefault: false, section: "ai", enabled: true },
];

interface Box {
  posts: { provider: string }[];
  signedOut: Set<string>;
}

function stubBox(opts: { harness?: "openclaw" | "hermes"; rows?: Row[]; refuse?: { status: number; error: string } } = {}): Box {
  const state: Box = { posts: [], signedOut: new Set() };
  const rows = opts.rows ?? OPENCLAW_ROWS;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("/setup-api/preferences")) return json({});
    if (url.startsWith("/setup-api/providers/status")) {
      // What the box answers once a row is signed out: the default stays
      // listed with no credential, any other row is gone from this list.
      const now = rows.flatMap((row) => !state.signedOut.has(row.id)
        ? [row]
        : row.isDefault ? [{ ...row, state: "needs-reauth" }] : [{ ...row, state: "disconnected" }]);
      return json({ harness: opts.harness ?? "openclaw", providers: now, defaultProvider: rows.find((r) => r.isDefault)?.id ?? null, unrunnable: [], degraded: false });
    }
    if (url === "/setup-api/providers/sign-out" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { provider: string };
      state.posts.push(body);
      expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      if (opts.refuse) return json({ error: opts.refuse.error, kind: "still_signed_in" }, opts.refuse.status);
      state.signedOut.add(body.provider);
      return json({ signedOut: true, provider: body.provider, changed: true, gatewayRestarting: false });
    }
    return json({ error: "unexpected" }, 404);
  }));
  return state;
}

const renderList = () => render(<I18nProvider><AiProviderList /></I18nProvider>);

/** A row's button, once the English table (a chunk of its own) has named it. */
async function signOutButton(id: string, label: string): Promise<HTMLElement> {
  const button = await screen.findByTestId(`ai-provider-sign-out-${id}`);
  await waitFor(() => expect(button).toHaveTextContent(`Sign out of ${label}`));
  return button;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AiProviderList — signing out of a provider", () => {
  it("offers it on every signed-in row by its own name — a switched-off one too — and on ClawBox AI's default row", async () => {
    stubBox();
    renderList();
    for (const row of OPENCLAW_ROWS) {
      const button = await signOutButton(row.id, row.label);
      expect(button, row.id).toBeEnabled();
      // Under the name, not among the controls: beside them the name had no
      // room left and "ClawBox AI" drew as "C…".
      expect(screen.getByTestId(`ai-provider-controls-${row.id}`)).not.toContainElement(button);
      expect(screen.getByTestId(`ai-provider-${row.id}`)).toContainElement(button);
    }
    expect(screen.getByTestId("ai-provider-default-clawai")).toBeInTheDocument();
  });

  it("asks for a second tap, then signs THAT row out, re-reads the box, tells the other surfaces, and shows the signed-out list", async () => {
    const box = stubBox();
    const changed = vi.fn();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, changed);
    try {
      renderList();
      const button = await signOutButton("openai", "OpenAI GPT");
      fireEvent.click(button);
      expect(button).toHaveTextContent("Sign out — tap again");
      // Only the tapped row is armed.
      expect(screen.getByTestId("ai-provider-sign-out-xai")).toHaveTextContent("Sign out of xAI Grok");
      expect(box.posts).toEqual([]);
      fireEvent.click(button);
      await waitFor(() => expect(box.posts).toEqual([{ provider: "openai" }]));
      // The list is the box's answer: the OpenAI row has left it.
      await waitFor(() => expect(screen.queryByTestId("ai-provider-openai")).not.toBeInTheDocument());
      expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("Signed out of OpenAI GPT. Sign in again below to use it.");
      expect(screen.getByTestId("ai-provider-xai")).toBeInTheDocument();
      expect(changed).toHaveBeenCalled();
    } finally {
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, changed);
    }
  });

  it("signs ClawBox AI out while it is the default: the row stays the default, signed out, with no button", async () => {
    const box = stubBox();
    renderList();
    const button = await signOutButton("clawai", "ClawBox AI");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(box.posts).toEqual([{ provider: "clawai" }]));
    await waitFor(() => expect(screen.queryByTestId("ai-provider-sign-out-clawai")).not.toBeInTheDocument());
    expect(screen.getByTestId("ai-provider-default-clawai")).toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("Signed out of ClawBox AI. Sign in again below to use it.");
  });

  it("locks the default's sign-out with the switch's hint, and posts nothing", async () => {
    const box = stubBox({ harness: "hermes", rows: HERMES_ROWS });
    renderList();
    const locked = await signOutButton("openrouter", "OpenRouter");
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute("aria-describedby", "ai-provider-locked-openrouter");
    expect(screen.getByTestId("ai-provider-locked-hint-openrouter")).toHaveTextContent("Make another provider the default first.");
    fireEvent.click(locked);
    fireEvent.click(locked);
    expect(box.posts).toEqual([]);
  });

  it("signs out on Hermes too, ClawBox AI and a key provider alike", async () => {
    const box = stubBox({ harness: "hermes", rows: HERMES_ROWS });
    renderList();
    const gemini = await signOutButton("gemini", "Google Gemini");
    fireEvent.click(gemini);
    fireEvent.click(gemini);
    await waitFor(() => expect(box.posts).toEqual([{ provider: "gemini" }]));
    await waitFor(() => expect(screen.queryByTestId("ai-provider-gemini")).not.toBeInTheDocument());
    const clawai = await signOutButton("clawai", "ClawBox AI");
    fireEvent.click(clawai);
    fireEvent.click(clawai);
    await waitFor(() => expect(box.posts).toEqual([{ provider: "gemini" }, { provider: "clawai" }]));
    await waitFor(() => expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("Signed out of ClawBox AI."));
  });

  it("disarms by itself when the second tap does not come", async () => {
    const box = stubBox();
    renderList();
    const button = await signOutButton("xai", "xAI Grok");
    vi.useFakeTimers();
    fireEvent.click(button);
    expect(button).toHaveTextContent("Sign out — tap again");
    act(() => { vi.advanceTimersByTime(5_100); });
    expect(button).toHaveTextContent("Sign out of xAI Grok");
    expect(box.posts).toEqual([]);
  });

  it("moves the arming to the row tapped next, rather than signing out the first", async () => {
    const box = stubBox();
    renderList();
    const openai = await signOutButton("openai", "OpenAI GPT");
    const xai = await signOutButton("xai", "xAI Grok");
    fireEvent.click(openai);
    fireEvent.blur(openai);
    fireEvent.click(xai);
    expect(openai).toHaveTextContent("Sign out of OpenAI GPT");
    expect(xai).toHaveTextContent("Sign out — tap again");
    expect(box.posts).toEqual([]);
  });

  it("shows the box's refusal in its own words and keeps the row signed in", async () => {
    stubBox({ refuse: { status: 500, error: "The OpenAI GPT sign-in could not be removed from the gateway's auth store." } });
    renderList();
    const button = await signOutButton("openai", "OpenAI GPT");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be removed from the gateway's auth store");
    expect(screen.getByTestId("ai-provider-sign-out-openai")).toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("");
  });

  it("is offered on a dead sign-in the box still holds, and not on the default's 'needs sign-in' row", async () => {
    stubBox({ rows: [{ ...OPENCLAW_ROWS[0], state: "needs-reauth" }, { ...OPENCLAW_ROWS[1], state: "needs-reauth" }] });
    renderList();
    await signOutButton("openai", "OpenAI GPT");
    expect(screen.getByTestId("ai-provider-clawai")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-sign-out-clawai")).not.toBeInTheDocument();
  });
});
