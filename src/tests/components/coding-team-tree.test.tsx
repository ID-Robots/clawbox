/**
 * The team as a tree (src/components/CodingTeamTree.tsx): the assistant,
 * the Coding Agent, the planner, as many workers and reviewers as the board
 * counts — the nodes are the agents the card states — each column captioned
 * with its count, the ones at work marked live, hidden from assistive tech.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingTeamTree, { FLOW_FPS, MAX_TREE_REVIEWERS, MAX_TREE_WORKERS } from "@/components/CodingTeamTree";

const t = (key: string) => translations.en[key] ?? key;
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

describe("CodingTeamTree", () => {
  it("draws no lead unless the team had lead turns, then one under the planner with its count, live while it decides", () => {
    const { unmount } = render(<CodingTeamTree />);
    expect(screen.getByTestId("coding-team-tree")).toHaveAttribute("data-leads", "0");
    expect(screen.queryByTestId("coding-team-tree-lead")).toBeNull();
    unmount();
    render(<CodingTeamTree workers={2} reviewers={1} leads={2} leadActive />);
    const svg = screen.getByTestId("coding-team-tree");
    expect(svg).toHaveAttribute("data-leads", "2");
    const lead = within(svg).getByTestId("coding-team-tree-lead");
    expect(lead).toHaveAttribute("data-live", "true");
    expect(lead.textContent).toBe(`${t("codingAgent.team.artLead")} · 2`);
  });

  it("never draws a lead in the one-run shape", () => {
    render(<CodingTeamTree shape="run" workers={2} leads={3} />);
    expect(screen.getByTestId("coding-team-tree")).toHaveAttribute("data-leads", "0");
    expect(screen.queryByTestId("coding-team-tree-lead")).toBeNull();
  });

  it("draws the planner, three workers and one reviewer by default, captioned with counts, hidden from assistive tech", () => {
    render(<CodingTeamTree />);
    const svg = screen.getByTestId("coding-team-tree");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("data-workers", "3");
    expect(svg).toHaveAttribute("data-reviewers", "1");
    expect(within(svg).getByTestId("coding-team-tree-planner")).toBeInTheDocument();
    expect(within(svg).getAllByTestId("coding-team-tree-worker")).toHaveLength(3);
    expect(within(svg).getAllByTestId("coding-team-tree-reviewer")).toHaveLength(1);
    for (const key of ["codingAgent.team.artMain", "codingAgent.title", "codingAgent.team.artPlanner", "codingAgent.team.artWorkers", "codingAgent.team.artReviewers"]) {
      expect(svg.textContent).toContain(t(key));
    }
    expect(svg.textContent).toContain(`${t("codingAgent.team.artWorkers")} · 3`);
    expect(svg.textContent).toContain(`${t("codingAgent.team.artReviewers")} · 1`);
    expect(svg.querySelectorAll(".ct-art-flow").length).toBeGreaterThan(5);
  });

  it("draws one node per agent the board counts — workers and reviewers alike, capped — the ones at work live", () => {
    render(<CodingTeamTree workers={5} activeWorkers={2} reviewers={3} activeReviewers={1} plannerActive />);
    const svg = screen.getByTestId("coding-team-tree");
    expect(within(svg).getAllByTestId("coding-team-tree-worker")).toHaveLength(5);
    expect(within(svg).getAllByTestId("coding-team-tree-reviewer")).toHaveLength(3);
    // Planner + 5 workers + 3 reviewers = the 9 agents the card would state.
    expect(1 + within(svg).getAllByTestId("coding-team-tree-worker").length + within(svg).getAllByTestId("coding-team-tree-reviewer").length).toBe(9);
    const workers = within(svg).getAllByTestId("coding-team-tree-worker");
    expect(workers.filter((w) => w.getAttribute("data-live") === "true")).toHaveLength(2);
    const reviewers = within(svg).getAllByTestId("coding-team-tree-reviewer");
    expect(reviewers.filter((w) => w.getAttribute("data-live") === "true")).toHaveLength(1);
    expect(svg).toHaveAttribute("data-planner-active", "true");
    expect(within(svg).getByTestId("coding-team-tree-planner").querySelector(".ct-art-live")).not.toBeNull();
    expect(svg.textContent).toContain(`${t("codingAgent.team.artReviewers")} · 3`);
    // Past the caps, the caps.
    const { unmount } = render(<CodingTeamTree workers={MAX_TREE_WORKERS + 4} reviewers={MAX_TREE_REVIEWERS + 2} />);
    const capped = screen.getAllByTestId("coding-team-tree")[1];
    expect(capped).toHaveAttribute("data-workers", String(MAX_TREE_WORKERS));
    expect(capped).toHaveAttribute("data-reviewers", String(MAX_TREE_REVIEWERS));
    unmount();
  });

  it("never draws fewer than one worker, and no reviewer when the board has none", () => {
    render(<CodingTeamTree workers={0} reviewers={0} />);
    const svg = screen.getByTestId("coding-team-tree");
    expect(svg).toHaveAttribute("data-workers", "1");
    expect(within(svg).queryByTestId("coding-team-tree-reviewer")).toBeNull();
    expect(svg.textContent).toContain(`${t("codingAgent.team.artReviewers")} · 0`);
  });

  // The caption used to read the CAPPED number, so a board of nine workers was
  // captioned "Workers · 5" beside a card stating nine.
  it("captions what there is, even past the cap it draws", () => {
    render(<CodingTeamTree workers={MAX_TREE_WORKERS + 4} reviewers={MAX_TREE_REVIEWERS + 2} />);
    const svg = screen.getByTestId("coding-team-tree");
    expect(within(svg).getAllByTestId("coding-team-tree-worker")).toHaveLength(MAX_TREE_WORKERS);
    expect(svg.textContent).toContain(`${t("codingAgent.team.artWorkers")} · ${MAX_TREE_WORKERS + 4}`);
    expect(svg.textContent).toContain(`${t("codingAgent.team.artReviewers")} · ${MAX_TREE_REVIEWERS + 2}`);
  });

  /**
   * A run with no team is still a picture worth drawing: the assistant, the
   * Coding Agent and the helpers that run sent out itself. Same strokes, same
   * nodes, three columns — so the run page never shows a gap where the chart
   * is, and a team run and a solo run read as the same kind of thing.
   */
  describe('the "run" shape', () => {
    it("drops the planner and the reviewers and captions the run's own helpers", () => {
      render(<CodingTeamTree shape="run" workers={3} activeWorkers={1} />);
      const svg = screen.getByTestId("coding-team-tree");
      expect(svg).toHaveAttribute("data-shape", "run");
      expect(within(svg).queryByTestId("coding-team-tree-planner")).toBeNull();
      expect(within(svg).queryByTestId("coding-team-tree-reviewer")).toBeNull();
      const helpers = within(svg).getAllByTestId("coding-team-tree-worker");
      expect(helpers).toHaveLength(3);
      expect(helpers.filter((h) => h.getAttribute("data-live") === "true")).toHaveLength(1);
      expect(svg.textContent).toContain(`${t("codingAgent.statHelpers")} · 3`);
      expect(svg.textContent).not.toContain(t("codingAgent.team.artPlanner"));
      expect(svg.textContent).not.toContain(t("codingAgent.team.artReviewers"));
    });

    it("draws no fan at all for a run that sent nobody out", () => {
      render(<CodingTeamTree shape="run" workers={0} />);
      const svg = screen.getByTestId("coding-team-tree");
      expect(svg).toHaveAttribute("data-workers", "0");
      expect(within(svg).queryByTestId("coding-team-tree-worker")).toBeNull();
      // No column caption for a column that is not there.
      expect(svg.textContent).not.toContain(t("codingAgent.statHelpers"));
      // The two that ARE there stay.
      expect(svg.textContent).toContain(t("codingAgent.team.artMain"));
      expect(svg.textContent).toContain(t("codingAgent.title"));
    });
  });

  /**
   * The connectors' flowing dashes animate stroke-dashoffset, which the
   * compositor cannot run: left running they cost a style recalc and a repaint
   * of the drawing every frame, on every run page left open. They run PAUSED
   * (globals.css) and the tree steps them at FLOW_FPS — the same flow, a
   * quarter of the frames — and not at all while nobody can see it.
   */
  describe("the flowing dashes", () => {
    /** A CSS animation as the hook sees it: its name, and every time it is set. */
    class FakeAnimation {
      writes: number[] = [];
      constructor(readonly animationName: string) {}
      get currentTime(): number | null { return this.writes.at(-1) ?? null; }
      set currentTime(t: number | null) { if (t !== null) this.writes.push(t); }
    }
    let flow: FakeAnimation;
    let breathe: FakeAnimation;
    let getAnimations: ReturnType<typeof vi.fn>;

    const stubAnimations = () => {
      flow = new FakeAnimation("ct-art-flow");
      breathe = new FakeAnimation("ct-art-node");
      getAnimations = vi.fn(() => [flow, breathe]);
      Object.defineProperty(SVGElement.prototype, "getAnimations", { value: getAnimations, configurable: true, writable: true });
    };

    afterEach(() => {
      delete (SVGElement.prototype as { getAnimations?: unknown }).getAnimations;
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      vi.useRealTimers();
    });

    it("steps the flow FLOW_FPS times a second to the time since it mounted, and leaves the breathing alone", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      stubAnimations();
      const { unmount } = render(<CodingTeamTree />);
      // The first step lands at mount.
      expect(flow.writes).toEqual([0]);
      act(() => { vi.advanceTimersByTime(1000); });
      const steps = flow.writes.length - 1;
      expect(steps).toBeGreaterThanOrEqual(FLOW_FPS - 1);
      expect(steps).toBeLessThanOrEqual(FLOW_FPS + 1);
      // Where a running animation would be a second in.
      expect(flow.currentTime).toBeGreaterThan(900);
      expect(flow.currentTime).toBeLessThanOrEqual(1000);
      // The opacity breathing runs on the compositor and is never touched.
      expect(breathe.writes).toEqual([]);
      // Looked up once, not once a step: reading an animation flushes style.
      expect(getAnimations).toHaveBeenCalledTimes(1);
      // Unmounted, the timer goes with it.
      unmount();
      const atUnmount = flow.writes.length;
      act(() => { vi.advanceTimersByTime(1000); });
      expect(flow.writes.length).toBe(atUnmount);
    });

    it("looks the connectors up again after a render, which can add or drop one", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      stubAnimations();
      const { rerender } = render(<CodingTeamTree workers={1} />);
      act(() => { vi.advanceTimersByTime(500); });
      expect(getAnimations).toHaveBeenCalledTimes(1);
      const added = new FakeAnimation("ct-art-flow");
      getAnimations.mockImplementation(() => [flow, breathe, added]);
      rerender(<CodingTeamTree workers={3} />);
      act(() => { vi.advanceTimersByTime(200); });
      expect(getAnimations).toHaveBeenCalledTimes(2);
      // The new connector joins the same clock.
      expect(added.writes.length).toBeGreaterThan(0);
      expect(added.currentTime).toBe(flow.currentTime);
    });

    it("does not step while the desktop is hidden, and catches up when it is back", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      stubAnimations();
      render(<CodingTeamTree />);
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      const hiddenAt = flow.writes.length;
      act(() => { vi.advanceTimersByTime(2000); });
      expect(flow.writes.length).toBe(hiddenAt);
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      act(() => { vi.advanceTimersByTime(100); });
      // Not resumed from where it stopped: where it would be after 2.1 s.
      expect(flow.currentTime).toBeGreaterThan(2000);
    });

    it("does not step under reduced motion", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      stubAnimations();
      const matchMedia = window.matchMedia;
      window.matchMedia = vi.fn((query: string) => ({ matches: query.includes("reduce"), media: query })) as unknown as typeof window.matchMedia;
      try {
        render(<CodingTeamTree />);
        act(() => { vi.advanceTimersByTime(1000); });
        expect(getAnimations).not.toHaveBeenCalled();
        expect(flow.writes).toEqual([]);
      } finally {
        window.matchMedia = matchMedia;
      }
    });
  });
});
