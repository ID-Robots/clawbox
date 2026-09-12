/**
 * Delivery: the mode gate, the GitHub gate, dedupe, the rate limit and the
 * once-a-day comment — driven against a FAKE `gh`, so the suite asserts the
 * argv the box would really run without a credential or a network anywhere
 * near it.
 *
 * The property that matters most here is the one a test is the only way to
 * hold: **a failed dedupe search must not create an issue.** A duplicate on a
 * public tracker cannot be taken back, and a deferred report can.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildResult } from "@/lib/child-run";
import { saveEnv } from "@/tests/helpers/env";

let root: string;
let restore: () => void;
let store: typeof import("@/lib/incidents");
let report: typeof import("@/lib/incident-report");

/** A `gh` that answers whatever the test queues, and records every argv. */
function fakeGh(answers: Partial<ChildResult>[]) {
  const calls: string[][] = [];
  let i = 0;
  const run = async (args: string[]): Promise<ChildResult> => {
    calls.push(args);
    const a = answers[Math.min(i++, answers.length - 1)] ?? {};
    return {
      code: 0, stdout: "", stderr: "", signal: null, timedOut: false, startFailed: false, startError: null,
      ...a,
    };
  };
  return { run, calls };
}

const ok = (stdout: string) => ({ code: 0, stdout });
const NO_MATCH = ok("[]");

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-report-"));
  process.env.CLAWBOX_ROOT = root;
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  vi.resetModules();
  store = await import("@/lib/incidents");
  report = await import("@/lib/incident-report");
  report._resetAutoReportThrottleForTests();
});

afterEach(() => {
  restore();
  fs.rmSync(root, { recursive: true, force: true });
});

async function anIncident(message = "the update step failed") {
  const inc = await store.recordIncident({ source: "update", message, context: { step: "post_update" } });
  return inc!;
}

const connected = () => Promise.resolve(true);

describe("the mode gate", () => {
  it("sends NOTHING while the programme is off, and says so", async () => {
    const inc = await anIncident();
    const gh = fakeGh([]);
    const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "off" });
    expect(out).toMatchObject({ ok: false, code: "off" });
    expect(gh.calls).toEqual([]);
  });

  it("files in ask mode when a surface asks it to — the consent was the mode", async () => {
    const inc = await anIncident();
    const gh = fakeGh([NO_MATCH, ok("https://github.com/ID-Robots/clawbox/issues/912")]);
    const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "ask" });
    expect(out).toEqual({ ok: true, action: "created", issueNumber: 912, url: "https://github.com/ID-Robots/clawbox/issues/912" });
  });

  it("autoReportIfEnabled files only on auto", async () => {
    for (const [mode, expected] of [["off", 0], ["ask", 0], ["auto", 2]] as const) {
      const inc = await anIncident(`a ${mode} fault`);
      const gh = fakeGh([NO_MATCH, ok("https://github.com/ID-Robots/clawbox/issues/5")]);
      await report.autoReportIfEnabled(inc, { gh: gh.run, githubConnected: connected, mode: async () => mode });
      expect(gh.calls, mode).toHaveLength(expected);
    }
  });

  it("autoReportIfEnabled tolerates nothing to report", async () => {
    await expect(report.autoReportIfEnabled(null)).resolves.toBeUndefined();
  });
});

describe("the automatic path does not stampede", () => {
  /**
   * `recordIncident` hands the EXISTING record back for a fault it has seen
   * before — that is what dedupe is — so a box in a crash loop used to start
   * one `gh issue list` per capture, including while the first was still in
   * flight and long after the daily allowance was spent.
   */
  it("attempts one fingerprint once per throttle window", async () => {
    const inc = await anIncident();
    const t0 = Date.parse("2026-09-12T08:00:00Z");
    const gh = fakeGh([NO_MATCH, ok("https://github.com/ID-Robots/clawbox/issues/1")]);
    const deps = { gh: gh.run, githubConnected: connected, mode: async () => "auto" as const, now: () => t0 };
    await report.autoReportIfEnabled(inc, deps);
    expect(gh.calls).toHaveLength(2);

    for (let i = 0; i < 20; i++) await report.autoReportIfEnabled(inc, deps);
    expect(gh.calls, "no gh call for a fault inside the throttle window").toHaveLength(2);

    await report.autoReportIfEnabled(inc, { ...deps, now: () => t0 + report.AUTO_REPORT_THROTTLE_MS + 1 });
    expect(gh.calls.length).toBeGreaterThan(2);
  });

  it("single-flights: a second capture while the first report is in flight does nothing", async () => {
    const inc = await anIncident();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const gh = fakeGh([NO_MATCH, ok("https://github.com/ID-Robots/clawbox/issues/1")]);
    const slow = async (args: string[]) => { await held; return gh.run(args); };
    const deps = { gh: slow, githubConnected: connected, mode: async () => "auto" as const };

    const first = report.autoReportIfEnabled(inc, deps);
    await report.autoReportIfEnabled(inc, deps);
    await report.autoReportIfEnabled(inc, deps);
    release();
    await first;
    expect(gh.calls).toHaveLength(2);
  });

  it("does not spend the window on a box that is only on ask", async () => {
    const inc = await anIncident();
    const t0 = Date.parse("2026-09-12T08:00:00Z");
    const askDeps = { gh: fakeGh([]).run, githubConnected: connected, mode: async () => "ask" as const, now: () => t0 };
    await report.autoReportIfEnabled(inc, askDeps);
    // The owner switches to auto a minute later: the report must still go.
    const gh = fakeGh([NO_MATCH, ok("https://github.com/ID-Robots/clawbox/issues/9")]);
    await report.autoReportIfEnabled(inc, {
      gh: gh.run, githubConnected: connected, mode: async () => "auto", now: () => t0 + 60_000,
    });
    expect(gh.calls).toHaveLength(2);
  });

  it("throttles by FINGERPRINT, so a different fault is never held back", async () => {
    const t0 = Date.parse("2026-09-12T08:00:00Z");
    const a = await anIncident("the first distinct fault");
    const b = await anIncident("a completely different fault");
    for (const [i, inc] of [a, b].entries()) {
      const gh = fakeGh([NO_MATCH, ok(`https://github.com/ID-Robots/clawbox/issues/${i + 1}`)]);
      await report.autoReportIfEnabled(inc, {
        gh: gh.run, githubConnected: connected, mode: async () => "auto", now: () => t0,
      });
      expect(gh.calls, inc.message).toHaveLength(2);
    }
  });
});

describe("a stray cbip: token in the text", () => {
  /**
   * The dedupe search is `cbip:<fingerprint> in:body`, so a SECOND marker in a
   * body makes this issue answer a search for a different fault — the later
   * incident comments here instead of getting its own report. An error message
   * can carry one by accident, and by design if the text can be influenced.
   */
  it("is broken so it cannot answer another fault's search", async () => {
    const other = "0123456789abcdef";
    const inc = await anIncident(`upstream said cbip:${other} which is not ours`);
    const body = report.issueBodyFor(inc);
    expect(body).toContain(report.markerFor(inc.fingerprint));
    expect(body).not.toContain(`cbip:${other}`);
    // Still readable to a person — the token is broken, not deleted.
    expect(body).toContain(other);
  });

  it("leaves this incident's own marker intact", async () => {
    const inc = await anIncident();
    const body = report.issueBodyFor(inc);
    expect(body.match(/cbip:[0-9a-f]{16}/g)).toEqual([`cbip:${inc.fingerprint}`]);
  });

  it("covers the stack and the context, not only the message", async () => {
    const inc = (await store.recordIncident({
      source: "clawbox",
      message: "a fault",
      stack: "Error: x\n    at run (cbip:aaaaaaaaaaaaaaaa)",
      context: { note: "cbip:bbbbbbbbbbbbbbbb" },
    }))!;
    const body = report.issueBodyFor(inc);
    expect(body).not.toContain("cbip:aaaaaaaaaaaaaaaa");
    expect(body).not.toContain("cbip:bbbbbbbbbbbbbbbb");
  });
});

describe("the GitHub gate", () => {
  it("queues rather than failing when GitHub is not connected", async () => {
    const inc = await anIncident();
    const gh = fakeGh([]);
    const out = await report.reportIncident(inc.id, {
      gh: gh.run, githubConnected: async () => false, mode: async () => "auto",
    });
    expect(out).toMatchObject({ ok: false, code: "no_github" });
    expect(gh.calls).toEqual([]);
    expect(store.pendingIncidents()).toHaveLength(1);
  });
});

describe("what an issue is made of", () => {
  it("carries the marker, the labels, the repo and no invented text", async () => {
    const inc = await anIncident();
    const gh = fakeGh([NO_MATCH, ok("https://github.com/ID-Robots/clawbox/issues/1")]);
    await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    const create = gh.calls[1];
    expect(create[0]).toBe("issue");
    expect(create[1]).toBe("create");
    expect(create).toContain("--repo");
    expect(create).toContain(report.REPORT_REPO);
    for (const label of report.REPORT_LABELS) expect(create).toContain(label);
    const body = create[create.indexOf("--body") + 1];
    expect(body).toContain(report.markerFor(inc.fingerprint));
    expect(body).toContain("Reported from a ClawBox with the Improvement Program enabled.");
    expect(body).toContain(inc.message);
    expect(body).toContain("post_update");
    const title = create[create.indexOf("--title") + 1];
    expect(title).toBe(`[auto] update: ${inc.message}`);
  });

  it("says in the body that nothing personal travelled", async () => {
    const inc = await anIncident();
    const body = report.issueBodyFor(inc);
    expect(body).toContain("No transcripts, prompts, file contents or environment values are included.");
  });

  it("marks the incident with the number it became", async () => {
    const inc = await anIncident();
    const gh = fakeGh([NO_MATCH, ok("https://github.com/ID-Robots/clawbox/issues/77")]);
    await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    expect(store.getIncident(inc.id)?.issueNumber).toBe(77);
    expect(store.pendingIncidents()).toEqual([]);
  });
});

describe("dedupe", () => {
  it("searches for the marker before it creates anything", async () => {
    const inc = await anIncident();
    const gh = fakeGh([NO_MATCH, ok("https://github.com/ID-Robots/clawbox/issues/1")]);
    await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    const search = gh.calls[0];
    expect(search.slice(0, 2)).toEqual(["issue", "list"]);
    expect(search).toContain(`cbip:${inc.fingerprint} in:body`);
    expect(search).toContain("--state");
    expect(search).toContain("open");
  });

  it("comments instead of opening a second issue when one is already open", async () => {
    const inc = await anIncident();
    await store.recordIncident({ source: "update", message: "the update step failed" });
    const gh = fakeGh([ok('[{"number":404}]'), ok("")]);
    const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    expect(out).toEqual({ ok: true, action: "commented", issueNumber: 404 });
    expect(gh.calls[1].slice(0, 3)).toEqual(["issue", "comment", "404"]);
    expect(gh.calls[1][gh.calls[1].indexOf("--body") + 1]).toMatch(/^\+1, seen again on .+ \(2 times\)\.$/);
    // Found upstream, so it is remembered — and NOT charged against the day.
    expect(store.getIncident(inc.id)?.issueNumber).toBe(404);
    expect(store.remainingIssuesToday(report.MAX_ISSUES_PER_DAY)).toBe(report.MAX_ISSUES_PER_DAY);
  });

  it("adds at most one note per issue per day", async () => {
    const inc = await anIncident();
    const day = Date.parse("2026-09-12T09:00:00Z");
    const first = fakeGh([ok('[{"number":8}]'), ok("")]);
    await report.reportIncident(inc.id, { gh: first.run, githubConnected: connected, mode: async () => "auto", now: () => day });

    const second = fakeGh([ok("")]);
    const out = await report.reportIncident(inc.id, {
      gh: second.run, githubConnected: connected, mode: async () => "auto", now: () => day + 3_600_000,
    });
    expect(out).toEqual({ ok: true, action: "already_reported", issueNumber: 8 });
    expect(second.calls).toEqual([]);

    const tomorrow = fakeGh([ok("")]);
    const next = await report.reportIncident(inc.id, {
      gh: tomorrow.run, githubConnected: connected, mode: async () => "auto", now: () => day + 26 * 3_600_000,
    });
    expect(next).toMatchObject({ action: "commented" });
  });

  it("REFUSES rather than risking a duplicate when the search itself failed", async () => {
    const inc = await anIncident();
    const gh = fakeGh([{ code: 1, stderr: "HTTP 502" }]);
    const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    expect(out).toMatchObject({ ok: false, code: "search_failed" });
    expect(gh.calls).toHaveLength(1);
    expect(store.pendingIncidents()).toHaveLength(1);
  });

  it("treats an unreadable search answer as a failure, not as 'nothing found'", async () => {
    const inc = await anIncident();
    const gh = fakeGh([ok("not json at all")]);
    const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    expect(out).toMatchObject({ ok: false, code: "search_failed" });
    expect(gh.calls).toHaveLength(1);
  });

  it("does not search again for an incident it already knows the number of", async () => {
    const inc = await anIncident();
    store.markReported(inc.id, 33, { charge: false });
    const gh = fakeGh([ok("")]);
    const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    expect(out).toMatchObject({ action: "commented", issueNumber: 33 });
    expect(gh.calls[0].slice(0, 3)).toEqual(["issue", "comment", "33"]);
  });
});

describe("the rate limit", () => {
  it("stops at MAX_ISSUES_PER_DAY new issues and lets the rest wait", async () => {
    const day = Date.parse("2026-09-12T08:00:00Z");
    for (let i = 0; i < report.MAX_ISSUES_PER_DAY; i++) {
      const inc = await anIncident(`fault ${"q".repeat(i)}`);
      const gh = fakeGh([NO_MATCH, ok(`https://github.com/ID-Robots/clawbox/issues/${i + 1}`)]);
      const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto", now: () => day });
      expect(out).toMatchObject({ ok: true, action: "created" });
    }
    const extra = await anIncident("one fault too many today");
    const gh = fakeGh([NO_MATCH]);
    const out = await report.reportIncident(extra.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto", now: () => day });
    expect(out).toMatchObject({ ok: false, code: "rate_limited" });
    // Searched, never created: the queue keeps it for tomorrow.
    expect(gh.calls).toHaveLength(1);
    expect(store.getIncident(extra.id)?.issueNumber).toBeNull();
  });

  it("comes back the next day", async () => {
    const day = Date.parse("2026-09-12T08:00:00Z");
    for (let i = 0; i < report.MAX_ISSUES_PER_DAY; i++) {
      const inc = await anIncident(`fault ${"w".repeat(i)}`);
      const gh = fakeGh([NO_MATCH, ok(`https://github.com/ID-Robots/clawbox/issues/${i + 1}`)]);
      await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto", now: () => day });
    }
    const extra = await anIncident("tomorrow's fault");
    const gh = fakeGh([NO_MATCH, ok("https://github.com/ID-Robots/clawbox/issues/99")]);
    const out = await report.reportIncident(extra.id, {
      gh: gh.run, githubConnected: connected, mode: async () => "auto", now: () => day + 24 * 3_600_000,
    });
    expect(out).toMatchObject({ ok: true, action: "created", issueNumber: 99 });
  });
});

describe("the allowance holds across DIFFERENT faults reported at once", () => {
  /**
   * `autoReportIfEnabled` single-flights by fingerprint, so distinct faults
   * reach the create path concurrently. A read-then-create-then-charge sequence
   * let each of six read the same "under the limit" and file — six issues past
   * a limit of five. The slot is claimed before `gh` runs.
   */
  it("files at most MAX_ISSUES_PER_DAY even when every report is in flight together", async () => {
    const day = Date.parse("2026-09-12T08:00:00Z");
    const incidents = [];
    for (let i = 0; i < report.MAX_ISSUES_PER_DAY + 3; i++) {
      incidents.push(await anIncident(`simultaneous fault ${"s".repeat(i)}`));
    }
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let created = 0;
    // Every create parks until they are ALL past the allowance check, which is
    // the interleaving a sequential test can never produce.
    const slow = async (args: string[]): Promise<ChildResult> => {
      const base = { code: 0, stdout: "", stderr: "", signal: null, timedOut: false, startFailed: false, startError: null };
      if (args[1] === "list") return { ...base, stdout: "[]" };
      await held;
      created += 1;
      return { ...base, stdout: `https://github.com/ID-Robots/clawbox/issues/${created}` };
    };
    const outcomes = incidents.map((inc) =>
      report.reportIncident(inc.id, { gh: slow, githubConnected: connected, mode: async () => "auto", now: () => day }));
    release();
    const settled = await Promise.all(outcomes);
    expect(settled.filter((o) => o.ok)).toHaveLength(report.MAX_ISSUES_PER_DAY);
    expect(settled.filter((o) => !o.ok && o.code === "rate_limited")).toHaveLength(3);
    expect(created, "gh was asked to create no more issues than the limit").toBe(report.MAX_ISSUES_PER_DAY);
  });

  it("gives the slot back when the create failed, so the day is not spent on nothing", async () => {
    const day = Date.parse("2026-09-12T08:00:00Z");
    const inc = await anIncident();
    const gh = fakeGh([NO_MATCH, { code: 1, stderr: "GraphQL: something" }]);
    await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto", now: () => day });
    expect(store.remainingIssuesToday(report.MAX_ISSUES_PER_DAY, day)).toBe(report.MAX_ISSUES_PER_DAY);
  });

  it("keeps the slot when gh exited 0 without a URL — something was probably filed with it", async () => {
    const day = Date.parse("2026-09-12T08:00:00Z");
    const inc = await anIncident();
    const gh = fakeGh([NO_MATCH, ok("")]);
    await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto", now: () => day });
    expect(store.remainingIssuesToday(report.MAX_ISSUES_PER_DAY, day)).toBe(report.MAX_ISSUES_PER_DAY - 1);
  });

  it("does not charge the day for a comment on an issue that already exists", async () => {
    const day = Date.parse("2026-09-12T08:00:00Z");
    const inc = await anIncident();
    const gh = fakeGh([ok('[{"number":404}]'), ok("")]);
    await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto", now: () => day });
    expect(store.remainingIssuesToday(report.MAX_ISSUES_PER_DAY, day)).toBe(report.MAX_ISSUES_PER_DAY);
  });
});

describe("failures gh can have", () => {
  it("reports a missing gh as a refusal with a sentence, never a stack", async () => {
    const inc = await anIncident();
    const gh = fakeGh([{ code: null, startFailed: true, startError: "ENOENT" }]);
    const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    expect(out).toMatchObject({ ok: false, code: "search_failed" });
    expect((out as { detail: string }).detail).toContain("not installed");
  });

  it("reports a create that gh refused", async () => {
    const inc = await anIncident();
    const gh = fakeGh([NO_MATCH, { code: 1, stderr: "GraphQL: Label does not exist" }]);
    const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    expect(out).toMatchObject({ ok: false, code: "gh_failed" });
    expect(store.getIncident(inc.id)?.issueNumber).toBeNull();
  });

  it("does not claim success when gh exits 0 without a URL", async () => {
    const inc = await anIncident();
    const gh = fakeGh([NO_MATCH, ok("")]);
    const out = await report.reportIncident(inc.id, { gh: gh.run, githubConnected: connected, mode: async () => "auto" });
    expect(out).toMatchObject({ ok: false, code: "gh_failed" });
    expect(store.getIncident(inc.id)?.issueNumber).toBeNull();
  });

  it("answers not_found for an id that is not here", async () => {
    const out = await report.reportIncident("inc-nope", { gh: fakeGh([]).run, githubConnected: connected, mode: async () => "auto" });
    expect(out).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("issueNumberFrom", () => {
  it("reads the number out of an issue URL and nothing else", () => {
    expect(report.issueNumberFrom("https://github.com/ID-Robots/clawbox/issues/912")).toBe(912);
    expect(report.issueNumberFrom("https://github.com/ID-Robots/clawbox/pull/912")).toBeNull();
    expect(report.issueNumberFrom("")).toBeNull();
  });
});
