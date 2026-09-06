// The approve/deny card for one pending operator approval.
//
// The reading and the state machine are `gateway-approvals.ts`; this is the
// face. Shaped after `chat-clarify.tsx` deliberately — both are "the agent is
// blocked, waiting on the person at the box", and two different-looking cards
// for the same situation would be a third thing for the owner to learn.
//
// A card NEVER disappears without saying what happened. That is the failure
// behind TASK-612: an approval nothing rendered sat until it expired, and the
// only trace of it is a row in `approval.history`. So a resolved, denied or
// expired approval keeps its card and says which — greyed, without controls.

import { useT } from "@/lib/i18n";
import {
  APPROVAL_NO_DECISION_RECORDED,
  approvalIsActionable,
  type ApprovalCard,
  type ApprovalDecision,
} from "@/lib/gateway-approvals";

const CARD_BG = "rgba(249,115,22,0.10)";
const CARD_BORDER = "1px solid rgba(249,115,22,0.28)";
const CRITICAL_BG = "rgba(239,68,68,0.10)";
const CRITICAL_BORDER = "1px solid rgba(239,68,68,0.35)";
const TITLE_FG = "#fed7aa";
const CRITICAL_FG = "#fca5a5";
const BODY_FG = "rgba(255,255,255,0.72)";
const MUTED_FG = "rgba(255,255,255,0.5)";

/** The label for each decision the request offered, in the gateway's order. */
const DECISION_LABEL: Record<ApprovalDecision, string> = {
  "allow-once": "chat.approval.allowOnce",
  "allow-always": "chat.approval.allowAlways",
  deny: "chat.approval.deny",
};

export interface ApprovalPromptProps {
  card: ApprovalCard;
  /** Now, passed in so the expiry check is the caller's clock and testable. */
  nowMs: number;
  /** Resolve through the gateway. One call per press; the caller marks it busy. */
  onDecide: (card: ApprovalCard, decision: ApprovalDecision) => void | Promise<void>;
}

export function ApprovalPrompt({ card, nowMs, onDecide }: ApprovalPromptProps) {
  const { t } = useT();
  const actionable = approvalIsActionable(card, nowMs);
  // Pending but past its window is NOT "still waiting": the gateway would
  // refuse the decision, so the card says the same thing the gateway would.
  const lapsed = card.status === "expired" || (card.status === "pending" && card.expiresAtMs <= nowMs);
  const settled = card.status !== "pending" || lapsed;
  const critical = card.severity === "critical";

  const ending = card.status === "allowed"
    ? t("chat.approval.allowed")
    : card.status === "denied"
      ? t("chat.approval.denied")
      : lapsed
        ? t("chat.approval.expired")
        : "";

  return (
    <div
      data-testid="chat-approval"
      data-approval-id={card.id}
      data-approval-kind={card.kind}
      data-approval-status={lapsed && card.status === "pending" ? "expired" : card.status}
      style={{
        alignSelf: "flex-start",
        maxWidth: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        borderRadius: 12,
        background: critical ? CRITICAL_BG : CARD_BG,
        border: critical ? CRITICAL_BORDER : CARD_BORDER,
        // Settled is a state to SEE. The card stays so a question the box asked
        // never silently vanishes, and it is obviously no longer a control.
        opacity: settled ? 0.6 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: critical ? CRITICAL_FG : TITLE_FG,
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 15 }}>
          {critical ? "warning" : "gavel"}
        </span>
        <span>{t("chat.approval.title")}</span>
      </div>

      {card.headline ? (
        <div
          data-testid="chat-approval-headline"
          style={{ color: BODY_FG, fontSize: 13, lineHeight: 1.4, wordBreak: "break-word" }}
        >
          {card.headline}
        </div>
      ) : null}

      {card.detail ? (
        <div
          data-testid="chat-approval-detail"
          style={{
            color: BODY_FG,
            fontSize: 12.5,
            lineHeight: 1.4,
            wordBreak: "break-word",
            // The command as written, because that is the thing being judged.
            fontFamily: card.kind === "exec" ? "ui-monospace, monospace" : "inherit",
            whiteSpace: "pre-wrap",
          }}
        >
          {card.detail}
        </div>
      ) : null}

      {card.context.length > 0 ? (
        <div data-testid="chat-approval-context" style={{ color: MUTED_FG, fontSize: 12, wordBreak: "break-word" }}>
          {card.context.join(" · ")}
        </div>
      ) : null}

      {settled ? (
        <div
          data-testid="chat-approval-result"
          role="status"
          aria-live="polite"
          style={{ color: MUTED_FG, fontSize: 12.5 }}
        >
          {ending}
        </div>
      ) : (
        <>
          {/* The one state that needs the owner to DO something is the one
              that arrives on its own — from the replay or from a
              `session.approval` push — so it is the one that has to announce
              itself. The terminal line and the failure line already do. */}
          <div
            role="status"
            aria-live="polite"
            style={{ color: MUTED_FG, fontSize: 12, lineHeight: 1.4 }}
          >
            {t("chat.approval.summary")}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {card.decisions.map((decision) => (
              <button
                key={decision}
                type="button"
                data-testid="chat-approval-decision"
                data-decision={decision}
                // `aria-disabled`, never the native attribute: a disabled
                // button leaves the tab order, so the keyboard user loses the
                // card the moment a press is in flight. Same rule the email
                // batch card follows, and the handler is what refuses.
                aria-disabled={!actionable}
                onClick={() => {
                  if (!actionable) return;
                  void onDecide(card, decision);
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  fontSize: 12.5,
                  cursor: actionable ? "pointer" : "default",
                  opacity: actionable ? 1 : 0.5,
                  border: decision === "deny"
                    ? "1px solid rgba(255,255,255,0.22)"
                    : "1px solid rgba(249,115,22,0.5)",
                  background: decision === "deny" ? "transparent" : "rgba(249,115,22,0.18)",
                  color: decision === "deny" ? BODY_FG : TITLE_FG,
                }}
              >
                {card.busy === decision ? t("chat.approval.working") : t(DECISION_LABEL[decision])}
              </button>
            ))}
          </div>
        </>
      )}

      {card.error ? (
        // The gateway's OWN words beside the box's. It has permanent refusals
        // on this path — an id it cannot see, a record bound to another
        // reviewer's device, a window that closed — and a fixed "try again"
        // over one of those is a false failure that invites a retry which can
        // never work. The line the box owns says only what it knows; the
        // reason underneath is the gateway's.
        <div
          data-testid="chat-approval-error"
          role="alert"
          style={{ color: CRITICAL_FG, fontSize: 12.5, wordBreak: "break-word" }}
        >
          <div>{t("chat.approval.failed")}</div>
          <div data-testid="chat-approval-error-reason" style={{ color: MUTED_FG, marginTop: 2 }}>
            {card.error === APPROVAL_NO_DECISION_RECORDED
              ? t("chat.approval.unreadable")
              : card.error}
          </div>
        </div>
      ) : null}
    </div>
  );
}
