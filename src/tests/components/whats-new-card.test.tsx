import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import WhatsNewCard from "@/components/WhatsNewCard";
import { translations } from "@/lib/translations";
import { useWhatsNew } from "@/lib/use-whats-new";
import {
  WHATS_NEW_DOCS_URL,
  WHATS_NEW_PLANS_URL,
  type WhatsNewPlanCta,
  type WhatsNewState,
} from "@/lib/whats-new";
import { LANGUAGES, type Locale } from "@/lib/i18n";

/**
 * TASK-1059: the desktop's "What's new in 4.0" card.
 *
 * The card names the 4.0 highlights, links the docs page, and offers the plan
 * only for what the box's plan does not cover yet. The Hermes edition is told
 * about switching back to OpenClaw.
 */

let locale: Locale = "en";

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale,
    localeResolved: true,
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let s = translations[locale][key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
  }),
}));

const en = translations.en;

function stateWith(cta: WhatsNewPlanCta, overrides: Partial<WhatsNewState> = {}): WhatsNewState {
  return {
    show: true,
    release: "4.0",
    version: "4.0.0",
    edition: "openclaw",
    cta,
    freeMonthCode: null,
    ...overrides,
  };
}

const FREE_OPENCLAW = stateWith({ paidFeatures: true, editionSwitch: "hermes" });
const PRO_OPENCLAW = stateWith({ paidFeatures: false, editionSwitch: "hermes" });
const MAX = stateWith({ paidFeatures: false, editionSwitch: null });
const FREE_HERMES = stateWith({ paidFeatures: true, editionSwitch: "openclaw" }, { edition: "hermes" });

beforeEach(() => {
  locale = "en";
});

describe("WhatsNewCard", () => {
  it("names the four 4.0 highlights from the release notes", () => {
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} />);
    const card = screen.getByRole("region", { name: en["whatsNew.title"] });
    expect(within(card).getByText("This box now runs ClawBox 4.0.0.")).toBeInTheDocument();
    const list = within(card).getByRole("list", { name: en["whatsNew.highlightsLabel"] });
    const items = within(list).getAllByRole("listitem");
    // The words, without the icon's ligature name (the glyph is aria-hidden).
    const words = (li: HTMLElement) =>
      Array.from(li.children).filter((el) => el.getAttribute("aria-hidden") !== "true").map((el) => el.textContent).join("");
    expect(items.map(words)).toEqual([
      en["whatsNew.codingAgentTitle"] + en["whatsNew.codingAgentBody"],
      en["whatsNew.hostnameTitle"] + en["whatsNew.hostnameBody"],
      en["whatsNew.phoneChatTitle"] + en["whatsNew.phoneChatBody"],
      en["whatsNew.modelPillsTitle"] + en["whatsNew.modelPillsBody"],
    ]);
  });

  it("prints a tag-style version without its v", () => {
    render(<WhatsNewCard state={{ ...MAX, version: "v4.0.1" }} onDismiss={() => {}} />);
    expect(screen.getByText("This box now runs ClawBox 4.0.1.")).toBeInTheDocument();
  });

  it("drops the version line rather than print a blank version", () => {
    render(<WhatsNewCard state={{ ...MAX, version: null }} onDismiss={() => {}} />);
    expect(screen.queryByText(/This box now runs/)).toBeNull();
  });

  it("links the docs page in a new tab", () => {
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} />);
    const link = screen.getByRole("link", { name: new RegExp(en["whatsNew.readMore"]) });
    expect(link).toHaveAttribute("href", WHATS_NEW_DOCS_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("a box with no paid plan is offered both lines and the tagged portal link", () => {
    render(<WhatsNewCard state={FREE_OPENCLAW} onDismiss={() => {}} />);
    const plan = screen.getByTestId("whats-new-plan");
    expect(within(plan).getByText(en["whatsNew.planTitle"])).toBeInTheDocument();
    expect(within(plan).getByText(en["whatsNew.planPaidFeatures"])).toBeInTheDocument();
    expect(within(plan).getByText(en["whatsNew.planSwitchToHermes"])).toBeInTheDocument();
    expect(within(plan).queryByText(en["whatsNew.planSwitchToOpenclaw"])).toBeNull();

    const cta = screen.getByRole("link", { name: new RegExp(en["whatsNew.seePlans"]) });
    expect(cta).toHaveAttribute("href", WHATS_NEW_PLANS_URL);
    expect(cta.getAttribute("href")).toContain("utm_source=box&utm_medium=update_card&utm_campaign=v4");
    expect(cta).toHaveAttribute("target", "_blank");
  });

  it("a Pro box is offered only the Max-only edition switch", () => {
    render(<WhatsNewCard state={PRO_OPENCLAW} onDismiss={() => {}} />);
    const plan = screen.getByTestId("whats-new-plan");
    expect(within(plan).queryByText(en["whatsNew.planPaidFeatures"])).toBeNull();
    expect(within(plan).getByText(en["whatsNew.planSwitchToHermes"])).toBeInTheDocument();
    expect(screen.getByRole("link", { name: new RegExp(en["whatsNew.seePlans"]) })).toBeInTheDocument();
  });

  it("a Max box is offered nothing: no plan section and no portal link", () => {
    render(<WhatsNewCard state={MAX} onDismiss={() => {}} />);
    expect(screen.queryByTestId("whats-new-plan")).toBeNull();
    expect(screen.queryByRole("link", { name: new RegExp(en["whatsNew.seePlans"]) })).toBeNull();
    expect(screen.getByRole("button", { name: en["whatsNew.gotIt"] })).toBeInTheDocument();
  });

  it("the Hermes edition is told about switching back to OpenClaw", () => {
    render(<WhatsNewCard state={FREE_HERMES} onDismiss={() => {}} />);
    const plan = screen.getByTestId("whats-new-plan");
    expect(within(plan).getByText(en["whatsNew.planSwitchToOpenclaw"])).toBeInTheDocument();
    expect(within(plan).queryByText(en["whatsNew.planSwitchToHermes"])).toBeNull();
  });

  it("draws nothing for a free-month code: the portal publishes none, and the card has no UI for it", () => {
    render(<WhatsNewCard state={{ ...FREE_OPENCLAW, freeMonthCode: "FREEMONTH-123" }} onDismiss={() => {}} />);
    expect(screen.queryByText(/FREEMONTH-123/)).toBeNull();
  });

  it("both the close button and Got it dismiss the card", () => {
    const onDismiss = vi.fn();
    render(<WhatsNewCard state={FREE_OPENCLAW} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: en["whatsNew.dismiss"] }));
    fireEvent.click(screen.getByRole("button", { name: en["whatsNew.gotIt"] }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  describe.each(LANGUAGES.map((l) => l.code).filter((code) => code !== "en"))("in '%s'", (code) => {
    it("renders the locale's own copy and no raw keys", () => {
      locale = code;
      const { container } = render(<WhatsNewCard state={FREE_HERMES} onDismiss={() => {}} />);
      const table = translations[code];
      expect(screen.getByRole("heading", { name: table["whatsNew.title"] })).toBeInTheDocument();
      expect(table["whatsNew.title"]).not.toBe(en["whatsNew.title"]);
      expect(screen.getByText(table["whatsNew.planSwitchToOpenclaw"])).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/whatsNew\./);
      expect(container.textContent).toContain("4.0.0");
    });
  });
});

/** The hook the desktop drives the card with. */
function Harness({ refreshKey }: { refreshKey?: unknown }) {
  const { state, visible, dismiss, hide } = useWhatsNew(refreshKey);
  return (
    <div>
      <span data-testid="visible">{String(visible)}</span>
      <span data-testid="release">{state?.release ?? "none"}</span>
      <button onClick={dismiss}>dismiss</button>
      <button onClick={hide}>hide</button>
    </div>
  );
}

function jsonResponse(data: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(data) });
}

describe("useWhatsNew", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "POST" ? jsonResponse({ ok: true, show: false }) : jsonResponse(FREE_OPENCLAW),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the card when the route says so", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("visible")).toHaveTextContent("true"));
    expect(fetchMock).toHaveBeenCalledWith("/setup-api/whats-new", { cache: "no-store" });
  });

  it("does not show it when the route says no", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ ...FREE_OPENCLAW, show: false }));
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("release")).toHaveTextContent("4.0"));
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
  });

  it("draws nothing from an answer it cannot read, or a failed request", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ show: true }));
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
    unmount();

    fetchMock.mockImplementation(() => Promise.reject(new Error("offline")));
    render(<Harness />);
    await act(async () => {});
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
  });

  it("dismiss hides the card and records it on the box, once", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("visible")).toHaveTextContent("true"));
    fireEvent.click(screen.getByText("dismiss"));
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe("/setup-api/whats-new");
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ release: "4.0" });
  });

  it("an answer still in flight when the owner dismissed cannot bring the card back", async () => {
    let answer!: (value: unknown) => void;
    const { rerender } = render(<Harness refreshKey="free" />);
    await waitFor(() => expect(screen.getByTestId("visible")).toHaveTextContent("true"));

    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse({ ok: true })
        : new Promise((resolve) => { answer = resolve; }),
    );
    rerender(<Harness refreshKey="flash" />);
    fireEvent.click(screen.getByText("dismiss"));
    await act(async () => {
      answer({ ok: true, status: 200, json: () => Promise.resolve(FREE_OPENCLAW) });
    });
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
  });

  it("hide is for this page load only and records nothing", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("visible")).toHaveTextContent("true"));
    fireEvent.click(screen.getByText("hide"));
    expect(screen.getByTestId("visible")).toHaveTextContent("false");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("asks the route again when the refresh key (the plan tier) changes", async () => {
    const { rerender } = render(<Harness refreshKey={null} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<Harness refreshKey="flash" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
