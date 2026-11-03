import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { I18nProvider } from "@/lib/i18n";
import { ChatProgressCard } from "@/components/ChatProgressCard";
import {
  PROGRESS_CARD_COLLAPSED_KEY,
  PROGRESS_CARD_DISMISSED_KEY,
  PROGRESS_CARD_REFRESH_TIMEOUT_MS,
  useGatewayProgressCard,
  type ProgressCard,
} from "@/lib/chat-progress-card";

/**
 * The "Task progress" card (TASK-896): what it draws from a gateway card, that
 * it draws nothing the sanitiser did not allow, that the fold survives a
 * reload, and the hook that keeps it in step with `progressCard.changed`.
 */

const HOUR = 3_600_000;

const DOCS_NOTE = [
  "**Overnight coding queue — running until 08:00**",
  "",
  '<progress aria-label="Tests · 3/7" value="3" max="7"></progress>',
  "",
  "| LANE | UNIT | NOW ON |",
  "| --- | --- | --- |",
  "| api | auth | [PR #12](https://github.com/o/r/pull/12) |",
].join("\n");

function card(overrides: Partial<ProgressCard> = {}): ProgressCard {
  return {
    sessionKey: "agent:main:main",
    revision: 3,
    updatedAt: Date.now() - 2 * HOUR - 60_000,
    markdown: DOCS_NOTE,
    steps: [
      { step: "Inspect the failing route", status: "completed" },
      { step: "Repair the session owner", status: "in_progress" },
      { step: "Run focused verification", status: "pending" },
    ],
    ...overrides,
  };
}

function stubLocale(locale: string) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ui_language: locale }) })));
}

async function renderCard(value: ProgressCard, locale = "en") {
  stubLocale(locale);
  const view = render(<I18nProvider><ChatProgressCard card={value} /></I18nProvider>);
  // The catalogue is loaded after mount; wait for real copy rather than keys.
  await waitFor(() => expect(screen.getByTestId("chat-progress-card-title").textContent).not.toBe("chat.progressCard.title"));
  return view;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatProgressCard — what it draws", () => {
  it("heads the card with the title, how long ago it was updated, the step in progress and the count", async () => {
    await renderCard(card());
    expect(screen.getByTestId("chat-progress-card-title")).toHaveTextContent("Task progress");
    expect(screen.getByTestId("chat-progress-card-updated")).toHaveTextContent("Updated 2h ago");
    expect(screen.getByTestId("chat-progress-card-updated")).toHaveAttribute("dateTime", expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
    expect(screen.getByTestId("chat-progress-card-summary")).toHaveTextContent("Repair the session owner");
    const count = screen.getByTestId("chat-progress-card-count");
    expect(count).toHaveTextContent("1/3");
    // Spoken as words through real hidden text, not an aria-label on a role-less span.
    expect(count).not.toHaveAttribute("aria-label");
    expect(within(count).getByTestId("chat-progress-card-count-label")).toHaveTextContent("1 of 3 steps done");
    expect(within(count).getByTestId("chat-progress-card-count-label")).toHaveClass("sr-only");
    expect(within(count).getByText("1/3")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("chat-progress-card-toggle")).toHaveAccessibleName(expect.stringContaining("1 of 3 steps done"));
  });

  it("names the note's first line in the header when there is no plan", async () => {
    await renderCard(card({ steps: [] }));
    expect(screen.getByTestId("chat-progress-card-summary")).toHaveTextContent("Overnight coding queue — running until 08:00");
    expect(screen.queryByTestId("chat-progress-card-count")).toBeNull();
    expect(screen.queryByTestId("chat-progress-card-plan")).toBeNull();
  });

  it("renders the note: bold, the labelled bar, the table and a link that opens safely", async () => {
    await renderCard(card());
    const note = screen.getByTestId("chat-progress-card-markdown");
    expect(within(note).getByText("Overnight coding queue — running until 08:00").tagName).toBe("STRONG");

    const bar = within(note).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-label", "Tests · 3/7");
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "7");
    // The label is the bar's visible caption, as in the Control UI.
    expect(note).toHaveTextContent("Tests · 3/7");
    expect(note).toHaveTextContent("43%");

    const table = within(note).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["LANE", "UNIT", "NOW ON"]);
    const link = within(table).getByRole("link", { name: "PR #12" });
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/12");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("lists the plan in order with each step's state, at most one in progress", async () => {
    await renderCard(card());
    const steps = within(screen.getByTestId("chat-progress-card-plan")).getAllByTestId("chat-progress-step");
    expect(steps.map((li) => li.getAttribute("data-status"))).toEqual(["completed", "in_progress", "pending"]);
    expect(steps.map((li) => within(li).getByTestId("chat-progress-step-text").textContent)).toEqual([
      "Completed: Inspect the failing route",
      "In progress: Repair the session owner",
      "Pending: Run focused verification",
    ]);
    expect(steps.filter((li) => li.getAttribute("aria-current") === "step")).toHaveLength(1);
  });

  it("speaks the owner's language", async () => {
    await renderCard(card(), "de");
    // English is the first catalogue loaded; the saved locale lands a moment later.
    await waitFor(() => expect(screen.getByTestId("chat-progress-card-title")).toHaveTextContent("Aufgabenfortschritt"));
    expect(screen.getByTestId("chat-progress-card-updated")).toHaveTextContent("Aktualisiert vor 2 Std.");
    expect(screen.getByTestId("chat-progress-card-count-label")).toHaveTextContent("1 von 3 Schritten erledigt");
  });

  it("draws nothing when everything in the note was stripped and there is no plan", () => {
    const { container } = render(<ChatProgressCard card={card({ markdown: "<script>alert(1)</script><!-- x -->", steps: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("replaces the whole card in place when a new revision arrives", async () => {
    const view = await renderCard(card());
    view.rerender(
      <I18nProvider>
        <ChatProgressCard card={card({ revision: 4, markdown: "Only the note now.", steps: [{ step: "Ship it", status: "in_progress" }] })} />
      </I18nProvider>,
    );
    expect(screen.getAllByTestId("chat-progress-card")).toHaveLength(1);
    expect(screen.getByTestId("chat-progress-card")).toHaveAttribute("data-revision", "4");
    expect(screen.queryByText("Tests · 3/7")).toBeNull();
    expect(screen.queryByText(/Inspect the failing route/)).toBeNull();
    expect(screen.getByTestId("chat-progress-card-markdown")).toHaveTextContent("Only the note now.");
    expect(screen.getAllByTestId("chat-progress-step")).toHaveLength(1);
  });
});

describe("ChatProgressCard — the sanitiser, end to end", () => {
  const HOSTILE = [
    "<script>window.__pwned = 1</script>",
    '<img src=x onerror="window.__pwned = 2">',
    '<iframe src="https://evil.example"></iframe>',
    '<svg><script>window.__pwned = 3</script></svg>',
    '<a href="javascript:window.__pwned = 4">tap</a>',
    "[click](javascript:window.__pwned=5) [data](data:text/html,x) [ok](https://example.com)",
    '<div style="position:fixed;inset:0" onclick="x()">overlay</div>',
    "<style>*{display:none}</style>",
    "<form action=https://evil.example><input name=p><button>go</button></form>",
    '<progress value="2" max="4" onclick="x()" style="width:1000px"></progress>',
  ].join("\n\n");

  it("renders only the allowed elements, with no handler, style or unsafe URL from the note", () => {
    const { container } = render(<ChatProgressCard card={card({ markdown: HOSTILE, steps: [] })} />);
    const note = screen.getByTestId("chat-progress-card-markdown");
    expect(note.querySelector("script, img, iframe, svg, style, form, input, button, object, embed")).toBeNull();
    for (const element of Array.from(note.querySelectorAll("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith("on")).toBe(false);
      }
    }
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://example.com/"]);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // The words of a stripped element stay; the markup does not.
    expect(note).toHaveTextContent("overlay");
    expect(note).not.toHaveTextContent("display:none");
    expect(note.textContent).not.toContain("<");
    // The bar survived, without the attributes it was not allowed to keep.
    const bar = within(note).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "2");
    expect(bar.getAttribute("style") ?? "").not.toContain("1000px");
  });

  it("shows a step's text as text, never as markup", () => {
    render(<ChatProgressCard card={card({ markdown: "", steps: [{ step: "<b>bold?</b> <img src=x onerror=alert(1)>", status: "pending" }] })} />);
    const step = screen.getByTestId("chat-progress-step");
    expect(step.querySelector("b, img")).toBeNull();
    expect(within(step).getByTestId("chat-progress-step-text")).toHaveTextContent("<b>bold?</b> <img src=x onerror=alert(1)>");
  });
});

describe("ChatProgressCard — the fold", () => {
  it("collapses and expands from the header, and the state survives a reload", async () => {
    const view = await renderCard(card());
    const toggle = screen.getByTestId("chat-progress-card-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("chat-progress-card-body")).toBeInTheDocument();
    expect(toggle.getAttribute("aria-controls")).toBe(screen.getByTestId("chat-progress-card-body").id);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("chat-progress-card-body")).toBeNull();
    expect(screen.getByTestId("chat-progress-card")).toHaveAttribute("data-collapsed", "true");
    expect(window.localStorage.getItem(PROGRESS_CARD_COLLAPSED_KEY)).toBe("1");
    // Folded, the header still says what the agent is doing.
    expect(screen.getByTestId("chat-progress-card-summary")).toHaveTextContent("Repair the session owner");

    // A reload: a fresh mount reads the fold back.
    view.unmount();
    await renderCard(card());
    expect(screen.getByTestId("chat-progress-card-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("chat-progress-card-body")).toBeNull();

    fireEvent.click(screen.getByTestId("chat-progress-card-toggle"));
    expect(screen.getByTestId("chat-progress-card-body")).toBeInTheDocument();
    expect(window.localStorage.getItem(PROGRESS_CARD_COLLAPSED_KEY)).toBe("0");
  });

  it("follows a fold made in another tab", () => {
    render(<ChatProgressCard card={card()} />);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: PROGRESS_CARD_COLLAPSED_KEY, newValue: "1" }));
    });
    expect(screen.getByTestId("chat-progress-card-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("caps the body's height and scrolls inside it, so it cannot cover the composer", () => {
    render(<ChatProgressCard card={card()} />);
    const body = screen.getByTestId("chat-progress-card-body");
    expect(body.className).toContain("chat-progress-body");
    expect(body.style.overflowY).toBe("auto");
    const css = screen.getByTestId("chat-progress-card").querySelector("style")?.textContent ?? "";
    expect(css).toMatch(/\.chat-progress-body \{ max-height: min\(300px, 34dvh\); \}/);
    expect(css).toMatch(/@media \(max-height: 760px\) \{ \.chat-progress-body \{ max-height: min\(220px, 28dvh\); \} \}/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{ \.chat-progress-body \{ max-height: min\(240px, 30dvh\); \} \}/);
  });

  // Seen at 390px in German and Bulgarian: the title and "Updated…" never
  // shrank, so the time was cut mid-word and the step vanished. The header now
  // gives way in order — the summary first, the time last and with an ellipsis
  // — and on a narrow card puts both under the title. jsdom has no layout, so
  // this pins the structure and the rules that produce it.
  it("lets the header give way on a narrow card instead of cutting the time off", () => {
    render(<ChatProgressCard card={card()} />);
    const section = screen.getByTestId("chat-progress-card");
    expect(section.className).toContain("chat-progress-card");
    expect(screen.getByTestId("chat-progress-card-title").className).toContain("chat-progress-title");
    const time = screen.getByTestId("chat-progress-card-updated");
    const summary = screen.getByTestId("chat-progress-card-summary");
    expect(time.className).toContain("chat-progress-time");
    expect(summary.className).toContain("chat-progress-summary");
    // Neither carries an inline flex-shrink that would override the stylesheet's order.
    expect(time.style.flexShrink).toBe("");
    expect(summary.style.flexShrink).toBe("");
    expect(time.parentElement).toBe(summary.parentElement);
    expect(time.parentElement?.className).toContain("chat-progress-meta");

    const css = section.querySelector("style")?.textContent ?? "";
    // Measured on the fold toggle, so the buttons beside it count against the header's room.
    expect(css).toContain(".chat-progress-toggle { container: chat-progress / inline-size; }");
    expect(screen.getByTestId("chat-progress-card-toggle").className).toContain("chat-progress-toggle");
    expect(css).toContain(".chat-progress-time, .chat-progress-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; }");
    expect(css).toContain(".chat-progress-summary { flex-shrink: 1000; }");
    expect(css).toMatch(/@container chat-progress \(max-width: 374px\) \{[^}]*\.chat-progress-head \{ flex-direction: column;/);
  });
});

describe("ChatProgressCard — putting it away (TASK-2147)", () => {
  type Props = Partial<Parameters<typeof ChatProgressCard>[0]>;
  const tree = (value: ProgressCard, props: Props = {}) => <I18nProvider><ChatProgressCard card={value} {...props} /></I18nProvider>;

  /** Rendered in English with the catalogue loaded (the dismiss button is there on every card). */
  async function renderWith(value: ProgressCard, props: Props = {}) {
    stubLocale("en");
    const view = render(tree(value, props));
    await waitFor(() => expect(screen.getByTestId("chat-progress-card-dismiss")).toHaveAccessibleName("Dismiss progress card"));
    return { ...view, update: (next: ProgressCard, nextProps: Props = {}) => view.rerender(tree(next, nextProps)) };
  }

  it("dismisses with the X, stays hidden after a reload, and comes back on the agent's next write", async () => {
    const value = card();
    const view = await renderWith(value);
    const dismiss = screen.getByTestId("chat-progress-card-dismiss");
    expect(dismiss).toHaveAccessibleName("Dismiss progress card");
    expect(dismiss).toHaveAttribute("title", "Dismiss — hidden in this chat until the assistant updates it");
    fireEvent.click(dismiss);
    expect(screen.queryByTestId("chat-progress-card")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PROGRESS_CARD_DISMISSED_KEY) ?? "{}")).toEqual({
      "agent:main:main": { revision: 3, updatedAt: value.updatedAt, at: expect.any(Number) },
    });

    // A reload: the same card is still put away.
    view.unmount();
    const again = render(tree(value));
    expect(screen.queryByTestId("chat-progress-card")).toBeNull();

    // The agent writes again: a new revision shows.
    again.rerender(tree({ ...value, revision: 4, updatedAt: (value.updatedAt ?? 0) + 1000 }));
    expect(screen.getByTestId("chat-progress-card")).toHaveAttribute("data-revision", "4");
  });

  it("keeps each session's dismissal to that session", async () => {
    const value = card();
    const view = await renderWith(value);
    fireEvent.click(screen.getByTestId("chat-progress-card-dismiss"));
    view.update({ ...value, sessionKey: "agent:main:clawbox-tab-2" });
    expect(screen.getByTestId("chat-progress-card")).toBeInTheDocument();
  });

  it("follows a dismissal made in another tab", async () => {
    const value = card();
    await renderWith(value);
    act(() => {
      window.localStorage.setItem(
        PROGRESS_CARD_DISMISSED_KEY,
        JSON.stringify({ "agent:main:main": { revision: value.revision, updatedAt: value.updatedAt, at: 1 } }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key: PROGRESS_CARD_DISMISSED_KEY }));
    });
    expect(screen.queryByTestId("chat-progress-card")).toBeNull();
  });

  it("offers only the X where the card has no server-side state to clear or refresh", async () => {
    await renderWith(card());
    expect(screen.getByTestId("chat-progress-card-dismiss")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-progress-card-clear")).toBeNull();
    expect(screen.queryByTestId("chat-progress-card-refresh")).toBeNull();
  });

  it("keeps the buttons out of the fold toggle and available while the card is folded", async () => {
    await renderWith(card(), { onClear: vi.fn(async () => true), onRefresh: vi.fn() });
    const toggle = screen.getByTestId("chat-progress-card-toggle");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    for (const id of ["chat-progress-card-refresh", "chat-progress-card-clear", "chat-progress-card-dismiss"]) {
      const button = screen.getByTestId(id);
      expect(toggle.contains(button)).toBe(false);
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
    }
  });

  it("clears the saved card with the trash, the card it was asked on", async () => {
    const value = card();
    const onClear = vi.fn(async () => true);
    window.localStorage.setItem(PROGRESS_CARD_DISMISSED_KEY, JSON.stringify({ "agent:main:main": { revision: 1, updatedAt: 5, at: 1 } }));
    await renderWith(value, { onClear });
    const trash = screen.getByTestId("chat-progress-card-clear");
    expect(trash).toHaveAccessibleName("Clear saved progress for everyone");
    expect(trash).toHaveAttribute("title", "Clear saved progress for everyone");
    await act(async () => { fireEvent.click(trash); });
    expect(onClear).toHaveBeenCalledWith(value);
    // Nothing is left to hide in that session.
    expect(window.localStorage.getItem(PROGRESS_CARD_DISMISSED_KEY)).toBeNull();
  });

  it("says so when the clear is refused, and lets it be tried again", async () => {
    let fail!: (error: Error) => void;
    const onClear = vi.fn(() => new Promise<boolean>((_, reject) => { fail = reject; }));
    await renderWith(card(), { onClear });
    const trash = screen.getByTestId("chat-progress-card-clear");
    fireEvent.click(trash);
    expect(trash).toBeDisabled();
    expect(trash).toHaveAttribute("aria-busy", "true");
    fireEvent.click(trash);
    expect(onClear).toHaveBeenCalledTimes(1);
    await act(async () => { fail(new Error("FORBIDDEN")); });
    expect(screen.getByTestId("chat-progress-card")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Could not clear the saved progress card.");
    expect(trash).toBeEnabled();
  });

  it("refreshes with its own button, spinning until the newer card lands", async () => {
    const onRefresh = vi.fn();
    const view = await renderWith(card(), { onRefresh });
    const refresh = screen.getByTestId("chat-progress-card-refresh");
    expect(refresh).toHaveAccessibleName("Refresh task progress");
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    view.update(card(), { onRefresh, refreshState: "pending" });
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAccessibleName("Refreshing task progress…");
    expect(refresh.querySelector(".chat-progress-spinner")).not.toBeNull();

    view.update(card(), { onRefresh, refreshState: "failed" });
    expect(screen.getByRole("status")).toHaveTextContent("Could not refresh. The previous update is kept.");
    expect(refresh).toBeEnabled();

    view.update(card(), { onRefresh, refreshState: "timeout" });
    expect(screen.getByRole("status")).toHaveTextContent("No new update yet. The request may still be running.");

    view.update(card({ revision: 4 }), { onRefresh, refreshState: "idle" });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("labels its buttons in the owner's language", async () => {
    stubLocale("de");
    render(<I18nProvider><ChatProgressCard card={card()} onClear={async () => true} onRefresh={() => {}} /></I18nProvider>);
    await waitFor(() => expect(screen.getByTestId("chat-progress-card-dismiss")).toHaveAccessibleName("Fortschrittskarte schließen"));
    expect(screen.getByTestId("chat-progress-card-clear")).toHaveAccessibleName("Gespeicherten Fortschritt für alle löschen");
    expect(screen.getByTestId("chat-progress-card-refresh")).toHaveAccessibleName("Aufgabenfortschritt aktualisieren");
  });
});

describe("useGatewayProgressCard", () => {
  type Answer = { resolve: (value: unknown) => void; reject: (error: Error) => void };

  function fakeGateway() {
    const calls: Array<{ method: string; params: unknown; answer: Answer }> = [];
    const request = vi.fn((method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => { calls.push({ method, params, answer: { resolve, reject } }); }),
    );
    return { request, calls };
  }

  const wire = (overrides: Record<string, unknown> = {}) => ({ card: { ...card(), ...overrides } });

  it("reads the session's card once connected, by the gateway's method and params", async () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled: true }));
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0].method).toBe("progressCard.get");
    expect(gw.calls[0].params).toEqual({ sessionKey: "agent:main:main" });
    await act(async () => { gw.calls[0].answer.resolve(wire()); });
    expect(result.current.card?.revision).toBe(3);
  });

  it("asks nothing while disconnected, or where there is no gateway", () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled: false }));
    expect(gw.request).not.toHaveBeenCalled();
    act(() => result.current.onChanged({ sessionKey: "agent:main:main", revision: 2 }));
    expect(gw.request).not.toHaveBeenCalled();
    expect(result.current.card).toBeNull();
  });

  it("re-reads on a change to this session, and replaces the card with what it reads", async () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled: true }));
    await act(async () => { gw.calls[0].answer.resolve(wire()); });

    act(() => result.current.onChanged({ sessionKey: "agent:main:main", revision: 4 }));
    expect(gw.calls).toHaveLength(2);
    await act(async () => { gw.calls[1].answer.resolve(wire({ revision: 4, markdown: "new", steps: [] })); });
    expect(result.current.card).toMatchObject({ revision: 4, markdown: "new", steps: [] });
  });

  it("removes the card when the read confirms a clear", async () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled: true }));
    await act(async () => { gw.calls[0].answer.resolve(wire()); });
    act(() => result.current.onChanged({ sessionKey: "agent:main:main", revision: null }));
    await act(async () => { gw.calls[1].answer.resolve({ card: null }); });
    expect(result.current.card).toBeNull();
  });

  it("treats a card with both parts empty as removed", async () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled: true }));
    await act(async () => { gw.calls[0].answer.resolve(wire({ markdown: "  ", steps: [] })); });
    expect(result.current.card).toBeNull();
  });

  it("ignores changes to other sessions and a revision it already shows", async () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled: true }));
    await act(async () => { gw.calls[0].answer.resolve(wire()); });
    act(() => result.current.onChanged({ sessionKey: "agent:main:telegram-123", revision: 9 }));
    act(() => result.current.onChanged({ sessionKey: "agent:main:main", revision: 3 }));
    act(() => result.current.onChanged({ nonsense: true }));
    expect(gw.calls).toHaveLength(1);
  });

  it("applies only the newest read when answers arrive out of order", async () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled: true }));
    act(() => result.current.onChanged({ sessionKey: "agent:main:main", revision: 5 }));
    await act(async () => { gw.calls[1].answer.resolve(wire({ revision: 5, markdown: "newest" })); });
    await act(async () => { gw.calls[0].answer.resolve(wire({ revision: 3, markdown: "stale" })); });
    expect(result.current.card?.markdown).toBe("newest");
  });

  it("keeps the card on screen when a refresh fails", async () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled: true }));
    await act(async () => { gw.calls[0].answer.resolve(wire()); });
    act(() => result.current.onChanged({ sessionKey: "agent:main:main", revision: 4 }));
    await act(async () => { gw.calls[1].answer.reject(new Error("Request timeout")); });
    expect(result.current.card?.revision).toBe(3);
  });

  it("never shows one session's card under another, and reads the new one", async () => {
    const gw = fakeGateway();
    const { result, rerender } = renderHook(
      ({ sessionKey }) => useGatewayProgressCard({ request: gw.request, sessionKey, enabled: true }),
      { initialProps: { sessionKey: "agent:main:main" } },
    );
    await act(async () => { gw.calls[0].answer.resolve(wire()); });
    expect(result.current.card).not.toBeNull();

    rerender({ sessionKey: "agent:main:tab-2" });
    expect(result.current.card).toBeNull();
    expect(gw.calls[1].params).toEqual({ sessionKey: "agent:main:tab-2" });
    // The first session's late answer to an older read is not applied to the second.
    await act(async () => { gw.calls[1].answer.resolve(wire({ sessionKey: "agent:main:tab-2", revision: 1, markdown: "tab two" })); });
    expect(result.current.card?.markdown).toBe("tab two");
  });

  it("reads again after a reconnect", async () => {
    const gw = fakeGateway();
    const { rerender } = renderHook(
      ({ enabled }) => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => { gw.calls[0].answer.resolve(wire()); });
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(gw.calls).toHaveLength(2);
  });

  describe("clear (the trash) and refresh (TASK-2147)", () => {
    async function connectedHook() {
      const gw = fakeGateway();
      const hook = renderHook(() => useGatewayProgressCard({ request: gw.request, sessionKey: "agent:main:main", enabled: true }));
      await act(async () => { gw.calls[0].answer.resolve(wire()); });
      return { gw, ...hook };
    }

    it("clears with the Control UI's revision-checked put, and drops the card once it is gone", async () => {
      const { gw, result } = await connectedHook();
      let cleared: Promise<boolean> | undefined;
      act(() => { cleared = result.current.clear(result.current.card!); });
      expect(gw.calls[1].method).toBe("progressCard.put");
      expect(gw.calls[1].params).toEqual({ sessionKey: "agent:main:main", expectedRevision: 3 });
      await act(async () => { gw.calls[1].answer.resolve({ card: null }); });
      await expect(cleared).resolves.toBe(true);
      expect(result.current.card).toBeNull();
    });

    it("keeps and shows a newer card the agent wrote in between", async () => {
      const { gw, result } = await connectedHook();
      let cleared: Promise<boolean> | undefined;
      act(() => { cleared = result.current.clear(result.current.card!); });
      await act(async () => { gw.calls[1].answer.resolve(wire({ revision: 4, markdown: "newer" })); });
      await expect(cleared).resolves.toBe(false);
      expect(result.current.card).toMatchObject({ revision: 4, markdown: "newer" });
    });

    it("rejects on a refusal, keeps the card and reads it again", async () => {
      const { gw, result } = await connectedHook();
      let cleared: Promise<boolean> | undefined;
      act(() => { cleared = result.current.clear(result.current.card!); });
      const settled = cleared!.catch((error: Error) => error.message);
      await act(async () => { gw.calls[1].answer.reject(new Error("FORBIDDEN")); });
      await expect(settled).resolves.toBe("FORBIDDEN");
      expect(result.current.card?.revision).toBe(3);
      expect(gw.calls[2].method).toBe("progressCard.get");
    });

    it("does not let a read asked before the clear put the card back", async () => {
      const { gw, result } = await connectedHook();
      act(() => result.current.onChanged({ sessionKey: "agent:main:main", revision: 4 }));
      act(() => { void result.current.clear(result.current.card!); });
      await act(async () => { gw.calls[2].answer.resolve({ card: null }); });
      await act(async () => { gw.calls[1].answer.resolve(wire({ revision: 3 })); });
      expect(result.current.card).toBeNull();
    });

    it("asks for a refresh with a fresh retry key and spins until a newer card is read", async () => {
      const { gw, result } = await connectedHook();
      act(() => result.current.refresh());
      expect(gw.calls[1].method).toBe("progressCard.refresh");
      const params = gw.calls[1].params as { sessionKey: string; idempotencyKey: string };
      expect(params.sessionKey).toBe("agent:main:main");
      expect(params.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.current.refreshState).toBe("pending");
      await act(async () => { gw.calls[1].answer.resolve({ runId: "r1", status: "accepted", revision: 3 }); });
      expect(result.current.refreshState).toBe("pending");

      act(() => result.current.onChanged({ sessionKey: "agent:main:main", revision: 4 }));
      await act(async () => { gw.calls[2].answer.resolve(wire({ revision: 4, markdown: "brought up to date" })); });
      expect(result.current.refreshState).toBe("idle");
      expect(result.current.card?.markdown).toBe("brought up to date");

      act(() => result.current.refresh());
      expect((gw.calls[3].params as { idempotencyKey: string }).idempotencyKey).not.toBe(params.idempotencyKey);
    });

    it("is not done by a card the gateway already had when it took the request", async () => {
      const { gw, result } = await connectedHook();
      act(() => result.current.refresh());
      await act(async () => { gw.calls[1].answer.resolve({ runId: "r1", status: "accepted", revision: 4 }); });
      act(() => result.current.onChanged({ sessionKey: "agent:main:main", revision: 4 }));
      await act(async () => { gw.calls[2].answer.resolve(wire({ revision: 4 })); });
      expect(result.current.refreshState).toBe("pending");
    });

    it("says failed when the gateway refuses, and timeout when no newer card comes", async () => {
      vi.useFakeTimers();
      try {
        const { gw, result } = await connectedHook();
        act(() => result.current.refresh());
        await act(async () => { gw.calls[1].answer.reject(new Error("There is no progress card to refresh.")); });
        expect(result.current.refreshState).toBe("failed");
        expect(result.current.card?.revision).toBe(3);

        act(() => result.current.refresh());
        expect(result.current.refreshState).toBe("pending");
        await act(async () => { gw.calls[2].answer.resolve({ runId: "r2", status: "accepted", revision: 3 }); });
        act(() => { vi.advanceTimersByTime(PROGRESS_CARD_REFRESH_TIMEOUT_MS); });
        expect(result.current.refreshState).toBe("timeout");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps one session's refresh out of another's", async () => {
      const gw = fakeGateway();
      const { result, rerender } = renderHook(
        ({ sessionKey }) => useGatewayProgressCard({ request: gw.request, sessionKey, enabled: true }),
        { initialProps: { sessionKey: "agent:main:main" } },
      );
      await act(async () => { gw.calls[0].answer.resolve(wire()); });
      act(() => result.current.refresh());
      rerender({ sessionKey: "agent:main:tab-2" });
      expect(result.current.refreshState).toBe("idle");
    });
  });
});
