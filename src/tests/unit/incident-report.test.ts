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
