"use client";

/**
 * "What is this box actually running?" — for the owner, not for a log.
 *
 * A ClawBox can serve a build made from one commit while its source tree sits
 * on another; when that happened, features 404'd whose code was visibly on
 * disk and nothing in the UI said why. These two pieces put the answer where
 * someone would look for it: the commit on the About screen, and a banner on
 * both About and System the moment the two stop agreeing.
 *
 * The wording is deliberately not git jargon — "the code on disk", "run
 * Update to realign" — and it is translated, so it says the same thing in
 * every locale rather than falling back to English at the worst moment.
 */

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import type { BuildIdentity, DriftCode } from "@/lib/build-identity";

/** Every value this file renders is a string; anything else must not reach React. */
function optionalString(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "string";
}

/**
 * Shape-check the payload before rendering any of it.
 *
 * Not just the top level: React throws on an object child, so a body that
 * satisfies the outer shape while carrying `checkout.shortCommit: {}` would
 * still take the Settings window down. Every nullable scalar the banner and
 * the rows read is checked here, once, rather than defended at each use.
 */
function isBuildIdentity(data: unknown): data is BuildIdentity {
  if (!data || typeof data !== "object") return false;
  const d = data as Partial<BuildIdentity>;

  if (!d.drift || typeof d.drift !== "object" || !Array.isArray(d.drift.codes)) return false;
  if (!d.drift.codes.every((c) => typeof c === "string")) return false;

  if (!d.checkout || typeof d.checkout !== "object") return false;
  if (!optionalString(d.checkout.shortCommit) || !optionalString(d.checkout.branch)) return false;

  if (!d.pin || typeof d.pin !== "object") return false;
  if (!optionalString(d.pin.branch) || !optionalString(d.pin.commit)) return false;

  if (d.build !== null && d.build !== undefined) {
    if (typeof d.build !== "object") return false;
    if (!optionalString(d.build.shortCommit) || !optionalString(d.build.branch)) return false;
    if (!optionalString(d.build.builtAt)) return false;
  }

  return true;
}

/**
 * Fetch once per mount, and only where it is shown.
 *
 * The endpoint shells out to git, so polling it would put a handful of
 * subprocesses per second on a Jetson to answer a question that changes only
 * when the box rebuilds.
 */
export function useBuildIdentity(enabled: boolean): BuildIdentity | null {
  const [identity, setIdentity] = useState<BuildIdentity | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/setup-api/system/build-identity", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        // Shape-check before trusting it. A gateway/proxy error page, a
        // half-deployed server, or an older build answering this path can all
        // return 200 with a body that is not a BuildIdentity, and rendering
        // that would take the whole Settings window down over a diagnostic.
        if (cancelled || !isBuildIdentity(data)) return;
        setIdentity(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);

  return identity;
}

function formatBuiltAt(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  try {
    return new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** The plain facts, for the About screen: which commit, which branch, when. */
export function BuildIdentityRows({ identity }: { identity: BuildIdentity | null }) {
  const { t, locale } = useT();
  if (!identity?.checkout) return null;

  const unknown = t("settings.buildUnknownShort");
  const builtAt = formatBuiltAt(identity.build?.builtAt ?? null, locale);
  const buildCommit = identity.build?.shortCommit ?? unknown;
  const checkoutCommit = identity.checkout.shortCommit ?? unknown;
  const drifted = identity.drift?.buildVsCheckout === "drift";

  return (
    <>
      <div className="flex justify-between text-sm">
        <span className="text-[var(--text-muted)]">{t("settings.buildCommit")}</span>
        <span className={`font-mono ${drifted ? "text-amber-300" : "text-[var(--text-primary)]"}`}>
          {buildCommit}
        </span>
      </div>
      <div className="flex justify-between text-sm">
        <span className="text-[var(--text-muted)]">{t("settings.buildBranch")}</span>
        <span className="text-[var(--text-primary)]">
          {identity.build?.branch ?? identity.checkout.branch ?? unknown}
        </span>
      </div>
      {/* Only worth a row once it disagrees with the build — on a healthy box
          it is the same commit, and a duplicated line is noise. */}
      {drifted && (
        <div className="flex justify-between text-sm">
          <span className="text-[var(--text-muted)]">{t("settings.checkoutCommit")}</span>
          <span className="font-mono text-amber-300">{checkoutCommit}</span>
        </div>
      )}
      {builtAt && (
        <div className="flex justify-between text-sm">
          <span className="text-[var(--text-muted)]">{t("settings.builtAt")}</span>
          <span className="text-[var(--text-primary)]">{builtAt}</span>
        </div>
      )}
    </>
  );
}
