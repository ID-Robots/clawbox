import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor, within } from "@/tests/helpers/test-utils";
import UpdateWhatsNewPanel from "@/components/UpdateWhatsNewPanel";
import UpdatingPage from "@/app/updating/page";
import { translations } from "@/lib/translations";
import { LANGUAGES, type Locale } from "@/lib/i18n";
import { WHATS_NEW_RELEASE } from "@/lib/whats-new";
import {
  CLAWBOX_RELEASES_URL,
  releasePageUrl,
  updateWhatsNewPanel,
  UPDATE_WHATS_NEW_ENDPOINT,
  type UpdateWhatsNew,
} from "@/lib/update-whats-new";
import {
  MAX_NONE_ANSWERS,
  RETRY_AFTER_FAILURE_MS,
  RETRY_AFTER_NONE_MS,
  useUpdateWhatsNew,
} from "@/lib/use-update-whats-new";

/**
 * TASK-1205: the "What's new" panel on the /updating screen.
 *
 * It shows the highlights of the version being installed, is never empty, and
 * never takes the step list's place: the steps come first in the page, the
 * panel after them (beside them from `lg` up). Its strings read in every
 * locale, and in English — never as raw keys — when the catalogue could not
 * be loaded, because this is the screen that stays open while the box is
 * offline.
 */

/** `"raw"`: the catalogue never loaded, so `t()` answers the key itself. */
let locale: Locale | "raw" = "en";

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  // The page mounts its own provider; its locale read is not what is tested.
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
  useT: () => ({
    locale: locale === "raw" ? "en" : locale,
    localeResolved: true,
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let s = locale === "raw" ? key : translations[locale][key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
  }),
}));

const NOTES: UpdateWhatsNew = {
  version: "4.2.0",
  channel: "main",
  source: "notes",
  highlights: [
    { title: "Faster updates", body: "The box downloads less and restarts once." },
    { title: "", body: "A highlight with no bold lead." },
  ],
  releaseUrl: releasePageUrl("4.2.0"),
};
const NONE_ON_LINE: UpdateWhatsNew = { ...NOTES, version: `${WHATS_NEW_RELEASE}.9`, source: "none", highlights: [] };
const NONE_OFF_LINE: UpdateWhatsNew = { ...NOTES, version: "9.0.0", source: "none", highlights: [] };

beforeEach(() => {
  locale = "en";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("UpdateWhatsNewPanel", () => {
  it("names the version and lists the highlights read from its notes, marked as English", () => {
    render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel(NOTES)} />);
    const panel = screen.getByRole("region", { name: "What's new in ClawBox 4.2.0" });
    expect(panel).toHaveAttribute("data-kind", "notes");
    expect(within(panel).getByText("While you wait, here is what the version being installed brings.")).toBeInTheDocument();
    const list = within(panel).getByRole("list");
    expect(list).toHaveAttribute("lang", "en");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Faster updatesThe box downloads less and restarts once.",
      "A highlight with no bold lead.",
    ]);
    const link = within(panel).getByRole("link", { name: "Read the full release notes" });
    expect(link).toHaveAttribute("href", "https://github.com/ID-Robots/clawbox/releases/tag/v4.2.0");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(panel).queryByTestId("update-whats-new-channel")).toBeNull();
  });

  it("names a channel other than main, and cuts a long one rather than widen the panel", () => {
    const { unmount } = render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel({ ...NOTES, channel: "beta" })} />);
    expect(screen.getByTestId("update-whats-new-channel")).toHaveTextContent("beta channel");
    unmount();

    const pin = "qa/a-very-long-branch-name-somebody-pinned-for-testing";
    render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel({ ...NOTES, channel: pin })} />);
    const badge = screen.getByTestId("update-whats-new-channel");
    expect(badge).toHaveClass("truncate");
    expect(badge).not.toHaveClass("shrink-0");
    expect(badge).toHaveAttribute("title", pin);
  });

  it("draws two identical highlights as two items, without a key clash", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const same = { title: "Same", body: "Twice." };
    render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel({ ...NOTES, highlights: [same, same] })} />);
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key/i);
  });

  it("falls back to this build's own highlights, in the owner's language, for a target on their line", () => {
    locale = "de";
    render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel(NONE_ON_LINE)} />);
    const de = translations.de;
    const panel = screen.getByRole("region", { name: de["whatsNew.highlightsLabel"] });
    expect(panel).toHaveAttribute("data-kind", "bundled");
    const list = within(panel).getByRole("list");
    expect(list).not.toHaveAttribute("lang");
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getByText(de["whatsNew.phoneFullscreenTitle"])).toBeInTheDocument();
    expect(within(list).getByText(de["whatsNew.autoMergeBody"])).toBeInTheDocument();
    expect(within(panel).getByRole("link")).toHaveAttribute("href", releasePageUrl(NONE_ON_LINE.version));
  });

  it("falls back to one plain line and the release page for a target on another line", () => {
    render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel(NONE_OFF_LINE)} />);
    const panel = screen.getByRole("region", { name: "What's new in ClawBox 9.0.0" });
    expect(panel).toHaveAttribute("data-kind", "generic");
    expect(within(panel).queryByRole("list")).toBeNull();
    expect(within(panel).getByText(/latest ClawBox improvements and fixes/)).toBeInTheDocument();
    expect(within(panel).getByRole("link")).toHaveAttribute("href", releasePageUrl("9.0.0"));
  });

  it("is never empty, even with no answer at all", () => {
    render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel(null)} />);
    const panel = screen.getByRole("region", { name: "What's new in this update" });
    expect(within(panel).getByText(/latest ClawBox improvements and fixes/)).toBeInTheDocument();
    expect(within(panel).getByRole("link")).toHaveAttribute("href", CLAWBOX_RELEASES_URL);
  });

  it("reads English, never raw keys, when the catalogue could not be loaded", () => {
    locale = "raw";
    const { unmount } = render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel({ ...NOTES, channel: "beta" })} />);
    expect(screen.getByRole("region", { name: "What's new in ClawBox 4.2.0" })).toBeInTheDocument();
    expect(screen.getByText("beta channel")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/update\.whatsNew|whatsNew\./);
    unmount();

    render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel(NONE_ON_LINE)} />);
    expect(screen.getByRole("region", { name: `Highlights of ClawBox ${WHATS_NEW_RELEASE}` })).toBeInTheDocument();
    expect(screen.getByText("More of the phone for the chat")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/update\.whatsNew|whatsNew\./);
  });

  it.each(LANGUAGES.map((l) => l.code))("has every string translated in '%s'", (code) => {
    locale = code;
    for (const answer of [{ ...NOTES, channel: "beta" }, NONE_OFF_LINE, null]) {
      const { unmount } = render(<UpdateWhatsNewPanel panel={updateWhatsNewPanel(answer)} />);
      expect(document.body.textContent).not.toMatch(/update\.whatsNew|whatsNew\.|\{version\}|\{channel\}/);
      unmount();
    }
  });
});

function respond(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 503, json: async () => body } as Response;
}

describe("useUpdateWhatsNew", () => {
  it("draws nothing until the first ask settles, then keeps a notes answer and asks no more", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => respond(NOTES));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useUpdateWhatsNew());
    expect(result.current).toEqual({ answer: null, settled: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toEqual({ answer: NOTES, settled: true });
    expect(fetchMock).toHaveBeenCalledWith(UPDATE_WHATS_NEW_ENDPOINT, expect.objectContaining({ cache: "no-store" }));

    await act(async () => { await vi.advanceTimersByTimeAsync(10 * RETRY_AFTER_NONE_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("settles on a failure — the panel falls back — and asks again until the server is back", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(respond({ error: "gone" }, false))
      .mockResolvedValueOnce(respond({ not: "an answer" }))
      .mockResolvedValue(respond(NOTES));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useUpdateWhatsNew());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toEqual({ answer: null, settled: true });

    await act(async () => { await vi.advanceTimersByTimeAsync(2 * RETRY_AFTER_FAILURE_MS); });
    expect(result.current.answer).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_AFTER_FAILURE_MS); });
    expect(result.current.answer).toEqual(NOTES);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("asks past a `none` answer a few times, then stops", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => respond(NONE_OFF_LINE));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useUpdateWhatsNew());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.answer).toEqual(NONE_OFF_LINE);
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * RETRY_AFTER_NONE_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_NONE_ANSWERS);
  });

  it("never trades highlights it has for a worse answer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond(NONE_OFF_LINE))
      .mockResolvedValueOnce(respond(NOTES));
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useUpdateWhatsNew());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.answer).toEqual(NONE_OFF_LINE);
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_AFTER_NONE_MS); });
    expect(result.current.answer).toEqual(NOTES);
    unmount();
  });

  it("asks again when the refresh key changes, and keeps the newer highlights", async () => {
    vi.useFakeTimers();
    const OLD: UpdateWhatsNew = { ...NOTES, version: "4.1.0", releaseUrl: releasePageUrl("4.1.0") };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond(OLD))
      .mockResolvedValueOnce(respond(NOTES))
      .mockResolvedValueOnce(respond(NONE_OFF_LINE));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(({ key }) => useUpdateWhatsNew(key), { initialProps: { key: 0 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.answer).toEqual(OLD);

    rerender({ key: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.answer).toEqual(NOTES);

    // A later "could not read them" does not take the highlights away.
    rerender({ key: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.answer).toEqual(NOTES);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops asking when the screen goes away", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() => useUpdateWhatsNew());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * RETRY_AFTER_FAILURE_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the /updating screen", () => {
  const RUNNING = {
    phase: "running",
    currentStepIndex: 8,
    steps: [
      { id: "bootstrap_updater", label: "Refreshing updater scripts", status: "completed" },
      { id: "restart", label: "Updating ClawBox and restarting", status: "completed" },
      { id: "post_update", label: "Applying system fixups", status: "running" },
      { id: "gateway_verify", label: "Verifying gateway health", status: "pending" },
    ],
  };

  function stubRoutes(whatsNew: () => Promise<Response>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/setup-api/update/status") return respond(RUNNING);
      if (url === UPDATE_WHATS_NEW_ENDPOINT) return whatsNew();
      return respond({}, false);
    }));
  }

  it("draws the panel AFTER the step list, which stays whole", async () => {
    stubRoutes(async () => respond(NOTES));
    render(<UpdatingPage />);

    const panel = await screen.findByRole("region", { name: "What's new in ClawBox 4.2.0" });
    const step = await screen.findByText("Applying system fixups");
    expect(screen.getByText("Verifying gateway health")).toBeInTheDocument();
    expect(screen.getByText("Faster updates")).toBeInTheDocument();
    // The steps come first in the document: a phone reads them before the panel.
    expect(step.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("reconnect-stage-with-aside")).toContainElement(panel);
  });

  it("re-asks the server that comes back after an outage, and draws its answer", async () => {
    const OLD: UpdateWhatsNew = { ...NOTES, version: "4.1.0", releaseUrl: releasePageUrl("4.1.0") };
    let serverUp = true;
    const whatsNewAnswers = [OLD, NOTES];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/setup-api/update/status") {
        if (!serverUp) throw new TypeError("Failed to fetch");
        return respond(RUNNING);
      }
      if (url === UPDATE_WHATS_NEW_ENDPOINT) return respond(whatsNewAnswers.shift() ?? NOTES);
      return respond({}, false);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<UpdatingPage />);
    await screen.findByRole("region", { name: "What's new in ClawBox 4.1.0" });

    // The rebuild takes the server down for a poll or two, then it answers again.
    serverUp = false;
    await screen.findByText(/The device is restarting/, undefined, { timeout: 5_000 });
    serverUp = true;
    await screen.findByRole("region", { name: "What's new in ClawBox 4.2.0" }, { timeout: 5_000 });
    expect(fetchMock.mock.calls.filter(([url]) => url === UPDATE_WHATS_NEW_ENDPOINT)).toHaveLength(2);
  }, 20_000);

  it("still shows the steps and a fallback panel when the What's new route cannot be reached", async () => {
    stubRoutes(async () => { throw new TypeError("Failed to fetch"); });
    render(<UpdatingPage />);

    await screen.findByText("Applying system fixups");
    const panel = await screen.findByRole("region", { name: "What's new in this update" });
    await waitFor(() => expect(panel).toHaveAttribute("data-kind", "generic"));
    expect(within(panel).getByRole("link")).toHaveAttribute("href", CLAWBOX_RELEASES_URL);
  });
});
