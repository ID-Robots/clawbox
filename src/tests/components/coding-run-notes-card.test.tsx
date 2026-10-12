/**
 * A project's run notes on its page (src/components/CodingRunNotesCard.tsx):
 * what earlier runs learned, read from the route, edited and cleared by the
 * owner — in the real English strings, so a missing key fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunNotesCard from "@/components/CodingRunNotesCard";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const DIR = "/home/clawbox/Projects/site";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let notes: string;
let calls: Array<{ method: string; url: string; body?: unknown }>;
let refusePut: string | null;

function stub() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (!url.startsWith("/setup-api/coding-agent/run-notes")) return json({ error: "unexpected" }, 404);
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "PUT") {
      if (refusePut) return json({ error: refusePut, kind: "secret" }, 400);
      notes = String((JSON.parse(String(init!.body)) as { notes: string }).notes).trim();
    }
    if (method === "DELETE") notes = "";
    return json({ notes, maxChars: 4000, file: ".clawbox/run-notes.md" });
  }));
}

beforeEach(() => {
  notes = "- Tests: bun run test\n- tsc needs NODE_OPTIONS=--max-old-space-size=6144";
  refusePut = null;
  stub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the run notes card", () => {
  it("reads the project's notes — by folder, or by code-project id — and counts their lines", async () => {
    render(<CodingRunNotesCard directory={DIR} projectId={null} />);
    expect(await screen.findByTestId("coding-run-notes-text")).toHaveTextContent("tsc needs NODE_OPTIONS=--max-old-space-size=6144");
    expect(screen.getByTestId("coding-run-notes-count")).toHaveTextContent(t("codingAgent.runNotes.lines", { n: 2 }));
    expect(calls[0]).toEqual({ method: "GET", url: `/setup-api/coding-agent/run-notes?directory=${encodeURIComponent(DIR)}` });
  });

  it("asks by project id for a code project", async () => {
    render(<CodingRunNotesCard directory={DIR} projectId="invoice-app" />);
    await screen.findByTestId("coding-run-notes-text");
    expect(calls[0].url).toBe("/setup-api/coding-agent/run-notes?projectId=invoice-app");
  });

  it("says there are none yet, and how they get there", async () => {
    notes = "";
    render(<CodingRunNotesCard directory={DIR} projectId={null} />);
    expect(await screen.findByTestId("coding-run-notes-empty")).toHaveTextContent(t("codingAgent.runNotes.empty"));
    expect(screen.getByTestId("coding-run-notes-count")).toHaveTextContent(t("codingAgent.runNotes.none"));
    expect(screen.queryByTestId("coding-run-notes-clear")).toBeNull();
  });

  it("edits and saves the notes whole, and shows what the route saved", async () => {
    render(<CodingRunNotesCard directory={DIR} projectId={null} />);
    await screen.findByTestId("coding-run-notes-text");
    fireEvent.click(screen.getByTestId("coding-run-notes-edit"));
    const input = screen.getByTestId("coding-run-notes-input") as HTMLTextAreaElement;
    expect(input.value).toBe(notes);
    fireEvent.change(input, { target: { value: "- Port 3100 for the dev server" } });
    expect(screen.getByTestId("coding-run-notes-chars")).toHaveTextContent(t("codingAgent.runNotes.chars", { n: 30, max: 4000 }));
    fireEvent.click(screen.getByTestId("coding-run-notes-save"));
    await waitFor(() => expect(screen.getByTestId("coding-run-notes-text")).toHaveTextContent("- Port 3100 for the dev server"));
    expect(calls.find((c) => c.method === "PUT")).toEqual({ method: "PUT", url: "/setup-api/coding-agent/run-notes", body: { directory: DIR, notes: "- Port 3100 for the dev server" } });
  });

  it("keeps the edit open with the route's own reason when the save is refused", async () => {
    refusePut = "These notes look like they hold a password or a token.";
    render(<CodingRunNotesCard directory={DIR} projectId={null} />);
    await screen.findByTestId("coding-run-notes-text");
    fireEvent.click(screen.getByTestId("coding-run-notes-edit"));
    fireEvent.change(screen.getByTestId("coding-run-notes-input"), { target: { value: "- password: hunter2hunter2" } });
    fireEvent.click(screen.getByTestId("coding-run-notes-save"));
    expect(await screen.findByTestId("coding-run-notes-error")).toHaveTextContent(refusePut);
    expect((screen.getByTestId("coding-run-notes-input") as HTMLTextAreaElement).value).toBe("- password: hunter2hunter2");
  });

  it("clears only once the owner confirms", async () => {
    render(<CodingRunNotesCard directory={DIR} projectId={null} />);
    await screen.findByTestId("coding-run-notes-text");
    fireEvent.click(screen.getByTestId("coding-run-notes-clear"));
    expect(screen.getByText(t("codingAgent.runNotes.clearConfirm"))).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("coding-run-notes-clear-cancel"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByTestId("coding-run-notes-clear"));
    fireEvent.click(screen.getByTestId("coding-run-notes-clear-confirm"));
    expect(await screen.findByTestId("coding-run-notes-empty")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe(`/setup-api/coding-agent/run-notes?directory=${encodeURIComponent(DIR)}`);
  });

  it("says when the notes could not be read — never 'no notes yet', and never an editor that would save over them", async () => {
    let failing = true;
    vi.stubGlobal("fetch", vi.fn(async () => (failing ? json({ error: "nope" }, 500) : json({ notes, maxChars: 4000, file: ".clawbox/run-notes.md" }))));
    render(<CodingRunNotesCard directory={DIR} projectId={null} />);
    expect(await screen.findByTestId("coding-run-notes-error")).toHaveTextContent(t("codingAgent.runNotes.loadFailed"));
    expect(screen.getByTestId("coding-run-notes-count")).toHaveTextContent(t("codingAgent.runNotes.loadFailed"));
    expect(screen.queryByTestId("coding-run-notes-empty")).toBeNull();
    expect(screen.getByTestId("coding-run-notes-edit")).toBeDisabled();
    // Try again: the notes that were there all along.
    failing = false;
    fireEvent.click(screen.getByTestId("coding-run-notes-retry"));
    expect(await screen.findByTestId("coding-run-notes-text")).toHaveTextContent("tsc needs NODE_OPTIONS=--max-old-space-size=6144");
    expect(screen.queryByTestId("coding-run-notes-error")).toBeNull();
    expect(screen.queryByTestId("coding-run-notes-retry")).toBeNull();
    expect(screen.getByTestId("coding-run-notes-edit")).not.toBeDisabled();
  });
});
