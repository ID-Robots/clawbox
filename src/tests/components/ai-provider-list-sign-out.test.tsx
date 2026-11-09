/**
 * Signing out of a provider from the provider list (src/components/AiProviderList.tsx):
 * a two-tap "Sign out" on EVERY signed-in row — named "Sign out of <Provider>"
 * for assistive tech and in its tooltip — on either
 * harness, that posts the row's sign-out, re-reads the box and tells every
 * other surface, and draws the signed-out state from the box's own answer.
 * The default's sign-out is locked with the switch's hint — except ClawBox
 * AI's on OpenClaw, the account a box had no way out of (#1369). On Hermes
 * ClawBox AI's is locked like any default's.
 *
 * The sign-out is the box's background task (TASK-2148): the POST answers 202
 * with it, and the list follows it at /setup-api/background-jobs/tasks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import AiProviderList from "@/components/AiProviderList";
import { PROVIDERS_CHANGED_EVENT, notifyProvidersChanged } from "@/lib/ui-events";
import { providerTask } from "@/tests/helpers/provider-task";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
vi.mock("@/components/AIProviderIcon", () => ({ default: () => <span data-testid="icon" /> }));

type Row = { id: string; label: string; state: string; isDefault: boolean; section: string; enabled: boolean; credentialHeld?: boolean };

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
  /** What the status answers for rows not signed out here; a test may change it. */
  rows: Row[];
  /** The box's provider tasks, by id. */
  tasks: Map<string, Record<string, unknown>>;
}

function stubBox(opts: {
  harness?: "openclaw" | "hermes";
  rows?: Row[];
  refuse?: { status: number; error: string };
  /** The sign-out starts, and its task fails with this sentence. */
  failTask?: string;
  answer?: Promise<void>;
  /** The owner's UI language, as the I18nProvider reads it. */
  locale?: string;
} = {}): Box {
  const state: Box = { posts: [], signedOut: new Set(), rows: opts.rows ?? OPENCLAW_ROWS, tasks: new Map() };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("/setup-api/preferences")) return json(opts.locale ? { ui_language: opts.locale } : {});
    if (url.startsWith("/setup-api/providers/status")) {
      // What the box answers once a row is signed out: the default stays
      // listed with no credential, any other row is gone from this list.
      const rows = state.rows;
      const now = rows.flatMap((row) => !state.signedOut.has(row.id)
        ? [row]
        : row.isDefault ? [{ ...row, state: "needs-reauth" }] : [{ ...row, state: "disconnected" }]);
      return json({ harness: opts.harness ?? "openclaw", providers: now, defaultProvider: rows.find((r) => r.isDefault)?.id ?? null, unrunnable: [], degraded: false });
    }
    if (url === "/setup-api/providers/sign-out" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { provider: string };
      state.posts.push(body);
      await opts.answer;
      expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      if (opts.refuse) return json({ error: opts.refuse.error, kind: "is_default" }, opts.refuse.status);
      const id = `task-${state.posts.length}`;
      const label = state.rows.find((row) => row.id === body.provider)?.label ?? body.provider;
      if (opts.failTask) {
        state.tasks.set(id, providerTask(id, { provider: body.provider, label, state: "failed", error: opts.failTask }));
      } else {
        state.signedOut.add(body.provider);
        state.tasks.set(id, providerTask(id, { provider: body.provider, label, state: "succeeded" }));
      }
      return json({ taskId: id, started: true, task: state.tasks.get(id) }, 202);
    }
    if (url.startsWith("/setup-api/background-jobs/tasks")) {
      const id = new URL(url, "http://box").searchParams.get("id");
      if (id) return state.tasks.has(id) ? json({ task: state.tasks.get(id) }) : json({ error: "No such task." }, 404);
      return json({ tasks: [...state.tasks.values()] });
    }
    return json({ error: "unexpected" }, 404);
  }));
  return state;
}

const renderList = () => render(<I18nProvider><AiProviderList /></I18nProvider>);

/**
 * A row's button, by its role and the name assistive tech reads — once the
 * English table (a chunk of its own) has named it — and on the row it belongs to.
 */
async function signOutButton(id: string, label: string): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: `Sign out of ${label}` }, { timeout: 5_000 });
  expect(button).toHaveAttribute("data-testid", `ai-provider-sign-out-${id}`);
  return button;
}

/** A button at rest: the bare verb on it, the provider in its name and tooltip. */
function expectAtRest(button: HTMLElement, label: string) {
  expect(button).toHaveTextContent(/^Sign out$/);
  expect(button).toHaveAccessibleName(`Sign out of ${label}`);
  expect(button).toHaveAttribute("title", `Sign out of ${label}`);
}

function classes(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
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
      expectAtRest(button, row.label);
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
      // Armed, it still says whose sign-in it is about to remove.
      expect(button).toHaveAccessibleName("Sign out of OpenAI GPT — tap again");
      expect(button).toHaveAttribute("title", "Sign out of OpenAI GPT — tap again");
      // Only the tapped row is armed.
      expectAtRest(screen.getByTestId("ai-provider-sign-out-xai"), "xAI Grok");
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

  it("locks ClawBox AI's sign-out too while it is Hermes' default — #1369's exception is OpenClaw's", async () => {
    const box = stubBox({
      harness: "hermes",
      rows: [{ ...HERMES_ROWS[0], isDefault: true }, { ...HERMES_ROWS[1], isDefault: false }, HERMES_ROWS[2]],
    });
    renderList();
    const locked = await signOutButton("clawai", "ClawBox AI");
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute("aria-describedby", "ai-provider-locked-clawai");
    expect(screen.getByTestId("ai-provider-locked-hint-clawai")).toHaveTextContent("Make another provider the default first.");
    fireEvent.click(locked);
    fireEvent.click(locked);
    expect(box.posts).toEqual([]);
    // The provider that is not the default stays offered.
    expect(await signOutButton("openrouter", "OpenRouter")).toBeEnabled();
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
    expectAtRest(button, "xAI Grok");
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
    expectAtRest(openai, "OpenAI GPT");
    expect(xai).toHaveTextContent("Sign out — tap again");
    expect(box.posts).toEqual([]);
  });

  it("shows the box's refusal in its own words and keeps the row signed in", async () => {
    stubBox({ failTask: "The OpenAI GPT sign-in could not be removed from the gateway's auth store." });
    renderList();
    const button = await signOutButton("openai", "OpenAI GPT");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be removed from the gateway's auth store");
    expect(screen.getByTestId("ai-provider-sign-out-openai")).toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("");
  });

  it("shows a refusal the box answers at once, before any task, the same way", async () => {
    const box = stubBox({ refuse: { status: 409, error: "OpenAI GPT is the default provider. Make another provider the default first, then sign out of it." } });
    renderList();
    const button = await signOutButton("openai", "OpenAI GPT");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("is the default provider");
    expect(screen.getByTestId("ai-provider-sign-out-openai")).toBeEnabled();
    expect(box.tasks.size).toBe(0);
  });

  it("is offered on a dead sign-in the box still holds, and not on the default's 'needs sign-in' row", async () => {
    stubBox({ rows: [{ ...OPENCLAW_ROWS[0], state: "needs-reauth" }, { ...OPENCLAW_ROWS[1], state: "needs-reauth" }] });
    renderList();
    await signOutButton("openai", "OpenAI GPT");
    expect(screen.getByTestId("ai-provider-clawai")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-sign-out-clawai")).not.toBeInTheDocument();
  });
  it("offers the sign-out of a refused token on the default ClawBox AI row, not of a default left with nothing", async () => {
    stubBox({ rows: [{ ...OPENCLAW_ROWS[0], state: "needs-reauth", credentialHeld: true }, OPENCLAW_ROWS[1]] });
    renderList();
    expect(await signOutButton("clawai", "ClawBox AI")).toBeEnabled();
    cleanup();
    stubBox({ rows: [{ ...OPENCLAW_ROWS[0], state: "needs-reauth", credentialHeld: false }, OPENCLAW_ROWS[1]] });
    renderList();
    await signOutButton("openai", "OpenAI GPT");
    expect(screen.queryByTestId("ai-provider-sign-out-clawai")).not.toBeInTheDocument();
  });

  it("holds every Make default and switch while a sign-out runs", async () => {
    let answer!: () => void;
    const box = stubBox({ answer: new Promise<void>((resolve) => { answer = resolve; }) });
    renderList();
    const button = await signOutButton("openai", "OpenAI GPT");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(box.posts).toEqual([{ provider: "openai" }]));
    expect(screen.getByTestId("ai-provider-make-default-xai")).toBeDisabled();
    expect(screen.getByTestId("ai-provider-switch-xai")).toBeDisabled();
    expect(screen.getByTestId("ai-provider-sign-out-xai")).toBeDisabled();
    answer();
    await waitFor(() => expect(screen.getByTestId("ai-provider-make-default-xai")).toBeEnabled());
  });

  it("forgets the note once the provider is signed in again, so a later refusal does not bring it back", async () => {
    const box = stubBox();
    renderList();
    const button = await signOutButton("openai", "OpenAI GPT");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("Signed out of OpenAI GPT."));
    // Signed in again: the box answers it connected.
    box.signedOut.clear();
    act(() => notifyProvidersChanged());
    await waitFor(() => expect(screen.getByTestId("ai-provider-sign-out-openai")).toBeInTheDocument());
    expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("");
    // ...and that new sign-in is then refused: "Needs sign-in", never "Signed out".
    box.rows = OPENCLAW_ROWS.map((row) => (row.id === "openai" ? { ...row, state: "needs-reauth", credentialHeld: true } : row));
    act(() => notifyProvidersChanged());
    await waitFor(() => expect(screen.getByTestId("ai-provider-openai")).toHaveTextContent(/Needs sign-in/));
    expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("");
  });
});

/**
 * Where the button stands and what it looks like (TASK-2246). It used to sit
 * under the row's status: alone under the default's hint on ClawBox AI's row,
 * inline beside "Connected" — into it — on OpenAI's, and as "Sign out of
 * Anthropic Claude" on two lines in a tall button on Anthropic's. Now it is
 * one of the row's controls, the bare verb, the same box as Make default.
 * jsdom does no layout, so the half held here is the structure and the class
 * contract that produce it; the pixels are the screenshots on the PR.
 */
describe("AiProviderList — the sign-out among the row's controls", () => {
  /** The classes that give a labelled row control its height, type and centring. */
  const ROW_BOX = ["inline-flex", "items-center", "text-[11px]", "px-2.5", "py-1", "rounded-lg", "border"];

  it("sits in the row's controls just left of the switch on every row, the default's too, and never in the name's column", async () => {
    stubBox();
    renderList();
    for (const row of OPENCLAW_ROWS) {
      const button = await signOutButton(row.id, row.label);
      const controls = screen.getByTestId(`ai-provider-controls-${row.id}`);
      const slot = screen.getByTestId(`ai-provider-sign-out-slot-${row.id}`);
      const toggle = screen.getByTestId(`ai-provider-switch-${row.id}`);
      expect(controls, row.id).toContainElement(button);
      // One slot, the last of the controls, holding the sign-out and then the
      // switch — so it lines up the same on every row.
      expect(controls.lastElementChild, row.id).toBe(slot);
      expect(slot.firstElementChild, row.id).toBe(button);
      expect(slot.lastElementChild, row.id).toContainElement(toggle);
      expect(button.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING, row.id).toBeTruthy();
      // The status line, the default's hint and the name are in the other column.
      const identity = screen.getByTestId(`ai-provider-identity-${row.id}`);
      expect(identity, row.id).not.toContainElement(button);
      expect(identity, row.id).toHaveTextContent(row.enabled ? "Connected" : "Switched off");
    }
    expect(screen.getByTestId("ai-provider-identity-clawai")).toContainElement(screen.getByTestId("ai-provider-locked-hint-clawai"));
  });

  it("is the same box as Make default and the disclosure beside it, and its words never wrap — at rest, armed and in hand", async () => {
    let answer!: () => void;
    const box = stubBox({ answer: new Promise<void>((resolve) => { answer = resolve; }) });
    renderList();
    const button = await signOutButton("openai", "OpenAI GPT");
    const makeDefault = screen.getByTestId("ai-provider-make-default-openai");
    const usage = screen.getByTestId("clawai-usage-toggle");
    for (const cls of ROW_BOX) {
      expect(classes(button), cls).toContain(cls);
      expect(classes(makeDefault), cls).toContain(cls);
    }
    for (const cls of ["items-center", "text-[11px]", "px-2.5", "py-1", "rounded-lg", "border"]) {
      expect(classes(usage), cls).toContain(cls);
    }
    expect(classes(button)).toContain("whitespace-nowrap");
    expect(classes(button)).toContain("shrink-0");
    // No margin of its own pushing it off the controls' centre line.
    expect(classes(button).filter((c) => /^-?m[trblxy]?-/.test(c))).toEqual([]);

    fireEvent.click(button);
    expect(button).toHaveTextContent("Sign out — tap again");
    expect(classes(button)).toContain("whitespace-nowrap");
    fireEvent.click(button);
    await waitFor(() => expect(box.posts).toEqual([{ provider: "openai" }]));
    expect(button).toHaveTextContent("Signing out…");
    expect(classes(button)).toContain("whitespace-nowrap");
    for (const cls of ROW_BOX) expect(classes(button), cls).toContain(cls);
    answer();
    await waitFor(() => expect(screen.queryByTestId("ai-provider-openai")).not.toBeInTheDocument());
  });

  it("dims the row's other controls while it is in hand, never itself", async () => {
    let answer!: () => void;
    const box = stubBox({ answer: new Promise<void>((resolve) => { answer = resolve; }) });
    renderList();
    const button = await signOutButton("openai", "OpenAI GPT");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(box.posts).toEqual([{ provider: "openai" }]));
    expect(button.closest(".provider-sign-out-dim")).toBeNull();
    expect(screen.getByTestId("ai-provider-switch-openai").closest(".provider-sign-out-dim")).not.toBeNull();
    expect(screen.getByTestId("ai-provider-make-default-openai").closest(".provider-sign-out-dim")).not.toBeNull();
    answer();
    await waitFor(() => expect(screen.queryByTestId("ai-provider-openai")).not.toBeInTheDocument());
  });

  it("keeps the provider's name on a locked default, with the reason in its tooltip", async () => {
    stubBox({ harness: "hermes", rows: HERMES_ROWS });
    renderList();
    const locked = await signOutButton("openrouter", "OpenRouter");
    expect(locked).toBeDisabled();
    expect(locked).toHaveTextContent(/^Sign out$/);
    expect(locked).toHaveAttribute("title", "Make another provider the default first.");
    expect(screen.getByTestId("ai-provider-controls-openrouter")).toContainElement(locked);
  });

  it("says it in the owner's language: the short verb on the button, the provider in its name", async () => {
    stubBox({ locale: "de" });
    renderList();
    const button = await screen.findByRole("button", { name: "Von OpenAI GPT abmelden" }, { timeout: 5_000 });
    expect(button).toHaveAttribute("data-testid", "ai-provider-sign-out-openai");
    expect(button).toHaveTextContent(/^Abmelden$/);
    expect(button).toHaveAttribute("title", "Von OpenAI GPT abmelden");
    fireEvent.click(button);
    expect(button).toHaveTextContent("Abmelden — nochmal tippen");
    expect(button).toHaveAccessibleName("Von OpenAI GPT abmelden — nochmal tippen");
  });
});
