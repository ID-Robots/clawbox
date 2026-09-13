/**
 * The delivery pipeline's stage machine, walked without a run, a Vercel account
 * or a browser.
 *
 * That is the whole point of the module being pure: the ORDER and the routing
 * are what the owner asked for ("auto from start to finish"), and they have to
 * be provable on their own — the driver's own suite then proves that the box
 * actually does what the machine says.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_EXPECTATIONS,
  MAX_STAGE_ATTEMPTS,
  PIPELINE_MAX_WALL_MS,
  PIPELINE_STAGES,
  addEvidence,
  clonePipeline,
  decidePipeline,
  defaultPipelineInput,
  enterStage,
  improvementNudge,
  isPipelineLive,
  isPipelineSettled,
  newPipeline,
  parsePipeline,
  readPipelineInput,
  stageNoun,
  stepFor,
  stopPipeline,
  type PipelineStage,
  type PipelineState,
} from "@/lib/coding-pipeline";

function made(over: { maxRounds?: number; production?: boolean; expect?: string[] } = {}): PipelineState {
  const p = newPipeline({
    verify: { path: "/", expect: over.expect ?? ["Invoice"] },
    production: over.production ?? true,
    maxRounds: over.maxRounds ?? 2,
  });
  enterStage(p, "build");
  return p;
}

/** Walk the happy path one stage at a time, asserting where each lands. */
function pass(p: PipelineState, stage: PipelineStage) {
  const t = decidePipeline(p, stage, { kind: "passed" });
  if (t.action === "enter") enterStage(p, t.stage);
  return t;
}

describe("the order the owner asked for", () => {
  it("runs build → review → preview → check → production → check → done", () => {
    const p = made();
    expect(pass(p, "build")).toEqual({ action: "enter", stage: "review" });
    expect(pass(p, "review")).toEqual({ action: "enter", stage: "deploy_preview" });
    expect(pass(p, "deploy_preview")).toEqual({ action: "enter", stage: "verify_preview" });
    expect(pass(p, "verify_preview")).toEqual({ action: "enter", stage: "deploy_production" });
    expect(pass(p, "deploy_production")).toEqual({ action: "enter", stage: "verify_production" });
    expect(pass(p, "verify_production")).toEqual({ action: "settled", status: "complete" });
    expect(p.status).toBe("complete");
    expect(stepFor(p, "complete").state).toBe("passed");
    expect(isPipelineSettled(p.status)).toBe(true);
    expect(isPipelineLive(p)).toBe(false);
  });

  it("stops at a verified preview when production was switched off", () => {
    const p = made({ production: false });
    pass(p, "build");
    pass(p, "review");
    pass(p, "deploy_preview");
    expect(pass(p, "verify_preview")).toEqual({ action: "settled", status: "complete" });
    // Never entered: a pipeline that was told to stop at the preview must not
    // record a production stage at all.
    expect(stepFor(p, "deploy_production").attempt).toBe(0);
  });

  it("a review that found nothing to fix is SKIPPED, never passed", () => {
    const p = made();
    pass(p, "build");
    const t = decidePipeline(p, "review", { kind: "skipped", detail: "nothing to read" });
    expect(t).toEqual({ action: "enter", stage: "deploy_preview" });
    expect(stepFor(p, "review").state).toBe("skipped");
  });
});

describe("what sends the work back, and what does not", () => {
  it("a failed preview check goes to improvement and spends a round", () => {
    const p = made({ maxRounds: 2 });
    pass(p, "build"); pass(p, "review"); pass(p, "deploy_preview");
    const t = decidePipeline(p, "verify_preview", { kind: "failed", reason: "The page answered 500." });
    expect(t).toEqual({ action: "enter", stage: "improvement" });
    expect(p.round).toBe(1);
    expect(stepFor(p, "verify_preview").state).toBe("failed");
    expect(stepFor(p, "verify_preview").detail).toContain("500");
  });

  it("an improvement lap goes back to REVIEW, not straight to the deploy", () => {
    const p = made();
    pass(p, "build"); pass(p, "review"); pass(p, "deploy_preview");
    decidePipeline(p, "verify_preview", { kind: "failed", reason: "no" });
    enterStage(p, "improvement");
    expect(pass(p, "improvement")).toEqual({ action: "enter", stage: "review" });
  });

  it("a failed preview DEPLOY loops back too — the build log is what the lap carries", () => {
    const p = made();
    pass(p, "build"); pass(p, "review");
    expect(decidePipeline(p, "deploy_preview", { kind: "failed", reason: "the build failed" }))
      .toEqual({ action: "enter", stage: "improvement" });
  });

  it("a failed review loops back", () => {
    const p = made();
    pass(p, "build");
    expect(decidePipeline(p, "review", { kind: "failed", reason: "the pass did not finish" }))
      .toEqual({ action: "enter", stage: "improvement" });
  });

  it("a failed BUILD ends it — there is no work to improve", () => {
    const p = made();
    const t = decidePipeline(p, "build", { kind: "failed", reason: "the run did not finish (failed)" });
    expect(t).toEqual({ action: "settled", status: "failed" });
    expect(p.failure).toEqual({ stage: "build", reason: "the run did not finish (failed)" });
    expect(p.round).toBe(0);
  });

  it("a failed IMPROVEMENT ends it — another fix turn does not fix a fix turn", () => {
    const p = made();
    pass(p, "build"); pass(p, "review"); pass(p, "deploy_preview");
    decidePipeline(p, "verify_preview", { kind: "failed", reason: "no" });
    enterStage(p, "improvement");
    expect(decidePipeline(p, "improvement", { kind: "failed", reason: "no session" }))
      .toEqual({ action: "settled", status: "failed" });
  });

  it("a PRODUCTION failure ends it rather than rebuilding a live domain again", () => {
    const p = made({ maxRounds: 3 });
    pass(p, "build"); pass(p, "review"); pass(p, "deploy_preview"); pass(p, "verify_preview");
    const t = decidePipeline(p, "deploy_production", { kind: "failed", reason: "Vercel refused it" });
    expect(t).toEqual({ action: "settled", status: "failed" });
    // The rounds were there and deliberately not spent.
    expect(p.round).toBe(0);
  });

  it("a failed PRODUCTION check ends it too, naming the stage", () => {
    const p = made({ maxRounds: 3 });
    pass(p, "build"); pass(p, "review"); pass(p, "deploy_preview"); pass(p, "verify_preview"); pass(p, "deploy_production");
    expect(decidePipeline(p, "verify_production", { kind: "failed", reason: "the domain answered 502" }))
      .toEqual({ action: "settled", status: "failed" });
    expect(p.failure?.stage).toBe("verify_production");
  });

  it("runs out of rounds and says so", () => {
    const p = made({ maxRounds: 1 });
    pass(p, "build"); pass(p, "review"); pass(p, "deploy_preview");
    decidePipeline(p, "verify_preview", { kind: "failed", reason: "no" });
    expect(p.round).toBe(1);
    enterStage(p, "improvement");
    pass(p, "improvement");
    pass(p, "review");
    pass(p, "deploy_preview");
    const t = decidePipeline(p, "verify_preview", { kind: "failed", reason: "still no" });
    expect(t).toEqual({ action: "settled", status: "failed" });
    expect(p.failure?.reason).toContain("last of 1 improvement round");
  });

  it("with no rounds at all, the first failure ends it and says why", () => {
    const p = made({ maxRounds: 0 });
    pass(p, "build"); pass(p, "review"); pass(p, "deploy_preview");
    const t = decidePipeline(p, "verify_preview", { kind: "failed", reason: "no" });
    expect(t).toEqual({ action: "settled", status: "failed" });
    expect(p.failure?.reason).toContain("No improvement rounds are allowed");
  });
});

describe("a stage this box cannot run at all", () => {
  it("is `blocked`, not `failed`, and never loops", () => {
    const p = made({ maxRounds: 3 });
    pass(p, "build"); pass(p, "review");
    const t = decidePipeline(p, "deploy_preview", { kind: "blocked", reason: "No Vercel project is attached." });
    expect(t).toEqual({ action: "settled", status: "blocked" });
    expect(p.status).toBe("blocked");
    expect(p.round).toBe(0);
    expect(stepFor(p, "deploy_preview").state).toBe("failed");
  });
});

describe("the production gate", () => {
  it("waits rather than failing, and holds the pipeline live", () => {
    const p = made();
    pass(p, "build"); pass(p, "review"); pass(p, "deploy_preview"); pass(p, "verify_preview");
    const t = decidePipeline(p, "deploy_production", { kind: "waiting_owner", reason: "waiting for you" });
    expect(t).toEqual({ action: "wait" });
    expect(p.status).toBe("waiting_owner");
    // Still live: the owner's button is what moves it, and a settled pipeline
    // would have the run announced as finished under them.
    expect(isPipelineLive(p)).toBe(true);
    expect(stepFor(p, "deploy_production").state).toBe("waiting_owner");
    expect(stepFor(p, "deploy_production").endedAt).toBeNull();
  });
});

describe("the caps", () => {
  it("the wall clock ends it at the next transition, whatever the stage said", () => {
    const p = made();
    const late = p.startedAt + PIPELINE_MAX_WALL_MS + 1;
    const t = decidePipeline(p, "build", { kind: "passed" }, late);
    expect(t).toEqual({ action: "settled", status: "failed" });
    expect(p.failure?.reason).toContain("budget");
  });

  it("a stage entered too many times ends it", () => {
    const p = made({ maxRounds: 50 });
    // Drive the loop until the improvement stage has been entered its limit.
    pass(p, "build");
    for (let i = 0; i < MAX_STAGE_ATTEMPTS + 2; i += 1) {
      if (p.status !== "running") break;
      const t = decidePipeline(p, "review", { kind: "failed", reason: `lap ${i}` });
      if (t.action !== "enter") break;
      enterStage(p, t.stage);
      const back = decidePipeline(p, "improvement", { kind: "passed" });
      if (back.action !== "enter") break;
      enterStage(p, back.stage);
    }
    expect(p.status).toBe("failed");
    expect(p.failure?.reason).toMatch(/tried \d+ times/);
  });
});

describe("the owner's own stop", () => {
  it("marks the stage it was in and settles as stopped", () => {
    const p = made();
    pass(p, "build");
    stopPipeline(p, "The owner stopped it.");
    expect(p.status).toBe("stopped");
    expect(p.failure).toEqual({ stage: "review", reason: "The owner stopped it." });
    // Idempotent: a second stop must not overwrite the first reason.
    stopPipeline(p, "again");
    expect(p.failure?.reason).toBe("The owner stopped it.");
  });
});

describe("evidence", () => {
  it("is bounded, flattened, and keeps the NEWEST when it overflows", () => {
    const p = made();
    for (let i = 0; i < 30; i += 1) {
      addEvidence(p, "build", { kind: "note", ref: null, detail: `note ${i}\n  with   whitespace` });
    }
    const kept = stepFor(p, "build").evidence;
    expect(kept.length).toBeLessThanOrEqual(12);
    expect(kept[kept.length - 1].detail).toBe("note 29 with whitespace");
  });

  it("clamps a ref and a detail that are far too long", () => {
    const p = made();
    addEvidence(p, "build", { kind: "url", ref: "x".repeat(2000), detail: "y".repeat(2000) });
    const [only] = stepFor(p, "build").evidence;
    expect(only.ref!.length).toBeLessThanOrEqual(512);
    expect(only.detail.length).toBeLessThanOrEqual(400);
  });
});

describe("what a caller may ask for", () => {
  it("says nothing at all → null, so the project's own default can decide", () => {
    expect(readPipelineInput(undefined)).toBeNull();
    expect(readPipelineInput(null)).toBeNull();
    expect(readPipelineInput(false)).toBeNull();
    expect(readPipelineInput({ enabled: false })).toBeNull();
  });

  it("`true` is the usual one", () => {
    expect(readPipelineInput(true)).toEqual({ ok: true, pipeline: defaultPipelineInput() });
  });

  it("takes a path and the strings the page must contain", () => {
    const read = readPipelineInput({ path: "/invoices", expect: [" Invoice ", "Total"], production: false });
    expect(read).toEqual({
      ok: true,
      pipeline: { verify: { path: "/invoices", expect: ["Invoice", "Total"] }, production: false },
    });
  });

  it("refuses with a stable code rather than repairing", () => {
    expect(readPipelineInput("yes")).toMatchObject({ ok: false, code: "not_an_object" });
    expect(readPipelineInput({ path: "invoices" })).toMatchObject({ ok: false, code: "bad_path" });
    expect(readPipelineInput({ path: 7 })).toMatchObject({ ok: false, code: "bad_path" });
    expect(readPipelineInput({ expect: "Invoice" })).toMatchObject({ ok: false, code: "bad_expect" });
    expect(readPipelineInput({ expect: [""] })).toMatchObject({ ok: false, code: "bad_expect" });
    expect(readPipelineInput({ expect: Array.from({ length: MAX_EXPECTATIONS + 1 }, () => "x") }))
      .toMatchObject({ ok: false, code: "too_many_expect" });
    expect(readPipelineInput({ production: "yes" })).toMatchObject({ ok: false, code: "bad_production" });
  });
});

describe("reading a record back off disk", () => {
  it("round-trips everything a live pipeline carries", () => {
    const p = made();
    pass(p, "build");
    addEvidence(p, "review", { kind: "run", ref: "run-abc12345", detail: "the review pass" });
    p.lastVerification = {
      ok: false,
      url: "https://x.vercel.app/",
      status: 200,
      reason: "not there",
      judgedBy: "expectations",
      expectations: [{ text: "Invoice", found: false }],
      vision: null,
      screenshot: "verify-1.png",
      checkedAt: 5,
    };
    const back = parsePipeline(JSON.parse(JSON.stringify(p)));
    expect(back).toEqual(p);
  });

  it("degrades to NO pipeline rather than to one this code cannot drive", () => {
    expect(parsePipeline(null)).toBeNull();
    expect(parsePipeline({ stage: "somewhere_new", status: "running", startedAt: 1 })).toBeNull();
    expect(parsePipeline({ stage: "build", status: "whatever", startedAt: 1 })).toBeNull();
    expect(parsePipeline({ stage: "build", status: "running" })).toBeNull();
  });

  it("fills in a stage the record has no step for, so no strip has a hole", () => {
    const back = parsePipeline({ stage: "build", status: "running", startedAt: 1, steps: [] });
    expect(back!.steps.map((s) => s.stage)).toEqual([...PIPELINE_STAGES]);
    expect(back!.steps.every((s) => s.state === "pending")).toBe(true);
  });

  it("a hand-edited deadline cannot buy more than the budget", () => {
    const back = parsePipeline({
      stage: "build", status: "running", startedAt: 1_000,
      deadlineAt: 1_000 + PIPELINE_MAX_WALL_MS * 100,
    });
    expect(back!.deadlineAt).toBe(1_000 + PIPELINE_MAX_WALL_MS);
  });

  it("clones deeply, so a caller holding one cannot write the driver's state", () => {
    const p = made();
    addEvidence(p, "build", { kind: "note", ref: null, detail: "x" });
    const copy = clonePipeline(p);
    copy.steps[0].evidence[0].detail = "tampered";
    copy.verify.expect.push("extra");
    expect(stepFor(p, "build").evidence[0].detail).toBe("x");
    expect(p.verify.expect).toEqual(["Invoice"]);
  });
});

describe("what the harness is told when the work comes back", () => {
  it("carries the reason, the build log and what the check saw — and no deploy verb", () => {
    const nudge = improvementNudge({
      stage: "verify_preview",
      reason: "The page is up but does not contain \"Invoice\".",
      round: 1,
      maxRounds: 2,
      buildLog: "error TS2304: Cannot find name 'Invoice'",
      verification: {
        url: "https://x.vercel.app/invoices",
        status: 200,
        missing: ["Invoice"],
        description: "A blank white page with a heading.",
      },
    });
    expect(nudge).toContain("preview verification");
    expect(nudge).toContain("does not contain");
    expect(nudge).toContain("HTTP 200");
    expect(nudge).toContain("\"Invoice\"");
    expect(nudge).toContain("A blank white page");
    expect(nudge).toContain("error TS2304");
    expect(nudge).toContain("improvement round 1 of 2");
    expect(nudge).toContain("do not start the task over");
    // The box deploys, the run writes code. A nudge that told a run to deploy
    // would be a run that could put its own work in front of a project's users.
    expect(nudge).toContain("Do not try to deploy");
  });

  it("says the page did not answer at all when it did not", () => {
    const nudge = improvementNudge({
      stage: "verify_production",
      reason: "timed out",
      round: 2,
      maxRounds: 2,
      verification: { url: "https://x.com/", status: null, missing: [], description: null },
    });
    expect(nudge).toContain("It did not answer.");
  });
});

describe("stage names", () => {
  it("has one for every stage, so no sentence can say `undefined`", () => {
    for (const stage of PIPELINE_STAGES) {
      expect(stageNoun(stage)).toMatch(/^[a-z ]+$/);
    }
  });
});
