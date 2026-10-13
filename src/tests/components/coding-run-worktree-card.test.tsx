/**
 * The run page's worktree line (src/components/CodingRunWorktreeCard.tsx):
 * where a settled run's work IS, in one sentence.
 *
 * The settle removes a run's copy of the project whether or not its branch
 * could be merged home, and keeps the branch. So the card has three faces —
 * merged, open as a pull request, on a branch and why — and ONE control,
 * Remove copy, drawn only while a copy is actually still on disk. The
 * "Bring the work home" button and its copied git commands are gone (the
 * owner's word, 2026-10-12), so no face posts anything.
 *
 * The real English strings are used throughout, so a missing key fails here
 * rather than on the owner's screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunWorktreeCard, { worktreeCardApplies, type RunWorktreeView } from "@/components/CodingRunWorktreeCard";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const RUN_ID = "run-k3x9q2ab";
const WORKTREE: RunWorktreeView = {
  path: "/home/clawbox/Projects/site/.clawbox/worktrees/run-k3x9q2ab",
  branch: "clawbox/run-k3x9q2ab",
  base: "main",
  project: "/home/clawbox/Projects/site",
  removed: true,
  branchRemoved: false,
  result: null,
};

let fetchSpy: ReturnType<typeof vi.fn>;
let onRemove: () => void;

function draw(worktree: Partial<RunWorktreeView>, pullRequestOpen = false) {
  return render(
    <CodingRunWorktreeCard
      runId={RUN_ID}
      worktree={{ ...WORKTREE, ...worktree }}
      pullRequestOpen={pullRequestOpen}
      onRemove={onRemove}
    />,
  );
}

beforeEach(() => {
  onRemove = vi.fn();
  fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a run whose work is on its branch and not in the project", () => {
  it.each([
    ["dirty", "codingAgent.worktreeUnmergedDirty"],
    ["not_on_base", "codingAgent.worktreeUnmergedNotOnBase"],
    ["conflict", "codingAgent.worktreeUnmergedConflict"],
    ["failed", "codingAgent.worktreeUnmergedFailed"],
  ] as const)("says the branch and why (%s) in one line, with nothing to press", (reason, key) => {
    draw({ result: { kind: "unmerged", reason, detail: "the box's own words" } });
    const card = screen.getByTestId("coding-agent-run-worktree");
    expect(card.getAttribute("data-state")).toBe(reason);
    expect(card.textContent).toContain(t(key, { branch: WORKTREE.branch, base: WORKTREE.base }));
    // The branch is named in full, so a person can reach the work by hand.
    expect(card.textContent).toContain("clawbox/run-k3x9q2ab");
    // The copy is gone with the settle: no Remove, no bring-home, no commands.
    expect(screen.queryByRole("button")).toBeNull();
    expect(card.textContent).not.toContain(t("codingAgent.worktreeOnDisk"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the plain sentence for a record written before the box kept a verdict", () => {
    draw({ result: null });
    const card = screen.getByTestId("coding-agent-run-worktree");
    expect(card.getAttribute("data-state")).toBe("unknown");
    expect(card.textContent).toContain(t("codingAgent.worktreeOnBranch", { branch: WORKTREE.branch }));
  });

  it("offers Remove copy only while the copy is still on disk, and says so", () => {
    draw({ removed: false, result: { kind: "unmerged", reason: "dirty", detail: "x" } });
    const card = screen.getByTestId("coding-agent-run-worktree");
    expect(card.textContent).toContain(t("codingAgent.worktreeOnDisk"));
    fireEvent.click(screen.getByTestId(`coding-agent-worktree-remove-${RUN_ID}`));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe("a run whose work IS in the project", () => {
  it("says where it went, with the commit", () => {
    draw({ removed: false, result: { kind: "merged", reason: null, detail: null, base: "main", commit: "9f1c0ab3d4e5f60718293a4b5c6d7e8f90a1b2c3" } });
    const card = screen.getByTestId("coding-agent-run-worktree");
    expect(card.getAttribute("data-state")).toBe("merged");
    expect(card.textContent).toContain(t("codingAgent.worktreeMergedInto", { base: "main" }));
    // The commit, short enough to recognise and long enough to find.
    expect(card.textContent).toContain("9f1c0ab");
    fireEvent.click(screen.getByTestId(`coding-agent-worktree-remove-${RUN_ID}`));
    expect(onRemove).toHaveBeenCalled();
  });

  it("names the pull request's branch and nothing more", () => {
    draw({ result: null }, true);
    const card = screen.getByTestId("coding-agent-run-worktree");
    expect(card.getAttribute("data-state")).toBe("pull_request");
    expect(card.textContent).toContain(t("codingAgent.worktreeKept", { branch: WORKTREE.branch }));
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("whether the line is drawn at all", () => {
  it("is drawn for any copy still on disk, and for unmerged work whose copy is gone", () => {
    expect(worktreeCardApplies({ ...WORKTREE, removed: false }, false)).toBe(true);
    expect(worktreeCardApplies({ ...WORKTREE, removed: false, result: { kind: "merged" } }, false)).toBe(true);
    expect(worktreeCardApplies({ ...WORKTREE, result: { kind: "unmerged", reason: "dirty" } }, false)).toBe(true);
    expect(worktreeCardApplies({ ...WORKTREE, result: null }, false)).toBe(true);
  });

  it("is NOT drawn once the work is home, or a pull request owns it, or there was never any", () => {
    // The timeline says "merged into main" and the PR chip names the request;
    // a third line saying the same thing is what this pass removed.
    expect(worktreeCardApplies({ ...WORKTREE, result: { kind: "merged", base: "main" } }, false)).toBe(false);
    expect(worktreeCardApplies({ ...WORKTREE, result: null }, true)).toBe(false);
    expect(worktreeCardApplies({ ...WORKTREE, branchRemoved: true }, false)).toBe(false);
  });
});
