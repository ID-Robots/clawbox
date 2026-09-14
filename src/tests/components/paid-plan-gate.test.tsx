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
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSetupWizard from "@/components/CodingAgentSetupWizard";
import MemoryShardWizard from "@/components/MemoryShardWizard";
import MemoryShardSettingsPanel from "@/components/MemoryShardSettingsPanel";
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

describe("the settings switch behind an unsatisfied gate", () => {
  /**
   * A switch that posts a request the box will answer 402 is not a switch: the
   * page showed the notice and then let the owner press On, which came back as
   * a generic "could not save" naming nothing they could act on.
   *
   * Only the OFF-to-ON move is held. The other direction is always allowed,
   * because an already-enabled box whose plan lapsed is never auto-disabled
   * and must still be switchable off — the whole shape of this gate.
   */
  const unsatisfied = { required: true, satisfied: false, plan: null };

  it("holds the Memory Shard switch off, and lets an enabled one be turned off", () => {
    const { rerender } = render(
      <MemoryShardSettingsPanel
        state={{ enabled: false, setupComplete: false, planGate: unsatisfied }}
        onChanged={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTestId("memory-shard-switch")).toBeDisabled();

    rerender(
      <MemoryShardSettingsPanel
        state={{ enabled: true, setupComplete: true, planGate: unsatisfied }}
        onChanged={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTestId("memory-shard-switch")).not.toBeDisabled();
    expect(screen.getByTestId("paid-plan-notice")).toBeInTheDocument();
  });

  it("leaves the switch alone when the server never sent a gate", () => {
    render(
      <MemoryShardSettingsPanel
        state={{ enabled: false, setupComplete: false }}
        onChanged={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTestId("memory-shard-switch")).not.toBeDisabled();
    expect(screen.queryByTestId("paid-plan-notice")).toBeNull();
  });
});

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

describe("the device handoff inside the gate", () => {
  it("says it is checking rather than dropping back to the Connect button", async () => {
    // The poll runs every PAID_GATE_POLL_MS and the pairing finishes in
    // between; the card must not read as a failure in that gap.
    let polled = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "/setup-api/ai-models/status") {
        polled += 1;
        return json({ clawaiConfigured: false, clawaiAccountTier: null });
      }
      if (url === "/setup-api/ai-models/clawai/start") {
        // One second, so the handoff's first tick lands inside the test's
        // budget; the device flow's own cadence is the portal's to set.
        return json({ user_code: "WDJB-MJHT", verification_url: "https://clawbox.com/portal/device", interval: 1 });
      }
      if (url === "/setup-api/ai-models/clawai/poll") return json({ status: "complete" });
      return json({ installed: true, connected: false, login: null, paths: [] });
    }));

    render(<MemoryShardWizard onDone={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("paid-gate")).toHaveAttribute("data-face", "connect"));
    expect(polled).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("paid-gate-connect-start"));
    expect(await screen.findByTestId("paid-gate-device")).toHaveTextContent("WDJB-MJHT");

    // The poll reports `complete` on its first tick, so what matters is the
    // state AFTER it: the card must say it is checking the plan. Dropping back
    // to the Connect button — which is what `reset()` alone did — reads as a
    // failure over a pairing that worked, and is exactly what this pins.
    await screen.findByTestId("paid-gate-connected", undefined, { timeout: 5_000 });
    expect(screen.queryByTestId("paid-gate-connect-start")).toBeNull();
    expect(screen.queryByTestId("paid-gate-connect-error")).toBeNull();
  }, 10_000);

  it("stops polling when the owner cancels", async () => {
    // `reset()` only clears the code on screen. Without `stop()` the timer and
    // the in-flight request survive a cancel, so a handoff the owner walked
    // away from went on polling and could still land on them.
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "/setup-api/ai-models/status") {
        return json({ clawaiConfigured: false, clawaiAccountTier: null });
      }
      if (url === "/setup-api/ai-models/clawai/start") {
        return json({ user_code: "WDJB-MJHT", verification_url: "https://clawbox.com/portal/device", interval: 1 });
      }
      if (url === "/setup-api/ai-models/clawai/poll") {
        polls += 1;
        return json({ status: "pending", interval: 1 });
      }
      return json({ installed: true, connected: false, login: null, paths: [] });
    }));

    render(<MemoryShardWizard onDone={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("paid-gate")).toHaveAttribute("data-face", "connect"));
    fireEvent.click(screen.getByTestId("paid-gate-connect-start"));
    await screen.findByTestId("paid-gate-device");

    // Let it poll at least once, so "no polls after cancel" is a fact about
    // the cancel and not about a flow that never started.
    await waitFor(() => expect(polls).toBeGreaterThan(0), { timeout: 5_000 });
    fireEvent.click(screen.getByTestId("paid-gate-connect-cancel"));
    const after = polls;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(polls).toBe(after);
  }, 15_000);
});

describe("the gate holds for the whole wizard, not just its front door", () => {
  /**
   * The plan poll runs behind every step. A subscription that lapses — or a
   * credential withdrawn — while the owner is several steps in used to leave
   * the finishing button live, so the flow ran to its end and collected a 402
   * from the enable route after the work had been done.
   */
  for (const wizard of WIZARDS) {
    it(`${wizard.name} returns to the gate when the plan goes away mid-flow`, async () => {
      let paid = true;
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        const url = input.toString();
        if (url === "/setup-api/ai-models/status") {
          return json({ clawaiConfigured: true, clawaiAccountTier: paid ? "flash" : null });
        }
        return json({ installed: true, connected: false, login: null, paths: [] });
      }));

      wizard.render();
      const enable = await screen.findByTestId(wizard.enableTestId);
      await waitFor(() => expect(enable).not.toBeDisabled());
      fireEvent.click(enable);
      // Off the intro: the enable button is gone.
      await waitFor(() => expect(screen.queryByTestId(wizard.enableTestId)).toBeNull());

      paid = false;
      // Back on the intro, with the upgrade card in the place the next step
      // would have been.
      await waitFor(() =>
        expect(screen.getByTestId("paid-gate")).toHaveAttribute("data-face", "upgrade"), { timeout: 10_000 });
      expect(screen.getByTestId(wizard.enableTestId)).toBeDisabled();
    }, 15_000);
  }
});
