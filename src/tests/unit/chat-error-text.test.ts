import { describe, it, expect } from "vitest";
import { describeChatFailure } from "@/lib/chat-error-text";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";

// The exact two lines a customer saw in the transcript on .177, beta ff04cee,
// after a New chat reset landed on a turn that was already running. Kept
// verbatim rather than paraphrased: the point of this test is that THIS string
// never reaches a chat bubble again.
const TAKEOVER_RAW =
  "session file changed while embedded prompt lock was released: "
  + "/home/clawbox/.openclaw/agents/main/sessions/3b45304b-89ff-496c-a392-4e1719de0878.jsonl";
const FOLLOWUP_RAW =
  "⚠️ Agent failed before reply: " + TAKEOVER_RAW + ".\nLogs: openclaw logs --follow";

/** Everything the acceptance matrix's leak check looks for. */
function leaks(text: string): boolean {
  return /\/home\/clawbox/.test(text)
    || /\.jsonl/.test(text)
    || /\.openclaw\//.test(text)
    || /openclaw logs/.test(text)
    || /\bagent:[\w.-]+:/.test(text)
    || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text);
}

describe("describeChatFailure", () => {
  it("never renders the session-takeover error a customer actually saw", () => {
    for (const raw of [TAKEOVER_RAW, FOLLOWUP_RAW]) {
      const shown = describeChatFailure(raw);
      expect(leaks(shown)).toBe(false);
      expect(shown).not.toContain("embedded prompt lock");
    }
  });

  it("offers both recoveries: retry for the collision, New chat for the wedge", () => {
    // TASK-512: a session on .177 wedged so that EVERY turn died with this
    // error for ten hours — one tab, one gateway, nothing "open somewhere
    // else" — and the only cure was New chat, which nothing on screen named.
    // So the line must offer the retry (cures a real one-off collision) AND
    // the New chat escape hatch (cures the wedge).
    const shown = describeChatFailure(TAKEOVER_RAW);
    expect(shown).toMatch(/send it again/i);
    expect(shown).toMatch(/new chat/i);
  });

  it("does not assert an unchecked cause as established fact", () => {
    // The box has not checked for another tab and, in the wedged case, there
    // is none — the cause is internal. Presenting a guess as the diagnosis
    // sent the owner hunting a phantom window while the real recovery sat one
    // click away. Causes may be OFFERED ("that can happen when…"), never
    // STATED ("this chat was…" / "the conversation changed outside…").
    const shown = describeChatFailure(TAKEOVER_RAW);
    expect(shown).not.toMatch(/was open somewhere else/i);
    expect(shown).not.toMatch(/changed outside/i);
    expect(shown).toMatch(/can happen/i);
  });

  it("says the same thing for the followup wording", () => {
    expect(describeChatFailure(FOLLOWUP_RAW)).toBe(describeChatFailure(TAKEOVER_RAW));
  });

  it("keeps a message that is genuinely useful to the customer", () => {
    // Replacing this with the generic line would throw away the one thing that
    // tells them what to change.
    expect(describeChatFailure("Request exceeds the size limit"))
      .toBe("Error: Request exceeds the size limit");
  });

  it("falls back rather than going silent", () => {
    // A turn that just stops with no bubble is worse than a vague one: the
    // customer cannot tell whether the box is thinking or dead.
    for (const raw of [undefined, null, "", "   ", 42, {}]) {
      const shown = describeChatFailure(raw);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown).toMatch(/send it again/i);
    }
  });

  it("maps an Anthropic 429 to a calm, actionable rate-limit sentence", () => {
    // TASK: an Anthropic 429 reached the owner as "The agent run failed before
    // producing a reply." — a generic dead-end. The gateway had already worded
    // the real cause ("API rate limit reached. Please try again later.");
    // reason=rate_limit / a bare 429 carry the same signal. Whichever wording
    // reaches us, the customer must be told it is a rate limit, that the box is
    // fine, and what to do — wait, or switch provider in Settings.
    for (const raw of [
      "API rate limit reached. Please try again later.",
      "rate_limit",
      "429 Error",
      "Error: 429 Too Many Requests",
    ]) {
      const shown = describeChatFailure(raw);
      expect(shown).toMatch(/rate[ -]?limit/i);
      expect(shown).toMatch(/settings/i);
      // Says the box itself is not broken.
      expect(shown).toMatch(/nothing is (wrong|broken)|not broken|is fine/i);
      // A rate limit is transient — never the generic "log has the details".
      expect(shown).not.toMatch(/stayed in this box's log/i);
    }
  });

  it("does not leak anything unsafe on the rate-limit path", () => {
    // The rate-limit sentence is authored by us, but the matcher must not let a
    // rate-limit-shaped string smuggle a path/UUID/CLI line onto the screen.
    const shown = describeChatFailure(
      "429 rate limit on run 3b45304b-89ff-496c-a392-4e1719de0878; "
      + "see /home/clawbox/.openclaw/logs; Logs: openclaw logs --follow",
    );
    expect(leaks(shown)).toBe(false);
    expect(shown).toMatch(/rate[ -]?limit/i);
  });

  it("does not misfire on ordinary text that merely mentions limits", () => {
    // "Request exceeds the size limit" is a size limit, not a rate limit — it
    // must keep its own useful passthrough, not get swallowed by the new case.
    expect(describeChatFailure("Request exceeds the size limit"))
      .toBe("Error: Request exceeds the size limit");
  });

  it("drops anything that carries an internal handle, whatever the wording", () => {
    for (const raw of [
      "run 3b45304b-89ff-496c-a392-4e1719de0878 failed",
      "lane task error: lane=session:agent:main:main",
      "could not write /home/clawbox/.openclaw/media/x.png",
      "Logs: openclaw logs --follow",
      "POST https://clawbox.com/api/ai returned 500",
      "Bearer claw_abc123 rejected",
    ]) {
      const shown = describeChatFailure(raw);
      expect(leaks(shown)).toBe(false);
      expect(shown).not.toContain("claw_");
      expect(shown).not.toContain("https://");
    }
  });
});

describe("sanitizeErrorMessage — handles added for TASK-440", () => {
  it("rejects a bare internal handle with no path attached", () => {
    // The UUID reached the transcript alongside a path this time. It would have
    // reached it alone had the message been worded slightly differently.
    expect(sanitizeErrorMessage("run 3b45304b-89ff-496c-a392-4e1719de0878 failed")).toBeNull();
    expect(sanitizeErrorMessage("lane=session:agent:main:main timed out")).toBeNull();
  });

  it("rejects an instruction to open a terminal", () => {
    expect(sanitizeErrorMessage("Logs: openclaw logs --follow")).toBeNull();
    expect(sanitizeErrorMessage("run openclaw doctor to repair")).toBeNull();
  });

  it("still passes plain operational text", () => {
    expect(sanitizeErrorMessage("Request exceeds the size limit")).toBe("Request exceeds the size limit");
    expect(sanitizeErrorMessage("The model is busy, try again")).toBe("The model is busy, try again");
  });
});
