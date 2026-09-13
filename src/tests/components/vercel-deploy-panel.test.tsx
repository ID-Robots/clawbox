/**
 * The two Deploy buttons.
 *
 * The properties under test:
 *
 *  1. PREVIEW IS ONE CLICK; PRODUCTION IS NOT. The production button does not
 *     deploy — it asks, in a sentence that names the Vercel project and, when
 *     the box could learn it, the domain the build lands on. Only the confirm
 *     sends, and it sends `confirm: true`, so the button and the route agree
 *     about what the gesture is.
 *  2. NOTHING IS OFFERED ON A PROJECT WITH NO VERCEL PROJECT ATTACHED. A greyed
 *     Deploy would be a second, wordless way of saying what the link card above
 *     already says.
 *  3. THE PANEL NEVER NAMES A VERCEL PROJECT OF ITS OWN. What it posts is the
 *     coding project it was given and the target; the device resolves the rest.
 *  4. THE OWNER'S STANDING PERMISSION FOR THE ASSISTANT IS ON THE PROJECT PAGE
 *     AND NOT ON A RUN — it is a setting, and a setting belongs beside the
 *     thing it governs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import VercelDeployPanel from "@/components/VercelDeployPanel";
import type { ProjectDeploy } from "@/lib/vercel-state";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};

function deploy(over: Partial<ProjectDeploy> = {}): ProjectDeploy {
  return {
    target: "preview", phase: "ready", readyState: "ready", projectId: "prj_acme", teamId: null,
    deploymentId: "dpl_1", url: "https://shop-abc.vercel.app", inspectorUrl: null,
    source: "files", gitRef: null, fileCount: 5, by: "owner", runId: null,
    startedAt: 1, endedAt: 2, detail: null, ...over,
  };
}

/** Every request the panel made. */
let calls: { url: string; method: string; body: Record<string, unknown> | null }[];

function api(payload: Record<string, unknown>, post?: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url: String(input), method: init.method ?? "GET", body });
    const answered = init.method && init.method !== "GET" ? (post ?? payload) : payload;
    return new Response(JSON.stringify(answered), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

const LINKED = {
  linked: true,
  deploy: null,
  autoProduction: false,
  production: { left: 3, max: 3, nextAt: null },
  project: { name: "shop", productionDomain: "shop.example.com" },
};

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("a project with no Vercel project attached", () => {
  it("offers nothing at all", async () => {
    api({ linked: false, deploy: null, autoProduction: false, production: { left: 3, max: 3, nextAt: null } });
    render(<VercelDeployPanel query="directory=%2Fp%2Fshop" t={t} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("coding-agent-deploy-actions")).toBeNull();
  });
});

describe("a preview", () => {
  it("is one click, and posts the coding project and the target — nothing else", async () => {
    api(LINKED, { ...LINKED, deploy: deploy() });
    render(<VercelDeployPanel query="directory=%2Fp%2Fshop" t={t} />);
    fireEvent.click(await screen.findByTestId("coding-agent-deploy-preview-btn"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ directory: "/p/shop", target: "preview" });
    // No confirmation on a preview, and no Vercel project of the panel's own.
    expect(post.body).not.toHaveProperty("confirm");
    expect(JSON.stringify(post.body)).not.toContain("prj_");
  });
});

describe("production", () => {
  it("asks first, and the question names the project and the domain", async () => {
    api(LINKED);
    render(<VercelDeployPanel query="directory=%2Fp%2Fshop" t={t} />);
    fireEvent.click(await screen.findByTestId("coding-agent-deploy-production-btn"));
    const ask = await screen.findByTestId("coding-agent-deploy-production-confirm");
    expect(ask).toHaveTextContent(t("codingAgent.deployProductionAsk"));
    expect(ask).toHaveTextContent("shop.example.com");
    // Asking is not deploying.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("names the project alone when this box could not learn the domain", async () => {
    api({ ...LINKED, project: { name: "shop", productionDomain: null } });
    render(<VercelDeployPanel query="directory=%2Fp%2Fshop" t={t} />);
    fireEvent.click(await screen.findByTestId("coding-agent-deploy-production-btn"));
    const ask = await screen.findByTestId("coding-agent-deploy-production-confirm");
    expect(ask).toHaveTextContent(t("codingAgent.deployProductionWarn", { project: "shop" }));
  });

  it("sends the confirmation with the request when the owner says yes", async () => {
    api(LINKED, { ...LINKED, deploy: deploy({ target: "production" }) });
    render(<VercelDeployPanel query="projectId=shop" t={t} />);
    fireEvent.click(await screen.findByTestId("coding-agent-deploy-production-btn"));
    fireEvent.click(await screen.findByTestId("coding-agent-deploy-production-confirm-yes"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ projectId: "shop", target: "production", confirm: true });
  });

  it("cancels without deploying", async () => {
    api(LINKED);
    render(<VercelDeployPanel query="projectId=shop" t={t} />);
    fireEvent.click(await screen.findByTestId("coding-agent-deploy-production-btn"));
    fireEvent.click(await screen.findByTestId("coding-agent-deploy-production-cancel"));
    await waitFor(() => expect(screen.queryByTestId("coding-agent-deploy-production-confirm")).toBeNull());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("what the panel says about the last deployment", () => {
  it("shows the address, the target and who asked", async () => {
    api({ ...LINKED, deploy: deploy({ target: "production", by: "agent" }) });
    render(<VercelDeployPanel query="projectId=shop" t={t} />);
    const link = await screen.findByTestId("coding-agent-project-deploy-url");
    expect(link).toHaveAttribute("href", "https://shop-abc.vercel.app");
    const row = screen.getByTestId("coding-agent-project-deploy");
    expect(row).toHaveAttribute("data-target", "production");
    // After the fact there is no other way to tell the owner's own press from
    // one the assistant made.
    expect(row).toHaveTextContent(t("codingAgent.deployByAgent"));
  });

  it("says a failed build in the record's own words", async () => {
    api({ ...LINKED, deploy: deploy({ phase: "failed", url: null, detail: "Build exceeded memory" }) });
    render(<VercelDeployPanel query="projectId=shop" t={t} />);
    expect(await screen.findByTestId("coding-agent-project-deploy-detail")).toHaveTextContent("Build exceeded memory");
    expect(screen.getByTestId("coding-agent-project-deploy-phase")).toHaveTextContent(t("codingAgent.deployFailed"));
  });

  it("shows a refusal the device spoke, in its own words", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push({ url: String(input), method: init.method ?? "GET", body: null });
      if (init.method === "POST") {
        return new Response(JSON.stringify({ error: "back it up to GitHub first", code: "no_remote" }), { status: 400 });
      }
      return new Response(JSON.stringify(LINKED), { status: 200 });
    }));
    render(<VercelDeployPanel query="projectId=shop" t={t} />);
    fireEvent.click(await screen.findByTestId("coding-agent-deploy-preview-btn"));
    const said = await screen.findByTestId("coding-agent-deploy-error");
    expect(said).toHaveTextContent("back it up to GitHub first");
    expect(said).toHaveAttribute("role", "alert");
  });
});

describe("the owner's standing permission for the assistant", () => {
  it("is on the project page, off by default, and writes through PUT", async () => {
    api(LINKED, { ...LINKED, autoProduction: true });
    render(<VercelDeployPanel query="projectId=shop" t={t} />);
    const box = await screen.findByTestId("coding-agent-deploy-auto") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ projectId: "shop", autoProduction: true });
  });

  it("is NOT on a run's page — a setting belongs beside the thing it governs", async () => {
    api({ ...LINKED, deploy: deploy() });
    render(<VercelDeployPanel query="projectId=shop" t={t} runId="run-1" compact />);
    await screen.findByTestId("coding-agent-deploy-preview-btn");
    expect(screen.queryByTestId("coding-agent-deploy-auto")).toBeNull();
    // Nor the project's own deployment state: the run's card says that above.
    expect(screen.queryByTestId("coding-agent-project-deploy")).toBeNull();
  });

  it("carries the run id on a run's page, so the deployment lands on that record", async () => {
    api(LINKED, { ...LINKED, deploy: deploy({ runId: "run-1" }) });
    render(<VercelDeployPanel query="projectId=shop" t={t} runId="run-1" compact />);
    fireEvent.click(await screen.findByTestId("coding-agent-deploy-preview-btn"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ runId: "run-1" });
  });
});

describe("what it costs to have open", () => {
  it("asks Vercel for the domain ONCE, not on every poll", async () => {
    api({ ...LINKED, deploy: deploy({ phase: "building" }) });
    render(<VercelDeployPanel query="projectId=shop" t={t} />);
    await screen.findByTestId("coding-agent-deploy-preview-btn");
    const withDomain = calls.filter((c) => c.method === "GET" && c.url.includes("domain=1"));
    expect(withDomain).toHaveLength(1);
  });
});
