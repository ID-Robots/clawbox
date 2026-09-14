/**
 * The paid-plan gate on the FIRST step of both first-run wizards.
 *
 * Owner's decision, 2026-09-14: the Coding Agent and Memory Shard need a
 * ClawBox Pro or Max plan. The server refuses the enable routes (see
 * src/tests/routes/coding-agent/enable.test.ts and
 * src/tests/routes/memory-shard-enable.test.ts); this is the half that stops
 * the owner pressing a button that was always going to bounce, and it has four
 * states rather than two.
 *
 * The one that matters most is LOADING. `useClawboxLogin` starts every mount
 * at `loggedIn: false`, so a gate that read the first render as "Free" would
 * flash an upgrade card at a Max subscriber every time the window opened —
 * which is why `paidGateFace` treats the poll's own first tick as its own face
 * and neither wizard may draw a refusal during it.
 *
 * The tier names are off by one: the internal `flash` IS the plan marketed as
 * Pro and the internal `pro` is Max. Both pass.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSetupWizard from "@/components/CodingAgentSetupWizard";
import MemoryShardWizard from "@/components/MemoryShardWizard";
import { PaidPlanNotice } from "@/components/PaidFeatureGate";
import type { AgentStatus } from "@/components/CodingAgentSettingsPanel";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** What the box's ClawBox AI account is, as /setup-api/ai-models/status says it. */
type Account = "pro-plan" | "max-plan" | "free" | "not-connected" | "never-answers";

function stubAccount(account: Account) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = input.toString();
    if (url === "/setup-api/ai-models/status") {
      // A poll that never answers is the loading face: the hook holds
      // `loading: true` until its first 2xx body.
      if (account === "never-answers") return new Promise<Response>(() => {});
      return json({
        clawaiConfigured: account !== "not-connected",
        clawaiAccountTier:
          account === "pro-plan" ? "flash" : account === "max-plan" ? "pro" : null,
      });
    }
    // Everything else these wizards read on mount — the GitHub card, the
    // folder list. Nothing here is under test.
    return json({ installed: true, connected: false, login: null, paths: [] });
  }));
}

const CODING_STATUS = {
  setupComplete: false,
  enabled: false,
  ready: true,
  readiness: {
    ready: true,
    wrapperInstalled: true,
    claudeInstalled: true,
    clawaiConnected: true,
    capabilityDropAvailable: true,
    problems: [],
  },
  running: 0,
  defaultDirectory: null,
  suggestedDirectory: "/home/clawbox/Projects",
  effort: "ultracode",
  effortLevels: ["low", "max", "ultracode"],
  subagents: true,
  maxTurns: 150,
  minMaxTurns: 10,
  maxMaxTurns: 2000,
  tokenLimit: null,
  minTokenLimit: 10_000,
  reviewPass: true,
} as unknown as AgentStatus;

/** The two wizards, behind one name, so every case below is asserted on both. */
const WIZARDS = [
  {
    name: "the Coding Agent wizard",
    enableTestId: "coding-agent-wizard-enable",
    render: () => render(<CodingAgentSetupWizard status={CODING_STATUS} onDone={vi.fn()} />),
  },
  {
    name: "the Memory Shard wizard",
    enableTestId: "memory-shard-enable",
    render: () => render(<MemoryShardWizard onDone={vi.fn()} />),
  },
] as const;

afterEach(() => vi.unstubAllGlobals());

for (const wizard of WIZARDS) {
  describe(`${wizard.name}'s first step`, () => {
    it("shows no refusal while the plan is still being read", async () => {
      stubAccount("never-answers");
      wizard.render();

      const gate = await screen.findByTestId("paid-gate");
      expect(gate).toHaveAttribute("data-face", "loading");
      // Nothing is claimed either way yet, so the button is held rather than
      // refused — and no upgrade card is shown to a subscriber.
      expect(screen.getByTestId(wizard.enableTestId)).toBeDisabled();
      expect(screen.queryByText(t("upgradeCard.subscribeButton"))).toBeNull();
    });

    it("offers the device handoff when the box has no ClawBox account at all", async () => {
      stubAccount("not-connected");
      wizard.render();

      await waitFor(() =>
        expect(screen.getByTestId("paid-gate")).toHaveAttribute("data-face", "connect"));
      expect(screen.getByTestId("paid-gate-connect-start")).toBeInTheDocument();
      // The one line the owner needs: which plan, and for what.
      expect(screen.getByText(/needs a ClawBox Pro or Max plan/i)).toBeInTheDocument();
      expect(screen.getByTestId(wizard.enableTestId)).toBeDisabled();
    });

    it("offers the upgrade when the account is on the Free plan", async () => {
      stubAccount("free");
      wizard.render();

      await waitFor(() =>
        expect(screen.getByTestId("paid-gate")).toHaveAttribute("data-face", "upgrade"));
      expect(screen.getByText(t("upgradeCard.subscribeButton"))).toBeInTheDocument();

      const enable = screen.getByTestId(wizard.enableTestId);
      expect(enable).toBeDisabled();
      expect(enable).toHaveAttribute("aria-disabled", "true");
      expect(enable).toHaveAttribute("title", t("paidGate.buttonBlocked"));
    });

    for (const account of ["pro-plan", "max-plan"] as const) {
      it(`is untouched on the ${account === "pro-plan" ? "Pro" : "Max"} plan`, async () => {
        stubAccount(account);
        wizard.render();

        const enable = await screen.findByTestId(wizard.enableTestId);
        await waitFor(() => expect(enable).not.toBeDisabled());
        expect(enable).not.toHaveAttribute("aria-disabled", "true");
        expect(screen.queryByTestId("paid-gate")).toBeNull();
      });
    }
  });
}

describe("the settings-page notice", () => {
  it("says nothing when the plan covers the feature", () => {
    render(<PaidPlanNotice gate={{ required: true, satisfied: true, plan: "flash" }} />);
    expect(screen.queryByTestId("paid-plan-notice")).toBeNull();
  });

  it("says nothing when the server is older than the gate", () => {
    render(<PaidPlanNotice gate={undefined} />);
    expect(screen.queryByTestId("paid-plan-notice")).toBeNull();
  });

  it("names the plan needed, with the way out beside it", () => {
    render(<PaidPlanNotice gate={{ required: true, satisfied: false, plan: null }} />);
    expect(screen.getByTestId("paid-plan-notice")).toHaveTextContent(t("paidGate.requiresPlan"));
    expect(screen.getByText(t("paidGate.upgradeLink"))).toHaveAttribute(
      "href",
      "https://clawbox.com/portal/dashboard",
    );
  });
});
