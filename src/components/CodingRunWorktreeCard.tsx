"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { copyToClipboard } from "@/lib/clipboard";
import { BTN_PRIMARY, BTN_SECONDARY } from "./coding-agent-ui";
import type { MergeHomeBlocker } from "@/lib/coding-run-worktree";

/**
 * A settled run's own copy of the project, and — the point of this card —
 * WHERE ITS WORK IS.
 *
 * A run works in a git worktree of its own and the settle merges that branch
 * back into the project, conservatively: never over uncommitted changes of the
 * owner's own, never onto a project that has been moved to another branch,
 * never through a conflict. Every one of those refusals used to leave the same
 * screen behind — a run saying "Finished", its work reachable only as
 * `clawbox/<runId>`, and ONE button, which deleted the copy. On a box whose
 * owner keeps any uncommitted change in a project folder that is every run.
 *
 * So the card has three faces, and no face is a dead end:
 *
 *   - MERGED: the work is in the project, and the sentence says which branch
 *     and which commit. Only the copy is left to remove.
 *   - A PULL REQUEST owns the branch: the work is going home that way, and
 *     merging locally would take the commits away from the request they are
 *     open as. The old sentence, unchanged.
 *   - UNMERGED: one plain sentence naming the blocker and the move that
 *     clears it, the branch in full, **Bring the work home**, and the git
 *     commands to do it by hand for an owner who would rather.
 *
 * Remove copy stays exactly as it was on all three — but it is never the only
 * thing offered over work that is not in the project.
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

/** One sentence per blocker: what stood in the way, and what clears it. */
const REASON_KEY: Record<MergeHomeBlocker, string> = {
  dirty: "codingAgent.bringHomeDirty",
  not_on_base: "codingAgent.bringHomeNotOnBase",
  conflict: "codingAgent.bringHomeConflict",
  failed: "codingAgent.bringHomeFailed",
};

/** Enough of a sha to recognise the commit by, which is all the card claims. */
function shortSha(sha: string): string {
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/**
 * One argument of a shell command, safe to paste.
 *
 * The plain word is left plain — these commands are READ by the owner before
 * they are run, and `git checkout 'main'` reads worse than `git checkout main`
 * for no gain. Anything else is single-quoted, which makes every character
 * literal to the shell, with the one sequence single quotes cannot hold
 * (`'`) closed, escaped and reopened. A project folder is named by the owner
 * and may perfectly well be `~/My Projects/the site`; nothing this box copies
 * to a clipboard may turn a folder name into shell syntax.
 */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The same merge, by hand. Deliberately the commands and not a diff: the
 * clipboard is where a person takes a thing to run, and a run's diff can be
 * megabytes.
 */
export function mergeByHandCommands(wt: { project: string; base: string; branch: string }): string {
  return [
    `cd ${shellArg(wt.project)}`,
    `git checkout ${shellArg(wt.base)}`,
    `git merge ${shellArg(wt.branch)}`,
  ].join("\n");
}

export default function CodingRunWorktreeCard({
  runId,
  worktree,
  pullRequestOpen = false,
  busy = false,
  onRemove,
  onChanged,
}: {
  runId: string;
  worktree: RunWorktreeView;
  /** A pull request owns the branch — its work goes home that way, not through a local merge. */
  pullRequestOpen?: boolean;
  /** The host is already acting on this run; every control here is held with it. */
  busy?: boolean;
  /** Remove copy — the host's own lifecycle call, unchanged. */
  onRemove: () => void;
  /** The record moved. The host re-reads the run so the card redraws from the box. */
  onChanged: () => void;
}) {
  const { t } = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const result = worktree.result ?? null;
  const merged = result?.kind === "merged";
  // Unmerged is the DEFAULT, not a claim: a record written before the box kept
  // a verdict, or one whose verdict this build does not recognise, has work on
  // a branch that nothing says is in the project. The one thing that must not
  // happen is offering to bring home work that is already home.
  const unmerged = !merged && !pullRequestOpen;

  const bringHome = async () => {
    if (working || busy) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      if (!res.ok) {
        // A blocker still in place is not an unexplained failure: the record
        // has just been updated with it, so the sentence above re-words itself
        // and this line only has to say the attempt did not land. Anything
        // else — a refused session, a device fault — is said in the box's own
        // words, because no catalogue entry covers it.
        const body = await res.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
        const known = typeof body?.code === "string" && body.code in REASON_KEY;
        setError(known || typeof body?.error !== "string" ? t("codingAgent.bringHomeError") : body.error);
        return;
      }
    } catch {
      setError(t("codingAgent.bringHomeError"));
      return;
    } finally {
      setWorking(false);
      onChanged();
    }
  };

  const copy = async () => {
    if (!(await copyToClipboard(mergeByHandCommands(worktree)))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  const sentence = merged
    ? t("codingAgent.worktreeMergedInto", { base: result?.base ?? worktree.base })
    : pullRequestOpen
      ? t("codingAgent.worktreeKept", { branch: worktree.branch })
      : t(result?.reason ? REASON_KEY[result.reason] : "codingAgent.bringHomeUnknown", {
        branch: worktree.branch,
        base: worktree.base,
      });

  return (
    <div
      className={`mt-3 rounded-xl px-4 py-2.5 border ${unmerged
        ? "bg-amber-500/[0.05] border-amber-500/30"
        : "bg-white/[0.03] border-[var(--border-subtle)]"}`}
      data-testid="coding-agent-run-worktree"
      data-state={merged ? "merged" : pullRequestOpen ? "pull_request" : result?.reason ?? "unknown"}
    >
      <div className="flex items-start gap-2 flex-wrap">
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
        </p>
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {unmerged && (
          <>
            <button
              type="button"
              onClick={bringHome}
              disabled={busy || working}
              data-testid={`coding-agent-bring-home-${runId}`}
              className={BTN_PRIMARY}
            >
              {working ? t("codingAgent.bringHomeWorking") : t("codingAgent.bringHome")}
            </button>
            <button
              type="button"
              onClick={copy}
              data-testid={`coding-agent-bring-home-copy-${runId}`}
              className={BTN_SECONDARY}
            >
              {copied ? t("codingAgent.bringHomeCopied") : t("codingAgent.bringHomeCopy")}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={busy || working}
          data-testid={`coding-agent-worktree-remove-${runId}`}
          className={`${BTN_SECONDARY} ml-auto`}
        >
          {t("codingAgent.worktreeRemove")}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-[11px] text-red-300 break-words" data-testid="coding-agent-bring-home-error">{error}</p>
      )}
    </div>
  );
}
