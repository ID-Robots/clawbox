"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import { useBuildIdentity } from "@/components/BuildIdentityPanel";
import {
  describeUpdateFailure,
  shownStepStatus,
  stepFailureReason,
  UpdateStepCount,
  UpdateStepList,
  UpdateStepMeter,
} from "@/components/UpdateStep";
import UpdateWhatsNewPanel from "@/components/UpdateWhatsNewPanel";
import type { RemoteReachability, UpdatePhase, UpdateState } from "@/lib/updater";
import { INTERRUPTED_MESSAGE_PREFIX, RESTART_STEP_ID } from "@/lib/update-constants";
import { isNamedChannel, updateWhatsNewPanel } from "@/lib/update-whats-new";
import { useUpdateWhatsNew } from "@/lib/use-update-whats-new";
import { DRIFT_RESOLVED_CODE } from "@/lib/drift-codes";
import { cleanVersion } from "@/lib/version-utils";
import {
  HARNESS_DOWNGRADE_BACKUP_FAILED_CODE,
  HARNESS_DOWNGRADE_CODE,
  HARNESS_DOWNGRADE_OVERRIDE_FLAG,
  HARNESS_LABEL,
  readHarnessDowngradeDetail,
  type HarnessDowngradeDetail,
} from "@/lib/harness-downgrade";

export interface ComponentVersion {
  current: string | null;
  target: string | null;
  /**
   * `null` where the device could not look — see `remote` below. It resolves
   * through `componentNeedsUpdate`, which falls back to the version comparison
   * for both null and absent, so nothing here changes behaviour on its own:
   * `remote.reachable === false` is what the screen renders the unknown from.
   */
  updateAvailable?: boolean | null;
}

export interface VersionInfo {
  clawbox: ComponentVersion & { current: string };
  openclaw: ComponentVersion;
  // Both optional: a device that has not been updated yet still answers
  // /update/versions with the old two-key shape, and the Hermes block is
  // present only on the SKUs that ship Hermes.
  hermes?: ComponentVersion;
  edition?: "openclaw" | "hermes" | "dual";
  /**
   * Whether the device actually reached its update remote — the producer's own
   * type, so a field added there (`cause`) cannot be missed here. Optional for
   * the same reason as the two above: a payload from a server that predates the
   * field must keep rendering exactly as it did, so ABSENT means "not known",
   * never "unreachable".
   */
  remote?: RemoteReachability;
}

/**
 * Whether an OpenClaw row is about software this device has. The `hermes` SKU
 * ships none; `dual` has one even while Hermes is the harness answering. A
 * payload from a server that predates the `edition` field reads as OpenClaw,
 * which is what those builds were.
 */
export function shipsOpenclaw(versions: VersionInfo | null): boolean {
  return versions?.edition !== "hermes";
}

/** How the effective branch was decided — `EffectiveUpdateBranch` in src/lib/updater.ts. */
type EffectiveBranchSource = "pin-file" | "checkout-branch" | "detached-recovered" | "default" | "unresolved";

interface EffectiveBranch {
  branch: string;
  source: EffectiveBranchSource;
}

interface BranchInfo {
  /** What `.update-branch` records, or null when nothing is. */
  branch: string | null;
  /** The branch updates actually follow. Absent from older servers. */
  effective?: EffectiveBranch | null;
}

/**
 * One whole sentence per source, so a translator can place `{branch}` where
 * their language wants it. "Nothing is recorded" is said wherever it is true:
 * it is the fact an owner asking "which branch do I enter?" needs.
 */
function effectiveBranchText(
  source: EffectiveBranchSource,
  tr: (key: string, english: string) => string,
): string {
  switch (source) {
    case "pin-file":
      return tr("update.effectiveBranchPinned", "Updates follow {branch}, the branch recorded on this box.");
    case "checkout-branch":
      return tr(
        "update.effectiveBranchCheckout",
        "Updates follow {branch}, the branch this box is checked out on. No branch is recorded.",
      );
    case "detached-recovered":
      return tr(
        "update.effectiveBranchRecovered",
        "Updates follow {branch}, worked out from this box's own build. No branch is recorded.",
      );
    case "unresolved":
      // The check looks at main; the update itself refuses to guess a channel
      // for a box that is not on a branch, and says so when it is started.
      return tr(
        "update.effectiveBranchUnresolved",
        "Checking against {branch}, the release channel. This box is not on a branch and records none, so enter a branch here before updating.",
      );
    default:
      return tr(
        "update.effectiveBranchDefault",
        "Updates follow {branch}, the release channel. No branch is recorded on this box.",
      );
  }
}

function readEffectiveBranch(value: unknown): EffectiveBranch | null {
  const v = value as Partial<EffectiveBranch> | null | undefined;
  if (!v || typeof v.branch !== "string" || !v.branch) return null;
  const source: EffectiveBranchSource =
    v.source === "pin-file" || v.source === "checkout-branch" || v.source === "detached-recovered"
      || v.source === "unresolved"
      ? v.source
      : "default";
  return { branch: v.branch, source };
}

const CARD = "rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-deep)]/70 p-5";

/**
 * A translated sentence with one or more rendered elements inside it.
 *
 * The elements are placeholders in the string (`{beta}`, `{reboot}`) rather
 * than markup in the catalogue: a translator gets one whole sentence and can
 * put the `<code>` chip or the emphasis where their language wants it, which
 * splitting the sentence into fragments around the JSX would not allow.
 */
function Interpolated({ text, slots }: { text: string; slots: Record<string, ReactNode> }) {
  return (
    <>
      {text.split(/(\{[a-zA-Z]+\})/g).map((part, i) => {
        const name = part.match(/^\{([a-zA-Z]+)\}$/)?.[1];
        const slot = name ? slots[name] : undefined;
        return <span key={i}>{slot ?? part}</span>;
      })}
    </>
  );
}

function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  // Split on both "." and "-" so a re-release suffix like "2026.5.3-1" parses
  // as [2026,5,3,1] (greater than [2026,5,3]) rather than [2026,5,NaN→0]
  // (which would mistakenly read as older). Non-numeric segments still fall
  // through to 0 via `Number(...) || 0`.
  const parse = (v: string) => (cleanVersion(v) ?? v).replace(/^v/, "").split(/[.-]/).map((n) => Number(n) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

function isUpdateAvailable(current: string | null | undefined, target: string | null | undefined): boolean {
  if (!current || !target) return false;
  return compareSemver(target, current) > 0;
}

export function componentNeedsUpdate(component: { current: string | null; target: string | null; updateAvailable?: boolean | null }): boolean {
  return component.updateAvailable ?? isUpdateAvailable(component.current, component.target);
}

type Status = "loading" | "up-to-date" | "available" | "drift" | "updating" | "completed" | "failed" | "fetch-error";

/**
 * `embedded`: drawn inside another pane — Settings → System Update — which
 * brings its own padding and width, so the app skips its window chrome (the
 * full-height centring) and just lays its cards out. The desktop window and
 * the standalone page keep the default.
 *
 * Embedded, the hero's headline is an `h2`: the pane around it already owns the
 * window's `h1`, and two of those would have the document claim two titles.
 */
export default function SystemUpdateApp({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useT();
  const tr = useTr();
  const HeroHeading = embedded ? "h2" : "h1";
  // Settings embeds this app while the desktop can have the standalone window
  // open beside it, so the label's id has to be per-instance or the second
  // toggle would borrow the first one's name.
  const betaLabelId = useId();
  const branchInputId = useId();
  const [versions, setVersions] = useState<VersionInfo | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateStarted, setUpdateStarted] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [effectiveBranch, setEffectiveBranch] = useState<EffectiveBranch | null>(null);
  const [branchInput, setBranchInput] = useState("");
  const [branchSaving, setBranchSaving] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  // A branch the server refused because following it would install an older
  // harness than the one that wrote this box's data (src/lib/harness-downgrade.ts).
  const [branchDowngrade, setBranchDowngrade] = useState<{ branch: string | null; detail: HarnessDowngradeDetail } | null>(null);
  const [betaConfirm, setBetaConfirm] = useState(false);
  const [forceConfirm, setForceConfirm] = useState(false);

  // Fetched once on mount, from the same endpoint the About screen uses, so
  // the two surfaces cannot disagree about whether this box is running its own
  // code. Not polled: it shells out to git and only changes when the box
  // rebuilds.
  const identity = useBuildIdentity(true);
  const driftDetected = !!identity?.drift?.detected;

  const pollRef = useRef<number | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollControllerRef.current) {
      pollControllerRef.current.abort();
      pollControllerRef.current = null;
    }
  }, []);

  const fetchVersions = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      // `force=1` invalidates the route's 60s in-process cache so the user
      // gets a fresh git ls-remote + npm view on open and on every explicit
      // "Check for updates" click. Without it, a stale "Up to date" can
      // linger for a minute after origin publishes a new tag.
      const url = force ? "/setup-api/update/versions?force=1" : "/setup-api/update/versions";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as VersionInfo;
      setVersions(data);
      setVersionsError(null);
    } catch (e) {
      setVersionsError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const fetchBranch = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/system/update-branch", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as BranchInfo;
      setBranch(data.branch);
      setEffectiveBranch(readEffectiveBranch(data.effective));
      setBranchInput(data.branch ?? "");
    } catch {
      /* leave defaults */
    }
  }, []);

  useEffect(() => {
    void fetchVersions(true);
    void fetchBranch();
  }, [fetchVersions, fetchBranch]);

  // If an update is already running when the user opens this app (it was
  // kicked off from Settings, the wizard, or a prior session), immediately
  // join the poll so the live progress shows.
  //
  // A run that already FAILED is adopted the same way. It used to be ignored,
  // and the failure of 2026-09-05 is what that costs: the restart step is the
  // one that failed, so nobody was watching this page when it did, and every
  // window opened afterwards showed "1 update available — Update everything"
  // over an update that had died an hour earlier. `completed` is deliberately
  // NOT adopted — the status route synthesises that phase for any box whose
  // `update_completed` flag is set and has nothing to do, so adopting it would
  // paint "Update complete" on a device that has just been sitting there.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/setup-api/update/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as UpdateState;
        if (cancelled) return;
        if (data.phase === "running") {
          setUpdateStarted(true);
          setUpdateState(data);
          startPolling();
        } else if (data.phase === "failed") {
          setUpdateStarted(true);
          setUpdateState(data);
        }
      } catch { /* idle */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current !== null) return;
    const controller = new AbortController();
    pollControllerRef.current = controller;
    let serverWentDown = false;
    let failures = 0;
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch("/setup-api/update/status", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          failures++;
          if (failures >= 3) serverWentDown = true;
          return;
        }
        if (serverWentDown) {
          window.location.reload();
          return;
        }
        failures = 0;
        const data = (await res.json()) as UpdateState;
        if (controller.signal.aborted) return;
        setUpdateState(data);
        if (data.phase !== "running") {
          stopPolling();
          if (data.phase === "completed") {
            // Re-fetch versions so the dashboard reflects the new ones.
            // Force a fresh lookup — the install just bumped current and
            // we want the new state visible immediately, not after the
            // 60s server cache expires.
            void fetchVersions(true);
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        failures++;
        if (failures >= 3) serverWentDown = true;
      }
    }, 2000);
  }, [stopPolling, fetchVersions]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // Only the "full" ClawBox update path is exposed from the UI now —
  // OpenClaw is pinned by ClawBox (config/openclaw-target.txt) and rides
  // along inside the full update. The "openclaw" mode remains as a
  // server-side endpoint for SSH/MCP/admin triggers but no UI button
  // reaches it, so the type stays narrow to reflect actual call sites.
  //
  // `allowDowngrade` is the owner's "Back up and update anyway", offered only on
  // a run the server refused for installing an older harness.
  const triggerUpdate = useCallback(async (allowDowngrade = false) => {
    setUpdateStarted(true);
    setUpdateError(null);
    setUpdateState(null);
    try {
      const res = await fetch("/setup-api/update/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `=== true`: a handler that passes its click event must never be the override.
        body: JSON.stringify(allowDowngrade === true ? { force: true, [HARNESS_DOWNGRADE_OVERRIDE_FLAG]: true } : { force: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUpdateError(typeof data.error === "string"
          ? data.error
          : tr("update.startFailedHttp", "Failed to start update (HTTP {status})", { status: res.status }));
        return;
      }
      startPolling();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : tr("update.startFailed", "Failed to start update"));
    }
  }, [startPolling, tr]);

  const dismissResult = useCallback(() => {
    setUpdateStarted(false);
    setUpdateError(null);
    setUpdateState(null);
    stopPolling();
    // The settled run lives in the web server's memory, not in this component,
    // so clearing local state alone would hide the panel until the next mount
    // re-adopted the same dead run.
    //
    // A 409 is not an error to show — it means another surface (Settings, the
    // wizard, the MCP tools) started an update between the click and the POST,
    // and the state this button was clearing now belongs to that run. `fetch`
    // resolves for a 409, so ignoring the answer left the screen showing "1
    // update available — Update everything" over an update that was already
    // running, and a second Update from here is exactly what the run route
    // refuses. Read the status back and rejoin the live run instead.
    void (async () => {
      try {
        const res = await fetch("/setup-api/update/dismiss", { method: "POST" });
        if (res.ok) return;
        // Anything OTHER than a 409 is the server saying the result is still
        // there — the record could not be written away. The panel has already
        // been cleared locally, so leaving it at that hides a dismissal that
        // did not happen and hands the same failure back on the next reload,
        // with nothing said. Put it back and say why.
        if (res.status !== 409) {
          setUpdateStarted(true);
          setUpdateError(tr("update.dismissFailed", "The device could not clear that result. Try again in a moment."));
          return;
        }
        const status = await fetch("/setup-api/update/status", { cache: "no-store" });
        if (!status.ok) return;
        const data = (await status.json()) as UpdateState;
        if (data.phase !== "running") return;
        setUpdateStarted(true);
        setUpdateState(data);
        startPolling();
      } catch { /* offline: the next mount adopts whatever is running */ }
    })();
  }, [stopPolling, startPolling, tr]);

  const saveBranch = useCallback(async (next: string | null, allowDowngrade = false) => {
    setBranchSaving(true);
    setBranchError(null);
    setBranchDowngrade(null);
    try {
      const res = await fetch("/setup-api/system/update-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(allowDowngrade === true ? { branch: next, [HARNESS_DOWNGRADE_OVERRIDE_FLAG]: true } : { branch: next }),
      });
      const data = await res.json().catch(() => ({}));
      const downgrade = res.status === 409 && data.code === HARNESS_DOWNGRADE_CODE
        ? readHarnessDowngradeDetail(data.downgrade)
        : null;
      if (downgrade) {
        // Said in the owner's language from the detail, with the override
        // beside it; the branch on record is unchanged.
        setBranchDowngrade({ branch: next, detail: downgrade });
        return;
      }
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
      setBranch(typeof data.branch === "string" ? data.branch : null);
      setEffectiveBranch(readEffectiveBranch(data.effective));
      setBranchInput(typeof data.branch === "string" ? data.branch : "");
    } catch (e) {
      setBranchError((e as Error).message);
    } finally {
      setBranchSaving(false);
    }
  }, []);

  const status: Status = useMemo(() => {
    if (updateStarted) {
      if (updateError || updateState?.phase === "failed") return "failed";
      if (updateState?.phase === "completed") return "completed";
      return "updating";
    }
    if (versionsError && !versions) return "fetch-error";
    if (!versions) return "loading";
    // Only ClawBox drives availability now — OpenClaw is bumped as part
    // of the ClawBox update, so an OpenClaw-pin delta without a ClawBox
    // delta means a ClawBox release hasn't been cut yet and there's
    // nothing for the user to install.
    if (componentNeedsUpdate(versions.clawbox)) return "available";
    // Versions cannot see drift: package.json does not change commit-to-commit,
    // so a box serving a build from another commit — or sitting dozens of
    // commits behind its tested branch — reports `target: null` and used to be
    // told "You're up to date" by the one screen whose whole job is "should I
    // update?", while Settings → About simultaneously said "run Update to
    // realign" (hwtest-round1, 2026-08-24). Drift offers the update instead,
    // and the banner below says which drift.
    if (driftDetected) return "drift";
    // Last, and only where the screen would otherwise say "You're up to date".
    //
    // A device GitHub refused produces the same payload as a current one: the
    // fetch fails, HEAD is compared against the STALE `origin/<branch>` the
    // last successful fetch left, and there is no delta. Reporting that as
    // "Every component is on the latest release" is the lie TASK-655 was filed
    // for, and a box behind a refused address can sit on it for weeks.
    //
    // Below the two tests above on purpose: an offer and a drift are LOCAL
    // evidence that there is something to do, and they stay actionable — a
    // refused remote must not take the Update button away from a box that
    // already knows it needs one.
    if (versions.remote && !versions.remote.reachable) return "fetch-error";
    return "up-to-date";
  }, [updateStarted, updateError, updateState, versions, versionsError, driftDetected]);

  // ─── HERO ────────────────────────────────────────────────────────────
  const hero = (() => {
    switch (status) {
      case "loading":
        return {
          icon: "hourglass_empty", iconClass: "text-white/40",
          headline: tr("update.heroChecking", "Checking for updates…"),
          subhead: tr("update.heroCheckingSub", "Reading device + cloud version manifests."),
          tone: "neutral" as const,
        };
      case "fetch-error":
        return {
          icon: "cloud_off", iconClass: "text-amber-300",
          // Two headlines, because the device now reports two kinds of failure
          // and "couldn't reach the update server" sends the owner to the
          // router for a box whose `origin` is a file on its own disk. The
          // reason below names the actual one either way.
          headline: versions?.remote?.cause === "device"
            ? tr("update.heroCouldNotCheck", "Couldn't check for updates")
            : tr("update.heroUnreachable", "Couldn't reach the update server"),
          subhead: versionsError
            ?? versions?.remote?.reason
            ?? tr("update.heroUnreachableSub", "Check the device's internet connection and try again."),
          tone: "warn" as const,
        };
      case "up-to-date":
        return {
          icon: "verified", iconClass: "text-emerald-300",
          headline: tr("update.heroCurrent", "You're up to date"),
          subhead: tr("update.heroCurrentSub", "Every component is on the latest release."),
          tone: "good" as const,
        };
      case "drift":
        // Offered, not alarmed about. Versions cannot see this case —
        // package.json does not change commit-to-commit — so a box serving a
        // build from another commit reports `target: null` and this screen,
        // whose whole job is "should I update?", would otherwise say "You're up
        // to date" and give the owner no button at all. It says what is true
        // and offers the rebuild; the amber "this box is not running its own
        // code" alarm this used to raise is gone.
        return {
          icon: "system_update", iconClass: "text-emerald-300",
          headline: t("update.driftHeadline"), subhead: t("update.driftSubhead"),
          tone: "available" as const,
        };
      case "available": {
        const updates: string[] = [];
        if (versions && componentNeedsUpdate(versions.clawbox)) updates.push("ClawBox");
        // Guarded by the edition, not only by `updateAvailable`: on the Hermes
        // SKU that flag is false today only because `openclaw.current` is null,
        // and a headline offering an OpenClaw update on a box that ships no
        // OpenClaw is not something to leave resting on that.
        if (versions && shipsOpenclaw(versions) && componentNeedsUpdate(versions.openclaw)) updates.push("OpenClaw");
        return {
          icon: "system_update", iconClass: "text-emerald-300",
          headline: updates.length === 1
            ? tr("update.heroAvailableOne", "1 update available")
            : tr("update.heroAvailableMany", "{count} updates available", { count: updates.length }),
          subhead: tr("update.heroAvailableSub", "New version available for {components}.", {
            components: updates.join(tr("update.componentJoin", " and ")),
          }),
          tone: "available" as const,
        };
      }
      // The three run states are drawn by UpdateRunView, which takes the
      // headline and subhead from here. "Don't power off" is its footer bar.
      case "updating":
        return {
          icon: "downloading", iconClass: "text-orange-300",
          headline: tr("update.heroUpdating", "Updating your device"),
          subhead: tr("update.updatingDescription", "Updating your ClawBox with the latest software…"),
          tone: "busy" as const,
        };
      case "completed":
        return {
          icon: "task_alt", iconClass: "text-emerald-300",
          headline: tr("update.heroComplete", "Update complete"),
          subhead: updateState?.steps.some((s) => s.id === RESTART_STEP_ID)
            ? tr("update.heroCompleteRestart", "The device will restart in a moment.")
            : tr("update.heroCompleteSub", "Everything's been updated."),
          tone: "good" as const,
        };
      case "failed":
        return {
          icon: "error", iconClass: "text-red-300",
          headline: tr("update.heroFailed", "Update failed"),
          // What stopped and why is the error panel's, said once, beside the
          // steps; a refused downgrade is said there in the owner's language,
          // from its detail — its English sentence is for the log and the MCP
          // tools.
          subhead: tr("update.heroFailedSub", "One step couldn't complete. See the steps below."),
          tone: "error" as const,
        };
    }
  })();

  const heroBgClass = {
    neutral: "from-white/5 via-white/[0.02]",
    warn: "from-amber-500/10 via-amber-500/5",
    good: "from-emerald-500/10 via-emerald-500/5",
    available: "from-emerald-500/10 via-emerald-500/5",
    busy: "from-orange-500/10 via-orange-500/5",
    error: "from-red-500/10 via-red-500/5",
  }[hero.tone];

  // Drift counts as "there is an update to run" for the card too: its button
  // otherwise reads "Up to date" and is disabled, which is the same denial the
  // hero used to make, one card further down.
  const clawboxAvail = (!!versions && componentNeedsUpdate(versions.clawbox)) || driftDetected;

  // "CURRENT" / "Up to date" on the card is derived from a comparison against
  // the STALE refs a refused fetch left behind, so on a box whose remote could
  // not be reached it is the same denial the hero has just stopped making, one
  // card further down. `unknown` makes the card say so instead. Only where
  // there is no local evidence: a drifted or genuinely-behind box keeps its
  // offer, because that fact was established without the remote.
  const clawboxUnknown = !clawboxAvail && versions?.remote?.reachable === false;

  // A run on screen — live, finished or failed — gets the run view instead of
  // the hero and the component cards.
  const inRun = status === "updating" || status === "completed" || status === "failed";

  return (
    <div className={embedded ? "relative w-full text-gray-200" : "relative h-full w-full overflow-y-auto bg-[var(--bg-app)] text-gray-200"} data-testid="system-update-app">
      <div className={embedded ? "w-full" : `min-h-full w-full flex items-start justify-center p-6 ${inRun ? "pt-8" : "pt-10"} bg-[var(--bg-deep)]`}>
        <div className={`w-full ${inRun ? "max-w-[1200px]" : "max-w-2xl"} space-y-4`}>
          {inRun ? (
            <UpdateRunView
              status={status}
              state={updateState}
              error={updateError}
              versions={versions}
              channel={effectiveBranch?.branch ?? branch}
              heading={HeroHeading}
              headline={hero.headline}
              lede={hero.subhead}
              onDismiss={dismissResult}
              // A run the box lost (a restart, a power cut, a replaced web
              // server) is RESUMED from the step it died on by a fresh run —
              // the verdict's own sentence says so — and this is the control
              // that starts one. Dismiss forgets the position; the hero's
              // update button is hidden while a run is settled, so without
              // this the resume was reachable by no gesture at all. Any other
              // failure starts over from step 1 on a fresh run, so it is not
              // offered as a "resume": Dismiss, then Update everything.
              onResume={updateState?.error?.startsWith(INTERRUPTED_MESSAGE_PREFIX) ? () => void triggerUpdate() : undefined}
              onOverrideDowngrade={() => void triggerUpdate(true)}
            />
          ) : (
          <>
          {/* HERO */}
          <div className={`${CARD} relative overflow-hidden flex flex-col items-center text-center px-6 pt-10 pb-8 bg-gradient-to-br ${heroBgClass} to-transparent`}>
            <div className="relative w-32 h-32 flex items-center justify-center mb-3">
              {(status === "available" || status === "up-to-date") && (
                <>
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full"
                    style={{
                      background: "radial-gradient(circle, rgba(16,185,129,0.35), transparent 70%)",
                      filter: "blur(20px)",
                      opacity: 0.7,
                    }}
                  />
                </>
              )}
              <div className="relative w-24 h-24 rounded-full flex items-center justify-center bg-white/[0.04] border border-[var(--border-subtle)]">
                <span className={`material-symbols-rounded ${hero.iconClass}`} style={{ fontSize: 56, fontVariationSettings: "'FILL' 1, 'wght' 600" }}>
                  {hero.icon}
                </span>
              </div>
            </div>
            <HeroHeading className="font-display text-3xl font-bold">{hero.headline}</HeroHeading>
            <p className="mt-1.5 max-w-md text-sm text-[var(--text-muted)] leading-relaxed">
              {hero.subhead}
            </p>

            {(status === "available" || status === "up-to-date" || status === "drift") && (
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                {(status === "available" || status === "drift") && (
                  <button
                    type="button"
                    onClick={() => void triggerUpdate()}
                    className="px-6 py-2.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black text-sm font-semibold shadow-lg cursor-pointer"
                  >
                    {tr("update.updateEverything", "Update everything")}
                  </button>
                )}
                {status === "up-to-date" && (
                  <button
                    type="button"
                    onClick={() => void fetchVersions(true)}
                    disabled={refreshing}
                    className="px-6 py-2.5 rounded-full border border-[var(--border-subtle)] bg-white/[0.04] text-sm font-semibold text-gray-200 hover:bg-white/[0.08] disabled:opacity-50 cursor-pointer"
                  >
                    {refreshing ? tr("update.checking", "Checking…") : tr("update.checkForUpdates", "Check for updates")}
                  </button>
                )}
              </div>
            )}

            {status === "fetch-error" && (
              <button
                type="button"
                onClick={() => void fetchVersions(true)}
                disabled={refreshing}
                className="mt-6 px-5 py-2 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-200 text-sm font-semibold hover:bg-amber-500/25 cursor-pointer disabled:opacity-50"
              >
                {refreshing ? tr("update.retrying", "Retrying…") : tr("update.tryAgain", "Try again")}
              </button>
            )}
          </div>

          {/* COMPONENTS
              Only ClawBox is exposed as a standalone update target. The agent
              harness is pinned by ClawBox (config/openclaw-target.txt) and
              bumped automatically inside the full ClawBox update — see
              install.sh::step_openclaw_install. Surfacing a separate
              OpenClaw card would let customers bypass the pin and pick
              whatever was last published to npm, which is what we just
              moved away from. The installed harness version is reported
              below the card instead: read-only, no second update button. */}
          {versions && (
            <div className="grid grid-cols-1 gap-3">
              <ComponentCard
                name="ClawBox"
                description={tr("update.clawboxCardSub", "Device OS and built-in apps")}
                current={versions.clawbox.current}
                target={versions.clawbox.target}
                available={clawboxAvail}
                unknown={clawboxUnknown}
                onUpdate={() => void triggerUpdate()}
              />
            </div>
          )}

          {/* The run view draws these itself once a run has settled: "Update
              complete" is exactly when an owner wants to read the version
              their agent came back on. */}
          {versions && <AgentVersions versions={versions} />}
          </>
          )}

          {/* ADVANCED */}
          {status !== "updating" && (
            <div className={CARD}>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
                className="w-full flex items-center justify-between text-left text-sm font-semibold text-gray-100 cursor-pointer"
              >
                <span className="inline-flex items-center gap-2">
                  <span className="material-symbols-rounded text-[var(--text-muted)]" style={{ fontSize: 18 }} aria-hidden="true">tune</span>
                  {tr("update.advancedOptions", "Advanced options")}
                </span>
                <span
                  className={`material-symbols-rounded text-[var(--text-muted)] transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                  style={{ fontSize: 18 }}
                  aria-hidden="true"
                >
                  expand_more
                </span>
              </button>

              {showAdvanced && (
                <div className="mt-4 space-y-4">
                  {/* Beta toggle */}
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      {/* The label the toggle beside it is named by — a switch
                          whose only accessible name was the empty string is an
                          unnamed button to a screen reader. */}
                      <div id={betaLabelId} className="text-sm text-gray-100 inline-flex items-center gap-2">
                        <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 18 }} aria-hidden="true">science</span>
                        {tr("update.betaChannel", "Beta channel")}
                      </div>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        <Interpolated
                          text={tr(
                            "update.betaChannelHelp",
                            "Pulls updates from {beta} instead of {main}. Pre-release features land here first; expect rough edges.",
                          )}
                          slots={{
                            beta: <code className="bg-[var(--bg-elevated)] px-1 rounded">beta</code>,
                            main: <code className="bg-[var(--bg-elevated)] px-1 rounded">main</code>,
                          }}
                        />
                      </p>
                    </div>
                    <BetaToggle
                      enabled={branch === "beta"}
                      saving={branchSaving}
                      labelledBy={betaLabelId}
                      onEnable={() => setBetaConfirm(true)}
                      onDisable={() => void saveBranch(null)}
                    />
                  </div>

                  {/* Branch override */}
                  <div className="border-t border-[var(--border-subtle)] pt-4">
                    {/* A label, not a div: the input was named by its placeholder alone. */}
                    <label htmlFor={branchInputId} className="block text-sm text-gray-100">{tr("update.branchOverride", "Branch override")}</label>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      {tr("update.branchOverrideHelp", "Pin updates to a specific git branch (e.g. for QA). Leave blank to follow the configured channel.")}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        id={branchInputId}
                        type="text"
                        value={branchInput}
                        onChange={(e) => setBranchInput(e.target.value)}
                        placeholder="main / beta / clawkeep"
                        spellCheck={false}
                        className="flex-1 px-2.5 py-1.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-sm font-mono text-gray-200 focus:outline-none focus:border-emerald-500/50"
                      />
                      <button
                        type="button"
                        onClick={() => void saveBranch(branchInput.trim() || null)}
                        disabled={branchSaving || branchInput.trim() === (branch ?? "")}
                        className="px-3 py-1.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 text-xs font-semibold disabled:opacity-50 cursor-pointer"
                      >
                        {branchSaving ? tr("update.saving", "Saving…") : tr("update.save", "Save")}
                      </button>
                    </div>
                    {effectiveBranch && (
                      <p className="mt-2 text-xs text-[var(--text-muted)]" data-testid="update-effective-branch">
                        <Interpolated
                          text={effectiveBranchText(effectiveBranch.source, tr)}
                          slots={{
                            branch: <code className="bg-[var(--bg-elevated)] px-1 rounded text-gray-200">{effectiveBranch.branch}</code>,
                          }}
                        />
                      </p>
                    )}
                    {branchError && (
                      <p className="mt-2 text-xs text-red-300">{branchError}</p>
                    )}
                    {branchDowngrade && (
                      <HarnessDowngradeNotice
                        detail={branchDowngrade.detail}
                        kind="branch"
                        busy={branchSaving}
                        onOverride={() => void saveBranch(branchDowngrade.branch, true)}
                      />
                    )}
                  </div>

                  {/* Force full update — recovery for a device left with a stale
                      OpenClaw/system unit by force-update.sh (restores the UI but
                      not the full update). Offered when there is no update to
                      run — up to date, or a box whose remote could not be
                      reached — and never while loading, so it can't fire before
                      the payload is in. The refused case is the one that most
                      needs it: install.sh retries the fetch, so the update has a
                      real chance of getting through where the version check did
                      not, and this is the only control that starts it. */}
                  {(status === "up-to-date" || (status === "fetch-error" && !!versions)) && (
                    <div className="border-t border-[var(--border-subtle)] pt-4">
                      <div className="text-sm text-gray-100 inline-flex items-center gap-2">
                        <span className="material-symbols-rounded text-amber-400" style={{ fontSize: 18 }} aria-hidden="true">restart_alt</span>
                        {tr("update.forceFullUpdate", "Force full update")}
                      </div>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">
                        {tr("update.forceFullUpdateHelp", "Re-runs OpenClaw and system-service setup even when the version is current. Use it if a recovery script told you to, or if the assistant or services misbehave after an update. The device reboots when it finishes.")}
                      </p>
                      <button
                        type="button"
                        onClick={() => setForceConfirm(true)}
                        className="mt-2 px-3 py-1.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs font-semibold cursor-pointer hover:bg-amber-500/25"
                      >
                        {tr("update.forceFullUpdate", "Force full update")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {betaConfirm && (
        <ConfirmModal
          titleId="beta-confirm-title"
          title={tr("update.betaConfirmTitle", "Enable beta updates?")}
          icon="warning"
          confirmLabel={tr("update.betaConfirmAction", "Enable beta")}
          onCancel={() => setBetaConfirm(false)}
          onConfirm={() => { setBetaConfirm(false); void saveBranch("beta"); }}
        >
          <p>
            {tr("update.betaConfirmBody", "Beta builds may include unfinished features and regressions. They're great for early feedback but can break local state. You can switch back any time, but downgrades aren't always reversible.")}
          </p>
        </ConfirmModal>
      )}

      {forceConfirm && (
        <ConfirmModal
          titleId="force-confirm-title"
          title={tr("update.forceConfirmTitle", "Force a full update?")}
          icon="restart_alt"
          confirmLabel={tr("update.forceConfirmAction", "Yes, run full update")}
          onCancel={() => setForceConfirm(false)}
          onConfirm={() => { setForceConfirm(false); void triggerUpdate(); }}
        >
          <p>
            <Interpolated
              text={tr(
                "update.forceConfirmBody",
                "This re-runs the full update — including OpenClaw and system-service setup — even though the version is already current, then {reboot}. Use it to finish a recovery or fix services that misbehave after an update.",
              )}
              slots={{ reboot: <strong>{tr("update.forceConfirmReboot", "reboots the device")}</strong> }}
            />
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

// Shared confirmation dialog. Focuses Cancel on open (so a stray Enter can't
// confirm a destructive action), closes on Escape, and traps Tab focus within
// the dialog — the keyboard-nav behavior CLAUDE.md requires of modals.
//
// That behaviour now comes from useModalDialog rather than a second copy of it
// here, which also gets this dialog the two things the local copy lacked:
// focus returns to the trigger on close, and the page behind goes inert.
function ConfirmModal({
  titleId,
  title,
  icon,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
}: {
  titleId: string;
  title: string;
  icon: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const tr = useTr();
  // Cancel is first in DOM order, so the shared trap lands there on open.
  const dialogRef = useModalDialog<HTMLDivElement>({ onClose: onCancel });

  return (
    <div
      // No backdrop blur under the dim: a full-screen blur is redone over the whole
      // desktop on every frame anything beneath it moves (the mascot always does).
      // One step darker keeps the look.
      className="main-screen-scrim fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-deep)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 pt-5">
          <div className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center bg-amber-500/15 text-amber-300">
            <span className="material-symbols-rounded" style={{ fontSize: 22 }}>{icon}</span>
          </div>
          <h2 id={titleId} className="text-base font-semibold text-gray-100">{title}</h2>
        </div>
        <div className="px-5 pt-3 pb-4 text-sm leading-relaxed text-[var(--text-secondary)]">
          {children}
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5 pt-2 border-t border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-[var(--border-subtle)] text-gray-200 hover:bg-white/5 cursor-pointer"
          >
            {tr("update.cancel", "Cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500 hover:bg-amber-400 text-black cursor-pointer"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The harness this box actually runs, read-only.
 *
 * TASK-548: this screen is where an owner goes to ask "what version am I on",
 * and it named only ClawBox — so a Hermes owner could read their agent's
 * version in Settings -> About and nowhere here. The rows follow the same
 * per-edition rule About uses: OpenClaw unless the SKU is `hermes`, Hermes
 * whenever the payload carries it.
 *
 * BOTH harnesses are pinned by ClawBox and bumped inside the full update —
 * OpenClaw by `config/openclaw-target.txt`, Hermes by `HERMES_PIN_COMMIT` in
 * install.sh, which `step_hermes_install` re-checks on every update — so the
 * note is the same for both. There is no way for an owner to update either one
 * on its own, and telling them otherwise sends them looking for a button that
 * does not exist.
 *
 * `format` per row, not one shared call: `hermes.current` has already been
 * normalised server-side by `parseHermesVersion`, whose whole reason for
 * existing is that `cleanVersion`'s rules are shaped for OpenClaw/git-describe
 * output. Running the second parser over the first one's result turned
 * "Hermes Agent (dev build)" into "Hermes Agent" here while About, reading the
 * same field raw, kept it — two windows the desktop can show side by side.
 */
function AgentVersions({ versions }: { versions: VersionInfo }) {
  const tr = useTr();
  const pinnedNote = tr("update.pinnedByClawbox", "Pinned by ClawBox — updated with it");
  const rows: { name: string; version: string | null; note: string }[] = [];
  if (shipsOpenclaw(versions)) {
    rows.push({
      name: "OpenClaw",
      version: cleanVersion(versions.openclaw.current) || versions.openclaw.current,
      note: pinnedNote,
    });
  }
  if (versions.hermes) {
    rows.push({
      name: "Hermes",
      version: versions.hermes.current,
      note: pinnedNote,
    });
  }
  if (!rows.length) return null;

  return (
    <div className={CARD} data-testid="agent-versions">
      <div className="text-base font-semibold text-gray-100">{tr("update.agent", "Agent")}</div>
      <p className="text-xs text-[var(--text-muted)] mt-0.5 mb-3">{tr("update.agentSub", "The assistant harness running on this device")}</p>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.name} className="flex items-baseline justify-between gap-3 text-xs">
            <div className="min-w-0">
              <div className="text-sm text-gray-100">{row.name}</div>
              <div className="text-[11px] text-[var(--text-muted)]">{row.note}</div>
            </div>
            {/* "—", not "not installed": a null version here means the probe
                failed, never that the harness is absent. The payload only
                carries a `hermes` block on a box that HAS Hermes, and
                `hermes --version` does not answer while step_hermes_install is
                moving the checkout aside mid-update. ComponentCard below says
                the same nothing the same way. */}
            <div className="min-w-0 font-mono text-gray-100 truncate">{row.version || "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ComponentCard({
  name,
  description,
  current,
  target,
  available,
  unknown = false,
  onUpdate,
}: {
  name: string;
  description: string;
  current: string | null;
  target: string | null;
  available: boolean;
  /** The remote could not be reached, so "current" is not a fact. */
  unknown?: boolean;
  onUpdate: () => void;
}) {
  const tr = useTr();
  return (
    <div className={`${CARD} flex flex-col`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-base font-semibold text-gray-100">{name}</div>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{description}</p>
        </div>
        <span className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] font-semibold tracking-wider ${available ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-white/5 text-[var(--text-muted)] border-[var(--border-subtle)]"}`}>
          {available
            ? tr("update.badgeUpdate", "UPDATE")
            : unknown ? tr("update.badgeUnknown", "UNKNOWN") : tr("update.badgeCurrent", "CURRENT")}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="uppercase tracking-wider text-[10px] text-[var(--text-muted)]">{tr("update.installed", "Installed")}</div>
          <div className="mt-1 font-mono text-gray-100 truncate">{cleanVersion(current ?? "") || current || "—"}</div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-[10px] text-[var(--text-muted)]">{tr("update.latest", "Latest")}</div>
          <div className={`mt-1 font-mono truncate ${available ? "text-emerald-300" : "text-gray-100"}`}>
            {unknown ? "—" : cleanVersion(target ?? "") || target || "—"}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onUpdate}
        disabled={!available}
        className="mt-4 px-3 py-1.5 rounded-md text-xs font-semibold border cursor-pointer disabled:cursor-default disabled:opacity-50 transition-colors bg-emerald-500/15 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/25"
      >
        {available
          ? tr("update.updateComponent", "Update {name}", { name })
          : unknown ? tr("update.couldNotCheck", "Couldn't check") : tr("update.upToDateShort", "Up to date")}
      </button>
    </div>
  );
}

function BetaToggle({
  enabled,
  saving,
  labelledBy,
  onEnable,
  onDisable,
}: {
  enabled: boolean;
  saving: boolean;
  /**
   * The id of the "Beta channel" text beside it. The toggle has no label of
   * its own — it is a bare styled <button> — so without this assistive tech
   * reads "button, pressed" with no name at all.
   */
  labelledBy: string;
  onEnable: () => void;
  onDisable: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => (enabled ? onDisable() : onEnable())}
      disabled={saving}
      role="switch"
      aria-checked={enabled}
      aria-labelledby={labelledBy}
      className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors cursor-pointer border-none shrink-0 ${enabled ? "bg-amber-500" : "bg-white/15"} ${saving ? "opacity-50" : ""}`}
    >
      <span
        className="absolute w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200"
        style={{ left: 2, transform: enabled ? "translateX(18px)" : "translateX(0)" }}
      />
    </button>
  );
}

/**
 * "This would install an older assistant" — a branch or an update the box
 * refused because the harness it installs is older than the one that wrote the
 * assistant's data (src/lib/harness-downgrade.ts). Said from the refusal's
 * detail, one line per harness, with the documented override beside it:
 * back the data up first, then go ahead.
 */
function HarnessDowngradeNotice({
  detail,
  kind,
  busy = false,
  backupFailure,
  onOverride,
}: {
  detail: HarnessDowngradeDetail;
  kind: "branch" | "update";
  busy?: boolean;
  /** Present when the override's backup failed: the server's reason, shown as given. */
  backupFailure?: string;
  onOverride?: () => void;
}) {
  const tr = useTr();
  return (
    <div
      role="alert"
      data-testid="update-harness-downgrade"
      className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
    >
      <p className="font-semibold text-amber-50">
        {kind === "branch" && detail.branch
          ? tr("update.harnessDowngrade.titleBranch", "Branch {branch} would install an older assistant", { branch: detail.branch })
          : tr("update.harnessDowngrade.titleUpdate", "This update would install an older assistant")}
      </p>
      <ul className="mt-1 space-y-0.5">
        {detail.downgrades.map((d) => (
          <li key={d.harness}>
            {d.schema
              ? tr(
                "update.harnessDowngrade.schemaLine",
                "{harness} data on this box is on schema {onDisk}; {harness} {target} supports up to schema {supported}.",
                { harness: HARNESS_LABEL[d.harness], onDisk: d.schema.onDisk, target: d.target, supported: d.schema.supported },
              )
              : tr(
                "update.harnessDowngrade.versionLine",
                "{harness} {installed} is installed; this would install the older {target}.",
                { harness: HARNESS_LABEL[d.harness], installed: d.installed ?? "?", target: d.target },
              )}
          </li>
        ))}
      </ul>
      {backupFailure !== undefined ? (
        <>
          <p className="mt-1">
            {tr("update.harnessDowngrade.backupFailed", "The backup could not be taken, so the older version was not installed and nothing was changed.")}
          </p>
          {backupFailure && <p className="mt-1 text-amber-200/80 break-words">{backupFailure}</p>}
        </>
      ) : (
        <p className="mt-1">
          {tr(
            "update.harnessDowngrade.body",
            "An older version cannot open data a newer one has written, so nothing was changed. Stay on your current update branch, or back up the assistant's data and continue anyway: whatever the older version cannot open is set aside in that backup.",
          )}
        </p>
      )}
      {onOverride && (
        <button
          type="button"
          onClick={onOverride}
          disabled={busy}
          className="mt-2 px-3 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs font-semibold disabled:opacity-50 cursor-pointer hover:bg-amber-500/25"
        >
          {kind === "branch"
            ? tr("update.harnessDowngrade.switchAnyway", "Back up and switch anyway")
            : tr("update.harnessDowngrade.updateAnyway", "Back up and update anyway")}
        </button>
      )}
    </div>
  );
}

/** A step's place in the list, as the log writes it: `05`. */
function stepNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/**
 * The System Update window while a run is on screen — running, finished or
 * failed.
 *
 * Running and finished: the run on the left (where it is, how far, every step
 * by number) and what the version being installed brings on the right, with
 * "don't power off" across the bottom while it runs. Failed: what stopped and
 * why first — the failed step's name, the most specific reason the updater
 * recorded, the way on (Resume where the server can resume, Dismiss always) —
 * then the log of the steps that ran, beside the stopped step list.
 *
 * The columns follow the window, not the screen (container queries), so a
 * narrow window, the Settings pane or a phone stacks them. In a stack the
 * failure comes before the steps, and it stays first in the document either
 * way: a refused downgrade's explanation and override were once out of sight
 * below ten pending steps on a laptop-sized window.
 */
function UpdateRunView({
  status,
  state,
  error,
  versions,
  channel,
  heading: Heading,
  headline,
  lede,
  onDismiss,
  onResume,
  onOverrideDowngrade,
}: {
  status: Status;
  state: UpdateState | null;
  /** This screen's own failure to start or clear a run. */
  error: string | null;
  versions: VersionInfo | null;
  /** The branch this box updates from, as far as this screen knows it. */
  channel: string | null;
  heading: "h1" | "h2";
  headline: string;
  lede: string;
  onDismiss: () => void;
  /** Present only for an interrupted run: starts the fresh run that resumes it. */
  onResume?: () => void;
  /** "Back up and update anyway", offered on a run refused for installing an older harness. */
  onOverrideDowngrade?: () => void;
}) {
  const tr = useTr();
  const SubHeading = Heading === "h1" ? "h2" : "h3";
  // Asked only while a run is on screen: the route reads the target's notes,
  // and an idle System Update window has no target to ask about.
  const whatsNew = useUpdateWhatsNew();
  const panel = updateWhatsNewPanel(whatsNew.answer);

  const failed = status === "failed";
  // The screen's verdict wins over a stale poll: a run this screen calls
  // failed has no step still "in progress".
  const phase: UpdatePhase | undefined = failed ? "failed" : state?.phase;
  const steps = state?.steps ?? [];
  const running = steps.find((s) => shownStepStatus(s, phase) === "running");
  const failure = failed ? describeUpdateFailure(state, error) : null;
  // A refused downgrade (or the backup its override could not take) is said
  // from its detail in the owner's language, never as the server's English.
  const downgrade = failed
    && (state?.errorCode === HARNESS_DOWNGRADE_CODE || state?.errorCode === HARNESS_DOWNGRADE_BACKUP_FAILED_CODE)
    ? readHarnessDowngradeDetail(state.downgrade)
    : null;
  // Non-fatal problems the update found and worked around — build drift, a
  // missing update pin it wrote for the owner. The ruling is that these
  // warn rather than block, which only means anything if they are visible;
  // the text comes from the server alongside the step labels.
  const warnings = state?.warnings ?? [];
  const restarts = steps.some((s) => s.id === RESTART_STEP_ID);

  const current = versions ? cleanVersion(versions.clawbox.current) ?? versions.clawbox.current : null;
  const target = panel.version
    ?? (versions?.clawbox.target ? cleanVersion(versions.clawbox.target) ?? versions.clawbox.target : null);
  const shownChannel = panel.channel ?? channel;

  const header = (
    <div className="min-w-0">
      <p className="m-0 mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-orange-400">
        {tr("update.title", "System Update")}
      </p>
      <Heading className="m-0 font-display text-[32px] font-bold leading-tight tracking-[-0.02em] text-[var(--text-primary)]">
        {headline}
      </Heading>
      <p className="m-0 mt-2 text-[15px] leading-relaxed text-[var(--text-secondary)]">{lede}</p>
    </div>
  );

  const versionRow = (current || target) && (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[var(--text-secondary)]"
      data-testid="update-run-versions"
    >
      <span>ClawBox</span>
      {current && <span className="font-mono">{current}</span>}
      {target && target !== current && (
        <>
          {current && <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>arrow_forward</span>}
          <span className="font-mono text-[var(--text-primary)]">{target}</span>
        </>
      )}
      {isNamedChannel(shownChannel) && (
        // A QA pin can be a long branch name: it is cut, never allowed to
        // push the row past a narrow window.
        <span
          className="min-w-0 max-w-[14rem] truncate rounded-[var(--r-full)] border border-[var(--coral-edge)] bg-[var(--coral-wash)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-orange-400"
          title={shownChannel}
          data-testid="update-run-channel"
        >
          {tr("update.whatsNewChannel", "{channel} channel", { channel: shownChannel })}
        </span>
      )}
    </div>
  );

  const countHeadline = status === "completed"
    ? tr("update.progressFinished", "Update finished")
    : failed
      ? tr("update.progressStopped", "Update stopped")
      : running?.label ?? (state ? tr("update.progressRunning", "In progress") : tr("update.connecting", "Connecting…"));

  const stepsPanel = (
    <section
      className="rounded-[var(--r-2)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6"
      data-testid="update-steps-panel"
    >
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--text-secondary)]">
        <span className="inline-flex min-w-0 items-center gap-2 font-medium text-[var(--text-primary)]">
          {!state && !failed && (
            <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--coral-bright)] border-t-transparent motion-safe:animate-spin" aria-hidden="true" />
          )}
          <span className="truncate">{countHeadline}</span>
        </span>
        {steps.length > 0 && <UpdateStepCount steps={steps} />}
      </div>
      {steps.length > 0 && (
        <>
          <div className="mt-4">
            <UpdateStepMeter steps={steps} phase={phase} label={tr("update.title", "System Update")} />
          </div>
          <div className="mt-[18px]">
            <UpdateStepList steps={steps} phase={phase} />
          </div>
        </>
      )}
    </section>
  );

  const warningList = warnings.length > 0 && (
    <ul className="m-0 list-none space-y-2 p-0">
      {warnings.map((w) => {
        // The line a finished run leaves behind about drift it RESOLVED is
        // history, not a problem. Drawn amber with a warning triangle it
        // alarmed the owner exactly as the stale imperative did, which is
        // the thing the completion view is meant to stop doing.
        const resolved = w.code === DRIFT_RESOLVED_CODE;
        return (
          <li
            key={w.code}
            data-testid={`update-warning-${w.code}`}
            data-tone={resolved ? "info" : "warning"}
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
              resolved
                ? "border-[var(--border-subtle)] bg-white/5 text-[var(--text-muted)]"
                : "border-amber-500/20 bg-amber-500/10 text-amber-100"
            }`}
          >
            <span
              className={`material-symbols-rounded shrink-0 ${resolved ? "text-gray-400" : "text-amber-300"}`}
              style={{ fontSize: 16 }}
            >
              {resolved ? "history" : "warning"}
            </span>
            <span>{w.message}</span>
          </li>
        );
      })}
    </ul>
  );

  const dismissButton = (
    <button
      type="button"
      onClick={onDismiss}
      className="rounded-[var(--r-1)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-2.5 text-sm font-semibold text-gray-300 hover:bg-[var(--fill-3)] cursor-pointer"
    >
      {tr("update.dismiss", "Dismiss")}
    </button>
  );

  const agentVersions = versions && status !== "updating" && <AgentVersions versions={versions} />;

  if (failure) {
    const ran = steps
      .map((step, index) => ({ step, index, shown: shownStepStatus(step, phase) }))
      .filter(({ shown }) => shown === "completed" || shown === "failed");
    const completedCount = steps.filter((s) => s.status === "completed").length;
    const noReason = tr(
      "update.noFailureReason",
      "The device did not say why the update stopped. Run the update again; if it stops at the same step, contact ClawBox support.",
    );

    return (
      <div className="@container w-full" data-testid="update-run" data-status={status}>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          {header}
          {versionRow}
        </div>
        {/* Placed, not reordered, on a wide window: the steps fill the left
            column, the failure and its log sit right with the feature below.
            Stacked, the document order reads failure, log, steps, feature. */}
        <div className="mt-6 grid grid-cols-1 gap-5 @3xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)] @3xl:grid-rows-[auto_1fr] @3xl:gap-x-7">
          <div className="min-w-0 space-y-5 @3xl:col-start-2 @3xl:row-start-1">
            <section className="rounded-[var(--r-2)] border border-red-500/25 bg-red-500/[0.06] p-5" data-testid="update-error-panel">
              {failure.step && (
                <SubHeading className="m-0 mb-2 flex items-center gap-2 font-display text-[19px] font-semibold text-red-300">
                  <span className="material-symbols-rounded shrink-0" aria-hidden="true" style={{ fontSize: 21 }}>error</span>
                  <span className="min-w-0 break-words">{failure.step.label}</span>
                </SubHeading>
              )}
              {downgrade && state ? (
                <HarnessDowngradeNotice
                  detail={downgrade}
                  kind="update"
                  backupFailure={state.errorCode === HARNESS_DOWNGRADE_BACKUP_FAILED_CODE ? downgrade.backupFailure ?? "" : undefined}
                  onOverride={onOverrideDowngrade}
                />
              ) : (
                <>
                  <p className="m-0 flex items-start gap-2 text-[13px] leading-relaxed text-[var(--text-secondary)]" data-testid="update-error-reason">
                    {!failure.step && (
                      <span className="material-symbols-rounded shrink-0 text-red-300" aria-hidden="true" style={{ fontSize: 20 }}>error</span>
                    )}
                    <span className="min-w-0 break-words">{failure.reason ?? noReason}</span>
                  </p>
                  {failure.context && (
                    <p className="m-0 mt-2 break-words text-xs leading-relaxed text-[var(--text-muted)]" data-testid="update-error-context">
                      {failure.context}
                    </p>
                  )}
                </>
              )}
              <div className="mt-[18px] flex flex-wrap items-center gap-2.5">
                {onResume && (
                  <button
                    type="button"
                    onClick={onResume}
                    className="inline-flex items-center gap-2 rounded-[var(--r-1)] bg-[var(--coral-bright)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--coral-mid)] cursor-pointer"
                  >
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>refresh</span>
                    {/* The step is known when one is marked failed: the run picks
                        up there. With none known a fresh run is what "again" means. */}
                    {failure.step
                      ? tr("update.resume", "Resume update")
                      : tr("update.startAgain", "Start the update again")}
                  </button>
                )}
                {dismissButton}
              </div>
            </section>

            {ran.length > 0 && (
              <section
                aria-label={tr("update.updateLog", "Update log")}
                className="rounded-[var(--r-2)] border border-[var(--border-subtle)] bg-[var(--bg-deep)] p-5 font-mono text-xs text-[var(--text-secondary)]"
                data-testid="update-log"
              >
                <div className="mb-2 flex justify-between gap-3 border-b border-[var(--border-subtle)] pb-2 text-gray-300" aria-hidden="true">
                  <span>{tr("update.updateLog", "Update log")}</span>
                  <span className="tabular-nums">{completedCount} / {steps.length}</span>
                </div>
                <ol className="m-0 list-none p-0">
                  {ran.map(({ step, index, shown }) => {
                    // The step the run stopped at carries the reason the panel
                    // gives; any other failed step only its own. A refused
                    // downgrade's English is never written here.
                    const reason = shown !== "failed" || downgrade
                      ? null
                      : step === failure.step ? failure.reason : stepFailureReason(step);
                    return (
                      <li key={step.id} className="flex min-w-0 gap-3 py-[3px] leading-relaxed">
                        <span className="shrink-0 text-[var(--text-muted)]">{stepNumber(index)}</span>
                        {shown === "completed" ? (
                          <span className="min-w-0">
                            <span className="text-[var(--cyan-bright)]" aria-hidden="true">✓</span> {step.label}
                          </span>
                        ) : (
                          <span className="min-w-0 break-words text-red-300">
                            <span aria-hidden="true">×</span> {reason ? `${step.label}: ${reason}` : step.label}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

          </div>

          <div className="min-w-0 space-y-4 @3xl:col-start-1 @3xl:row-span-2 @3xl:row-start-1">
            {stepsPanel}
            {warningList}
            {agentVersions}
          </div>

          {whatsNew.settled && (
            <div className="min-w-0 self-start @3xl:col-start-2 @3xl:row-start-2">
              <UpdateWhatsNewPanel panel={panel} variant="compact" headingLevel={SubHeading} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const bar = status === "updating"
    ? { icon: "power_settings_new", title: tr("update.heroUpdatingSub", "Don't power off until this finishes."), note: tr("update.reconnectNote", "Your ClawBox will briefly go offline while restarting. This page reconnects automatically.") }
    : restarts
      ? { icon: "restart_alt", title: tr("update.reloadOnRestart", "The page will reload once the device is back up."), note: null }
      : null;

  return (
    <div className="@container w-full" data-testid="update-run" data-status={status}>
      <div className="grid grid-cols-1 gap-8 @3xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-[18px]">
          {header}
          {versionRow}
          {stepsPanel}
          {warningList}
          {status === "completed" && <div>{dismissButton}</div>}
          {agentVersions}
        </div>
        <div className="min-w-0">
          {whatsNew.settled && <UpdateWhatsNewPanel panel={panel} variant="grid" headingLevel={SubHeading} />}
        </div>
      </div>
      {/* While the run is live it is held to the bottom of the window as the
          steps scroll under it: "don't power off" is the one line that must
          stay in sight. A finished run's restart note sits in the flow, over
          nothing. */}
      {bar && (
        <div
          className={`${status === "updating" ? "sticky bottom-4 z-10 shadow-[0_-8px_24px_rgba(0,0,0,0.25)]" : ""} mt-7 flex items-center gap-3 rounded-[10px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-5 py-4 text-xs text-[var(--text-secondary)]`}
          data-testid="update-run-notice"
        >
          <span className="material-symbols-rounded shrink-0 text-orange-400" aria-hidden="true" style={{ fontSize: 21 }}>{bar.icon}</span>
          <div className="min-w-0">
            <p className="m-0 font-medium text-gray-300">{bar.title}</p>
            {bar.note && <p className="m-0 mt-1 text-[11px]">{bar.note}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
