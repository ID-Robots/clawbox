/**
 * "Tell the agent" — the run page's steering box (CodingRunMessageBox).
 *
 * What is pinned here is what the owner reads: that the two endings are said
 * apart (Queued is not Delivered), that a refusal is worded from the route's
 * code in the desktop's own language, that what was typed survives a refusal,
 * and that a full queue closes the box rather than letting the owner type into
 * a send that cannot happen.
 *
 * The real English catalogue throughout, so a missing key fails here rather
 * than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunMessageBox from "@/components/CodingRunMessageBox";
import { MAX_QUEUED_RUN_MESSAGES, MAX_RUN_MESSAGE_CHARS, type RunMessage } from "@/lib/coding-run-messages";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let calls: { url: string; body: unknown }[];

function stubFetch(answer: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answer();
  }));
}

const queued = (text: string): RunMessage => ({ at: 1_000, text, deliveredAt: null });
const delivered = (text: string): RunMessage => ({ at: 1_000, text, deliveredAt: 2_000 });

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

const type = (value: string) =>
  fireEvent.change(screen.getByTestId("coding-agent-run-message-input"), { target: { value } });

describe("sending", () => {
  it("posts the run id and the text, and clears the box", async () => {
    stubFetch(() => json({ queued: true, delivered: true }));
    const onSent = vi.fn();
    render(<CodingRunMessageBox runId="run-1" messages={[]} onSent={onSent} />);

    type("use tabs, not spaces");
    fireEvent.click(screen.getByTestId("coding-agent-run-message-send"));

    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/setup-api/coding-agent/message");
    expect(calls[0].body).toEqual({ runId: "run-1", text: "use tabs, not spaces" });
    expect(screen.getByTestId("coding-agent-run-message-input")).toHaveValue("");
  });

  it("sends on Enter and takes a new line on Shift+Enter", async () => {
    stubFetch(() => json({ queued: true, delivered: true }));
    render(<CodingRunMessageBox runId="run-1" messages={[]} />);
    const input = screen.getByTestId("coding-agent-run-message-input");

    type("first");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(calls).toHaveLength(0);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("will not send nothing", () => {
    stubFetch(() => json({ queued: true, delivered: true }));
    render(<CodingRunMessageBox runId="run-1" messages={[]} />);
    expect(screen.getByTestId("coding-agent-run-message-send")).toBeDisabled();
    type("   ");
    expect(screen.getByTestId("coding-agent-run-message-send")).toBeDisabled();
    expect(calls).toHaveLength(0);
  });

  it("holds the text to the same cap the device does", () => {
    stubFetch(() => json({}));
    render(<CodingRunMessageBox runId="run-1" messages={[]} />);
    expect(screen.getByTestId("coding-agent-run-message-input"))
      .toHaveAttribute("maxLength", String(MAX_RUN_MESSAGE_CHARS));
  });
});

describe("what the owner is told", () => {
  it("says Queued and Delivered apart — they are different promises", () => {
    stubFetch(() => json({}));
    render(<CodingRunMessageBox runId="run-1" messages={[queued("wait for me"), delivered("use tabs")]} />);
    const rows = screen.getAllByTestId("coding-agent-run-message-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-delivered", "false");
    expect(rows[0]).toHaveTextContent(t("codingAgent.message.queued"));
    expect(rows[1]).toHaveAttribute("data-delivered", "true");
    expect(rows[1]).toHaveTextContent(t("codingAgent.message.delivered"));
  });

  it("draws no list at all on a run nobody has told anything", () => {
    stubFetch(() => json({}));
    render(<CodingRunMessageBox runId="run-1" messages={[]} />);
    expect(screen.queryByTestId("coding-agent-run-message-list")).toBeNull();
  });

  it("survives a server that predates the queue and sends no messages field", () => {
    stubFetch(() => json({}));
    render(<CodingRunMessageBox runId="run-1" />);
    expect(screen.getByTestId("coding-agent-run-message-input")).toBeEnabled();
  });

  it("closes the box when the queue is full, and says why", () => {
    stubFetch(() => json({}));
    const full = Array.from({ length: MAX_QUEUED_RUN_MESSAGES }, (_, i) => queued(`m${i}`));
    render(<CodingRunMessageBox runId="run-1" messages={full} />);
    expect(screen.getByTestId("coding-agent-run-message-input")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-run-message-send")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-run-message-full"))
      .toHaveTextContent(t("codingAgent.message.errorQueueFull", { n: MAX_QUEUED_RUN_MESSAGES }));
  });
});

describe("a refusal", () => {
  it("is worded from the route's code, in the desktop's language", async () => {
    stubFetch(() => json({ error: "That message is too long: at most 4000 characters.", code: "too_long" }, 413));
    render(<CodingRunMessageBox runId="run-1" messages={[]} />);
    type("way too much");
    fireEvent.click(screen.getByTestId("coding-agent-run-message-send"));

    await waitFor(() => expect(screen.getByTestId("coding-agent-run-message-error"))
      .toHaveTextContent(t("codingAgent.message.errorTooLong", { max: MAX_RUN_MESSAGE_CHARS })));
    // And what was typed is still there: emptying the box over a refusal
    // would lose it.
    expect(screen.getByTestId("coding-agent-run-message-input")).toHaveValue("way too much");
  });

  it("falls back to the route's own sentence for a code this build does not know", async () => {
    stubFetch(() => json({ error: "The box said no in a new way.", code: "from_a_newer_server" }, 409));
    render(<CodingRunMessageBox runId="run-1" messages={[]} />);
    type("hello");
    fireEvent.click(screen.getByTestId("coding-agent-run-message-send"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-run-message-error"))
      .toHaveTextContent("The box said no in a new way."));
  });

  it("says something even when the answer carries nothing at all", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    render(<CodingRunMessageBox runId="run-1" messages={[]} />);
    type("hello");
    fireEvent.click(screen.getByTestId("coding-agent-run-message-send"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-run-message-error"))
      .toHaveTextContent(t("codingAgent.message.failed")));
  });
});
