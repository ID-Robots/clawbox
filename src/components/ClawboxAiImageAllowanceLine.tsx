"use client";

import { useT } from "@/lib/i18n";
import type { ClawboxAiImageAllowance } from "@/lib/clawbox-ai-models";

/**
 * The day's image allowance, under the plan in Settings → AI Provider.
 *
 * WHY THIS EXISTS (TASK-469). The cap was real and enforced from the day image
 * generation shipped, and no surface anywhere on the box rendered a single
 * thing about it — not the limit, not the usage, not the reset. The first time
 * an owner learned the cap existed was the request that got refused, which is
 * exactly the outcome the metering was built to prevent.
 *
 * THREE STATES, and the difference between the last two is the whole design:
 *
 *   nothing        the portal did not answer, or answered something unusable.
 *                  Render NOTHING. A guessed allowance is a guess at somebody's
 *                  paid subscription, and it is worse than silence: silence is
 *                  a gap, a wrong cap is a support ticket.
 *   the ceiling    "20 images a day on Max" — we know the plan, not the usage.
 *   ceiling + use  "3 of 20 images today" — the portal reported both.
 *
 * "TODAY" IS NOT DECORATION. The allowance is 1 / 5 / 20 a day since TASK-485,
 * and without the word a customer reads a small number as a small month and
 * concludes the plan is worthless. The same copy said "a month" in ten locales
 * two days ago; that is why the period is never written into a string here
 * without the number it belongs to.
 */

/** Above this share of the day, the line stops being neutral and warns. */
const WARN_AT_PERCENT = 80;

export default function ClawboxAiImageAllowanceLine({
  allowance,
}: {
  allowance: ClawboxAiImageAllowance | null;
}) {
  const { t } = useT();
  if (!allowance) return null;

  const { limit, used, percentUsed, planLabel } = allowance;
  const exhausted = used !== null && used >= limit;
  // A warning at the point the day is nearly gone, not a permanent banner and
  // not a surprise at the wall. A cap that arrives with no warning does not
  // read as a plan limit, it reads as a broken box — and that is the actual
  // cost of getting this wrong.
  const warning = percentUsed !== null && percentUsed >= WARN_AT_PERCENT;

  const label =
    used === null
      ? t("ai.imagesPerDayOnPlan", { limit, plan: planLabel })
      : t("ai.imagesUsedToday", { used, limit });

  const tone = exhausted
    ? "text-[var(--coral-bright)]"
    : warning
      ? "text-amber-300"
      : "text-[var(--text-muted)]";

  return (
    <p
      className={`mt-2 flex items-center gap-1.5 text-[length:var(--t-2)] leading-[1.5] ${tone}`}
      data-testid="clawai-image-allowance"
      // Announced rather than silent: on a box that has just refused a picture
      // this line is the explanation, and it changes without the user moving.
      role="status"
    >
      <span
        aria-hidden="true"
        className="material-symbols-rounded shrink-0"
        style={{ fontSize: 14 }}
      >
        {exhausted || warning ? "error" : "image"}
      </span>
      <span>
        {label}
        {exhausted ? ` · ${t("ai.imagesResetTomorrow")}` : ""}
      </span>
    </p>
  );
}
