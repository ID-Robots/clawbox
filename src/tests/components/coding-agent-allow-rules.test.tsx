/**
 * The two surfaces of the owner's allow-list.
 *
 * `CodingRunDenials` is the run page's "Not allowed" panel: every refusal the
 * box can answer carries a button that saves the narrowest rule covering it,
 * behind one confirmation that shows the exact rule first — because a rule is a
 * STANDING permission, not a one-off. A refusal no rule could ever answer says
 * so instead of showing a button that could not work.
 *
 * `CodingAgentRulesCard` is Settings: the list read whole, with a Remove beside
 * every row and a field for the owner who knows what they want before a run
 * asks.
 *
 * The real English catalogue throughout, so a missing key fails here rather
 * than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunDenials from "@/components/CodingRunDenials";
import CodingAgentRulesCard from "@/components/CodingAgentRulesCard";
import { CODING_AGENT_CHANGED_EVENT } from "@/lib/ui-events";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const RULE = "Read(//home/clawbox/.claude-ds/projects/app/memory/**)";
const OTHER = "Write(//home/clawbox/Projects/notes/**)";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let calls: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every request recorded; the answer chosen by the caller. */
function stubFetch(answer: (url: string, method: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answer(url, method);
  }));
}

describe("the run page's refusal panel", () => {
  it("draws nothing at all when a run was refused nothing", () => {
    stubFetch(() => json({}));
    const { container } = render(<CodingRunDenials runId="run-1" denials={[]} resumable={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists every refusal, with a button only where there is a rule to offer", () => {
    stubFetch(() => json({}));
    render(
      <CodingRunDenials
        runId="run-1"
        denials={[
          { text: "Read: /home/clawbox/.claude-ds/projects/app/memory/notes.md", rule: RULE, refusal: null },
          { text: "Read: /home/clawbox/.ssh/id_ed25519", rule: null, refusal: "protected" },
        ]}
        resumable={false}
      />,
    );
    expect(screen.getAllByTestId("coding-agent-denied-row")).toHaveLength(2);
    // The one that can be answered.
    expect(screen.getByTestId("coding-agent-allow-run-1-0")).toHaveTextContent(t("codingAgent.allowNextTime"));
    // The one that cannot says why, and offers nothing.
    expect(screen.getByTestId("coding-agent-denied-protected")).toHaveTextContent(t("codingAgent.allowProtected"));
    expect(screen.queryByTestId("coding-agent-allow-run-1-1")).toBeNull();
  });

  it("falls back to the plain strings of an older record, and offers no button", () => {
    // Re-parsing "Read: /home/…" in the browser would be guessing at what the
    // tool was pointed at, and a button that widens a standing permission is
    // the last thing that may guess.
    stubFetch(() => json({}));
    render(<CodingRunDenials runId="run-1" deniedActions={["Read: /home/clawbox/x.md"]} resumable={false} />);
    expect(screen.getByTestId("coding-agent-denied-row")).toHaveTextContent("Read: /home/clawbox/x.md");
    expect(screen.queryByTestId("coding-agent-allow-run-1-0")).toBeNull();
  });

  it("shows the rule VERBATIM before it saves anything", async () => {
    stubFetch(() => json({}));
    render(<CodingRunDenials runId="run-1" denials={[{ text: "Read: …", rule: RULE, refusal: null }]} resumable={false} />);
    fireEvent.click(screen.getByTestId("coding-agent-allow-run-1-0"));
    const confirm = await screen.findByTestId("coding-agent-allow-confirm");
    // What will be stored and what the CLI will be started with: a paraphrase
    // would be a different permission.
    expect(confirm).toHaveTextContent(RULE);
    expect(confirm).toHaveTextContent(t("codingAgent.allowConfirmHint"));
    // Nothing has been written by merely arming it.
    expect(calls).toHaveLength(0);
  });

  it("cancelling writes nothing and puts the button back", async () => {
    stubFetch(() => json({}));
    render(<CodingRunDenials runId="run-1" denials={[{ text: "Read: …", rule: RULE, refusal: null }]} resumable={false} />);
    fireEvent.click(screen.getByTestId("coding-agent-allow-run-1-0"));
    fireEvent.click(await screen.findByTestId("coding-agent-allow-cancel-run-1-0"));
    await waitFor(() => expect(screen.queryByTestId("coding-agent-allow-confirm")).toBeNull());
    expect(calls).toHaveLength(0);
    expect(screen.getByTestId("coding-agent-allow-run-1-0")).toBeTruthy();
  });

  it("saves the derived rule and tells the host the list changed", async () => {
    stubFetch(() => json({ allowRules: [RULE] }));
    const onAllowed = vi.fn();
    render(
      <CodingRunDenials
        runId="run-1"
        denials={[{ text: "Read: …", rule: RULE, refusal: null }]}
        resumable={false}
        onAllowed={onAllowed}
      />,
    );
    fireEvent.click(screen.getByTestId("coding-agent-allow-run-1-0"));
    fireEvent.click(await screen.findByTestId("coding-agent-allow-save-run-1-0"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-allow-saved")).toBeTruthy());
    expect(calls).toEqual([{
      url: "/setup-api/coding-agent/permissions",
      method: "POST",
      body: { rule: RULE },
    }]);
    expect(onAllowed).toHaveBeenCalledWith(RULE);
    // The button is gone: the permission is granted, not grantable again.
    expect(screen.queryByTestId("coding-agent-allow-run-1-0")).toBeNull();
  });

  it("offers Resume only for a run that can be resumed", async () => {
    stubFetch(() => json({}));
    const onResume = vi.fn();
    const { unmount } = render(
      <CodingRunDenials
        runId="run-1"
        denials={[{ text: "Read: …", rule: RULE, refusal: null }]}
        resumable
        onResume={onResume}
      />,
    );
    fireEvent.click(screen.getByTestId("coding-agent-allow-run-1-0"));
    fireEvent.click(await screen.findByTestId("coding-agent-allow-save-run-1-0"));
    // The permission just granted is of no use to THIS run until it carries on.
    const resume = await screen.findByTestId("coding-agent-allow-resume-run-1");
    fireEvent.click(resume);
    expect(onResume).toHaveBeenCalled();
    unmount();

    // A settled run gets the same "allowed" note and no Resume.
    render(<CodingRunDenials runId="run-2" denials={[{ text: "Read: …", rule: RULE, refusal: null }]} resumable={false} />);
    fireEvent.click(screen.getByTestId("coding-agent-allow-run-2-0"));
    fireEvent.click(await screen.findByTestId("coding-agent-allow-save-run-2-0"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-allow-saved")).toBeTruthy());
    expect(screen.queryByTestId("coding-agent-allow-resume-run-2")).toBeNull();
  });

  it("words a refused save in the owner's language, from the code and not the sentence", async () => {
    stubFetch(() => json({ error: "That rule is already on the list.", kind: "invalid", code: "duplicate" }, 400));
    render(<CodingRunDenials runId="run-1" denials={[{ text: "Read: …", rule: RULE, refusal: null }]} resumable={false} />);
    fireEvent.click(screen.getByTestId("coding-agent-allow-run-1-0"));
    fireEvent.click(await screen.findByTestId("coding-agent-allow-save-run-1-0"));
    const err = await screen.findByTestId("coding-agent-allow-error");
    expect(err).toHaveTextContent(t("codingAgent.ruleRefusedDuplicate"));
    // Not saved, so the confirmation is still up and nothing claims success.
    expect(screen.queryByTestId("coding-agent-allow-saved")).toBeNull();
  });

  it("falls back to the box's own sentence for a code this build does not know", async () => {
    stubFetch(() => json({ error: "Something this build has never heard of.", code: "from_the_future" }, 400));
    render(<CodingRunDenials runId="run-1" denials={[{ text: "Read: …", rule: RULE, refusal: null }]} resumable={false} />);
    fireEvent.click(screen.getByTestId("coding-agent-allow-run-1-0"));
    fireEvent.click(await screen.findByTestId("coding-agent-allow-save-run-1-0"));
    expect(await screen.findByTestId("coding-agent-allow-error"))
      .toHaveTextContent("Something this build has never heard of.");
  });

  it("says so when the box could not be reached at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    render(<CodingRunDenials runId="run-1" denials={[{ text: "Read: …", rule: RULE, refusal: null }]} resumable={false} />);
    fireEvent.click(screen.getByTestId("coding-agent-allow-run-1-0"));
    fireEvent.click(await screen.findByTestId("coding-agent-allow-save-run-1-0"));
    expect(await screen.findByTestId("coding-agent-allow-error")).toBeTruthy();
    expect(screen.queryByTestId("coding-agent-allow-saved")).toBeNull();
  });
});

describe("Settings → the rules card", () => {
  it("lists what the box answers, with the count and a Remove per row", async () => {
    stubFetch(() => json({ allowRules: [RULE, OTHER], maxAllowRules: 32 }));
    render(<CodingAgentRulesCard />);
    await waitFor(() => expect(screen.getAllByTestId("coding-agent-rule-row")).toHaveLength(2));
    expect(screen.getByTestId("coding-agent-rules-count")).toHaveTextContent("2 of 32");
    expect(screen.getAllByTestId("coding-agent-rule-remove")).toHaveLength(2);
    expect(screen.getByTestId("coding-agent-rules-card")).toHaveTextContent(RULE);
  });

  it("says the list is empty only once the box has answered", async () => {
    stubFetch(() => json({ allowRules: [], maxAllowRules: 32 }));
    render(<CodingAgentRulesCard />);
    // Nothing claimed before the first read comes back.
    expect(screen.queryByTestId("coding-agent-rules-empty")).toBeNull();
    expect(await screen.findByTestId("coding-agent-rules-empty")).toHaveTextContent(t("codingAgent.rulesEmpty"));
  });

  it("adds a typed rule and renders back the list the box answered with", async () => {
    stubFetch((_url, method) => json(method === "POST"
      ? { allowRules: [OTHER] }
      : { allowRules: [], maxAllowRules: 32 }));
    render(<CodingAgentRulesCard />);
    await screen.findByTestId("coding-agent-rules-empty");
    fireEvent.change(screen.getByTestId("coding-agent-rule-input"), { target: { value: `  ${OTHER}  ` } });
    fireEvent.click(screen.getByTestId("coding-agent-rule-add"));
    await waitFor(() => expect(screen.getAllByTestId("coding-agent-rule-row")).toHaveLength(1));
    // Trimmed on the way out, and the field is cleared only because it worked.
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { rule: OTHER } });
    expect(screen.getByTestId("coding-agent-rule-input")).toHaveValue("");
  });

  it("adds on Enter too", async () => {
    stubFetch((_url, method) => json(method === "POST" ? { allowRules: [OTHER] } : { allowRules: [] }));
    render(<CodingAgentRulesCard />);
    await screen.findByTestId("coding-agent-rules-empty");
    fireEvent.change(screen.getByTestId("coding-agent-rule-input"), { target: { value: OTHER } });
    fireEvent.keyDown(screen.getByTestId("coding-agent-rule-input"), { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
  });

  it("refuses an empty field here rather than asking the box about it", async () => {
    stubFetch(() => json({ allowRules: [] }));
    render(<CodingAgentRulesCard />);
    await screen.findByTestId("coding-agent-rules-empty");
    const before = calls.length;
    fireEvent.change(screen.getByTestId("coding-agent-rule-input"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("coding-agent-rule-add"));
    expect(await screen.findByTestId("coding-agent-rules-error")).toHaveTextContent(t("codingAgent.ruleRefusedEmpty"));
    expect(calls).toHaveLength(before);
  });

  it("words a refusal from the code, and keeps what the owner typed", async () => {
    stubFetch((_url, method) => method === "POST"
      ? json({ error: "That path holds credentials.", kind: "invalid", code: "protected" }, 400)
      : json({ allowRules: [] }));
    render(<CodingAgentRulesCard />);
    await screen.findByTestId("coding-agent-rules-empty");
    fireEvent.change(screen.getByTestId("coding-agent-rule-input"), { target: { value: "Read(//home/clawbox/.ssh/**)" } });
    fireEvent.click(screen.getByTestId("coding-agent-rule-add"));
    expect(await screen.findByTestId("coding-agent-rules-error"))
      .toHaveTextContent(t("codingAgent.ruleRefusedProtected"));
    // Nothing was saved, so the owner still has what they wrote to correct.
    expect(screen.getByTestId("coding-agent-rule-input")).toHaveValue("Read(//home/clawbox/.ssh/**)");
  });

  it("removes a rule by naming it in the query", async () => {
    stubFetch((_url, method) => json(method === "DELETE" ? { allowRules: [] } : { allowRules: [RULE] }));
    render(<CodingAgentRulesCard />);
    await waitFor(() => expect(screen.getAllByTestId("coding-agent-rule-row")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("coding-agent-rule-remove"));
    await screen.findByTestId("coding-agent-rules-empty");
    const del = calls.at(-1)!;
    expect(del.method).toBe("DELETE");
    expect(del.url).toBe(`/setup-api/coding-agent/permissions?rule=${encodeURIComponent(RULE)}`);
  });

  it("keeps what it last knew when the read fails, rather than claiming nothing is allowed", async () => {
    // An empty list would invite the owner to re-add a rule already in force.
    let fail = false;
    stubFetch(() => (fail ? json({ error: "nope" }, 500) : json({ allowRules: [RULE], maxAllowRules: 32 })));
    render(<CodingAgentRulesCard />);
    await waitFor(() => expect(screen.getAllByTestId("coding-agent-rule-row")).toHaveLength(1));
    fail = true;
    await act(async () => { window.dispatchEvent(new CustomEvent(CODING_AGENT_CHANGED_EVENT)); });
    await waitFor(() => expect(screen.getByTestId("coding-agent-rules-error")).toBeTruthy());
    expect(screen.getAllByTestId("coding-agent-rule-row")).toHaveLength(1);
    expect(screen.queryByTestId("coding-agent-rules-empty")).toBeNull();
  });

  it("re-reads when a rule is saved from a run's page in another window", async () => {
    let rules = [RULE];
    stubFetch(() => json({ allowRules: rules, maxAllowRules: 32 }));
    render(<CodingAgentRulesCard />);
    await waitFor(() => expect(screen.getAllByTestId("coding-agent-rule-row")).toHaveLength(1));
    rules = [RULE, OTHER];
    await act(async () => { window.dispatchEvent(new CustomEvent(CODING_AGENT_CHANGED_EVENT)); });
    await waitFor(() => expect(screen.getAllByTestId("coding-agent-rule-row")).toHaveLength(2));
  });

  it("stops accepting new rules at the cap the box reports", async () => {
    const full = Array.from({ length: 3 }, (_, i) => `Read(//home/clawbox/Projects/p${i}/**)`);
    stubFetch(() => json({ allowRules: full, maxAllowRules: 3 }));
    render(<CodingAgentRulesCard />);
    await waitFor(() => expect(screen.getAllByTestId("coding-agent-rule-row")).toHaveLength(3));
    // Disabled rather than hidden, so the count beside the title explains why.
    expect(screen.getByTestId("coding-agent-rule-add")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-rule-input")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-rules-count")).toHaveTextContent("3 of 3");
  });
});
