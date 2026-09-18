import { describe, expect, it } from "vitest";

// A plain .mjs script, imported for its pure helpers only. Nothing runs on
// import: scripts/feature-sweep.mjs guards main() on argv[1], so importing it
// here can never sweep a box.
import { redact, speechEnginesReport, tally, uiLanguageReadsBack } from "../../../scripts/feature-sweep.mjs";

/**
 * The two pure halves of scripts/feature-sweep.mjs — the only parts that can
 * be wrong without a live box saying so.
 *
 * `redact` is the one thing standing between a sweep's stdout and a credential:
 * the script prints response bodies verbatim when a check fails, and a failing
 * route can answer with anything. `tally` is what the exit code is derived
 * from, and the whole value of the sweep rests on `unproven` never being
 * counted as a pass.
 */
describe("feature-sweep redact", () => {
  it("takes out the literal secrets the sweep itself holds, first", () => {
    const token = "5f8d2c1e9a7b4f60d3c2e1a09b8c7d6e";
    expect(redact(`sent Authorization: ${token}`, [token])).toBe("sent Authorization: <redacted>");
  });

  it("ignores a literal too short to be a credential", () => {
    // A one-character "literal" would redact half of every sentence.
    expect(redact("the answer was ok", ["ok"])).toBe("the answer was ok");
  });

  it("takes out the credential shapes the device deals in", () => {
    const shapes = [
      "Bearer abc.def-ghi_jkl123",
      "claw_AbCdEfGhIjKlMnOp",
      "sk-ant-0123456789abcdef",
      "ghp_0123456789abcdef0123456789abcdef",
      "github_pat_11ABCDEFG0123456789abcdefgh",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    ];
    for (const shape of shapes) {
      expect(redact(`leaked ${shape} here`)).toBe("leaked <redacted> here");
    }
  });

  it("takes out an address and the owner's home directory", () => {
    expect(redact("mailto owner@example.com")).toBe("mailto <redacted>");
    expect(redact("/home/someone/clawbox/data/config.json")).toBe("~/clawbox/data/config.json");
  });

  it("leaves an ordinary failure sentence readable", () => {
    const sentence = 'expected 200, got 502 {"error":"Could not list cloud backups"}';
    expect(redact(sentence)).toBe(sentence);
  });

  it("never throws on what a broken route might answer with", () => {
    expect(redact(undefined)).toBe("");
    expect(redact(null)).toBe("");
    expect(redact(12345)).toBe("12345");
  });
});

describe("feature-sweep tally", () => {
  const results = [
    { area: "kv", name: "a", verdict: "pass" },
    { area: "kv", name: "b", verdict: "pass" },
    { area: "clawkeep", name: "c", verdict: "fail" },
    { area: "clawkeep", name: "d", verdict: "pass" },
    { area: "network", name: "e", verdict: "unproven" },
    { area: "media", name: "f", verdict: "pass" },
    { area: "media", name: "g", verdict: "unproven" },
  ];

  it("counts the three verdicts apart", () => {
    const summary = tally(results);
    expect(summary).toMatchObject({ passed: 4, failed: 1, unproven: 2, total: 7 });
  });

  it("fails an area on one failed check and keeps the rest of it", () => {
    const clawkeep = tally(results).areas.find((a) => a.area === "clawkeep");
    expect(clawkeep).toMatchObject({ verdict: "fail", passed: 1, failed: 1, unproven: 0 });
    expect(clawkeep?.checks).toHaveLength(2);
  });

  it("does not let unproven drag an otherwise passing area down", () => {
    // This is the rule the whole sweep rests on: `unproven` is neither a pass
    // nor a failure, so an area that proved something and could not prove
    // something else still reads as working.
    expect(tally(results).areas.find((a) => a.area === "media")).toMatchObject({ verdict: "pass", unproven: 1 });
  });

  it("calls an area that proved nothing at all unproven, never passing", () => {
    expect(tally(results).areas.find((a) => a.area === "network")).toMatchObject({ verdict: "unproven", passed: 0 });
  });

  it("keeps the areas in the order they were swept", () => {
    expect(tally(results).areas.map((a) => a.area)).toEqual(["kv", "clawkeep", "network", "media"]);
  });

  it("answers for an empty sweep", () => {
    expect(tally([])).toMatchObject({ passed: 0, failed: 0, unproven: 0, total: 0, areas: [] });
  });
});

describe("feature-sweep uiLanguageReadsBack", () => {
  /**
   * A freshly flashed box has stored no `pref:ui_language`: the desktop takes
   * its language from the browser until the owner picks one, so the route
   * answering `{}` is the route WORKING. Read with the plain `ok("ui_language")`
   * expectation that was `missing field ui_language in {}` — a red check on
   * every clean device, which is the kind of red that trains an operator to
   * re-run the sweep until it goes green.
   */
  const res = (status: number, body: unknown) => ({
    status,
    text: typeof body === "string" ? body : JSON.stringify(body),
    json: typeof body === "string" ? null : body,
  });

  it("passes when a language has been chosen", () => {
    expect(uiLanguageReadsBack(res(200, { ui_language: "de" }))).toBe(true);
  });

  it("is unproven, never a failure, when no language was ever chosen", () => {
    const verdict = uiLanguageReadsBack(res(200, {}));
    expect(verdict).toMatchObject({ unproven: expect.stringContaining("language") });
  });

  it("is unproven for an explicit null, the way a cleared value reads", () => {
    expect(uiLanguageReadsBack(res(200, { ui_language: null }))).toMatchObject({
      unproven: expect.any(String),
    });
  });

  it("still fails when the route itself is broken", () => {
    // The point of the change is to stop excusing a clean box, not to stop
    // noticing a route that no longer answers.
    expect(uiLanguageReadsBack(res(500, { error: "boom" }))).toContain("expected 200");
    expect(uiLanguageReadsBack(res(200, "<html>login</html>"))).toContain("expected a JSON object");
    expect(uiLanguageReadsBack(res(200, ["en"]))).toContain("expected a JSON object");
  });

  it("fails on a stored value that is not a language", () => {
    // `sanitizePreferences` drops a value the write rules would refuse, so
    // anything non-string arriving here is the route breaking its contract.
    expect(uiLanguageReadsBack(res(200, { ui_language: 42 }))).toContain("ui_language");
    expect(uiLanguageReadsBack(res(200, { ui_language: "" }))).toContain("ui_language");
  });
});

describe("feature-sweep speechEnginesReport", () => {
  /**
   * A box with no speech engine configured answers `activeEngine: null` beside
   * an `engines` list where nothing is `configured` — the route WORKING. Read
   * with the plain `ok("engines", "activeEngine")` expectation that failed the
   * release-gate sweep on every box without a voice engine.
   */
  const res = (status: number, body: unknown) => ({
    status,
    text: typeof body === "string" ? body : JSON.stringify(body),
    json: typeof body === "string" ? null : body,
  });
  const engine = (id: string, configured: boolean) => ({ id, configured });

  it("passes when an engine is active", () => {
    expect(speechEnginesReport(res(200, {
      activeEngine: "local",
      engines: [engine("local", true), engine("cloud", false)],
    }))).toBe(true);
  });

  it("is unproven, never a failure, when nothing on the box can speak", () => {
    const verdict = speechEnginesReport(res(200, {
      activeEngine: null,
      engines: [engine("local", false), engine("cloud", false)],
    }));
    expect(verdict).toMatchObject({ unproven: expect.stringContaining("nothing can speak") });
  });

  it("is unproven for an empty engine list too", () => {
    expect(speechEnginesReport(res(200, { activeEngine: null, engines: [] }))).toMatchObject({
      unproven: expect.any(String),
    });
  });

  it("fails when an engine is configured and none is active — drift, not an empty box", () => {
    expect(speechEnginesReport(res(200, {
      activeEngine: null,
      engines: [engine("local", true), engine("cloud", false)],
    }))).toContain("activeEngine");
  });

  it("still fails when the route itself is broken", () => {
    expect(speechEnginesReport(res(500, { error: "boom" }))).toContain("expected 200");
    expect(speechEnginesReport(res(200, "<html>login</html>"))).toContain("expected a JSON object");
    expect(speechEnginesReport(res(200, { activeEngine: "local" }))).toContain("engines");
    expect(speechEnginesReport(res(200, { activeEngine: 7, engines: [engine("local", true)] }))).toContain("activeEngine");
  });
});
