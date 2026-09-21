/**
 * The delivery pipeline's stage strip on a run's page.
 *
 * The properties under test:
 *
 *  1. THE STRIP SAYS WHERE IT HAS GOT TO, in order, with the state of each
 *     stage readable without sight — an icon is nothing to a screen reader.
 *  2. A STAGE THAT DID NOT NEED TO RUN IS NOT A TICK. `skipped` and `passed`
 *     drawn the same would claim work this box did not do.
 *  3. PRODUCTION IS GATED BEHIND A QUESTION THAT SAYS WHAT IT DOES. The button
 *     does not deploy; it asks, and only the confirm sends.
 *  4. THE CHECK'S CLAIM IS SAID AS THE CLAIM IT IS — the page contained the
 *     strings, or a model looked at a picture.
 *  5. A PIPELINE THAT STOPPED SAYS WHY, and `blocked` is not drawn as a
 *     failure of the work.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunPipelineCard from "@/components/CodingRunPipelineCard";
import {
  PIPELINE_STAGES,
  type PipelineStage,
  type PipelineStageState,
  type PipelineState,
} from "@/lib/coding-pipeline";

/** The card's own words, in English: asserting on the catalogue's copy rather
 *  than on the key is what catches a string that never entered it. */
const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};

function state(over: Partial<PipelineState> = {}, states: Partial<Record<PipelineStage, PipelineStageState>> = {}): PipelineState {
  return {
    stage: "verify_preview",
    status: "running",
    steps: PIPELINE_STAGES.map((stage) => ({
      stage,
      state: states[stage] ?? "pending",
      attempt: 0,
      startedAt: null,
      endedAt: null,
      detail: null,
      evidence: [],
    })),
    startedAt: 1,
    endedAt: null,
    round: 0,
    maxRounds: 2,
    deadlineAt: 9,
    verify: { path: "/", expect: ["Invoice"] },
    production: true,
    failure: null,
    sentBackFrom: null,
    productionApprovedAt: null,
    lastVerification: null,
    ...over,
  };
}

describe("the strip", () => {
  it("draws every stage in the order they happen", () => {
    render(<CodingRunPipelineCard runId="run-1" pipeline={state()} t={t} />);
    const items = screen.getByTestId("coding-agent-pipeline-stages").querySelectorAll("li");
    expect([...items].map((li) => li.getAttribute("data-testid"))).toEqual(
      PIPELINE_STAGES.map((s) => `coding-agent-pipeline-stage-${s}`),
    );
  });

  it("says each stage's state in words, not only as an icon", () => {
    render(<CodingRunPipelineCard runId="run-1" pipeline={state({}, {
      build: "passed", review: "skipped", deploy_preview: "running",
    })} t={t} />);
    const stage = (s: string) => screen.getByTestId(`coding-agent-pipeline-stage-${s}`);
    expect(stage("build")).toHaveAttribute("data-state", "passed");
    expect(stage("build").textContent).toContain(t("codingAgent.pipelineState.passed"));
    // A stage that did not need to run has NOT passed.
    expect(stage("review")).toHaveAttribute("data-state", "skipped");
    expect(stage("review").textContent).toContain(t("codingAgent.pipelineState.skipped"));
    expect(stage("review").textContent).not.toContain(t("codingAgent.pipelineState.passed"));
    expect(stage("deploy_preview").textContent).toContain(t("codingAgent.pipelineState.running"));
  });

  it("leaves the production stages out when the pipeline was told to stop at a preview", () => {
    render(<CodingRunPipelineCard runId="run-1" pipeline={state({ production: false })} t={t} />);
    expect(screen.queryByTestId("coding-agent-pipeline-stage-deploy_production")).toBeNull();
    expect(screen.queryByTestId("coding-agent-pipeline-stage-verify_production")).toBeNull();
    expect(screen.getByTestId("coding-agent-pipeline-stage-verify_preview")).toBeTruthy();
  });

  it("shows a stage's own reason and its evidence", () => {
    const p = state({}, { verify_preview: "failed" });
    const step = p.steps.find((s) => s.stage === "verify_preview")!;
    step.detail = "The page is up but does not contain \"Invoice\".";
    step.evidence = [
      { kind: "url", ref: "https://shop-abc.example.com/", detail: "checked", at: 1 },
      { kind: "screenshot", ref: "verify-1.png", detail: "a blank page", at: 2 },
    ];
    render(
      <CodingRunPipelineCard
        runId="run-1"
        pipeline={p}
        t={t}
        artifactUrl={(name) => `/setup-api/coding-agent/artifacts?runId=run-1&name=${name}`}
      />,
    );
    expect(screen.getByTestId("coding-agent-pipeline-detail-verify_preview").textContent).toContain("does not contain");
    expect(screen.getByText("https://shop-abc.example.com/")).toHaveAttribute("href", "https://shop-abc.example.com/");
    expect(screen.getByTestId("coding-agent-pipeline-screenshot"))
      .toHaveAttribute("href", "/setup-api/coding-agent/artifacts?runId=run-1&name=verify-1.png");
  });

  it("counts the improvement rounds once any have been spent", () => {
    const { container } = render(<CodingRunPipelineCard runId="run-1" pipeline={state({ round: 1 })} t={t} />);
    expect(container.textContent).toContain(t("codingAgent.pipelineRounds", { round: 1, max: 2 }));
  });
});

describe("what the check actually established", () => {
  it("says so when it was the strings the page had to contain", () => {
    const { container } = render(<CodingRunPipelineCard runId="run-1" pipeline={state({
      lastVerification: {
        ok: true, url: "https://shop.example.com/", status: 200, reason: null,
        judgedBy: "expectations", expectations: [{ text: "Invoice", found: true }],
        vision: null, screenshot: null, checkedAt: 1,
      },
    })} t={t} />);
    expect(container.textContent).toContain("looking for what https://shop.example.com/ had to contain");
  });

  it("says so when it was a model looking at a picture — never the same sentence", () => {
    const { container } = render(<CodingRunPipelineCard runId="run-1" pipeline={state({
      lastVerification: {
        ok: true, url: "https://shop.example.com/", status: 200, reason: null,
        judgedBy: "vision", expectations: [],
        vision: { verdict: "yes", description: "an invoice table", error: null },
        screenshot: "verify-1.png", checkedAt: 1,
      },
    })} t={t} />);
    expect(container.textContent).toContain("screenshot");
    expect(container.textContent).toContain("vision model");
  });
});

describe("the production button", () => {
  const waiting = () => state({ stage: "deploy_production", status: "waiting_owner" }, {
    build: "passed", review: "passed", deploy_preview: "passed", verify_preview: "passed",
    deploy_production: "waiting_owner",
  });

  it("asks before it deploys, in a sentence saying what the world will see", async () => {
    const onApproveProduction = vi.fn(async () => null);
    render(<CodingRunPipelineCard runId="run-1" pipeline={waiting()} t={t} onApproveProduction={onApproveProduction} />);

    fireEvent.click(screen.getByTestId("coding-agent-pipeline-deploy-production"));
    expect(onApproveProduction).not.toHaveBeenCalled();
    const ask = screen.getByTestId("coding-agent-pipeline-confirm");
    expect(ask.textContent).toContain("everyone using it sees it straight away");

    fireEvent.click(screen.getByTestId("coding-agent-pipeline-production-confirm"));
    await waitFor(() => expect(onApproveProduction).toHaveBeenCalledTimes(1));
  });

  it("takes the question back on Cancel, without deploying", () => {
    const onApproveProduction = vi.fn(async () => null);
    render(<CodingRunPipelineCard runId="run-1" pipeline={waiting()} t={t} onApproveProduction={onApproveProduction} />);
    fireEvent.click(screen.getByTestId("coding-agent-pipeline-deploy-production"));
    fireEvent.click(screen.getByTestId("coding-agent-pipeline-production-cancel"));
    expect(screen.queryByTestId("coding-agent-pipeline-confirm")).toBeNull();
    expect(onApproveProduction).not.toHaveBeenCalled();
  });

  it("announces a refusal, because nothing else on the page changes", async () => {
    const onApproveProduction = vi.fn(async () => "That pipeline is not waiting for you.");
    render(<CodingRunPipelineCard runId="run-1" pipeline={waiting()} t={t} onApproveProduction={onApproveProduction} />);
    fireEvent.click(screen.getByTestId("coding-agent-pipeline-deploy-production"));
    fireEvent.click(screen.getByTestId("coding-agent-pipeline-production-confirm"));
    const said = await screen.findByTestId("coding-agent-pipeline-error");
    expect(said).toHaveAttribute("role", "alert");
    expect(said.textContent).toContain("not waiting for you");
  });

  it("does not get stuck on Working… when the host's promise REJECTS", async () => {
    const onApproveProduction = vi.fn(async () => { throw new Error("the network went away"); });
    render(<CodingRunPipelineCard runId="run-1" pipeline={waiting()} t={t} onApproveProduction={onApproveProduction} />);
    fireEvent.click(screen.getByTestId("coding-agent-pipeline-deploy-production"));
    fireEvent.click(screen.getByTestId("coding-agent-pipeline-production-confirm"));
    const said = await screen.findByTestId("coding-agent-pipeline-error");
    expect(said.textContent).toBe(t("codingAgent.pipelineWorkFailed"));
    // …and the button the owner needs is back, rather than the card sitting on
    // "Working…" with nothing on screen saying why.
    expect(screen.queryByTestId("coding-agent-pipeline-working")).toBeNull();
    expect(screen.getByTestId("coding-agent-pipeline-deploy-production")).toBeTruthy();
  });

  it("is not offered on a pipeline that is not waiting, nor where the page does not offer it", () => {
    render(<CodingRunPipelineCard runId="run-1" pipeline={state()} t={t} onApproveProduction={vi.fn(async () => null)} />);
    expect(screen.queryByTestId("coding-agent-pipeline-deploy-production")).toBeNull();

    render(<CodingRunPipelineCard runId="run-2" pipeline={waiting()} t={t} />);
    expect(screen.queryByTestId("coding-agent-pipeline-deploy-production")).toBeNull();
  });

  it("offers Stop beside it, and stops without a second question", async () => {
    const onStopPipeline = vi.fn(async () => null);
    render(<CodingRunPipelineCard runId="run-1" pipeline={waiting()} t={t} onStopPipeline={onStopPipeline} />);
    fireEvent.click(screen.getByTestId("coding-agent-pipeline-stop"));
    await waitFor(() => expect(onStopPipeline).toHaveBeenCalledTimes(1));
  });
});

describe("a pipeline that stopped", () => {
  it("says why", () => {
    render(<CodingRunPipelineCard runId="run-1" pipeline={state({
      status: "failed",
      failure: { stage: "verify_preview", reason: "The page is up but does not contain \"Invoice\"." },
    })} t={t} />);
    expect(screen.getByTestId("coding-agent-pipeline-failure").textContent).toContain("does not contain");
    expect(screen.getByTestId("coding-agent-pipeline-status").textContent).toBe(t("codingAgent.pipelineFailed"));
  });

  it("draws `blocked` as something not set up, not as the work failing", () => {
    render(<CodingRunPipelineCard runId="run-1" pipeline={state({
      status: "blocked",
      failure: { stage: "deploy_preview", reason: "This ClawBox has no deployment integration." },
    })} t={t} />);
    const status = screen.getByTestId("coding-agent-pipeline-status");
    expect(status.textContent).toBe(t("codingAgent.pipelineBlocked"));
    // Amber, the rule `abandoned` is drawn by — nothing broke.
    expect(status.className).toContain("amber");
    expect(screen.getByTestId("coding-agent-pipeline-failure").className).toContain("amber");
  });

  it("carries the status on the card, so a test or a style can read it without the words", () => {
    render(<CodingRunPipelineCard runId="run-1" pipeline={state({ status: "complete", stage: "complete" })} t={t} />);
    const card = screen.getByTestId("coding-agent-pipeline");
    expect(card).toHaveAttribute("data-status", "complete");
    expect(card).toHaveAttribute("data-stage", "complete");
  });
});
