import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { describeChatFailure, describeFallbackReply } from "@/lib/chat-error-text";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";
import { translations } from "@/lib/translations";

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

describe("describeChatFailure — a refused ClawBox AI credential", () => {
  // TASK-419. The whole customer-visible failure in one line: the box showed a
  // healthy paid badge and then answered a message with
  //   "Error: HTTP 403: Invalid token"
  //   "Error: Agent failed before reply: HTTP 403: Invalid token. Logs: openclaw logs --follow"
  // Nothing there is wrong, and nothing there is usable. The remedy is a
  // screen this customer already has open.
  it("names the reconnect screen instead of relaying the status line", () => {
    for (const raw of [
      "HTTP 403: Invalid token",
      "Agent failed before reply: HTTP 403: Invalid token",
      "HTTP 401: missing_token",
      "401 Unauthorized",
    ]) {
      const text = describeChatFailure(raw);
      expect(text).toMatch(/Settings/);
      expect(text).toMatch(/Providers/);
      expect(text).not.toContain("403");
      expect(text).not.toContain("401");
      expect(text).not.toMatch(/openclaw/i);
    }
  });

  it("leaves a 403 that is not about the credential alone", () => {
    // Both reach this function through the Hermes adapter, and both used to
    // fall to the calm generic line. Turning them into "your sign-in is dead"
    // would send a customer to re-link a paid account over a web page.
    for (const raw of [
      "tool browser_open failed: 403 Forbidden (https://news.example.com)",
      "web_fetch: the site returned 403 Forbidden",
      "HTTP 403 — Just a moment…",
    ]) {
      expect(describeChatFailure(raw)).not.toMatch(/Settings/);
    }
  });

  it("leaves an unrelated failure alone", () => {
    // Narrow on purpose: "limit" and "token" are ordinary words in this
    // codebase's error strings, and a greedy match would swallow a message
    // whose remedy is different.
    expect(describeChatFailure("Request exceeds the size limit")).toBe(
      "Error: Request exceeds the size limit",
    );
    expect(describeChatFailure("context window exceeded: 403000 tokens")).not.toMatch(/Settings/);
  });
});

/**
 * A turn the gateway could not even ask the provider about: its auth store
 * holds no usable sign-in for the model the chat is set to (2026-10-10, a
 * Claude sign-in the store never received). The strings are the three shapes
 * one such run put on the wire — the failover detail, the first `chat` error
 * frame (cut at 240 characters by the gateway) and the second one, sent when
 * dispatch completes — with only the home directory changed.
 */
describe("describeChatFailure — a provider this box has no sign-in for", () => {
  const RAW =
    'No API key found for provider "anthropic". Auth store: /home/clawbox/.openclaw/state/openclaw.sqlite'
    + " (agentDir: /home/clawbox/.openclaw/agents/main/agent). Configure an API key"
    + " (openclaw models auth paste-api-key --provider anthropic; add --agent <id> for a non-default agent)"
    + " or copy only portable static auth profiles from the main agentDir.";
  const FRAME1 = `${(RAW + " | missing-provider-auth").slice(0, 240)}...`;
  const FRAME2 =
    "⚠️ Agent failed before reply: " + RAW + " | missing-provider-auth.\nTo view logs, run `openclaw logs --follow` in a terminal.";

  const GENERIC = "That message did not go through. Send it again — the details stayed in this box's log.";
  const NAMED = (provider: string) =>
    `That message did not go through — this box has no working sign-in for ${provider}, the provider this chat is set to.`
    + ` Connect ${provider} again in Settings, under Providers, or pick another model in the header, then send it again.`;
  const UNNAMED =
    "That message did not go through — this box has no working sign-in for the provider this chat is set to."
    + " Connect it again in Settings, under Providers, or pick another model in the header, then send it again.";

  it("says what is wrong and where to fix it, for every shape the failure arrives in", () => {
    for (const raw of [RAW, FRAME1, FRAME2]) {
      const shown = [
        describeChatFailure(raw),
        describeChatFailure(raw, {}),
        describeChatFailure(raw, { reason: "auth", model: "anthropic/claude-opus-5-5", detail: RAW }),
      ];
      // One failure, one sentence — whatever the frame happened to carry.
      expect(new Set(shown).size).toBe(1);
      const text = shown[0];
      expect(text).toBe(NAMED("Anthropic"));
      expect(text).toMatch(/Settings/);
      expect(text).toMatch(/Providers/);
      expect(text).toMatch(/header/);
      expect(leaks(text)).toBe(false);
      expect(text).not.toMatch(/openclaw|sqlite|paste-api-key|missing-provider-auth|agentDir/i);
      // Not the refused-credential sentence: the gateway tags this `auth`, but
      // nobody refused anything — the provider was never asked.
      expect(text).not.toMatch(/not accepting this box's sign-in/);
      // And not the line the owner actually read, which could never work.
      expect(text).not.toBe(GENERIC);
    }
  });

  it("names no provider when the gateway named none", () => {
    expect(describeChatFailure("LLM request failed. | missing-provider-auth")).toBe(UNNAMED);
    expect(describeChatFailure("⚠️ Missing API key for the selected provider on the gateway. Configure provider auth, then try again.")).toBe(UNNAMED);
  });

  it("falls back to the provider the run named, then to the model's", () => {
    expect(describeChatFailure("missing-provider-auth", { provider: "openai", model: "anthropic/claude-opus-5-5" })).toBe(NAMED("OpenAI"));
    expect(describeChatFailure("missing-provider-auth", { model: "anthropic/claude-opus-5-5" })).toBe(NAMED("Anthropic"));
    // The id in the wording wins over both: it is the store that was looked in.
    expect(describeChatFailure(RAW, { provider: "openai", model: "google/gemini-3" })).toBe(NAMED("Anthropic"));
  });

  it("reads the gateway's user copy of the same failure, and labels an id it has no name for", () => {
    expect(describeChatFailure('⚠️ Missing API key for provider "openai". Configure the gateway auth for that provider, then try again.'))
      .toBe(NAMED("OpenAI"));
    expect(describeChatFailure('No API key found for provider "litellm".')).toBe(NAMED("Litellm"));
  });

  it("never echoes an id that is not a plain provider id", () => {
    const longId = "a".repeat(200);
    for (const raw of [
      'No API key found for provider "../../etc/passwd".',
      'No API key found for provider "/home/clawbox/.ssh/id_ed25519".',
      'No API key found for provider "open ai <script>".',
      `No API key found for provider "${longId}".`,
    ]) {
      const text = describeChatFailure(raw);
      // Still this failure — just with nobody named.
      expect(text).toBe(UNNAMED);
      expect(text).not.toMatch(/passwd|id_ed25519|script|aaaa/);
    }
  });

  it("is not a rate limit because a folder on the box has 429 in its name", () => {
    const raw = RAW.replaceAll("/home/clawbox/.openclaw", "/home/clawbox/box-429/.openclaw");
    expect(describeChatFailure(raw)).toBe(NAMED("Anthropic"));
    expect(describeChatFailure("LLM request failed.", { reason: "auth", detail: raw })).toBe(NAMED("Anthropic"));
  });

  it("leaves a sign-in the provider really refused on its own sentence", () => {
    const refused = "That message did not go through — the AI provider is not accepting this box's sign-in any more. Reconnect it in Settings, under Providers, and send it again.";
    expect(describeChatFailure("HTTP 401: invalid_api_key", { reason: "auth", provider: "anthropic" })).toBe(refused);
    expect(describeChatFailure("The agent run failed before producing a reply.", { reason: "auth", provider: "anthropic" })).toBe(refused);
  });

  it("says so under a reply the fallback wrote, instead of blaming the provider", () => {
    const note = describeFallbackReply({
      reason: "auth",
      model: "anthropic/claude-opus-5-5",
      detail: RAW,
      servedModel: "deepseek/deepseek-v4-flash",
    });
    expect(note).toBe(
      "This reply came from deepseek-v4-flash, not claude-opus-5-5: this box has no working sign-in for Anthropic."
      + " Connect Anthropic again in Settings, under Providers, to get claude-opus-5-5 back.",
    );
    expect(note).not.toMatch(/did not accept/);
    expect(leaks(note ?? "")).toBe(false);
  });

  // A chain of models: the gateway's summary names every attempt, and the
  // last step's detail is the LAST fallback's. The frames are a live 2026.9.4
  // gateway's for a box whose picked model (ClawBox AI's, on its `deepseek`
  // wire id) hit its weekly allowance and whose fallback list — hand-edited —
  // ends on a Claude model with no sign-in. The missing sign-in outranked the
  // allowance and named Anthropic as "the provider this chat is set to".
  describe("when it is a later fallback that has no sign-in", () => {
    const SUMMARY = (firstAttempt: string) =>
      `All models failed (2): deepseek/deepseek-v4-flash: ${firstAttempt} (rate_limit) | anthropic/claude-opus-5-5:`
      + " Couldn't sign in to anthropic. Your saved login looks expired or no longer works. Run `openclaw models auth log...";
    const LAST_STEP = {
      provider: "deepseek",
      model: "anthropic/claude-opus-5-5",
      reason: "auth",
      detail: "Couldn't sign in to anthropic. Your saved login looks expired or no longer works. Run `openclaw models auth login"
        + ' --provider anthropic` or `openclaw configure`. (No API key found for provider "anthropic". Auth store:'
        + " /home/clawbox/.openclaw/agents/main/agent/openclaw-agent.sqlite (agentDir: /home/clawbox/.openclaw/…",
    };

    it("says what stopped the model the chat is set to: its allowance", () => {
      const text = describeChatFailure(SUMMARY("429 Weekly token allowance used up."), LAST_STEP);
      expect(text).toMatch(/this week's ClawBox AI chat allowance is used up/);
      expect(text).not.toMatch(/no working sign-in/);
      expect(text).not.toMatch(/Anthropic/);
      expect(leaks(text)).toBe(false);
    });

    it("…or its rate limit", () => {
      const text = describeChatFailure(SUMMARY("429 Too many requests."), LAST_STEP);
      expect(text).toMatch(/rate-limiting this box right now/);
      expect(text).not.toMatch(/no working sign-in/);
      expect(text).not.toMatch(/Anthropic/);
    });

    it("still says the sign-in is missing when the model the chat is set to is the one without it", () => {
      // A constructed line: on the wire the gateway's 240-character cut usually
      // ends the first attempt before the quoted id, and the rule then has
      // nothing to read. Where the id does arrive, the first attempt is asked.
      const first ='anthropic/claude-opus-5-5: No API key found for provider "anthropic". (auth) | deepseek/deepseek-v4-flash: 429 Weekly token allowance used up. (rate_limit)';
      expect(describeChatFailure(`All models failed (2): ${first}`, { reason: "rate_limit", model: "deepseek/deepseek-v4-flash", detail: "429 Weekly token allowance used up." }))
        .toBe(NAMED("Anthropic"));
    });

    it("reads a chain of ONE, and any line that is no summary, off everything the run said — as before", () => {
      // One candidate has no "first of several" to prefer: the detail is its own.
      expect(describeChatFailure("All models failed (1): anthropic/claude-opus-5-5: LLM request failed.", { reason: "auth", detail: RAW }))
        .toBe(NAMED("Anthropic"));
      expect(describeChatFailure("The agent run failed before producing a reply.", { reason: "auth", detail: RAW })).toBe(NAMED("Anthropic"));
    });
  });

  // The provider id is lifted out of error text and looked up in a table. A
  // plain object answers `constructor` with Object's own function, which was
  // printed into the box's sentence as its source text.
  it("never prints a prototype member's source where a provider's name goes", () => {
    const shown = [
      describeChatFailure('Missing API key for provider "constructor"'),
      describeChatFailure("The agent run failed before producing a reply.", { provider: "anthropic", reason: "auth", detail: 'HTTP 400: upstream said: No API key found for provider "constructor".' }),
      // The structured path, which reached the same lookup before any id came out of free text.
      describeChatFailure("The agent run failed before producing a reply.", { provider: "constructor", reason: "format", detail: "HTTP 400: bad request" }),
      describeFallbackReply({ reason: "auth", provider: "anthropic", model: "claude-opus-5-5", servedModel: "deepseek/deepseek-v4-flash", detail: 'No API key found for provider "constructor".' }) ?? "",
    ];
    for (const text of shown) {
      expect(text).not.toMatch(/native code|function\b|\[object/);
      expect(leaks(text)).toBe(false);
    }
    // Named like any id the table has no label for.
    expect(shown[0]).toBe(NAMED("Constructor"));
    expect(shown[1]).toBe(NAMED("Constructor"));
    expect(shown[3]).toContain("no working sign-in for Constructor");
  });
});

/**
 * A ClawBox AI allowance refusal. It also arrives as a 429, and the generic
 * "wait a minute and send it again" is the wrong advice for a window that
 * frees up days from now — so the turn names WHICH allowance is spent and
 * WHEN it frees up, in the owner's language and clock.
 */
describe("describeChatFailure — a spent ClawBox AI allowance", () => {
  // Later the same day, read in UTC so the clock is the same on every machine.
  const RESET = "2026-09-17T10:30:00.000Z";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-17T09:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const envelope = (code: string, message: string, resetAt: string | null = RESET) =>
    `429 ${JSON.stringify({ error: { message, type: "usage_limit", code, ...(resetAt ? { resetAt } : {}) } })}`;
  const en = (key: string, params?: Record<string, string | number>) => {
    let str = translations.en[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) str = str.replaceAll(`{${k}}`, String(v));
    return str;
  };

  it("names the weekly chat allowance and when it frees up", () => {
    const shown = describeChatFailure(envelope("weekly_limit_exceeded", "Weekly token allowance used up."), undefined, { t: en, locale: "en", timeZone: "UTC" });
    expect(shown).toContain("this week's ClawBox AI chat allowance is used up");
    expect(shown).toContain("It frees up at 10:30.");
    expect(shown).toContain("Settings, under Providers");
    // Not the generic throttling sentence it would otherwise fall to.
    expect(shown).not.toContain("rate-limiting");
  });

  it("tells a burst refusal apart from a spent week", () => {
    const shown = describeChatFailure(envelope("burst_limit_exceeded", "Short-term burst limit reached"), undefined, { t: en, locale: "en", timeZone: "UTC" });
    expect(shown).toContain("5-hour burst limit is reached");
    expect(shown).toContain("Your weekly allowance still has room");
  });

  it("names the memory indexing allowance", () => {
    const shown = describeChatFailure(envelope("embeddings_weekly_limit_exceeded", "Memory indexing allowance used up."), undefined, { t: en, locale: "en", timeZone: "UTC" });
    expect(shown).toContain("memory indexing allowance is used up");
  });

  it("promises no hour the refusal did not carry", () => {
    const shown = describeChatFailure(envelope("weekly_limit_exceeded", "out", null), undefined, { t: en, locale: "en", timeZone: "UTC" });
    expect(shown).toContain("It frees up as older usage leaves the rolling window.");
    expect(shown).not.toMatch(/\d{2}:\d{2}/);
  });

  it("speaks the owner's language when the chat hands in its translator", () => {
    const de = (key: string, params?: Record<string, string | number>) => {
      let str = translations.de[key] ?? key;
      for (const [k, v] of Object.entries(params ?? {})) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    };
    const shown = describeChatFailure(envelope("weekly_limit_exceeded", "Weekly token allowance used up."), undefined, { t: de, locale: "de", timeZone: "UTC" });
    expect(shown).toContain(translations.de["chat.allowanceWeekly"]);
    expect(shown).toContain("Es wird um 10:30 frei.");
  });

  it("falls back to English with no translator, or one that does not know the key", () => {
    const raw = envelope("weekly_limit_exceeded", "Weekly token allowance used up.");
    expect(describeChatFailure(raw)).toContain("this week's ClawBox AI chat allowance is used up");
    expect(describeChatFailure(raw, undefined, { t: (key) => key, locale: "en" })).toContain("this week's ClawBox AI chat allowance is used up");
  });

  it("keeps an ordinary rate limit on its own sentence", () => {
    expect(describeChatFailure("API rate limit reached. Please try again later.", undefined, { t: en, locale: "en", timeZone: "UTC" })).toContain("rate-limiting");
  });
});

describe("the provider's own words, scrubbed with the repo's one inventory", () => {
  // The pre-scrub used to be a regex of its own (`claw_`/`sk-` and nothing
  // else), a third copy of "what may not reach a person" beside
  // incident-sanitize.ts and safe-error-text.ts. It now calls
  // `redactCredentialShapes`, so every shape THAT module knows is taken out of
  // a bubble too — and a shape added there reaches this path with no second
  // edit. `sanitizeErrorMessage` is still the wall behind it: an unstripped
  // `claw_`/`sk-`/`Bearer ` rejects the whole message to GENERIC.
  const detailWith = (body: string) =>
    describeChatFailure("The agent run failed before producing a reply.", {
      reason: "format",
      provider: "openai",
      model: "openai/gpt-5.5",
      detail: `HTTP 400: ${JSON.stringify({ error: { message: body } })}`,
    });

  it("keeps the sentence and drops the credential, for shapes only the wider inventory knew", () => {
    for (const [body, secret] of [
      ["Incorrect API key provided: ghp_abcdefghijklmnopqrst", "ghp_"],
      ["Token github_pat_11ABCDEFG0aaaaaaaaaaaa was refused", "github_pat_"],
      ["Bad credential xoxb-1111111111-abcdefghijkl", "xoxb-"],
    ] as const) {
      const shown = detailWith(body);
      expect(shown).not.toContain(secret);
      // The refusal is still explained, not swallowed into the generic line.
      expect(shown).toMatch(/gpt-5\.5/);
    }
  });

  it("strips a bearer token whole and keeps what the provider said around it", () => {
    // The inventory takes the entire `Bearer sk-…` shape out BEFORE the
    // whole-message reject list runs, so this never reaches GENERIC: the
    // provider's one remaining word is quoted and the refusal is still
    // explained. Pinned to the exact sentence, so a redaction regression that
    // let some other text through could not pass on "no key fragment" alone.
    expect(detailWith("Bearer sk-abcdefghijklmnop rejected")).toBe(
      "That message did not go through — OpenAI rejected the request for gpt-5.5: “rejected”. Pick another model in the header, or send it again.",
    );
  });
});

describe("a provider echoing the key it refused, masked", () => {
  // Verbatim from OpenAI through the gateway on a box (2026-09-17). Two things
  // have to happen to it: the masked key goes, and the developer-facing URL
  // sentence goes — and the ORDER matters, because the shared inventory's
  // token alphabet includes `.` and so eats the full stop the URL rule cuts at.
  const DETAIL =
    "unexpected status 401 Unauthorized: Incorrect API key provided: claw_08d*************************765e."
    + " You can find your API key at https://platform.openai.com/account/api-keys.,"
    + " url: https://api.openai.com/v1/responses, cf-ray: a3c7c040e8e4bc1a-SOF,"
    + " request id: req_000000000000000000000000";

  it("keeps the provider's sentence and nothing else", () => {
    // Through the fallback note, which is where this detail actually reaches a
    // person: `describeChatFailure` answers a 401 with the reconnect sentence
    // before the provider's own words are ever quoted.
    const shown = describeFallbackReply({
      reason: "auth",
      provider: "openai",
      model: "openai/gpt-6-astra",
      servedModel: "deepseek/deepseek-v4-flash",
      detail: DETAIL,
    }) ?? "";
    expect(shown).toContain("Incorrect API key provided");
    expect(shown).not.toContain("claw_");
    expect(shown).not.toContain("*");
    expect(shown).not.toMatch(/https?:\/\//);
    expect(shown).not.toContain("cf-ray");
    expect(shown).not.toContain("req_");
  });
});
