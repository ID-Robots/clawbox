// ── Operator approvals, as the ClawBox chat shows them ──────────────────────
//
// WHAT THIS IS FOR. When the agent asks to do something the box gates — run a
// command, send mail on the owner's behalf, restart a service — OpenClaw raises
// a durable *operator approval* and waits. Every surface that can answer one
// renders it; ClawBox rendered none, so on this box the answer was "nobody
// replies and it expires". `approval.history` still holds that row:
// `system-agent:2e94af8f…`, `status: "expired"`, title "OpenClaw change",
// description "restart the Gateway" — the failure TASK-612 papered over with a
// sentence in the workspace guide, and the one TASK-704 exists to fix.
//
// HARNESS FIRST, AND THE HARNESS OWNS ALL OF IT. Nothing here invents a queue,
// a store, a code or an expiry. Read off the pinned 2026.8.1 core on the box:
//
//   * `sessions.messages.subscribe` takes `includeApprovals: true`
//     (`SessionsMessagesSubscribeParamsSchema`; the literal `true` is the only
//     accepted value). Its response then carries a bounded pending
//     `approvalReplay` — `{sessionKey, updatedAtMs, approvals, truncated}`,
//     `SessionApprovalReplaySchema` — "authoritative when `truncated` is
//     false", and the socket carries `session.approval` lifecycle events from
//     then on. `docs/gateway/protocol.md` says the opt-in needs
//     `operator.admin`, or `operator.approvals` on a **paired device**.
//   * `approval.resolve` takes `{id, kind, decision}`
//     (`ApprovalResolveParamsSchema`) and answers
//     `{applied, approval}` — "first-answer outcome plus the canonical recorded
//     state returned to all contenders" (`ApprovalResolveResultSchema`).
//   * The card's own text is `ApprovalPresentationSchema`, the core's
//     "reviewer-safe presentation discriminated by the approval owner".
//
// The ClawBox chat already makes that subscribe call, already asks for
// `operator.admin` + `operator.approvals`, and already signs a paired device
// identity — so the whole feature is one flag on a call it was making anyway.
// There is no poll here, no second RPC, no second credential and no ClawBox
// store: an approval that outlives this browser tab is still the gateway's, and
// the next subscribe replays it.
//
// TELEGRAM IS ALREADY NATIVE, which is why nothing here mints a code.
// `docs/tools/exec-approvals-advanced.md`: "When an exec or plugin approval
// request originates from a deliverable chat surface, that same chat can
// approve it with `/approve` by default … Discord, Telegram, and QQ bot also
// support same-chat `/approve`, but those channels still use their resolved
// approver list for authorization even when native approval delivery is
// disabled" — plus native approval cards when `channels.telegram.execApprovals`
// is on. A ClawBox `approve <code>` reply would be a SECOND resolver over the
// harness's own, and `approve`/`deny` are already the email verbs #713's
// inbound hook claims, so it would take the owner's approval reply away from
// the mail queue and spend its attempt budget on the way.

/** The kinds `approval.resolve` accepts. Anything else is not acted on. */
export const APPROVAL_KINDS = ["exec", "plugin", "system-agent"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** The decisions the gateway accepts; a request may offer a subset. */
export const APPROVAL_DECISIONS = ["allow-once", "allow-always", "deny"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** Every state the harness records. `pending` is the only actionable one. */
export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";

export type ApprovalSeverity = "info" | "warning" | "critical";

/** The event the opt-in subscribes to. */
export const APPROVAL_SESSION_EVENT = "session.approval";

export interface ApprovalCard {
  readonly id: string;
  readonly kind: ApprovalKind;
  /** One line naming the action, in the words its owner chose. */
  readonly headline: string;
  /** The thing itself: the command, or the description. */
  readonly detail: string;
  /** Reviewer-safe facts — host, folder, plugin, tool, blast radius. */
  readonly context: readonly string[];
  readonly decisions: readonly ApprovalDecision[];
  readonly severity: ApprovalSeverity;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly status: ApprovalStatus;
  readonly decision?: ApprovalDecision;
  /** The decision the owner pressed, while the call is in flight. */
  readonly busy?: ApprovalDecision;
  /** Why the last attempt did not reach the gateway. Never a decision. */
  readonly error?: string;
}

/** The params for the one call this rides on. */
export function sessionApprovalSubscribeParams(key: string): {
  key: string;
  includeApprovals: true;
} {
  return { key, includeApprovals: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asKind(value: unknown): ApprovalKind | null {
  return APPROVAL_KINDS.includes(value as ApprovalKind) ? (value as ApprovalKind) : null;
}

function asStatus(value: unknown): ApprovalStatus | null {
  return value === "pending" || value === "allowed" || value === "denied" || value === "expired"
    ? value
    : null;
}

function asDecision(value: unknown): ApprovalDecision | null {
  return APPROVAL_DECISIONS.includes(value as ApprovalDecision)
    ? (value as ApprovalDecision)
    : null;
}

function asDecisions(value: unknown): ApprovalDecision[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ApprovalDecision>();
  for (const entry of value) {
    const decision = asDecision(entry);
    if (decision) seen.add(decision);
  }
  // The gateway's own order, so the buttons read the same everywhere.
  return APPROVAL_DECISIONS.filter((decision) => seen.has(decision));
}

function asSeverity(value: unknown): ApprovalSeverity {
  return value === "info" || value === "warning" || value === "critical" ? value : "warning";
}

/** The blast-radius facts the owner declared, as lines a person can read. */
function scopeFacts(scope: Record<string, unknown> | null): string[] {
  if (!scope) return [];
  const target = asText(scope.target);
  switch (scope.kind) {
    case "message-send": {
      const count = typeof scope.recipientCount === "number" ? scope.recipientCount : null;
      const audience = asText(scope.audience);
      return [
        [target, count === null ? "" : `${count} recipient(s)`, audience].filter(Boolean).join(" · "),
      ].filter(Boolean);
    }
    case "payment":
      return [[asText(scope.amount), asText(scope.currency), target].filter(Boolean).join(" ")];
    case "external-post":
      return [[target, asText(scope.visibility)].filter(Boolean).join(" · ")];
    case "standing-grant":
      return [[asText(scope.automation), asText(scope.command)].filter(Boolean).join(" · ")];
    default:
      return [];
  }
}

interface Presented {
  headline: string;
  detail: string;
  context: string[];
  decisions: ApprovalDecision[];
  severity: ApprovalSeverity;
}

/**
 * The presentation, per kind.
 *
 * A kind this build has never heard of answers `null` rather than a card with
 * generic words on it: the owner is being asked to authorise something, and a
 * card that cannot say WHAT is worse than no card at all.
 */
function present(kind: ApprovalKind, raw: Record<string, unknown>): Presented | null {
  const decisions = asDecisions(raw.allowedDecisions);
  const context: string[] = [];
  if (kind === "exec") {
    const detail = asText(raw.commandText) || asText(raw.commandPreview);
    if (!detail) return null;
    for (const key of ["host", "cwd", "nodeId", "agentId"]) context.push(asText(raw[key]));
    context.push(...scopeFacts(asRecord(raw.scope)));
    return {
      headline: asText(raw.warningText) || "",
      detail,
      context: context.filter(Boolean),
      decisions,
      severity: asText(raw.warningText) ? "critical" : "warning",
    };
  }
  if (kind === "plugin") {
    const headline = asText(raw.title);
    if (!headline) return null;
    for (const key of ["pluginId", "toolName", "agentId"]) context.push(asText(raw[key]));
    context.push(...scopeFacts(asRecord(raw.scope)));
    return {
      headline,
      detail: asText(raw.description) || asText(raw.detail),
      context: context.filter(Boolean),
      decisions,
      severity: asSeverity(raw.severity),
    };
  }
  const headline = asText(raw.title);
  if (!headline) return null;
  context.push(asText(raw.agentId));
  return {
    headline,
    detail: asText(raw.description),
    context: context.filter(Boolean),
    decisions,
    severity: "warning",
  };
}

/**
 * One approval, or null when there is nothing here that can be acted on.
 *
 * Null on: a payload that is not an object, no id, a kind this build cannot
 * resolve, a presentation it cannot describe, and a PENDING approval that
 * offers no decision — a card with no button is a question with no answer.
 */
export function readApproval(raw: unknown): ApprovalCard | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = asText(record.id);
  if (!id) return null;
  const status = asStatus(record.status);
  if (!status) return null;
  const presentation = asRecord(record.presentation);
  if (!presentation) return null;
  // The id's own prefix is NOT read as the kind: the docs say a channel adapter
  // "must not … infer kind from the ID", and `approval.resolve` takes it
  // explicitly for the same reason.
  const kind = asKind(presentation.kind);
  if (!kind) return null;
  const presented = present(kind, presentation);
  if (!presented) return null;
  if (status === "pending" && presented.decisions.length === 0) return null;
  const createdAtMs = asMs(record.createdAtMs, 0);
  return {
    id,
    kind,
    headline: presented.headline || presented.detail,
    detail: presented.headline ? presented.detail : "",
    context: presented.context,
    decisions: presented.decisions,
    severity: presented.severity,
    createdAtMs,
    expiresAtMs: asMs(record.expiresAtMs, createdAtMs),
    status,
    ...(asDecision(record.decision) ? { decision: asDecision(record.decision)! } : {}),
  };
}

export interface ApprovalReplay {
  readonly cards: readonly ApprovalCard[];
  /**
   * The harness's own word for "this is not the whole set" — and what this
   * answers for a replay it could not read at all, because reporting a box it
   * could not ask as a box with nothing waiting is the false success this
   * whole feature exists to remove.
   */
  readonly truncated: boolean;
}

/** The authoritative pending set the subscribe answered with. */
export function readApprovalReplay(raw: unknown): ApprovalReplay {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.approvals)) return { cards: [], truncated: true };
  const cards: ApprovalCard[] = [];
  for (const entry of record.approvals) {
    const card = readApproval(entry);
    if (card) cards.push(card);
  }
  // An entry this could not read is a hole in the set, and the set says so.
  const truncated = record.truncated === true || cards.length !== record.approvals.length;
  return { cards, truncated };
}

/** `next` replacing any card with the same id, or appended, order preserved. */
export function mergeApprovalCard(
  cards: readonly ApprovalCard[],
  next: ApprovalCard,
): ApprovalCard[] {
  const index = cards.findIndex((card) => card.id === next.id);
  if (index < 0) return [...cards, next];
  const kept = cards[index];
  // A pushed update carries the harness's truth; the click in flight is ours,
  // and survives only while the card is still pending.
  const merged: ApprovalCard = next.status === "pending" && kept.busy
    ? { ...next, busy: kept.busy }
    : next;
  return cards.map((card, i) => (i === index ? merged : card));
}

/** The card the owner just pressed, so it cannot be pressed again. */
export function markApprovalBusy(
  cards: readonly ApprovalCard[],
  id: string,
  decision: ApprovalDecision,
): ApprovalCard[] {
  return cards.map((card) =>
    card.id === id ? { ...card, busy: decision, error: undefined } : card,
  );
}

/**
 * What the gateway RECORDED, folded into the card — never what was asked for.
 *
 * `approval.resolve` is first-answer-wins and hands every contender the
 * canonical state, so an owner who approved in Telegram a moment earlier sees
 * "allowed" here rather than an error, and nothing is resolved twice. An answer
 * that is not the documented shape leaves the card pending and says so: a
 * decision this could not read is not a decision that was taken.
 */
export function applyResolveResult(
  cards: readonly ApprovalCard[],
  id: string,
  result: unknown,
): ApprovalCard[] {
  const target = cards.find((card) => card.id === id);
  if (!target) return cards as ApprovalCard[];

  if (result instanceof Error) {
    return cards.map((card) =>
      card.id === id ? { ...card, busy: undefined, error: result.message } : card,
    );
  }

  const record = asRecord(result);
  const approval = record ? asRecord(record.approval) : null;
  const status = approval ? asStatus(approval.status === "allowed" ? "allowed" : approval.status) : null;
  if (!approval || !status || status === "pending") {
    return cards.map((card) =>
      card.id === id
        ? { ...card, busy: undefined, error: "the gateway recorded no decision" }
        : card,
    );
  }
  const decision = asDecision(approval.decision);
  return cards.map((card) =>
    card.id === id
      ? {
        ...card,
        status,
        ...(decision ? { decision } : {}),
        busy: undefined,
        error: undefined,
      }
      : card,
  );
}

/**
 * Whether pressing a button on this card could do anything.
 *
 * A window that has closed is refused HERE rather than by the gateway a second
 * later: `timeoutMs` is the request's own, the gateway rejects a late decision,
 * and offering a button that cannot work is the "false success" of the UI.
 */
export function approvalIsActionable(card: ApprovalCard, nowMs: number): boolean {
  if (card.status !== "pending") return false;
  if (card.busy) return false;
  if (card.decisions.length === 0) return false;
  return card.expiresAtMs > nowMs;
}
