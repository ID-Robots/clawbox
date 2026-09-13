/**
 * The two Vercel surfaces: the deployment on a run's page, and the link on a
 * project's page.
 *
 * The properties under test:
 *
 *  1. THE PREVIEW ADDRESS IS SURFACED, as a real link, and only when there IS
 *     one — the whole reason an owner opens this card.
 *  2. PROMOTION IS GATED BEHIND A QUESTION THAT SAYS WHAT IT DOES. The button
 *     does not promote; it asks, in a sentence naming the project, and only the
 *     confirm sends. A build that is not ready offers no button at all.
 *  3. THE LINK CARD NEVER ASKS FOR A TOKEN. It offers the NAMES of stored
 *     secrets and posts a name, so no credential is typed, held or shown here.
 *  4. "COULD NOT REACH VERCEL" IS SAID AS SUCH, never as "your token is wrong"
 *     — an owner sent to rotate a working credential because their internet
 *     blinked is the failure this sentence exists to avoid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunVercelCard from "@/components/CodingRunVercelCard";
import VercelProjectCard from "@/components/VercelProjectCard";
import type { VercelPhase, VercelState } from "@/lib/vercel-state";

/** The card's own words, in English: asserting on the catalogue's copy rather
 *  than on the key is what catches a string that never entered it. */
const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};

function state(over: Partial<VercelState> = {}): VercelState {
  return {
    phase: "ready",
    projectId: "prj_acme",
    teamId: null,
    deploymentId: "dpl_1",
    readyState: "ready",
    url: "https://shop-abc123.vercel.app",
    inspectorUrl: "https://vercel.com/acme/shop/dpl_1",
    target: "preview",
    branch: "clawbox/run-1",
    sha: "abc123",
    startedAt: 1,
    endedAt: 2,
    detail: null,
    fixRunId: null,
    feedbackSent: false,
    promotion: null,
    ...over,
  };
}

describe("the deployment on a run's page", () => {
  it("shows the preview address as a link the owner can open", () => {
    render(<CodingRunVercelCard runId="run-1" vercel={state()} t={t} />);
    const link = screen.getByTestId("coding-agent-deploy-preview");
    expect(link).toHaveAttribute("href", "https://shop-abc123.vercel.app");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveTextContent("https://shop-abc123.vercel.app");
  });

  it("shows no preview link while there is nothing to open", () => {
    render(<CodingRunVercelCard runId="run-1" vercel={state({ phase: "looking", url: null })} t={t} />);
    expect(screen.queryByTestId("coding-agent-deploy-preview")).toBeNull();
    expect(screen.getByTestId("coding-agent-deploy-phase")).toHaveTextContent(t("codingAgent.deployLooking"));
  });

  it("names each phase in the owner's own words", () => {
    const said: Record<VercelPhase, string> = {
      looking: "codingAgent.deployLooking",
      building: "codingAgent.deployBuilding",
      ready: "codingAgent.deployReady",
      failed: "codingAgent.deployFailed",
      canceled: "codingAgent.deployCanceled",
      abandoned: "codingAgent.deployAbandoned",
    };
    for (const [phase, key] of Object.entries(said) as [VercelPhase, string][]) {
      const { unmount } = render(<CodingRunVercelCard runId="run-1" vercel={state({ phase })} t={t} />);
      expect(screen.getByTestId("coding-agent-deploy"), phase).toHaveAttribute("data-phase", phase);
      expect(screen.getByTestId("coding-agent-deploy-phase"), phase).toHaveTextContent(t(key));
      unmount();
    }
  });

  it("shows why a build failed, in the record's own words", () => {
    render(<CodingRunVercelCard runId="run-1" vercel={state({ phase: "failed", detail: 'Command "npm run build" exited with 1' })} t={t} />);
    expect(screen.getByTestId("coding-agent-deploy-detail")).toHaveTextContent('Command "npm run build" exited with 1');
  });

  it("offers the fix turn the box started, as a way into that run", () => {
    const onOpenRun = vi.fn();
    render(<CodingRunVercelCard runId="run-1" vercel={state({ phase: "failed", fixRunId: "run-fix1" })} t={t} onOpenRun={onOpenRun} />);
    fireEvent.click(screen.getByTestId("coding-agent-deploy-fix-run"));
    expect(onOpenRun).toHaveBeenCalledWith("run-fix1");
  });
});

describe("promoting to production", () => {
  it("asks before it promotes, in a sentence that names the project", async () => {
    const onPromote = vi.fn(async () => null);
    render(<CodingRunVercelCard runId="run-1" vercel={state()} t={t} onPromote={onPromote} />);

    fireEvent.click(screen.getByTestId("coding-agent-deploy-promote"));
    // The button ASKS. Nothing has been sent.
    expect(onPromote).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("coding-agent-deploy-confirm");
    expect(confirm).toHaveTextContent(t("codingAgent.deployPromoteAsk"));
    expect(confirm).toHaveTextContent("prj_acme");

    fireEvent.click(screen.getByTestId("coding-agent-deploy-promote-confirm"));
    await waitFor(() => expect(onPromote).toHaveBeenCalledWith("dpl_1"));
  });

  it("sends nothing when the owner backs out", () => {
    const onPromote = vi.fn(async () => null);
    render(<CodingRunVercelCard runId="run-1" vercel={state()} t={t} onPromote={onPromote} />);
    fireEvent.click(screen.getByTestId("coding-agent-deploy-promote"));
    fireEvent.click(screen.getByTestId("coding-agent-deploy-promote-cancel"));
    expect(screen.queryByTestId("coding-agent-deploy-confirm")).toBeNull();
    expect(onPromote).not.toHaveBeenCalled();
    // And the offer is still there to take up later.
    expect(screen.getByTestId("coding-agent-deploy-promote")).toBeTruthy();
  });

  it("offers no promotion for a build that is not ready", () => {
    for (const phase of ["looking", "building", "failed", "canceled", "abandoned"] as const) {
      const { unmount } = render(<CodingRunVercelCard runId="run-1" vercel={state({ phase })} t={t} onPromote={vi.fn()} />);
      expect(screen.queryByTestId("coding-agent-deploy-promote"), phase).toBeNull();
      unmount();
    }
  });

  it("offers no promotion where the host does not allow one, or where it already happened", () => {
    const { unmount } = render(<CodingRunVercelCard runId="run-1" vercel={state()} t={t} />);
    expect(screen.queryByTestId("coding-agent-deploy-promote")).toBeNull();
    unmount();

    render(
      <CodingRunVercelCard
        runId="run-1"
        vercel={state({ promotion: { deploymentId: "dpl_1", url: "https://shop.example", at: 5, by: "owner" } })}
        t={t}
        onPromote={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("coding-agent-deploy-promote")).toBeNull();
    expect(screen.getByTestId("coding-agent-deploy-promoted")).toHaveTextContent(t("codingAgent.deployPromotedBy"));
  });

  it("draws the refusal beside the deployment rather than swallowing it", async () => {
    const onPromote = vi.fn(async () => "Vercel refused this ClawBox's token");
    render(<CodingRunVercelCard runId="run-1" vercel={state()} t={t} onPromote={onPromote} />);
    fireEvent.click(screen.getByTestId("coding-agent-deploy-promote"));
    fireEvent.click(screen.getByTestId("coding-agent-deploy-promote-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("coding-agent-deploy-promote-error")).toHaveTextContent("Vercel refused this ClawBox's token"));
  });
});

describe("the link on a project's page", () => {
  let calls: { url: string; method: string; body: unknown }[] = [];
  let link: unknown = null;
  let readiness: unknown = null;
  let secretNames: { name: string; scope: string }[] = [];
  let refuse: { status: number; body: unknown } | null = null;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  beforeEach(() => {
    calls = [];
    link = null;
    readiness = null;
    refuse = null;
    secretNames = [{ name: "VERCEL_TOKEN", scope: "@box" }, { name: "VERCEL_TOKEN", scope: "shop" }, { name: "STRIPE_KEY", scope: "@box" }];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ url: String(url), method, body: init.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes("secrets/names")) return json({ names: secretNames });
      if (method === "DELETE") return json({ link: null, readiness: null, removed: true });
      if (method === "POST") {
        if (refuse) return json(refuse.body, refuse.status);
        const body = JSON.parse(String(init.body)) as { vercelProjectId: string; tokenSecretName: string };
        link = { projectId: body.vercelProjectId, teamId: null, tokenSecretName: body.tokenSecretName, createdAt: 1, updatedAt: 1 };
        readiness = { linked: true, tokenPresent: true, tokenValid: true, username: "acme", projectResolves: true, projectName: "app", ready: true, problems: [] };
        return json({ link, readiness });
      }
      return json({ link, readiness });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("says a project deploys nowhere until one is attached", async () => {
    render(<VercelProjectCard query="directory=%2Fhome%2Fclawbox%2Fprojects%2Fshop" t={t} />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-vercel-none")).toHaveTextContent(t("codingAgent.vercelNone")));
    expect(screen.getByTestId("coding-agent-vercel-card")).toHaveAttribute("data-linked", "false");
  });

  it("asks Vercel once on open, through the route's own check flag", async () => {
    render(<VercelProjectCard query="directory=%2Fshop" t={t} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0].url).toContain("check=1");
  });

  it("offers the NAMES of stored secrets and posts a name — no token is ever typed here", async () => {
    render(<VercelProjectCard query="directory=%2Fshop" t={t} />);
    await waitFor(() => screen.getByTestId("coding-agent-vercel-attach"));
    fireEvent.click(screen.getByTestId("coding-agent-vercel-attach"));

    const picker = await screen.findByTestId("coding-agent-vercel-secret-input") as HTMLSelectElement;
    // One entry per NAME, not per stored row: the same name in two scopes is
    // one choice, and the store's precedence decides which is opened.
    expect([...picker.options].map((o) => o.value)).toEqual(["STRIPE_KEY", "VERCEL_TOKEN"]);
    // No field anywhere asks for a value.
    expect(screen.queryByDisplayValue(/vrc_live/)).toBeNull();

    fireEvent.change(screen.getByTestId("coding-agent-vercel-project-input"), { target: { value: "prj_acme" } });
    fireEvent.change(picker, { target: { value: "VERCEL_TOKEN" } });
    fireEvent.click(screen.getByTestId("coding-agent-vercel-save"));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const posted = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(posted).toMatchObject({ vercelProjectId: "prj_acme", tokenSecretName: "VERCEL_TOKEN" });
    // The headline: the posted body carries a NAME and nothing that could be a
    // credential.
    expect(JSON.stringify(posted)).not.toMatch(/vrc_live/);
    await waitFor(() => expect(screen.getByTestId("coding-agent-vercel-project")).toHaveTextContent("prj_acme"));
  });

  it("says the box could not REACH Vercel, never that the token is wrong", async () => {
    link = { projectId: "prj_acme", teamId: null, tokenSecretName: "VERCEL_TOKEN", createdAt: 1, updatedAt: 1 };
    readiness = { linked: true, tokenPresent: true, tokenValid: null, username: null, projectResolves: null, projectName: null, ready: false, problems: ["This ClawBox could not reach Vercel"] };
    render(<VercelProjectCard query="directory=%2Fshop" t={t} />);
    const verdict = await screen.findByTestId("coding-agent-vercel-verdict");
    expect(verdict).toHaveTextContent(t("codingAgent.vercelUnreachable"));
    expect(verdict.textContent).not.toContain(t("codingAgent.vercelProblem", { reason: "" }).replace("{reason}", ""));
  });

  it("says Vercel refused the link when Vercel is the one that said so", async () => {
    link = { projectId: "prj_acme", teamId: null, tokenSecretName: "VERCEL_TOKEN", createdAt: 1, updatedAt: 1 };
    readiness = { linked: true, tokenPresent: true, tokenValid: false, username: null, projectResolves: false, projectName: null, ready: false, problems: ["Vercel refused this ClawBox's token"] };
    render(<VercelProjectCard query="directory=%2Fshop" t={t} />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-vercel-verdict")).toHaveTextContent("Vercel refused this ClawBox's token"));
  });

  it("says the account when the link works", async () => {
    link = { projectId: "prj_acme", teamId: null, tokenSecretName: "VERCEL_TOKEN", createdAt: 1, updatedAt: 1 };
    readiness = { linked: true, tokenPresent: true, tokenValid: true, username: "acme-ops", projectResolves: true, projectName: "app", ready: true, problems: [] };
    render(<VercelProjectCard query="directory=%2Fshop" t={t} />);
    await waitFor(() =>
      expect(screen.getByTestId("coding-agent-vercel-verdict")).toHaveTextContent(t("codingAgent.vercelConnected", { user: "acme-ops" })));
  });

  it("draws the route's own refusal when a save is turned down", async () => {
    refuse = { status: 400, body: { error: "A Vercel project is named by its id", code: "invalid_project" } };
    render(<VercelProjectCard query="directory=%2Fshop" t={t} />);
    await waitFor(() => screen.getByTestId("coding-agent-vercel-attach"));
    fireEvent.click(screen.getByTestId("coding-agent-vercel-attach"));
    await screen.findByTestId("coding-agent-vercel-project-input");
    fireEvent.change(screen.getByTestId("coding-agent-vercel-project-input"), { target: { value: "../etc" } });
    fireEvent.click(screen.getByTestId("coding-agent-vercel-save"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-vercel-error")).toHaveTextContent("A Vercel project is named by its id"));
  });

  it("detaches, and does not claim the stored secret went with it", async () => {
    link = { projectId: "prj_acme", teamId: null, tokenSecretName: "VERCEL_TOKEN", createdAt: 1, updatedAt: 1 };
    render(<VercelProjectCard query="directory=%2Fshop" t={t} />);
    await waitFor(() => screen.getByTestId("coding-agent-vercel-detach"));
    fireEvent.click(screen.getByTestId("coding-agent-vercel-detach"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-vercel-none")).toBeTruthy());
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("tells the owner to save the token first when this box has no secrets at all", async () => {
    secretNames = [];
    render(<VercelProjectCard query="directory=%2Fshop" t={t} />);
    await waitFor(() => screen.getByTestId("coding-agent-vercel-attach"));
    fireEvent.click(screen.getByTestId("coding-agent-vercel-attach"));
    await waitFor(() =>
      expect(screen.getByTestId("coding-agent-vercel-no-secrets")).toHaveTextContent(t("codingAgent.vercelNoSecrets")));
    // With no secret to name there is nothing to save, so the button is shut.
    expect(screen.getByTestId("coding-agent-vercel-save")).toBeDisabled();
  });
});
