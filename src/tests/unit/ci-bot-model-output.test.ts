import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AREA_LABELS,
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  TRIAGE_SCHEMA,
  assertMatchesSchema,
  labelFor,
  plain,
} from "../../../scripts/lib/triage-output.mjs";
import { apiSchema, callClaude } from "../../../scripts/lib/ai-backend.mjs";
import fs from "node:fs";
import path from "node:path";

/**
 * What the CI bots let a model reply do to the repository.
 *
 * issue-triage.mjs runs on `issues: [opened, reopened]` with `issues: write`,
 * for any non-bot actor, and its OAuth CLI transport only PASTED the schema
 * into the prompt: whatever object `claude -p` returned went straight to
 * `gh label create`, `gh issue edit --add-label` and `gh issue comment`. An
 * issue body is attacker-chosen text, so a coaxed reply could name a label,
 * @-mention a maintainer or put an `<a href>` in a comment signed by the bot.
 *
 * The bot scripts themselves cannot be imported — they read GITHUB_EVENT_PATH
 * and run `main()` at load — so the three fences live in
 * scripts/lib/triage-output.mjs and are pinned here through that module and
 * the shared transport in scripts/lib/ai-backend.mjs.
 */

const { execFileSyncMock, sdkCreateMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn(), sdkCreateMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));
// The SDK is not installed here (the workflows install it only on the API-key
// path), so the fallback transport is exercised against a fake client whose
// `messages.create` records what it was handed.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create: sdkCreateMock };
  },
}));

const REPO = path.resolve(__dirname, "../../..");
const source = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf-8");

const canonical = {
  category: "bug",
  priority: "high",
  area: "install",
  summary: "install.sh fails on a fresh Orin when the mirror is unreachable.",
  suggested_action: "Reproduce with CLAWBOX_TEST_MODE=1 and check the apt step's retry.",
};

describe("assertMatchesSchema — the model reply against the schema it was asked for", () => {
  it("accepts the canonical triage response unchanged", () => {
    expect(assertMatchesSchema(TRIAGE_SCHEMA, canonical)).toEqual(canonical);
  });

  it("refuses an out-of-enum category, naming the path", () => {
    // The exploit: a category that is a sentence with a URL in it became a
    // label name. `labelFor` refuses it again below; this is the first fence.
    expect(() => assertMatchesSchema(TRIAGE_SCHEMA, { ...canonical, category: "SECURITY: rotate token at evil.example" }))
      .toThrow(/rejected at \$\.category: expected one of/);
  });

  it("refuses a non-string priority, naming the path", () => {
    // `priority: [object Object]` was a label this could create.
    expect(() => assertMatchesSchema(TRIAGE_SCHEMA, { ...canonical, priority: { x: 1 } }))
      .toThrow(/rejected at \$\.priority/);
  });

  it("refuses a missing required key, naming it", () => {
    const { suggested_action: _dropped, ...without } = canonical;
    void _dropped;
    expect(() => assertMatchesSchema(TRIAGE_SCHEMA, without))
      .toThrow(/rejected at \$: missing required key "suggested_action"/);
  });

  it("drops an unknown key rather than refusing the reply", () => {
    // A stray key from a model answering a prompt-pasted schema is not worth
    // an untriaged issue — but it is not passed through either.
    const out = assertMatchesSchema(TRIAGE_SCHEMA, { ...canonical, confidence: 0.9 });
    expect(out).toEqual(canonical);
    expect("confidence" in out).toBe(false);
  });

  it("truncates an over-long summary to its maxLength instead of refusing it", () => {
    const summary = "x".repeat(TRIAGE_SCHEMA.properties.summary.maxLength + 50);
    const out = assertMatchesSchema(TRIAGE_SCHEMA, { ...canonical, summary });
    expect(out.summary).toHaveLength(TRIAGE_SCHEMA.properties.summary.maxLength);
  });

  it("caps the free-text fields of both bots' schemas", () => {
    // The verdict's point about the SDK transport: the API enforces enums
    // there, but the free text is by design unbounded unless the schema says.
    for (const key of ["summary", "suggested_action"] as const) {
      expect(typeof TRIAGE_SCHEMA.properties[key].maxLength, `${key} has no maxLength`).toBe("number");
    }
  });

  it("walks the pr-review shape: nested objects, arrays with maxItems, booleans", () => {
    // pr-review.mjs's SCHEMA is not importable (its main() runs at load), so
    // the shape it declares is mirrored here: `highlights[].{note,tone}` and
    // `duplicate` both say additionalProperties: false, and the validator has
    // to enforce that RECURSIVELY.
    const schema = {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["feature", "fix"] },
        highlights: {
          type: "array",
          maxItems: 2,
          items: {
            type: "object",
            properties: { note: { type: "string", maxLength: 10 }, tone: { type: "string", enum: ["info", "heads-up"] } },
            required: ["note", "tone"],
            additionalProperties: false,
          },
        },
        duplicate: {
          type: "object",
          properties: { likely: { type: "boolean" }, of: { type: "string" } },
          required: ["likely", "of"],
          additionalProperties: false,
        },
      },
      required: ["kind", "highlights", "duplicate"],
      additionalProperties: false,
    };
    const out = assertMatchesSchema(schema, {
      kind: "fix",
      highlights: [
        { note: "a note that runs long", tone: "info", extra: true },
        { note: "b", tone: "heads-up" },
        { note: "c", tone: "info" },
      ],
      duplicate: { likely: false, of: "", why: "not asked for" },
    });
    expect(out).toEqual({
      kind: "fix",
      highlights: [{ note: "a note tha", tone: "info" }, { note: "b", tone: "heads-up" }],
      duplicate: { likely: false, of: "" },
    });

    expect(() => assertMatchesSchema(schema, { kind: "fix", highlights: [{ note: "x", tone: "loud" }], duplicate: { likely: false, of: "" } }))
      .toThrow(/rejected at \$\.highlights\[0\]\.tone/);
    expect(() => assertMatchesSchema(schema, { kind: "fix", highlights: [], duplicate: { likely: "no", of: "" } }))
      .toThrow(/rejected at \$\.duplicate\.likely: expected a boolean/);
    expect(() => assertMatchesSchema(schema, { kind: "fix", highlights: "none", duplicate: { likely: false, of: "" } }))
      .toThrow(/rejected at \$\.highlights: expected an array/);
  });

  it("refuses a schema keyword it cannot check rather than passing it", () => {
    // A schema this validator does not understand must fail loudly — a future
    // `type: "number"` field would otherwise be a field nothing validates.
    expect(() => assertMatchesSchema({ type: "number" }, 3)).toThrow(/not one this validator checks/);
  });

  it("refuses a non-object reply outright", () => {
    expect(() => assertMatchesSchema(TRIAGE_SCHEMA, null)).toThrow(/rejected at \$: expected an object, got null/);
    expect(() => assertMatchesSchema(TRIAGE_SCHEMA, [canonical])).toThrow(/rejected at \$: expected an object, got array/);
  });
});

describe("the label tables — no model string is ever a label name", () => {
  it("throws on a key that is not in the table, with no fallback", () => {
    // The `?? "ededed"` fallback was what let any category string become a
    // label; there is deliberately no default colour or name any more.
    expect(() => labelFor(CATEGORY_LABELS, "category", "SECURITY ADVISORY")).toThrow(/category "SECURITY ADVISORY" is not one of/);
    expect(() => labelFor(PRIORITY_LABELS, "priority", { x: 1 })).toThrow(/priority/);
    expect(() => labelFor(AREA_LABELS, "area", undefined)).toThrow(/area/);
    // Prototype keys are not table entries either.
    expect(() => labelFor(CATEGORY_LABELS, "category", "constructor")).toThrow(/category/);
  });

  it("answers the fixed name and colour for a known key", () => {
    expect(labelFor(PRIORITY_LABELS, "priority", "high")).toEqual({ name: "priority: high", color: "b60205", icon: "🔴" });
    expect(labelFor(AREA_LABELS, "area", "ci-e2e")).toEqual({ name: "area: ci-e2e", color: "c5def5" });
    expect(labelFor(CATEGORY_LABELS, "category", "bug")).toEqual({ name: "bug", color: "d73a4a" });
  });

  it("is the same list the schema asks the model for", () => {
    // The enum and the table are one list, so they cannot drift apart: a key
    // the schema admits is always a key the table can name.
    expect(TRIAGE_SCHEMA.properties.category.enum).toEqual(Object.keys(CATEGORY_LABELS));
    expect(TRIAGE_SCHEMA.properties.priority.enum).toEqual(Object.keys(PRIORITY_LABELS));
    expect(TRIAGE_SCHEMA.properties.area.enum).toEqual(Object.keys(AREA_LABELS));
  });
});

describe("plain — model free text as one inert line of a comment", () => {
  it("escapes HTML", () => {
    const out = plain('rotate it <a href="https://evil.example">here</a>');
    expect(out).not.toContain("<a");
    expect(out).not.toContain("</a>");
    expect(out).toContain("&lt;a href=");
  });

  it("breaks a markdown link", () => {
    expect(plain("see [the fix](https://evil.example/x)")).not.toContain("](");
  });

  it("breaks a bare autolink", () => {
    const out = plain("go to https://evil.example/x now");
    expect(out).not.toContain("https://");
    expect(out).toContain("https:\u200b//");
  });

  it("stops an @-mention from notifying anyone", () => {
    const out = plain("@maintainer your token was leaked");
    expect(out).not.toContain("@maintainer");
    expect(out).toContain("@\u200bmaintainer");
  });

  it("shows an entity as the entity, so `&#64;` cannot decode into a mention", () => {
    // GitHub's mention filter runs over the DECODED text, so an `@` spelt as
    // an entity would be a live mention; escaping `&` keeps it an entity.
    expect(plain("&#64;maintainer rotate it")).toBe("&amp;#64;maintainer rotate it");
    // …and the escape of `<` is not itself re-escaped.
    expect(plain("<b>")).toBe("&lt;b&gt;");
  });

  it("breaks a scheme-less www. autolink", () => {
    // GitHub's extended autolink links `www.` hosts with no scheme at all.
    const out = plain("open www.evil.example/phish");
    expect(out).not.toContain("www.evil");
    expect(out).toContain("www.\u200bevil.example/phish");
  });

  it("collapses newlines so the text cannot open a heading of its own", () => {
    const out = plain("fine.\n\n# ACTION REQUIRED\n- do this");
    expect(out).not.toContain("\n");
    expect(out).toBe("fine. # ACTION REQUIRED - do this");
  });

  it("strips a leading block marker", () => {
    expect(plain("# ACTION REQUIRED")).toBe("ACTION REQUIRED");
    expect(plain("> quoted")).toBe("quoted");
    expect(plain("- a list item")).toBe("a list item");
    // …but an issue reference is text, not a heading.
    expect(plain("#241")).toBe("#241");
  });

  it("caps the length", () => {
    const out = plain("y".repeat(1000), 100);
    expect(out).toHaveLength(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves ordinary prose alone", () => {
    expect(plain("Reproduce with CLAWBOX_TEST_MODE=1 and check the apt step's retry.")).toBe(
      "Reproduce with CLAWBOX_TEST_MODE=1 and check the apt step's retry.",
    );
    expect(plain(undefined)).toBe("");
  });
});

describe("callClaude — validated on the OAuth CLI transport before anything returns", () => {
  const cliOpts = {
    system: "triage",
    schema: TRIAGE_SCHEMA,
    userContent: "<title>x</title>",
    model: "claude-haiku-4-5",
    maxTokens: 1024,
    timeoutMs: 1000,
    maxBuffer: 1024,
  };

  beforeEach(() => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token-for-the-test");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws on a hostile reply rather than handing it to the caller", async () => {
    // The exploit shape: the CLI wrapper carrying a reply the schema does not
    // admit. Before this, `parseModelJson` handed it straight to `gh`.
    execFileSyncMock.mockReturnValue(JSON.stringify({
      result: JSON.stringify({
        category: "<a href=x>",
        priority: "high",
        area: "install",
        summary: "@maintainer rotate your token at https://evil.example",
        suggested_action: "…",
      }),
    }));
    await expect(callClaude(cliOpts)).rejects.toThrow(/rejected at \$\.category/);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0][0]).toBe("claude");
    // …and says so where the run page shows it: both bots' outer catch exits
    // 0, so a quiet refusal would be an untriaged issue under a green run.
    expect(vi.mocked(console.error).mock.calls.some(([line]) => String(line).startsWith("::error::"))).toBe(true);
  });

  it("returns the conformed reply for a canonical answer", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({ result: JSON.stringify({ ...canonical, extra: "dropped" }) }));
    await expect(callClaude(cliOpts)).resolves.toEqual(canonical);
  });

  it("still validates when the CLI wraps the JSON in a fence", async () => {
    execFileSyncMock.mockReturnValue(JSON.stringify({
      result: "```json\n" + JSON.stringify({ ...canonical, priority: "urgent" }) + "\n```",
    }));
    await expect(callClaude(cliOpts)).rejects.toThrow(/rejected at \$\.priority/);
  });
});

describe("callClaude — the SDK fallback transport", () => {
  const sdkOpts = {
    system: "triage",
    schema: TRIAGE_SCHEMA,
    userContent: "<title>x</title>",
    model: "claude-haiku-4-5",
    maxTokens: 1024,
    timeoutMs: 1000,
    maxBuffer: 1024,
  };

  beforeEach(() => {
    // No OAuth token: the API-key transport is the one that runs.
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    sdkCreateMock.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const hasKeyword = (node: unknown, keyword: string): boolean => {
    if (Array.isArray(node)) return node.some((n) => hasKeyword(n, keyword));
    if (node === null || typeof node !== "object") return false;
    return Object.entries(node as Record<string, unknown>)
      .some(([k, v]) => k === keyword || hasKeyword(v, keyword));
  };

  it("hands the API a schema without the caps it refuses, and still applies them locally", async () => {
    // Anthropic's structured outputs reject `maxLength`/`maxItems` in a raw
    // `output_config.format.schema` (only the SDK's `.parse()` strips them),
    // so a schema sent as written was a 400 on every fallback call — and
    // both bots' outer catch turns a 400 into a green run.
    const summary = "s".repeat(TRIAGE_SCHEMA.properties.summary.maxLength + 25);
    sdkCreateMock.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ ...canonical, summary, extra: "dropped" }) }],
    });
    const out = await callClaude(sdkOpts);
    expect(sdkCreateMock).toHaveBeenCalledTimes(1);
    const sent = sdkCreateMock.mock.calls[0][0].output_config.format.schema;
    expect(hasKeyword(sent, "maxLength")).toBe(false);
    expect(hasKeyword(sent, "maxItems")).toBe(false);
    // What the API does enforce is still asked of it.
    expect(sent.additionalProperties).toBe(false);
    expect(sent.required).toEqual(TRIAGE_SCHEMA.required);
    expect(sent.properties.category.enum).toEqual(TRIAGE_SCHEMA.properties.category.enum);
    // The caller's schema is not mutated; the reply is conformed to it.
    expect(TRIAGE_SCHEMA.properties.summary.maxLength).toBe(200);
    expect(out.summary).toHaveLength(TRIAGE_SCHEMA.properties.summary.maxLength);
    expect("extra" in out).toBe(false);
  });

  it("strips the caps at every depth of the pr-review shape and nothing else", () => {
    const schema = {
      type: "object",
      properties: {
        highlights: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            properties: { note: { type: "string", maxLength: 240, description: "kept" } },
            required: ["note"],
            additionalProperties: false,
          },
        },
      },
      required: ["highlights"],
      additionalProperties: false,
    };
    expect(apiSchema(schema)).toEqual({
      type: "object",
      properties: {
        highlights: {
          type: "array",
          items: {
            type: "object",
            properties: { note: { type: "string", description: "kept" } },
            required: ["note"],
            additionalProperties: false,
          },
        },
      },
      required: ["highlights"],
      additionalProperties: false,
    });
    expect(schema.properties.highlights.maxItems, "the caller's schema was mutated").toBe(4);
  });

  it("validates the SDK reply the same way as the CLI one", async () => {
    sdkCreateMock.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ ...canonical, area: "everything" }) }],
    });
    await expect(callClaude(sdkOpts)).rejects.toThrow(/rejected at \$\.area/);
    expect(vi.mocked(console.error).mock.calls.some(([line]) => String(line).startsWith("::error::"))).toBe(true);
  });
});

describe("the bot scripts' sinks — pinned as text, since neither script can be imported", () => {
  // Both run main() at load, so the fences are checked where they are
  // applied: no model string in a label argument, no free-text field in a
  // comment outside plain(). Belt and braces over callClaude's validator —
  // a revert to `ensure(\`priority: ${t.priority}\`, …)` would pass it.
  const triage = source("scripts/issue-triage.mjs");
  const review = source("scripts/pr-review.mjs");

  it("issue-triage looks every label up in the tables and never templates a model key into one", () => {
    expect(triage).toContain("labelFor(CATEGORY_LABELS");
    expect(triage).toContain("labelFor(PRIORITY_LABELS");
    expect(triage).toContain("labelFor(AREA_LABELS");
    for (const key of ["t.category", "t.priority", "t.area"]) {
      // A template literal carrying the model's key on a label line.
      expect(triage, `${key} reaches a label as a template`).not.toMatch(new RegExp(`(ensure\\(|add-label)[^\\n]*\\$\\{${key.replace(".", "\\.")}`));
    }
    expect(triage, "the old any-string-is-a-label fallback is back").not.toContain('"ededed"');
  });

  it("issue-triage renders its free text only through plain()", () => {
    for (const field of ["t.summary", "t.suggested_action"]) {
      const uses = triage.match(new RegExp(`\\b${field.replace(".", "\\.")}\\b`, "g")) ?? [];
      const wrapped = triage.match(new RegExp(`plain\\(${field.replace(".", "\\.")}\\b`, "g")) ?? [];
      expect(uses.length, `${field} is never rendered`).toBeGreaterThan(0);
      expect(wrapped.length, `${field} is rendered outside plain()`).toBe(uses.length);
    }
  });

  it("pr-review renders its free text only through plain()", () => {
    for (const field of ["r.summary", "r.touches", "h.note", "r.duplicate.of", "r.duplicate.reason"]) {
      const escaped = field.replace(/\./g, "\\.");
      const uses = review.match(new RegExp(`\\b${escaped}\\b`, "g")) ?? [];
      const wrapped = review.match(new RegExp(`plain\\(${escaped}\\b`, "g")) ?? [];
      expect(uses.length, `${field} is never rendered`).toBeGreaterThan(0);
      expect(wrapped.length, `${field} is rendered outside plain()`).toBe(uses.length);
    }
  });
});
