/**
 * The team as a tree (src/components/CodingTeamTree.tsx): the assistant,
 * the Coding Agent, as many workers as the board says, the reviewer — a
 * picture sized by data and hidden from the screen reader, whose caption is
 * the card's own sentence.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingTeamTree, { MAX_TREE_WORKERS } from "@/components/CodingTeamTree";

const t = (key: string) => translations.en[key] ?? key;
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

describe("CodingTeamTree", () => {
  it("draws three workers and a reviewer by default, captioned by column, hidden from assistive tech", () => {
    render(<CodingTeamTree />);
    const svg = screen.getByTestId("coding-team-tree");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("data-workers", "3");
    expect(svg).toHaveAttribute("data-reviewer", "true");
    expect(within(svg).getAllByTestId("coding-team-tree-worker")).toHaveLength(3);
    expect(within(svg).getByTestId("coding-team-tree-reviewer")).toBeInTheDocument();
    for (const key of ["codingAgent.team.artMain", "codingAgent.title", "codingAgent.team.artWorkers", "codingAgent.artReviewer"]) {
      expect(svg.textContent).toContain(t(key));
    }
    expect(svg.querySelectorAll(".ct-art-flow").length).toBeGreaterThan(3);
  });

  it("draws as many workers as the board has, capped, the ones at work marked live, and no reviewer when told", () => {
    render(<CodingTeamTree workers={MAX_TREE_WORKERS + 4} activeWorkers={2} reviewer={false} />);
    const svg = screen.getByTestId("coding-team-tree");
    expect(svg).toHaveAttribute("data-workers", String(MAX_TREE_WORKERS));
    const workers = within(svg).getAllByTestId("coding-team-tree-worker");
    expect(workers.filter((w) => w.getAttribute("data-live") === "true")).toHaveLength(2);
    expect(workers[0].querySelector(".ct-art-live")).not.toBeNull();
    expect(workers[2].querySelector(".ct-art-node")).not.toBeNull();
    expect(within(svg).queryByTestId("coding-team-tree-reviewer")).toBeNull();
    expect(svg.textContent).not.toContain(t("codingAgent.artReviewer"));
  });

  it("never draws fewer than one worker", () => {
    render(<CodingTeamTree workers={0} />);
    expect(screen.getByTestId("coding-team-tree")).toHaveAttribute("data-workers", "1");
  });
});
