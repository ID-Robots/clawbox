/**
 * The team as a tree (src/components/CodingTeamTree.tsx): the assistant,
 * the Coding Agent, the planner, as many workers and reviewers as the board
 * counts — the nodes are the agents the card states — each column captioned
 * with its count, the ones at work marked live, hidden from assistive tech.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingTeamTree, { MAX_TREE_REVIEWERS, MAX_TREE_WORKERS } from "@/components/CodingTeamTree";

const t = (key: string) => translations.en[key] ?? key;
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

describe("CodingTeamTree", () => {
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
});
