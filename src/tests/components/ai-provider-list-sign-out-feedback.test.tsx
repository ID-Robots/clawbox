/**
 * What the owner SEES while "Sign out of <Provider>" runs (TASK-2126), in the
 * provider list both harnesses share (src/components/AiProviderList.tsx).
 *
 * The second tap used to change nothing on screen until the row finally did —
 * on a sign-out that restarts the gateway, a minute of a page that looks as if
 * the tap was lost. Now:
 *   - pending: the button is a spinner reading "Signing out…", disabled (no
 *     second submit), and the row dims under a sheen — through the request,
 *     the gateway restart the route reports, and the box's re-read after it;
 *   - success: a row the box no longer lists folds away, one it still lists
 *     (ClawBox AI as the default) brightens into "Needs sign-in", and "Signed
 *     out of …" stands above the list for about three seconds;
 *   - error: the row is back as it was, the box's reason under its button;
 *   - reduced motion: every state and word, no fold and no wash.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import AiProviderList, { SIGN_OUT_REQUEST_MS } from "@/components/AiProviderList";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
vi.mock("@/components/AIProviderIcon", () => ({ default: () => <span data-testid="icon" /> }));

// The wait for the gateway after a restart polls /setup-api/gateway/health
// every two seconds; here the test says when the gateway is back. A plain
// function, not a vi.fn: the suite resets mock implementations before each test.
const gateway = vi.hoisted(() => ({ waits: 0, back: null as null | (() => void) }));
vi.mock("@/lib/wait-for-gateway", () => ({
  waitForGatewayAfterRestart: () => {
    gateway.waits += 1;
    return new Promise<boolean>((resolve) => { gateway.back = () => resolve(true); });
  },
}));

type Row = { id: string; label: string; state: string; isDefault: boolean; section: string; enabled: boolean; credentialHeld?: boolean };

const OPENCLAW_ROWS: Row[] = [
  { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, section: "ai", enabled: true },
  { id: "openai", label: "OpenAI GPT", state: "connected", isDefault: false, section: "ai", enabled: true },
  { id: "xai", label: "xAI Grok", state: "connected", isDefault: false, section: "ai", enabled: true },
];
const HERMES_ROWS: Row[] = [
  { id: "clawai", label: "ClawBox AI", state: "connected", isDefault: false, section: "ai", enabled: true },
  { id: "openrouter", label: "OpenRouter", state: "connected", isDefault: true, section: "ai", enabled: true },
  { id: "gemini", label: "Google Gemini", state: "connected", isDefault: false, section: "ai", enabled: true },
];

interface Box {
  posts: string[];
  statusReads: number;
  signedOut: Set<string>;
}

function stubBox(opts: {
  harness?: "openclaw" | "hermes";
  rows?: Row[];
  refuse?: { status: number; error: string };
  answer?: Promise<void>;
  restarting?: boolean;
  /** The sign-out request never answers; it fails only when the page aborts it. */
  hang?: boolean;
  /** Every status read after a sign-out fails. */
  readFailsAfterSignOut?: boolean;
} = {}): Box {
  const rows = opts.rows ?? OPENCLAW_ROWS;
  const box: Box = { posts: [], statusReads: 0, signedOut: new Set() };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("/setup-api/preferences")) return json({});
    if (url.startsWith("/setup-api/providers/status")) {
      box.statusReads += 1;
      if (opts.readFailsAfterSignOut && box.signedOut.size > 0) return json({ error: "busy" }, 503);
      // Signed out: the default stays listed with no credential, any other
      // row leaves this list.
      const now = rows.flatMap((row) => !box.signedOut.has(row.id)
        ? [row]
        : row.isDefault ? [{ ...row, state: "needs-reauth", credentialHeld: false }] : [{ ...row, state: "disconnected" }]);
      return json({ harness: opts.harness ?? "openclaw", providers: now, defaultProvider: rows.find((r) => r.isDefault)?.id ?? null, unrunnable: [], degraded: false });
    }
    if (url === "/setup-api/providers/sign-out" && init?.method === "POST") {
      const { provider } = JSON.parse(String(init.body)) as { provider: string };
      box.posts.push(provider);
      if (opts.hang) {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
      }
      await opts.answer;
      if (opts.refuse) return json({ error: opts.refuse.error, kind: "still_signed_in" }, opts.refuse.status);
      box.signedOut.add(provider);
      return json({ signedOut: true, provider, changed: true, gatewayRestarting: opts.restarting === true });
    }
    return json({ error: "unexpected" }, 404);
  }));
  return box;
}

/** A promise the test resolves: the route's answer, held. */
function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function reduceMotion() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const renderList = () => render(<I18nProvider><AiProviderList /></I18nProvider>);

/** Both taps of the two-tap sign-out, on the row's button found by the name a person reads. */
async function signOut(label: string): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: `Sign out of ${label}` }, { timeout: 5_000 });
  fireEvent.click(button);
  expect(button).toHaveTextContent("Sign out — tap again");
  fireEvent.click(button);
  return button;
}

afterEach(() => {
  vi.unstubAllGlobals();
  gateway.waits = 0;
  gateway.back = null;
});

describe("AiProviderList — what a sign-out looks like while it runs", () => {
  it("pending: the button is a spinner reading 'Signing out…' that takes no second submit, and the row dims", async () => {
    const answer = held();
    const box = stubBox({ answer: answer.promise });
    renderList();
    const ready = await screen.findByRole("button", { name: "Sign out of OpenAI GPT" }, { timeout: 5_000 });
    ready.focus();
    const button = await signOut("OpenAI GPT");
    await waitFor(() => expect(box.posts).toEqual(["openai"]));

    expect(button).toHaveTextContent("Signing out…");
    // Disabled for every purpose but focus: a keyboard keeps its place
    // through the whole sign-out.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("ai-provider-sign-out-spinner-openai")).toHaveAttribute("aria-hidden", "true");
    // The spinner's ligature is not part of the button's name.
    expect(screen.getByRole("button", { name: "Signing out…" })).toBe(button);
    const row = screen.getByTestId("ai-provider-openai");
    expect(row).toHaveAttribute("data-sign-out", "pending");
    expect(row).toHaveClass("provider-sign-out-pending");
    expect(row).toHaveAttribute("aria-busy", "true");
    // Only the tapped row is in hand.
    expect(screen.getByTestId("ai-provider-xai")).not.toHaveAttribute("data-sign-out");
    expect(screen.getByTestId("ai-provider-sign-out-xai")).toHaveTextContent("Sign out of xAI Grok");

    // No double submit, however often it is pressed.
    fireEvent.click(button);
    fireEvent.click(button);
    expect(box.posts).toEqual(["openai"]);
    // "Signed out" is not said before the box has answered; that it is
    // running is, to assistive tech, in the status region.
    expect(screen.queryByTestId("ai-provider-signed-out")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("Signing out…");
    expect(screen.getByTestId("ai-provider-sign-out-progress")).toHaveClass("sr-only");

    answer.release();
    await waitFor(() => expect(screen.getByTestId("ai-provider-signed-out")).toHaveTextContent("Signed out of OpenAI GPT."));
    expect(box.posts).toEqual(["openai"]);
  });

  it("holds the row through the gateway restart the route reports, says so, and lets go once the gateway is back and the box has re-read", async () => {
    const box = stubBox({ restarting: true });
    renderList();
    const button = await signOut("OpenAI GPT");
    const restarting = await screen.findByTestId("ai-provider-sign-out-restarting-openai");
    expect(restarting).toHaveTextContent("The assistant is restarting to finish — back in about a minute.");
    expect(gateway.waits).toBe(1);
    expect(button).toHaveTextContent("Signing out…");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("ai-provider-openai")).toHaveAttribute("data-sign-out", "pending");
    // The box is not re-read against a gateway that is still coming back.
    const readsDuringRestart = box.statusReads;
    expect(screen.queryByTestId("ai-provider-signed-out")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-sign-out-progress"))
      .toHaveTextContent("Signing out… The assistant is restarting to finish — back in about a minute.");

    gateway.back?.();
    await waitFor(() => expect(screen.getByTestId("ai-provider-signed-out")).toHaveTextContent("Signed out of OpenAI GPT."));
    expect(box.statusReads).toBeGreaterThan(readsDuringRestart);
    expect(screen.queryByTestId("ai-provider-sign-out-restarting-openai")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-openai")).not.toBeInTheDocument();
  });

  it("success: a row the box no longer lists folds away in its place, and 'Signed out of …' stands for about three seconds", async () => {
    stubBox();
    renderList();
    await signOut("OpenAI GPT");
    await waitFor(() => expect(screen.getByTestId("ai-provider-signed-out")).toBeInTheDocument());
    expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("Signed out of OpenAI GPT. Sign in again below to use it.");

    // The box's answer has let the row go; its picture folds away where it stood.
    expect(screen.queryByTestId("ai-provider-openai")).not.toBeInTheDocument();
    const leaving = screen.getByTestId("ai-provider-held-openai");
    expect(leaving).toHaveAttribute("data-sign-out", "leaving");
    expect(leaving).toHaveClass("provider-sign-out-leaving");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    // A picture of the row, not the row: it keeps its spinner to the end, can
    // be pressed by nobody, and answers to none of the row's test ids.
    expect(within(leaving).getByText("Signing out…").closest("button")).toBeDisabled();
    expect(within(leaving).queryByText("Sign out of OpenAI GPT")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-sign-out-openai")).not.toBeInTheDocument();
    const order = screen.getAllByTestId(/^ai-provider-(held-)?(clawai|openai|xai)$/).map((el) => el.dataset.testid);
    expect(order).toEqual(["ai-provider-clawai", "ai-provider-held-openai", "ai-provider-xai"]);
    // The rest of the list is free again at once.
    expect(screen.getByTestId("ai-provider-sign-out-xai")).toBeEnabled();

    await waitFor(() => expect(screen.queryByTestId("ai-provider-held-openai")).not.toBeInTheDocument(), { timeout: 2_000 });
    expect(screen.getByTestId("ai-provider-signed-out")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent(""), { timeout: 4_500 });
  });

  it("success: ClawBox AI as the default stays listed and brightens into 'Needs sign-in'", async () => {
    stubBox();
    renderList();
    await signOut("ClawBox AI");
    await waitFor(() => expect(screen.getByTestId("ai-provider-signed-out")).toHaveTextContent("Signed out of ClawBox AI."));
    const row = screen.getByTestId("ai-provider-clawai");
    expect(row).toHaveAttribute("data-sign-out", "settled");
    expect(row).toHaveClass("provider-sign-out-settled");
    expect(row).toHaveTextContent("Needs sign-in");
    expect(screen.getByTestId("ai-provider-default-clawai")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-held-clawai")).not.toBeInTheDocument();
    await waitFor(() => expect(row).not.toHaveAttribute("data-sign-out"), { timeout: 2_000 });
  });

  it("success on Hermes too: the same list, the same states", async () => {
    const answer = held();
    stubBox({ harness: "hermes", rows: HERMES_ROWS, answer: answer.promise });
    renderList();
    const button = await signOut("Google Gemini");
    await waitFor(() => expect(button).toHaveTextContent("Signing out…"));
    expect(screen.getByTestId("ai-provider-gemini")).toHaveAttribute("data-sign-out", "pending");
    answer.release();
    await waitFor(() => expect(screen.getByTestId("ai-provider-signed-out")).toHaveTextContent("Signed out of Google Gemini."));
    expect(screen.getByTestId("ai-provider-held-gemini")).toHaveAttribute("data-sign-out", "leaving");
    await waitFor(() => expect(screen.queryByTestId("ai-provider-held-gemini")).not.toBeInTheDocument(), { timeout: 2_000 });
  });

  it("error: the row is back as it was, with the box's reason under its own button", async () => {
    const reason = "The OpenAI GPT sign-in could not be removed from the gateway's auth store.";
    const box = stubBox({ refuse: { status: 500, error: reason } });
    renderList();
    await signOut("OpenAI GPT");
    const error = await screen.findByTestId("ai-provider-sign-out-error-openai");
    expect(error).toHaveTextContent(reason);
    expect(error).toHaveAttribute("role", "alert");
    const row = screen.getByTestId("ai-provider-openai");
    expect(row).toContainElement(error);
    // Said once, on the row — not again above the list.
    expect(screen.getAllByRole("alert")).toEqual([error]);
    await waitFor(() => expect(row).not.toHaveAttribute("data-sign-out"));
    const button = screen.getByTestId("ai-provider-sign-out-openai");
    expect(button).toHaveTextContent("Sign out of OpenAI GPT");
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("ai-provider-sign-out-spinner-openai")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-provider-sign-out-note")).toHaveTextContent("");
    // Trying again takes the old reason away.
    fireEvent.click(button);
    expect(screen.queryByTestId("ai-provider-sign-out-error-openai")).not.toBeInTheDocument();
    expect(box.posts).toEqual(["openai"]);
  });

  it("a re-read that fails still lets the row go, and keeps 'Signed out' up against the list it could not replace", async () => {
    stubBox({ readFailsAfterSignOut: true });
    renderList();
    await signOut("OpenAI GPT");
    await waitFor(() => expect(screen.getByTestId("ai-provider-signed-out")).toHaveTextContent("Signed out of OpenAI GPT."));
    // The list says it is the last known state...
    expect(screen.getByRole("alert")).toHaveTextContent("The provider list could not be read from the box.");
    // ...which still shows the row signed in — and that older list does not
    // take back what the sign-out did.
    const row = screen.getByTestId("ai-provider-openai");
    expect(row).not.toHaveAttribute("data-sign-out", "pending");
    expect(screen.getByTestId("ai-provider-signed-out")).toBeInTheDocument();
    // Nothing is held: the rest of the list is free again.
    expect(screen.getByTestId("ai-provider-switch-xai")).toBeEnabled();
    expect(screen.getByTestId("ai-provider-sign-out-xai")).toBeEnabled();
  });

  it("a request that never answers gives every row back after SIGN_OUT_REQUEST_MS, and says the sign-out may have gone through", async () => {
    const box = stubBox({ hang: true });
    renderList();
    const button = await screen.findByRole("button", { name: "Sign out of OpenAI GPT" }, { timeout: 5_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(button);
      fireEvent.click(button);
      expect(box.posts).toEqual(["openai"]);
      expect(button).toHaveTextContent("Signing out…");
      await act(async () => { await vi.advanceTimersByTimeAsync(SIGN_OUT_REQUEST_MS - 1_000); });
      // Still in hand a second before the bound.
      expect(button).toHaveTextContent("Signing out…");
      expect(screen.getByTestId("ai-provider-switch-xai")).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    } finally {
      vi.useRealTimers();
    }
    const error = await screen.findByTestId("ai-provider-sign-out-error-openai");
    expect(error).toHaveTextContent("The box took too long to answer. The list has been read again — if OpenAI GPT is no longer in it, the sign-out went through.");
    await waitFor(() => expect(screen.getByTestId("ai-provider-switch-xai")).toBeEnabled());
    expect(screen.getByTestId("ai-provider-sign-out-openai")).toHaveTextContent("Sign out of OpenAI GPT");
    expect(screen.queryByTestId("ai-provider-signed-out")).not.toBeInTheDocument();
  });

  it("reduced motion: the same states and words, with no fold and no wash", async () => {
    reduceMotion();
    const answer = held();
    stubBox({ answer: answer.promise });
    renderList();
    const button = await signOut("OpenAI GPT");
    await waitFor(() => expect(button).toHaveTextContent("Signing out…"));
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("ai-provider-openai")).toHaveAttribute("data-sign-out", "pending");
    answer.release();
    await waitFor(() => expect(screen.getByTestId("ai-provider-signed-out")).toHaveTextContent("Signed out of OpenAI GPT."));
    // Gone in one step: no picture left behind to fold.
    expect(screen.queryByTestId("ai-provider-openai")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ai-provider-held-openai")).not.toBeInTheDocument();

    await signOut("ClawBox AI");
    await waitFor(() => expect(screen.getByTestId("ai-provider-signed-out")).toHaveTextContent("Signed out of ClawBox AI."));
    expect(screen.getByTestId("ai-provider-clawai")).toHaveTextContent("Needs sign-in");
    expect(screen.getByTestId("ai-provider-clawai")).not.toHaveAttribute("data-sign-out");
  });
});

describe("globals.css — the sign-out's motion", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** The body of the `@media (prefers-reduced-motion: reduce) { … }` block that names `selector`, braces balanced. */
  function reducedBlockFor(selector: string): string {
    const marker = "@media (prefers-reduced-motion: reduce)";
    for (let at = css.indexOf(marker); at !== -1; at = css.indexOf(marker, at + marker.length)) {
      const open = css.indexOf("{", at);
      let depth = 0;
      let end = open;
      for (; end < css.length; end++) {
        if (css[end] === "{") depth++;
        else if (css[end] === "}" && --depth === 0) break;
      }
      const block = css.slice(open, end + 1);
      if (block.includes(selector)) return block;
    }
    throw new Error(`no reduced-motion block names ${selector}`);
  }

  it("defines every class the list puts on a row and the note", () => {
    for (const cls of ["provider-sign-out-dim", "provider-sign-out-pending", "provider-sign-out-leaving", "provider-sign-out-settled", "provider-sign-out-note"]) {
      expect(css, cls).toMatch(new RegExp(`\\.${cls}[\\s{:,.]`));
    }
  });

  it("the sheen, which can run for a minute, moves by transform only", () => {
    const start = css.indexOf("@keyframes provider-sign-out-sheen {");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = css.slice(start, css.indexOf("}\n", css.indexOf("to {", start)) + 1);
    const props = [...new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))];
    expect(props).toEqual(["transform"]);
  });

  it("drops the sheen, the wash, the fold and the note's slide under reduced motion", () => {
    const block = reducedBlockFor(".provider-sign-out-pending::after");
    expect(block).toMatch(/\.provider-sign-out-pending::after,\s*\.provider-sign-out-settled::after\s*\{[^}]*content:\s*none/);
    expect(block).toMatch(/\.provider-sign-out-leaving,\s*\.provider-sign-out-note\s*\{[^}]*animation:\s*none/);
  });
});
