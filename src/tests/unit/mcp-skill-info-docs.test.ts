import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HERMES-06 — the phase-2 documentation fetch, from the agent's side.
 *
 * `skill_info` answers in two phases: `?id=` is metadata off disk and the
 * catalog (no CLI), and `?id=&docs=1` shells out to `hermes skills inspect` for
 * the README of a skill that is not installed. Two defects sat on that second
 * call:
 *
 *  1. The tool allowed the fetch 30 s while the ROUTE lets the CLI itself run
 *     for the shared docs cap. The tool therefore gave up first, every time the
 *     route was slow enough to matter — the route's own 504 (`cli_timeout`, the
 *     one answer that says WHICH half failed) could never arrive.
 *  2. The failure was swallowed by `.catch(() => null)`, so `documentation`
 *     stayed `""` and the agent read that as "this skill ships no
 *     documentation" — it then described a store skill to the user from its
 *     name alone, with no sign anything had gone wrong. The browser panel has
 *     said "the documentation could not be loaded" since HERMES-04; the agent
 *     was the surface still being told a fetch failure was an empty README.
 *
 * The metadata calls are deliberately NOT part of this: a 30 s budget for a
 * call that never spawns the CLI is correct, and pinning it here keeps the
 * timeout change from spreading into them.
 */

const { apiGet, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

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

import { ApiError, ToolError } from "../../../mcp/lib/errors";
import { registerSkillTools } from "../../../mcp/tools/skills";
import { captureRegistrar } from "../helpers/mcp-registrar";

const INSPECT = "/setup-api/hermes/skills/inspect";
const ID = "clawhub/pdf-tools";

/**
 * What the route serves from phase 1 for a store skill that is not installed:
 * catalog metadata, no body, `needsRemoteDocs` set — the shape that makes the
 * tool fire the second call at all.
 */
const PHASE1 = {
  skill: {
    id: ID,
    name: "pdf-tools",
    description: "Work with PDF files.",
    source: "clawhub",
    trust: "community",
    needsRemoteDocs: true,
  },
};

function skills() {
  const h = captureRegistrar("hermes");
  registerSkillTools(h.reg);
  return h;
}

/** Phase 1 answers; phase 2 (`docs=1`) is handed to `onDocs`. */
function inspectIs(onDocs: () => Promise<unknown>) {
  apiGet.mockImplementation(async (route: string, opts: { query?: Record<string, unknown> }) => {
    if (route !== INSPECT) throw new Error(`unexpected GET ${route}`);
    if (opts?.query?.docs) return onDocs();
    return PHASE1;
  });
}

/** The note the answer carries about its documentation, or "" when it has none. */
function noteOf(textOut: string): string {
  const body = JSON.parse(textOut) as { documentation_note?: unknown };
  return typeof body.documentation_note === "string" ? body.documentation_note : "";
}

/** The options the tool passed for whichever inspect call asked for docs. */
function docsCall(): { query?: Record<string, unknown>; timeoutMs?: number } {
  const call = apiGet.mock.calls.find(
    (c) => c[0] === INSPECT && (c[1] as { query?: Record<string, unknown> })?.query?.docs,
  );
  if (!call) throw new Error("the tool never asked for the documentation");
  return call[1] as { query?: Record<string, unknown>; timeoutMs?: number };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("skill_info — a documentation fetch that failed is not an empty README", () => {
  it("says the documentation could not be fetched when the route reports its own timeout", async () => {
    // The route's answer when `hermes skills inspect` outruns the docs cap: a
    // 504 whose code names the documentation, not the skill.
    inspectIs(async () => {
      throw new ApiError(
        504,
        JSON.stringify({ error: "Could not load the full documentation", code: "cli_timeout" }),
      );
    });

    const out = await skills().call("skill_info", { id: ID });

    // Still an ANSWER — the metadata is real and the agent should relay it.
    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    // ...but it has to carry the failure, in words the agent can repeat. On the
    // named field: `"documentation": ""` is in the answer either way, so a
    // match against the whole blob would pass on the key alone.
    const note = noteOf(out.text);
    expect(note).toMatch(/could not be fetched/i);
    // Naming the deadline is what separates "the source was slow" from "the
    // device broke", which are different things to tell the user.
    expect(note).toMatch(/within \d+ seconds/i);
  });

  it("says so for a documentation fetch that failed for any other reason", async () => {
    inspectIs(async () => {
      throw new ApiError(
        502,
        JSON.stringify({ error: "Could not load skill details", code: "cli_failed" }),
      );
    });

    const out = await skills().call("skill_info", { id: ID });

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    const note = noteOf(out.text);
    expect(note).toMatch(/could not be fetched/i);
    // A device that broke is not a source that was slow, and the note must not
    // invent a deadline that was never reached.
    expect(note).not.toMatch(/within \d+ seconds/i);
  });

  it("keeps quiet when the documentation arrived", async () => {
    inspectIs(async () => ({ delta: { body: "# pdf-tools\n\nSplit and merge PDFs." } }));

    const out = await skills().call("skill_info", { id: ID });

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("Split and merge PDFs.");
    expect(noteOf(out.text)).toBe("");
  });

  it("allows the fetch at least as long as the route allows the CLI it runs", async () => {
    // The route caps `hermes skills inspect` at the shared docs timeout and
    // only then answers 504. A client budget below that cap aborts first, so
    // the route's code never reaches the agent and every slow source reads as
    // "the ClawBox service did not answer in time" instead.
    inspectIs(async () => ({ delta: { body: "x" } }));

    await skills().call("skill_info", { id: ID });

    // Strictly MORE than the cap: equal budgets race, and the loser is the
    // route's 504 — the only answer that says the documentation was what
    // failed.
    expect(docsCall().timeoutMs).toBeGreaterThan(60_000);
  });

  it("leaves the metadata calls at their own 30 s budget", async () => {
    inspectIs(async () => ({ delta: { body: "x" } }));

    await skills().call("skill_info", { id: ID });

    const phase1 = apiGet.mock.calls.find(
      (c) => c[0] === INSPECT && !(c[1] as { query?: Record<string, unknown> })?.query?.docs,
    );
    expect((phase1?.[1] as { timeoutMs?: number })?.timeoutMs).toBe(30_000);
  });

  it("still refuses a skill the device knows nothing about, once phase 2 has answered", async () => {
    // The emptiness guard's premise is that phase 2 RAN: a record with no
    // description, documentation, source or trust after the CLI has had its
    // turn is a skill that does not exist. That premise holds only for a
    // phase 2 that ANSWERED — here, with an empty delta.
    apiGet.mockImplementation(async (route: string, opts: { query?: Record<string, unknown> }) => {
      if (route !== INSPECT) throw new Error(`unexpected GET ${route}`);
      if (opts?.query?.docs) return { delta: {} };
      return { skill: { id: ID, name: "pdf-tools", needsRemoteDocs: true } };
    });

    const out = await skills().call("skill_info", { id: ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
  });

  it("does NOT call a skill non-existent when the lookup timed out", async () => {
    // The same empty record, on a box whose catalogue index is not built — so
    // phase 1 synthesises {id, name, needsRemoteDocs} for ANY well-formed id
    // and the CLI is the only thing that could have resolved it. Answering
    // "the device knows nothing about it — do not guess ids" over a fetch that
    // never completed is the harder version of the lie this tool just stopped
    // telling.
    apiGet.mockImplementation(async (route: string, opts: { query?: Record<string, unknown> }) => {
      if (route !== INSPECT) throw new Error(`unexpected GET ${route}`);
      if (opts?.query?.docs) throw new ApiError(504, JSON.stringify({ code: "cli_timeout" }));
      return { skill: { id: ID, name: "pdf-tools", needsRemoteDocs: true } };
    });

    const out = await skills().call("skill_info", { id: ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("TIMEOUT");
    expect(out.error.next).toMatch(/does not exist/i);
  });

  it("does not claim a source deadline when it was OUR budget that ran out", async () => {
    // The route queues its CLI calls two at a time and that wait is not part
    // of the cap, so the client can still give up first. Naming "within 60
    // seconds" there would attribute a queue wait to a fetch that may never
    // have started.
    inspectIs(async () => {
      throw new ToolError(
        "TIMEOUT",
        "The ClawBox service did not answer in time.",
        "Retry once.",
      );
    });

    const out = await skills().call("skill_info", { id: ID });

    expect(out.isError, JSON.stringify(out)).toBe(false);
    if (out.isError) return;
    const note = noteOf(out.text);
    expect(note).toMatch(/could not be fetched/i);
    expect(note).not.toMatch(/within \d+ seconds/i);
  });

  it("puts an ambiguous id back to the user instead of an empty README", async () => {
    // The route answers ambiguity with a 200 from the DOCS phase only, so the
    // tool's phase-1 check never fired and the answer reached the agent as
    // `documentation: ""` with nothing saying why.
    inspectIs(async () => ({
      ambiguous: true,
      query: ID,
      candidates: [{ id: "clawhub/pdf-tools", name: "pdf-tools" }, { id: "official/pdf", name: "pdf" }],
    }));

    const out = await skills().call("skill_info", { id: ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.next).toContain("official/pdf");
  });

  it("does not read a code-less 404 as the CLI saying the skill is unknown", async () => {
    // A device build that predates this route answers 404 with no code at all.
    // Reading that as the CLI's own lookup verdict puts "do not guess ids" back
    // on a request nothing ever answered — the defect this file exists for, in
    // its last branch.
    apiGet.mockImplementation(async (route: string, opts: { query?: Record<string, unknown> }) => {
      if (route !== INSPECT) throw new Error(`unexpected GET ${route}`);
      if (opts?.query?.docs) throw new ApiError(404, "<!doctype html>");
      return { skill: { id: ID, name: "pdf-tools", needsRemoteDocs: true } };
    });

    const out = await skills().call("skill_info", { id: ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).not.toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/not that the skill is missing/i);
  });

  it("still reads the route's own not_found code as the CLI's verdict", async () => {
    apiGet.mockImplementation(async (route: string, opts: { query?: Record<string, unknown> }) => {
      if (route !== INSPECT) throw new Error(`unexpected GET ${route}`);
      if (opts?.query?.docs) {
        throw new ApiError(404, JSON.stringify({ error: "Skill not found", code: "not_found" }));
      }
      return { skill: { id: ID, name: "pdf-tools", needsRemoteDocs: true } };
    });

    const out = await skills().call("skill_info", { id: ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
  });

  it("rethrows an off-Hermes refusal rather than calling it a documentation failure", async () => {
    // NOT_SUPPORTED_HERE is the whole tool failing. Reporting it as "the
    // documentation could not be fetched, everything else is accurate" would
    // put a second false story on top of the first.
    inspectIs(async () => {
      throw new ApiError(404, JSON.stringify({ error: "Not found", code: "not_hermes" }));
    });

    const out = await skills().call("skill_info", { id: ID });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_SUPPORTED_HERE");
  });
});
