/**
 * Settings → System → ClawBox Improvement Program.
 *
 * THE CARD IS THE CONSENT, so the first thing pinned here is that an owner
 * reading it is actually told what travels and what never does — in the real
 * English catalogue, so a missing key fails here rather than on screen.
 *
 * After that: the mode is never optimistic (the card renders what the route
 * read back, not the button that was pressed), and the Report button appears
 * only where pressing it could do something — `ask` mode, GitHub connected,
 * an incident not already filed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import ImprovementProgramCard from "@/components/ImprovementProgramCard";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const INCIDENT = {
  id: "inc-abc",
  source: "coding-agent",
  message: "Claude Code exited with code 1 before reporting a result.",
  count: 3,
  lastSeen: Date.parse("2026-09-11T10:00:00Z"),
  issueNumber: null as number | null,
};

function state(over: Record<string, unknown> = {}) {
  return {
    mode: "off",
    repo: "ID-Robots/clawbox",
    pending: 1,
    reported: 0,
    total: 1,
    maxIssuesPerDay: 5,
    remainingToday: 5,
    github: { installed: true, connected: true, login: "ada" },
    incidents: [INCIDENT],
    ...over,
  };
}

let calls: { url: string; method: string; body: unknown }[];

/** `answers` is consulted in order; the last one is reused. */
function mockFetch(answers: (() => Response)[]) {
  calls = [];
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return answers[Math.min(i++, answers.length - 1)]();
  }));
}

beforeEach(() => {
  mockFetch([() => json(state())]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("what the card tells the owner before they choose", () => {
  it("says what is sent and what is never sent, in full", async () => {
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    for (const key of [
      "improvement.intro",
      "improvement.sendsTitle", "improvement.sends1", "improvement.sends2", "improvement.sends3",
      "improvement.neverTitle", "improvement.never1", "improvement.never2", "improvement.never3",
    ]) {
      expect(screen.getByText(t(key)), key).toBeTruthy();
    }
  });

  it("promises that the removal happens on the device", async () => {
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    expect(t("improvement.never3")).toMatch(/removed on the device/);
  });

  it("names the repository the reports go to", async () => {
    render(<ImprovementProgramCard />);
    expect(await screen.findByText(/ID-Robots\/clawbox/)).toBeTruthy();
  });

  it("takes the daily limit from the box rather than restating a number", async () => {
    mockFetch([() => json(state({ maxIssuesPerDay: 3 }))]);
    render(<ImprovementProgramCard />);
    expect(await screen.findByText(t("improvement.modeAutoHint", { n: 3 }))).toBeTruthy();
  });
});

describe("the mode", () => {
  it("shows off as the current choice on a box nobody has asked", async () => {
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    expect(screen.getByTestId("improvement-mode-off").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("improvement-mode-auto").getAttribute("aria-checked")).toBe("false");
  });

  it("posts the chosen mode and renders what the route read back — not what was pressed", async () => {
    // The box answers `ask` to a request for `auto`: the card must follow the box.
    mockFetch([() => json(state()), () => json(state({ mode: "ask" }))]);
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    fireEvent.click(screen.getByTestId("improvement-mode-auto"));
    await waitFor(() => expect(screen.getByTestId("improvement-mode-ask").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByTestId("improvement-mode-auto").getAttribute("aria-checked")).toBe("false");
    expect(calls[1]).toMatchObject({ url: "/setup-api/improvement-program", method: "POST", body: { mode: "auto" } });
  });

  it("shows the box's own refusal and leaves the mode where it was", async () => {
    mockFetch([() => json(state()), () => json({ error: "Only from this ClawBox's own pages.", code: "cross_origin" }, 403)]);
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    fireEvent.click(screen.getByTestId("improvement-mode-ask"));
    expect(await screen.findByText("Only from this ClawBox's own pages.")).toBeTruthy();
    expect(screen.getByTestId("improvement-mode-off").getAttribute("aria-checked")).toBe("true");
  });

  it("does not post the mode that is already set", async () => {
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    fireEvent.click(screen.getByTestId("improvement-mode-off"));
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});

describe("the GitHub line", () => {
  it("is silent while the programme is off — there is nothing to connect for yet", async () => {
    mockFetch([() => json(state({ mode: "off", github: { installed: false, connected: false, login: null } }))]);
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    expect(screen.queryByTestId("improvement-github")).toBeNull();
  });

  it("asks for a connection once the programme is on, because nothing can be sent without one", async () => {
    mockFetch([() => json(state({ mode: "auto", github: { installed: true, connected: false, login: null } }))]);
    render(<ImprovementProgramCard />);
    expect((await screen.findByTestId("improvement-github")).textContent).toBe(t("improvement.githubMissing"));
  });

  it("names the account when there is one", async () => {
    mockFetch([() => json(state({ mode: "ask" }))]);
    render(<ImprovementProgramCard />);
    expect((await screen.findByTestId("improvement-github")).textContent)
      .toBe(t("improvement.githubConnected", { login: "ada" }));
  });
});

describe("what is on the box", () => {
  it("says nothing has gone wrong when nothing has", async () => {
    mockFetch([() => json(state({ pending: 0, total: 0, incidents: [] }))]);
    render(<ImprovementProgramCard />);
    expect((await screen.findByTestId("improvement-counts")).textContent).toBe(t("improvement.none"));
    expect(screen.queryByTestId("improvement-recent")).toBeNull();
  });

  it("counts what is waiting and what is filed", async () => {
    mockFetch([() => json(state({ pending: 2, reported: 4, total: 6 }))]);
    render(<ImprovementProgramCard />);
    const text = (await screen.findByTestId("improvement-counts")).textContent ?? "";
    expect(text).toContain(t("improvement.pending", { n: 2 }));
    expect(text).toContain(t("improvement.reported", { n: 4 }));
  });

  it("lists a recent error with its count and its issue number", async () => {
    mockFetch([() => json(state({ mode: "ask", incidents: [{ ...INCIDENT, issueNumber: 912 }] }))]);
    render(<ImprovementProgramCard />);
    const list = await screen.findByTestId("improvement-recent");
    expect(list.textContent).toContain(INCIDENT.message);
    expect(list.textContent).toContain(t("improvement.seen", { n: 3 }));
    expect(list.textContent).toContain(t("improvement.issue", { n: 912 }));
  });
});

describe("the Report button", () => {
  it("is offered in ask mode for an unreported incident", async () => {
    mockFetch([() => json(state({ mode: "ask" }))]);
    render(<ImprovementProgramCard />);
    expect(await screen.findByTestId("improvement-report-inc-abc")).toBeTruthy();
  });

  it("is not offered while the programme is off — the route would only refuse", async () => {
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    expect(screen.queryByTestId("improvement-report-inc-abc")).toBeNull();
  });

  it("is not offered on automatic, where the box files by itself", async () => {
    mockFetch([() => json(state({ mode: "auto" }))]);
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    expect(screen.queryByTestId("improvement-report-inc-abc")).toBeNull();
  });

  it("is not offered without GitHub, nor on an incident already filed", async () => {
    mockFetch([() => json(state({ mode: "ask", github: { installed: true, connected: false, login: null } }))]);
    const { unmount } = render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    expect(screen.queryByTestId("improvement-report-inc-abc")).toBeNull();
    unmount();

    mockFetch([() => json(state({ mode: "ask", incidents: [{ ...INCIDENT, issueNumber: 7 }] }))]);
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    expect(screen.queryByTestId("improvement-report-inc-abc")).toBeNull();
  });

  it("posts the id and says which issue it became", async () => {
    mockFetch([
      () => json(state({ mode: "ask" })),
      () => json({ ok: true, action: "created", issueNumber: 912 }),
      () => json(state({ mode: "ask", pending: 0, reported: 1, incidents: [{ ...INCIDENT, issueNumber: 912 }] })),
    ]);
    render(<ImprovementProgramCard />);
    fireEvent.click(await screen.findByTestId("improvement-report-inc-abc"));
    expect(await screen.findByText(t("improvement.reportedNow", { n: 912 }))).toBeTruthy();
    expect(calls[1]).toMatchObject({
      url: "/setup-api/improvement-program/report", method: "POST", body: { id: "inc-abc" },
    });
  });

  it("says a known fault was noted rather than filed again", async () => {
    mockFetch([
      () => json(state({ mode: "ask" })),
      () => json({ ok: true, action: "commented", issueNumber: 404 }),
      () => json(state({ mode: "ask" })),
    ]);
    render(<ImprovementProgramCard />);
    fireEvent.click(await screen.findByTestId("improvement-report-inc-abc"));
    expect(await screen.findByText(t("improvement.commentedNow", { n: 404 }))).toBeTruthy();
  });

  it("shows the box's own words when the send is refused", async () => {
    mockFetch([
      () => json(state({ mode: "ask" })),
      () => json({ ok: false, error: "This ClawBox has already filed 5 reports today.", code: "rate_limited" }, 429),
    ]);
    render(<ImprovementProgramCard />);
    fireEvent.click(await screen.findByTestId("improvement-report-inc-abc"));
    expect(await screen.findByText("This ClawBox has already filed 5 reports today.")).toBeTruthy();
  });
});

describe("a payload the card did not expect", () => {
  /**
   * The card sits inside Settings → System. A throw during its render unmounts
   * the WHOLE window — which is exactly what happened: `state?.github.connected`
   * optional-chained the state and then dereferenced `github`, so a 200 without
   * that field took the Settings window off the screen (caught by the e2e
   * `shelf-system-settings` and `settings-workflow` specs, where the window
   * never appeared at all).
   */
  it.each([
    ["no github field", { mode: "ask", incidents: [] }],
    ["no incidents field", { mode: "auto", github: { connected: true, login: "ada" } }],
    ["an empty object", {}],
    ["a mode that is not one of the three", { mode: "everything", github: {}, incidents: [] }],
    ["incidents that are not rows", { mode: "ask", github: {}, incidents: [null, 7, "x"] }],
    ["a body that is not an object at all", [1, 2, 3]],
  ])("renders rather than taking Settings down: %s", async (_name, body) => {
    mockFetch([() => json(body)]);
    render(<ImprovementProgramCard />);
    expect(await screen.findByTestId("improvement-program-card")).toBeTruthy();
    // …and falls back to the safe end of every field it could not read.
    expect(screen.getByTestId("improvement-counts").textContent).toBe(t("improvement.none"));
  });

  it("falls back to OFF for a mode it does not recognise — never to a sending one", async () => {
    mockFetch([() => json(state({ mode: "everything" }))]);
    render(<ImprovementProgramCard />);
    await screen.findByTestId("improvement-program-card");
    expect(screen.getByTestId("improvement-mode-off").getAttribute("aria-checked")).toBe("true");
  });
});

describe("when the box cannot be read", () => {
  it("says so instead of rendering an empty card", async () => {
    mockFetch([() => json({ error: "nope" }, 500)]);
    render(<ImprovementProgramCard />);
    expect(await screen.findByText(t("improvement.loadFailed"))).toBeTruthy();
  });
});
