"use client";

import { useT } from "@/lib/i18n";
import { BTN_SECONDARY } from "./coding-agent-ui";
import type { MergeHomeBlocker } from "@/lib/coding-run-worktree";

/**
 * WHERE A SETTLED RUN'S WORK IS — one line, and Remove copy only while there
 * is a copy to remove.
 *
 * A run works in a git worktree of its own and the settle merges that branch
 * back into the project, conservatively: never over uncommitted changes of the
 * owner's own, never onto a project that has been moved to another branch,
 * never through a conflict. The files then go either way (the branch keeps
 * the work, and a resume puts the tree back from it); what the owner needs
 * from this line is one fact — merged, open as a pull request, or on a branch
 * and why — not a paragraph and a button per blocker. The "Bring the work
 * home" button and the copied git commands that used to sit here were
 * removed at the owner's word (2026-10-12); the tinted card around the line
 * went with the run page's one column (2026-10-30) — it is a row of the
 * run's **What changed** block now.
 */

/** The record, as the run listing carries it. */
export interface RunWorktreeView {
  path: string;
  branch: string;
  base: string;
  project: string;
  removed: boolean;
  branchRemoved?: boolean;
  /** What became of the work. Absent on every record written before the box kept it. */
  result?: {
    kind: "merged" | "unmerged";
    reason?: MergeHomeBlocker | null;
    detail?: string | null;
    base?: string | null;
    commit?: string | null;
  } | null;
}

/** One short sentence per blocker: the branch the work is on, and why it is not in the project. */
const REASON_KEY: Record<MergeHomeBlocker, string> = {
  dirty: "codingAgent.worktreeUnmergedDirty",
  not_on_base: "codingAgent.worktreeUnmergedNotOnBase",
  conflict: "codingAgent.worktreeUnmergedConflict",
  failed: "codingAgent.worktreeUnmergedFailed",
  stopped: "codingAgent.worktreeUnmergedStopped",
};

/** Enough of a sha to recognise the commit by, which is all the line claims. */
function shortSha(sha: string): string {
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/**
 * Whether the line has anything to say for this record: a copy still on disk
 * (Remove copy), or work that is on a branch and not in the project. A merged
 * run whose copy is gone, or a pull request's branch whose copy is gone, has
 * nothing left to tell — the timeline and the PR chip already said it.
 */
export function worktreeCardApplies(worktree: RunWorktreeView, pullRequestOpen: boolean): boolean {
  if (!worktree.removed) return true;
  return worktree.result?.kind !== "merged" && !pullRequestOpen && !worktree.branchRemoved;
}

export default function CodingRunWorktreeCard({
  runId,
  worktree,
  pullRequestOpen = false,
  busy = false,
  onRemove,
}: {
  runId: string;
  worktree: RunWorktreeView;
  /** A pull request owns the branch — its work goes home that way, not through a local merge. */
  pullRequestOpen?: boolean;
  /** The host is already acting on this run; every control here is held with it. */
  busy?: boolean;
  /** Remove copy — the host's own lifecycle call, unchanged. */
  onRemove: () => void;
}) {
  const { t } = useT();
  const result = worktree.result ?? null;
  const merged = result?.kind === "merged";
  // Unmerged is the DEFAULT, not a claim: a record written before the box kept
  // a verdict has work on a branch that nothing says is in the project.
  const unmerged = !merged && !pullRequestOpen;
  const onDisk = !worktree.removed;

  const sentence = merged
    ? t("codingAgent.worktreeMergedInto", { base: result?.base ?? worktree.base })
    : pullRequestOpen
      ? t("codingAgent.worktreeKept", { branch: worktree.branch })
      : t(result?.reason ? REASON_KEY[result.reason] : "codingAgent.worktreeOnBranch", {
        branch: worktree.branch,
        base: worktree.base,
      });

  return (
    <div
      className="flex items-center gap-2 flex-wrap py-1"
      data-testid="coding-agent-run-worktree"
      data-state={merged ? "merged" : pullRequestOpen ? "pull_request" : result?.reason ?? "unknown"}
      data-on-disk={onDisk || undefined}
    >
      <span
        className={`material-symbols-rounded shrink-0 ${unmerged ? "text-amber-400" : "text-[var(--text-muted)]"}`}
        style={{ fontSize: 16 }}
        aria-hidden="true"
      >
        account_tree
      </span>
      <p className="text-[11px] text-[var(--text-secondary)] break-words flex-1 min-w-[12rem]">
        {sentence}
        {merged && result?.commit && (
          <>
            {" "}
            <code className="font-mono text-[10px] text-[var(--text-muted)]">{shortSha(result.commit)}</code>
          </>
        )}
        {onDisk && <> {t("codingAgent.worktreeOnDisk")}</>}
      </p>
      {onDisk && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          data-testid={`coding-agent-worktree-remove-${runId}`}
          className={`${BTN_SECONDARY} ml-auto`}
        >
          {t("codingAgent.worktreeRemove")}
        </button>
      )}
    </div>
  );
}
