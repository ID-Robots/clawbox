import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EditionStep, { readEditionChoiceStatus } from "@/components/EditionStep";

/**
 * "Choose your assistant" (TASK-1149): the wizard step in front of Update on
 * a unified-image box. The route is mocked; what is pinned is what the owner
 * sees and what the step sends — the two cards and the recommendation, the
 * order hint, the POST, the progress, the wait for the restart, and the error
 * views with their retry.
 */

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    // Parameters are appended so a test can see which agent a sentence names.
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}[${Object.values(params).join(",")}]` : key,
  }),
}));

vi.mock("next/image", () => ({
  default: ({ alt = "", src }: { alt?: string; src: string }) => <img alt={alt} src={src} />,
}));

const STARTED = 1_700_000_000_000;

interface Status {
  needed: boolean;
  unselected?: boolean;
  pending?: string | null;
  hint?: string | null;
  inProgress?: boolean;
  inProgressTarget?: string | null;
  serverStartedAt?: number;
}

function status(s: Status): Record<string, unknown> {
  return {
    unselected: s.needed && !s.pending,
    pending: null,
    hint: null,
    inProgress: false,
    inProgressTarget: null,
    serverStartedAt: STARTED,
    edition: null,
    ...s,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function ndjson(lines: Record<string, unknown>[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

/**
 * The device: GET answers come from `gets` in order (the last one repeats),
 * POST answers from `posts`.
 */
function device(gets: (Record<string, unknown> | Error)[], posts: Response[] = []) {
  let g = 0;
  let p = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("/setup-api/setup/edition");
    if (init?.method === "POST") {
      const res = posts[Math.min(p, posts.length - 1)];
      p += 1;
      return res.clone();
    }
    const next = gets[Math.min(g, gets.length - 1)];
    g += 1;
    if (next instanceof Error) throw next;
    return json(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postedBodies(fetchMock: ReturnType<typeof device>): unknown[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EditionStep — choosing", () => {
  it("offers both agents, OpenClaw preselected and recommended, with one primary button", async () => {
    device([status({ needed: true })]);
    render(<EditionStep onReady={vi.fn()} pollMs={5} />);

    expect(await screen.findByText("assistant.title")).toBeInTheDocument();
    const openclaw = screen.getByTestId("edition-card-openclaw");
    const hermes = screen.getByTestId("edition-card-hermes");
    expect(openclaw).toHaveAttribute("data-selected", "true");
    expect(hermes).toHaveAttribute("data-selected", "false");
    expect(within(openclaw).getByText("assistant.recommended")).toBeInTheDocument();
    expect(within(hermes).queryByText("assistant.recommended")).toBeNull();
    // One plain sentence and three "good if" lines per card.
    expect(within(openclaw).getByText("assistant.openclawWhat")).toBeInTheDocument();
    expect(within(hermes).getByText("assistant.hermesWhat")).toBeInTheDocument();
    expect(within(hermes).getAllByRole("listitem")).toHaveLength(3);
    // The recommendation and whether it can be changed later.
    expect(screen.getByText("assistant.recommendLine")).toBeInTheDocument();
    expect(screen.getByText("assistant.changeLater")).toBeInTheDocument();
    expect(screen.getByTestId("edition-continue")).toHaveTextContent("assistant.continue[OpenClaw]");
    // Real radios, one group.
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByTestId("edition-hint")).toBeNull();
  });

  it("preselects the agent the box was prepared for, and says why", async () => {
    device([status({ needed: true, hint: "hermes" })]);
    render(<EditionStep onReady={vi.fn()} pollMs={5} />);

    expect(await screen.findByTestId("edition-hint")).toHaveTextContent("assistant.hint[Hermes]");
    expect(screen.getByTestId("edition-card-hermes")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("edition-continue")).toHaveTextContent("assistant.continue[Hermes]");
    // A hint never locks: the other card is still a choice.
    fireEvent.click(screen.getByTestId("edition-card-openclaw"));
    expect(screen.getByTestId("edition-continue")).toHaveTextContent("assistant.continue[OpenClaw]");
  });

  it("goes straight on when the box needs no choice", async () => {
    device([status({ needed: false })]);
    const onReady = vi.fn();
    render(<EditionStep onReady={onReady} pollMs={5} />);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it("offers a retry when the box cannot be asked", async () => {
    const fetchMock = device([new Error("offline"), status({ needed: true })]);
    render(<EditionStep onReady={vi.fn()} pollMs={5} />);
    fireEvent.click(await screen.findByText("retry"));
    expect(await screen.findByTestId("edition-card-openclaw")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("EditionStep — setting up", () => {
  it("posts the choice, shows progress, waits for the restart, then moves on", async () => {
    const fetchMock = device(
      [
        status({ needed: true }),
        // After the stream: the box answers from the SAME server first…
        status({ needed: false, serverStartedAt: STARTED }),
        // …and then from the restarted one.
        status({ needed: false, serverStartedAt: STARTED + 30_000 }),
      ],
      [ndjson([
        { phase: "request" },
        { phase: "check" },
        { phase: "lock" },
        { phase: "provision" },
        { phase: "cleanup" },
        { phase: "done" },
        { success: true, edition: "hermes", restarting: true },
      ])],
    );
    const onReady = vi.fn();
    render(<EditionStep onReady={onReady} pollMs={5} />);

    fireEvent.click(await screen.findByTestId("edition-card-hermes"));
    fireEvent.click(screen.getByTestId("edition-continue"));

    expect(await screen.findByText("assistant.settingUpTitle[Hermes]")).toBeInTheDocument();
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(postedBodies(fetchMock)).toEqual([{ edition: "hermes" }]);
  });

  it("marks finished phases done and the restart as the current row", async () => {
    device(
      [status({ needed: true }), status({ needed: false, serverStartedAt: STARTED })],
      [ndjson([{ phase: "request" }, { phase: "check" }, { phase: "lock" }, { phase: "provision" }, { phase: "cleanup" }, { phase: "done" }, { success: true }])],
    );
    render(<EditionStep onReady={vi.fn()} pollMs={50} />);
    fireEvent.click(await screen.findByTestId("edition-continue"));

    const list = await screen.findByTestId("edition-progress");
    await waitFor(() => {
      const rows = within(list).getAllByRole("listitem");
      expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["done", "done", "done", "done", "current"]);
    });
    expect(within(list).getByText("assistant.phaseRestart[OpenClaw]")).toBeInTheDocument();
  });

  it("follows the box when the stream is lost, until the restarted server says it is done", async () => {
    const lost = new Response("", { status: 200 });
    const onReady = vi.fn();
    device(
      [
        status({ needed: true }),
        new Error("restarting"),
        status({ needed: true, inProgress: true, inProgressTarget: "openclaw" }),
        status({ needed: false, serverStartedAt: STARTED + 1 }),
      ],
      [lost],
    );
    render(<EditionStep onReady={onReady} pollMs={5} />);
    fireEvent.click(await screen.findByTestId("edition-continue"));
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it("resumes following a step already running when the page loads", async () => {
    const onReady = vi.fn();
    device([
      status({ needed: true, inProgress: true, inProgressTarget: "hermes" }),
      status({ needed: false, serverStartedAt: STARTED + 1 }),
    ]);
    render(<EditionStep onReady={onReady} pollMs={5} />);
    expect(await screen.findByText("assistant.settingUpTitle[Hermes]")).toBeInTheDocument();
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });
});

describe("EditionStep — when it fails", () => {
  it("says nothing changed, keeps the step's sentence behind Details, and retries or lets the owner choose again", async () => {
    const fetchMock = device(
      [status({ needed: true })],
      [ndjson([
        { phase: "request" },
        { phase: "check" },
        { error: "Error: the check phase failed — Hermes does not run on this box", code: "select_failed", unselected: true, pending: null },
      ])],
    );
    render(<EditionStep onReady={vi.fn()} pollMs={5} />);
    fireEvent.click(await screen.findByTestId("edition-card-hermes"));
    fireEvent.click(screen.getByTestId("edition-continue"));

    expect(await screen.findByText("assistant.failedTitle[Hermes]")).toBeInTheDocument();
    expect(screen.getByTestId("edition-failed-body")).toHaveTextContent("assistant.failedBody");
    expect(screen.getByTestId("edition-failed-detail")).toHaveTextContent("Hermes does not run on this box");

    fireEvent.click(screen.getByTestId("edition-retry"));
    await waitFor(() => expect(postedBodies(fetchMock)).toEqual([{ edition: "hermes" }, { edition: "hermes" }]));

    fireEvent.click(await screen.findByText("assistant.chooseOther"));
    expect(await screen.findByTestId("edition-card-openclaw")).toBeInTheDocument();
  });

  it("only offers to FINISH the agent a cut-short activation locked the box to", async () => {
    const fetchMock = device(
      [status({ needed: true, pending: "hermes" })],
      [ndjson([{ phase: "request" }, { success: true }])],
    );
    render(<EditionStep onReady={vi.fn()} pollMs={5} />);

    expect(await screen.findByText("assistant.failedTitle[Hermes]")).toBeInTheDocument();
    expect(screen.getByTestId("edition-failed-body")).toHaveTextContent("assistant.pendingBody[Hermes]");
    expect(screen.queryByText("assistant.chooseOther")).toBeNull();
    fireEvent.click(screen.getByTestId("edition-retry"));
    await waitFor(() => expect(postedBodies(fetchMock)).toEqual([{ edition: "hermes" }]));
  });

  it("turns a failure after the lock flipped into the finish-it view", async () => {
    device(
      [status({ needed: true })],
      [ndjson([{ phase: "request" }, { error: "Error: the provision phase failed — x", code: "select_failed", unselected: false, pending: "openclaw" }])],
    );
    render(<EditionStep onReady={vi.fn()} pollMs={5} />);
    fireEvent.click(await screen.findByTestId("edition-continue"));
    expect(await screen.findByTestId("edition-failed-body")).toHaveTextContent("assistant.pendingBody[OpenClaw]");
    expect(screen.queryByText("assistant.chooseOther")).toBeNull();
  });

  it("explains an update that owns the box in the owner's language", async () => {
    device(
      [status({ needed: true })],
      [json({ error: "An update is running on this box.", code: "update_in_progress" }, { status: 409 })],
    );
    render(<EditionStep onReady={vi.fn()} pollMs={5} />);
    fireEvent.click(await screen.findByTestId("edition-continue"));
    expect(await screen.findByTestId("edition-failed-body")).toHaveTextContent("assistant.updateRunning");
  });

  it("moves on when another tab already made the choice", async () => {
    const onReady = vi.fn();
    device([status({ needed: true })], [json({ error: "This box already runs Hermes.", code: "already_chosen" }, { status: 409 })]);
    render(<EditionStep onReady={onReady} pollMs={5} />);
    fireEvent.click(await screen.findByTestId("edition-continue"));
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it("reports a step that ended without finishing, seen only by polling", async () => {
    device(
      [status({ needed: true }), status({ needed: true, inProgress: false })],
      [new Response("", { status: 200 })],
    );
    render(<EditionStep onReady={vi.fn()} pollMs={5} />);
    fireEvent.click(await screen.findByTestId("edition-continue"));
    expect(await screen.findByTestId("edition-failed-body")).toHaveTextContent("assistant.failedBody");
  });
});

describe("readEditionChoiceStatus", () => {
  it("reads the route's GET and rejects anything else", () => {
    expect(readEditionChoiceStatus(status({ needed: true, hint: "hermes" }))).toMatchObject({ needed: true, hint: "hermes" });
    expect(readEditionChoiceStatus({ needed: true, hint: "dual", pending: "x" })).toMatchObject({ hint: null, pending: null });
    expect(readEditionChoiceStatus("<html>")).toBeNull();
    expect(readEditionChoiceStatus({})).toBeNull();
    expect(readEditionChoiceStatus(null)).toBeNull();
  });
});

// Keep ReactNode referenced for the mocks' JSX typing.
export type _Node = ReactNode;
