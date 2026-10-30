import { formatFreesUpAt } from "./clawai-allowance";
import { isRollingPauseMeter, pauseResetClock, type CodingPauseMeter, type CodingPauseReason } from "./coding-agent-status";

/**
 * WHY a paused run is paused, in the owner's language — the one sentence the
 * Coding Agent app's run page (CodingAgentApp) and the chat's run card
 * (CodingAgentActivityPill, via CodingChatCards) both show, so the two
 * surfaces cannot word the same pause two ways.
 *
 * A pause someone ASKED for needs nothing explained — whoever pressed it
 * knows — so `{ kind: "owner" }` and a record without a reason give null. A
 * pause that followed a refusal is the opposite: nobody chose it, and until
 * the allowance is back Resume only buys the same refusal, so the sentence
 * names the spent meter and says when it returns.
 */

/**
 * The sentence for each spent meter, keyed by the meter the record names.
 *
 * A table rather than a key built by hand from the meter string: the
 * catalogue parity test can only see keys that are written down, and a
 * `codingAgent.pausedAllowance${meter}` assembled at runtime would be
 * invisible to it — untranslated in nine languages, and nothing would say so.
 */
export const PAUSE_METER_KEY: Record<CodingPauseMeter, string> = {
  images: "codingAgent.pausedAllowanceImages",
  speech: "codingAgent.pausedAllowanceSpeech",
  weekly: "codingAgent.pausedAllowanceWeekly",
  burst: "codingAgent.pausedAllowanceBurst",
  embeddings: "codingAgent.pausedAllowanceEmbeddings",
  anthropic: "codingAgent.pausedAllowanceAnthropic",
};

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The full sentence for an allowance pause — "Paused: … It frees up at …" —
 * or null when there is nothing to explain.
 *
 * ClawBox AI's rolling allowances free up as old usage ages out, possibly
 * days from now: said in the owner's clock with the day in front. The per-day
 * meters keep the UTC hour they are counted in. Every Anthropic account at its
 * limit: nobody has to press Resume — the box carries on by itself at the
 * first reset, and says so rather than inviting a click that would only buy
 * the same refusal. No reset time means the far side never said when — so the
 * sentence says "once it is back" rather than inventing an hour the owner
 * would plan around.
 */
export function pauseReasonText(reason: CodingPauseReason | null | undefined, t: Translate, locale: string): string | null {
  if (!reason || reason.kind !== "allowance") return null;
  const head = t(PAUSE_METER_KEY[reason.meter]);
  let when: string;
  if (reason.meter === "anthropic") {
    const at = formatFreesUpAt(reason.resetsAt, { locale });
    when = at ? t("codingAgent.pausedAnthropicResumesAt", { time: at }) : t("codingAgent.pausedAnthropicResumes");
  } else if (isRollingPauseMeter(reason.meter)) {
    const freesUp = formatFreesUpAt(reason.resetsAt, { locale });
    when = freesUp ? t("codingAgent.pausedAllowanceFreesUp", { time: freesUp }) : t("codingAgent.pausedAllowanceResetsUnknown");
  } else {
    const clock = pauseResetClock(reason.resetsAt);
    when = clock ? t("codingAgent.pausedAllowanceResets", { time: clock }) : t("codingAgent.pausedAllowanceResetsUnknown");
  }
  return `${head} ${when}`;
}
