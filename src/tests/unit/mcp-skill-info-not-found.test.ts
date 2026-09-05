import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agent-facing half of TASK-547.
 *
 * Phase 1 of the inspect route answers 200 for ANY well-formed id — this device
 * cannot refuse one, because its catalogue is a snapshot the browse route builds
 * once and never rebuilds, and `related_skills` chips address skills by bare
 * name, which is not a key of that snapshot at all. So `skill_info` was left
 * guessing from empty fields whether the record it held was a sparse skill or no
 * skill, and a phase-2 timeout — the route's own 45 s cap — was guessed the same
 * way as a refusal: "No skill with that id — the device knows nothing about it."
 *
 * `catalogMiss` says which records are placeholders, and Hermes settles the
 * rest: a refusal (404 from `hermes skills inspect`) is not-found, a FAILURE is
 * a question this device could not ask.
 */

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

// Reproduces what api() does around a call: a matched ErrorRule becomes a
// ToolError before the tool handler ever sees the ApiError.
vi.mock("../../../mcp/lib/api", async () => {
  const { ApiError, matchRule } = await import("../../../mcp/lib/errors");
  const withRules =
    (fn: (...a: unknown[]) => unknown) =>
    async (route: string, ...rest: unknown[]) => {
      try {
        return await fn(route, ...rest);
      } catch (err) {
        const opts = (rest[rest.length - 1] ?? {}) as { rules?: Parameters<typeof matchRule>[1] };
        if (err instanceof ApiError) throw matchRule(err, opts?.rules) ?? err;
        throw err;
      }
    };
  return {
    apiGet: withRules(apiGet),
    apiPost: withRules(apiPost),
    apiTry: vi.fn(async () => null),
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));

vi.mock("@/lib/hermes-skills-cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-skills-cli")>();
  return { ...actual, runSkillsCli: vi.fn() };
});

vi.mock("@/lib/hermes-skill-index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-skill-index")>();
  return { ...actual, getCatalogRecord: vi.fn(async () => undefined) };
});

import { ApiError, ToolError } from "../../../mcp/lib/errors";
import { registerSkillTools } from "../../../mcp/tools/skills";
import { captureRegistrar } from "../helpers/mcp-registrar";

const UNKNOWN_ID = "clawhub/definitely-not-a-real-skill";

/** Exactly what phase 1 puts on the wire for an id nothing on the device backs. */
const UNBACKED = {
  skill: {
    id: UNKNOWN_ID,
    name: UNKNOWN_ID,
    catalogMiss: true,
    provenance: { sourceUrlVerified: false },
    bodySource: "none",
    bodyTruncated: false,
    needsRemoteDocs: true,
  },
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

function skills() {
  const h = captureRegistrar("hermes");
  registerSkillTools(h.reg);
  return h;
}

/** Phase 1 answers `phase1`; the docs call fails with `docsError`. */
function twoPhases(phase1: unknown, docsError: unknown) {
  apiGet.mockImplementation(async (_route: string, opts: { query?: Record<string, unknown> }) => {
    if (opts?.query?.docs) throw docsError;
    return phase1;
  });
}

describe("skill_info — an id nothing on the device backs", () => {
  it("says NOT_FOUND once Hermes itself has refused the id", async () => {
    // The route's own phase-2 404: `hermes skills inspect` printed no skill panel
    // and no disambiguation table.
    twoPhases(
      UNBACKED,
      new ApiError(404, JSON.stringify({ error: "Skill not found", code: "not_found" })),
    );

    const out = await skills().call("skill_info", { id: UNKNOWN_ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/skill_search/i);
    // Not the edition guard's 404, whose advice goes back through the same guard.
    expect(out.error.code).not.toBe("NOT_SUPPORTED_HERE");
  });

  it("does not call a skill imaginary because the docs call timed out", async () => {
    // The route caps `hermes skills inspect` at 45 s and answers 504 cli_timeout;
    // a browse.sh row over the unauthenticated GitHub API measures ~60 s on this
    // hardware, so this is the ordinary case, not the exotic one. It says nothing
    // about whether the skill exists.
    twoPhases(
      UNBACKED,
      new ApiError(504, JSON.stringify({ error: "Could not load the full documentation", code: "cli_timeout" })),
    );

    const out = await skills().call("skill_info", { id: UNKNOWN_ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).not.toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/do not tell them the skill does not exist/i);
  });

  it("still describes a skill the catalogue does back", async () => {
    // The docs call failing must not take a real record with it.
    twoPhases(
      {
        skill: {
          id: "official/pdf",
          name: "PDF",
          description: "Work with PDFs.",
          source: "official",
          trust: "builtin",
          bodySource: "none",
          bodyTruncated: false,
          needsRemoteDocs: true,
        },
      },
      new ApiError(504, JSON.stringify({ code: "cli_timeout" })),
    );

    const out = await skills().call("skill_info", { id: "official/pdf" });

    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("official/pdf");
  });
});

/**
 * The third 200-shaped outcome of phase 2, and the one the tool did not model.
 *
 * `hermes skills inspect <bare name>` prints a DISAMBIGUATION TABLE instead of a
 * skill panel when several catalogue rows match, and the route answers that as a
 * 200 `{ ambiguous, query, candidates }` (inspect/route.ts, `remoteDocs`). Read
 * only through `phase2?.delta`, it is neither a refusal nor a failure — so the
 * phase-1 PLACEHOLDER was handed to the agent as a real skill: the name is the
 * requested id echoed back, with no description, no source and no trust. That is
 * TASK-547's symptom verbatim, reached by the very input phase 2 exists to
 * resolve, since the store opens details by publisher-written bare NAME.
 */
describe("skill_info — an id Hermes could not narrow down", () => {
  /** Phase 1 answers `phase1`; the docs call ANSWERS with `docs`. */
  function twoPhaseAnswers(phase1: unknown, docs: unknown) {
    apiGet.mockImplementation(async (_route: string, opts: { query?: Record<string, unknown> }) =>
      opts?.query?.docs ? docs : phase1,
    );
  }

  it("refuses an ambiguous name with its candidates instead of inventing a skill", async () => {
    twoPhaseAnswers(
      { skill: { ...UNBACKED.skill, id: "notion", name: "notion" } },
      {
        ambiguous: true,
        query: "notion",
        candidates: [{ id: "official/notion" }, { id: "clawhub/notion-api" }],
      },
    );

    const out = await skills().call("skill_info", { id: "notion" });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    // The same answer phase 1's own ambiguity branch gives, so one device state
    // cannot produce two stories.
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.next).toContain("official/notion");
    expect(out.error.next).toContain("clawhub/notion-api");
  });

  it("still describes a skill only HERMES backs, however thin its panel is", async () => {
    // The other side of the floor, and the false failure it must not become.
    // A skill published since this device built its catalogue snapshot is real
    // and unbacked HERE — `catalogMiss` and no source or trust — and Hermes is
    // the authority that settles it. The route builds a delta off a real panel
    // with `bodySource`, `bodyTruncated`, `needsRemoteDocs` and `provenance`
    // always on it, so a panel carrying no Description row and no prose preview
    // is still Hermes saying the skill exists.
    twoPhaseAnswers(UNBACKED, {
      delta: {
        bodySource: "cli-preview",
        bodyTruncated: true,
        needsRemoteDocs: false,
        provenance: { sourceUrlVerified: false },
      },
    });

    const out = await skills().call("skill_info", { id: UNKNOWN_ID });

    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain(UNKNOWN_ID);
  });

  it("propagates a refusal the rules already classified", async () => {
    // `skillsGet` PREPENDS the edition rule, and `api()` turns a matched body
    // into a ToolError before this caller's `.catch` runs — so a phase-2 404
    // carrying `not_hermes` is not an `ApiError`, fails the `instanceof` test,
    // and was bucketed as "the device could not look that skill up", swallowing
    // a NOT_SUPPORTED_HERE the agent has to act on.
    twoPhases(UNBACKED, new ApiError(404, JSON.stringify({ error: "Not found", code: "not_hermes" })));

    const out = await skills().call("skill_info", { id: UNKNOWN_ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_SUPPORTED_HERE");
  });

  it("does not read a 404 that is not a not-found as Hermes refusing the id", async () => {
    // Status alone is not the refusal: only `code: "not_found"` is the route
    // saying `hermes skills inspect` printed neither a panel nor a table.
    twoPhases(UNBACKED, new ApiError(404, JSON.stringify({ error: "Nope", code: "something_else" })));

    const out = await skills().call("skill_info", { id: UNKNOWN_ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).not.toBe("NOT_FOUND");
  });
});

/**
 * The docs phase failing must not take a proven record down with it.
 *
 * `api()` raises its OWN ToolErrors — `TIMEOUT` for any aborted fetch,
 * `ENDPOINT_DOWN` for a transport failure — not only the ones an ErrorRule
 * matched. Re-throwing every ToolError therefore turns a slow documentation
 * lookup into a failed `skill_info` over a skill the catalogue proved exists,
 * discarding phase 1's metadata.
 *
 * And it is the ORDINARY case: this tool caps phase 2 at 30 s while the route
 * caps the CLI at 45 s, and the route's own comment says a browse.sh/github row
 * measures ~60 s on a loaded box — so the tool's own fetch is what gives up,
 * every time, and the route's 504 can essentially never reach it.
 */
describe("skill_info — a docs lookup that failed is not a verdict on the skill", () => {
  const BACKED = {
    skill: {
      id: "browse-sh/example.com/thing",
      name: "Thing",
      description: "Does a thing.",
      source: "browse-sh",
      trust: "community",
      bodySource: "none",
      bodyTruncated: false,
      needsRemoteDocs: true,
    },
  };

  it("still describes the skill when the docs fetch timed out", async () => {
    twoPhases(
      BACKED,
      new ToolError(
        "TIMEOUT",
        "The ClawBox service did not answer in time.",
        "Retry once. If it times out again, call clawbox_health and tell the user.",
      ),
    );

    const out = await skills().call("skill_info", { id: "browse-sh/example.com/thing" });

    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("browse-sh/example.com/thing");
  });

  it("says the documentation is missing rather than letting it read as absent", async () => {
    // A silent empty `documentation` lets an agent report "this skill has no
    // documentation" over a lookup that never completed.
    twoPhases(
      BACKED,
      new ToolError("ENDPOINT_DOWN", "The ClawBox service is not answering.", "Call clawbox_health."),
    );

    const out = await skills().call("skill_info", { id: "browse-sh/example.com/thing" });

    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(JSON.parse(out.text).documentation_unavailable).toBe(true);
  });

  it("still refuses an unbacked record whose docs fetch timed out, without claiming it is imaginary", async () => {
    twoPhases(UNBACKED, new ToolError("TIMEOUT", "…", "…"));

    const out = await skills().call("skill_info", { id: UNKNOWN_ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).not.toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/do not tell them the skill does not exist/i);
  });
});
