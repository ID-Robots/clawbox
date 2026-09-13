/**
 * The run card's worktree block (src/components/CodingRunWorktreeCard.tsx):
 * where a settled run's work actually IS, and what the owner can do about it.
 *
 * The card used to have one face — "its work is on the branch, remove the
 * copy?" — over three completely different situations, the commonest of which
 * (the project folder has uncommitted changes of the owner's own) is a dead
 * end nothing on the device could clear. Each state below is one of those
 * situations, and the test for it is that the screen says which one it is and
 * offers a move.
 *
 * The real English strings are used throughout, so a missing key fails here
 * rather than on the owner's screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingRunWorktreeCard, { mergeByHandCommands, type RunWorktreeView } from "@/components/CodingRunWorktreeCard";

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
  removed: false,
  branchRemoved: false,
  result: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let posts: unknown[];
let onRemove: () => void;
let onChanged: () => void;

function draw(worktree: Partial<RunWorktreeView>, pullRequestOpen = false) {
  return render(
    <CodingRunWorktreeCard
      runId={RUN_ID}
      worktree={{ ...WORKTREE, ...worktree }}
      pullRequestOpen={pullRequestOpen}
      onRemove={onRemove}
      onChanged={onChanged}
    />,
  );
}

beforeEach(() => {
  posts = [];
  onRemove = vi.fn();
  onChanged = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    posts.push({ url: input.toString(), body: JSON.parse(String(init?.body ?? "null")) });
    return json({ merged: true, base: "main", commit: "9f1c0ab3d4e5f60718293a4b5c6d7e8f90a1b2c3" });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a run whose work is not in the project", () => {
  it.each([
    ["dirty", "codingAgent.bringHomeDirty"],
    ["not_on_base", "codingAgent.bringHomeNotOnBase"],
    ["conflict", "codingAgent.bringHomeConflict"],
    ["failed", "codingAgent.bringHomeFailed"],
  ] as const)("says what stood in the way (%s) and what clears it", (reason, key) => {
    draw({ result: { kind: "unmerged", reason, detail: "the box's own words" } });
    const card = screen.getByTestId("coding-agent-run-worktree");
    expect(card.getAttribute("data-state")).toBe(reason);
    expect(card.textContent).toContain(t(key, { branch: WORKTREE.branch, base: WORKTREE.base }));
    // The branch is named in full, so a person can reach the work by hand.
    expect(card.textContent).toContain("clawbox/run-k3x9q2ab");
    // And Remove copy is never the only thing offered over unmerged work.
    expect(screen.getByTestId(`coding-agent-bring-home-${RUN_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`coding-agent-worktree-remove-${RUN_ID}`)).toBeInTheDocument();
  });

  it("falls back to the general sentence for a record written before the box kept a verdict", () => {
    draw({ result: null });
    const card = screen.getByTestId("coding-agent-run-worktree");
    expect(card.getAttribute("data-state")).toBe("unknown");
    expect(card.textContent).toContain(t("codingAgent.bringHomeUnknown", { branch: WORKTREE.branch }));
    expect(screen.getByTestId(`coding-agent-bring-home-${RUN_ID}`)).toBeInTheDocument();
  });

  it("brings the work home and tells the host to re-read the run", async () => {
    draw({ result: { kind: "unmerged", reason: "dirty", detail: "x" } });
    fireEvent.click(screen.getByTestId(`coding-agent-bring-home-${RUN_ID}`));
    await waitFor(() => {
      expect(posts).toEqual([{ url: "/setup-api/coding-agent/merge", body: { runId: RUN_ID } }]);
      expect(onChanged).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("coding-agent-bring-home-error")).toBeNull();
  });

  it("says the attempt did not land when the blocker is still there, and re-reads so the sentence follows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(
      { error: "Could not bring the work home: the project folder has uncommitted changes of its own.", kind: "unmerged", code: "dirty" },
      409,
    )));
    draw({ result: { kind: "unmerged", reason: "dirty", detail: "x" } });
    fireEvent.click(screen.getByTestId(`coding-agent-bring-home-${RUN_ID}`));
    // The box's English sentence is NOT what the owner reads: the card's own
    // catalogue line is, and the reason above it has just been re-read.
    const line = await screen.findByTestId("coding-agent-bring-home-error");
    expect(line.textContent).toBe(t("codingAgent.bringHomeError"));
    await waitFor(() => { expect(onChanged).toHaveBeenCalled(); });
  });

  it("shows the box's own words for a refusal no catalogue line covers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(
      { error: "Bringing a run's work into the project needs a signed-in browser session.", kind: "owner_only", code: "owner_only" },
      403,
    )));
    draw({ result: { kind: "unmerged", reason: "conflict", detail: "x" } });
    fireEvent.click(screen.getByTestId(`coding-agent-bring-home-${RUN_ID}`));
    const line = await screen.findByTestId("coding-agent-bring-home-error");
    expect(line.textContent).toContain("signed-in browser session");
  });

  it("copies the commands that do the same merge by hand", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    draw({ result: { kind: "unmerged", reason: "conflict", detail: "x" } });
    fireEvent.click(screen.getByTestId(`coding-agent-bring-home-copy-${RUN_ID}`));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(mergeByHandCommands(WORKTREE));
    });
    expect(await screen.findByText(t("codingAgent.bringHomeCopied"))).toBeInTheDocument();
    // The commands name the project, the base branch and the run's branch —
    // nothing a person has to look up somewhere else.
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toContain(WORKTREE.project);
    expect(copied).toContain("git checkout main");
    expect(copied).toContain("git merge clawbox/run-k3x9q2ab");
  });
});

describe("the commands the card copies", () => {
  it("leaves a plain path plain, so the owner can read what they are about to run", () => {
    expect(mergeByHandCommands({ project: "/home/clawbox/Projects/site", base: "main", branch: "clawbox/run-k3x9q2ab" }))
      .toBe("cd /home/clawbox/Projects/site\ngit checkout main\ngit merge clawbox/run-k3x9q2ab");
  });

  it("quotes a folder the owner named with a space, so `cd` reaches one folder and not two", () => {
    expect(mergeByHandCommands({ project: "/home/clawbox/My Projects/the site", base: "main", branch: "clawbox/run-1" }))
      .toContain("cd '/home/clawbox/My Projects/the site'");
  });

  it("closes, escapes and reopens the one character single quotes cannot hold", () => {
    // Nothing this box copies to a clipboard may turn a folder NAME into shell
    // syntax: everything after the path has to stay an argument.
    const out = mergeByHandCommands({ project: "/home/clawbox/it's mine; touch /tmp/pwned", base: "main", branch: "clawbox/run-1" });
    expect(out.split("\n")[0]).toBe("cd '/home/clawbox/it'\\''s mine; touch /tmp/pwned'");
  });

  it("quotes a branch name with a space in it too", () => {
    const out = mergeByHandCommands({ project: "/p", base: "my branch", branch: "clawbox/run 1" });
    expect(out).toContain("git checkout 'my branch'");
    expect(out).toContain("git merge 'clawbox/run 1'");
  });
});

describe("a run whose work IS in the project", () => {
  it("says where it went, and offers only the copy", () => {
    draw({ result: { kind: "merged", reason: null, detail: null, base: "main", commit: "9f1c0ab3d4e5f60718293a4b5c6d7e8f90a1b2c3" } });
    const card = screen.getByTestId("coding-agent-run-worktree");
    expect(card.getAttribute("data-state")).toBe("merged");
    expect(card.textContent).toContain(t("codingAgent.worktreeMergedInto", { base: "main" }));
    // The commit, short enough to recognise and long enough to find.
    expect(card.textContent).toContain("9f1c0ab");
    expect(screen.queryByTestId(`coding-agent-bring-home-${RUN_ID}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`coding-agent-worktree-remove-${RUN_ID}`));
    expect(onRemove).toHaveBeenCalled();
  });

  it("leaves a branch a pull request owns alone", () => {
    // Merging locally would take the commits away from the request they are
    // open as, so this face offers no bring-home at all.
    draw({ result: null }, true);
    const card = screen.getByTestId("coding-agent-run-worktree");
    expect(card.getAttribute("data-state")).toBe("pull_request");
    expect(card.textContent).toContain(t("codingAgent.worktreeKept", { branch: WORKTREE.branch }));
    expect(screen.queryByTestId(`coding-agent-bring-home-${RUN_ID}`)).toBeNull();
    expect(screen.getByTestId(`coding-agent-worktree-remove-${RUN_ID}`)).toBeInTheDocument();
  });
});
