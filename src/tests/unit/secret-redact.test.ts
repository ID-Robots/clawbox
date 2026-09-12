/**
 * Keeping an injected secret out of a run's own output.
 *
 * The property under test: a value a run was handed does not survive into
 * anything the web server writes about that run. That matters because the run
 * record is persisted in `data/coding-agent-runs.json` and answered by
 * `/setup-api/coding-agent/runs`, which middleware admits the MCP bearer to —
 * so an echoed token would be readable by the agent and by every later reader
 * of the run history.
 *
 * The cases below are the ones that actually happen: `env | grep`, a curl with
 * `-v`, a stack trace from a client that quotes the request it is complaining
 * about — and the two that would break a naive implementation: one value
 * containing another, and a value full of regex metacharacters.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetRunSecrets,
  MIN_REDACT_CHARS,
  redactForRun,
  redactSecrets,
  registerRunSecrets,
  _resetRunSecretsForTests,
} from "@/lib/secret-redact";

const TOKEN = "vrc_live_9Q3k2Zx7pLmN4tR8sW1yB6dF0hJ5aC";

beforeEach(() => _resetRunSecretsForTests());

describe("redactSecrets", () => {
  it("replaces the value with its NAME, which is what the owner can act on", () => {
    expect(redactSecrets(`VERCEL_TOKEN=${TOKEN}`, [{ name: "VERCEL_TOKEN", value: TOKEN }]))
      .toBe("VERCEL_TOKEN=<secret:VERCEL_TOKEN>");
  });

  it("replaces every occurrence, not only the first", () => {
    const line = `curl -H "Authorization: Bearer ${TOKEN}" && echo ${TOKEN}`;
    const out = redactSecrets(line, [{ name: "TOK", value: TOKEN }]);
    expect(out).not.toContain(TOKEN);
    expect(out.match(/<secret:TOK>/g)).toHaveLength(2);
  });

  it("takes the LONGEST value first, so one value inside another leaves no remains", () => {
    // The failure this ordering prevents: replacing "abcd1234" first leaves
    // "https://:@host/" in the line — recognisably the shape of the longer
    // secret, with the short one's place marked.
    const short = "abcd1234efgh";
    const long = `https://user:${short}@deploy.internal/hook`;
    const out = redactSecrets(`POST ${long}`, [
      { name: "SHORT", value: short },
      { name: "LONG", value: long },
    ]);
    expect(out).toBe("POST <secret:LONG>");
  });

  it("matches literal bytes, not a pattern — a value may be any characters at all", () => {
    // A value like this would be a broken RegExp if it were compiled into one,
    // or would match text it is not, which is why split/join is used.
    const value = "a+b(c)[d]{e}.*?^$|\\slash/";
    expect(redactSecrets(`KEY=${value} rest`, [{ name: "KEY", value }])).toBe("KEY=<secret:KEY> rest");
  });

  it("leaves a value shorter than the floor alone", () => {
    // Matching three characters would turn every "abc" in a timeline into a
    // marker — unreadable, and it would show an attentive reader the value by
    // showing which substrings vanish.
    const tiny = "x".repeat(MIN_REDACT_CHARS - 1);
    expect(redactSecrets(`A=${tiny}`, [{ name: "A", value: tiny }])).toBe(`A=${tiny}`);
    const enough = "x".repeat(MIN_REDACT_CHARS);
    expect(redactSecrets(`A=${enough}`, [{ name: "A", value: enough }])).toBe("A=<secret:A>");
  });

  it("is the identity for text with nothing in it and for a run with no secrets", () => {
    expect(redactSecrets("nothing to see", [{ name: "A", value: TOKEN }])).toBe("nothing to see");
    expect(redactSecrets(`has ${TOKEN}`, [])).toBe(`has ${TOKEN}`);
    expect(redactSecrets("", [{ name: "A", value: TOKEN }])).toBe("");
  });

  it("keeps a multi-line value out of a multi-line message", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----";
    const out = redactSecrets(`ssh failed with key:\n${pem}\nretrying`, [{ name: "DEPLOY_KEY", value: pem }]);
    expect(out).toBe("ssh failed with key:\n<secret:DEPLOY_KEY>\nretrying");
  });
});

describe("the per-run table", () => {
  it("scrubs only the run that holds the value", () => {
    registerRunSecrets("run-a", [{ name: "TOK", value: TOKEN }]);
    expect(redactForRun("run-a", `saw ${TOKEN}`)).toBe("saw <secret:TOK>");
    // Another run was not given it, so nothing about it is claimed there.
    expect(redactForRun("run-b", `saw ${TOKEN}`)).toBe(`saw ${TOKEN}`);
  });

  it("stops scrubbing once the run is forgotten", () => {
    registerRunSecrets("run-a", [{ name: "TOK", value: TOKEN }]);
    forgetRunSecrets("run-a");
    expect(redactForRun("run-a", `saw ${TOKEN}`)).toBe(`saw ${TOKEN}`);
  });

  it("REPLACES a run's table rather than adding to it", () => {
    // A resume re-resolves the owner's list: an entry they have un-ticked
    // since the pause is not in the environment any more, and the table must
    // say the same thing the environment does.
    registerRunSecrets("run-a", [{ name: "OLD", value: TOKEN }]);
    registerRunSecrets("run-a", [{ name: "NEW", value: "a-different-value-entirely" }]);
    expect(redactForRun("run-a", `saw ${TOKEN}`)).toBe(`saw ${TOKEN}`);
    expect(redactForRun("run-a", "saw a-different-value-entirely")).toBe("saw <secret:NEW>");
  });

  it("takes an empty list as 'this run holds nothing'", () => {
    registerRunSecrets("run-a", [{ name: "TOK", value: TOKEN }]);
    registerRunSecrets("run-a", []);
    expect(redactForRun("run-a", `saw ${TOKEN}`)).toBe(`saw ${TOKEN}`);
  });

  it("keeps a short value for the environment while never trying to scrub it", () => {
    // registerRunSecrets does not filter — the run is HANDED short values too —
    // and the length floor is applied when redacting. A filter at registration
    // would have meant a four-character secret was never injected.
    const tiny = "abc";
    registerRunSecrets("run-a", [{ name: "TINY", value: tiny }, { name: "TOK", value: TOKEN }]);
    expect(redactForRun("run-a", `${tiny} and ${TOKEN}`)).toBe(`${tiny} and <secret:TOK>`);
  });
});

describe("the two ways a run continues", () => {
  /**
   * A run can be spawned again under the same record in two quite different
   * ways, and the secret table has to follow each one correctly:
   *
   *  - the AUTOMATIC transient retry, from the child's own `close` handler.
   *    It cannot re-resolve (the resolve reads the disk) so coding-agent.ts
   *    carries the table across with `restoreRunSecrets`. What must not happen
   *    is a retried child running with the table empty: its output would reach
   *    the record unscrubbed.
   *  - every OTHER continuation — the owner's Resume, a drafted run, each
   *    attempt of the deliverable gate — which re-resolves and REPLACES.
   *
   * These are the table's own halves of that; the runner's wiring is pinned in
   * coding-agent-secret-env.test.ts and the store's in project-secrets.test.ts.
   */
  it("a carried table scrubs the second attempt exactly as it scrubbed the first", () => {
    registerRunSecrets("run-a", [{ name: "TOK", value: TOKEN }]);
    const carried = [{ name: "TOK", value: TOKEN }];
    // What cleanupRunResources does between the two attempts.
    forgetRunSecrets("run-a");
    expect(redactForRun("run-a", `saw ${TOKEN}`)).toBe(`saw ${TOKEN}`);
    // What the retry branch does before it respawns.
    registerRunSecrets("run-a", carried);
    expect(redactForRun("run-a", `saw ${TOKEN}`)).toBe("saw <secret:TOK>");
  });
});
