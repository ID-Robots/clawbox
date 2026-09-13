import { describe, expect, it } from "vitest";

// A plain .mjs script, imported for its pure helpers only. Nothing runs on
// import: scripts/feature-sweep.mjs guards main() on argv[1], so importing it
// here can never sweep a box.
import { redact, tally } from "../../../scripts/feature-sweep.mjs";

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
