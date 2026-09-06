// A pending operator approval, as the ClawBox chat has to read it.
//
// TASK-704, and the failure behind TASK-612: the agent proposed "restart the
// Gateway", OpenClaw raised an operator approval for it, and ClawBox rendered
// none — so it sat there until it expired. `approval.history` on the OpenClaw
// box still holds that row (`system-agent:…`, `status: "expired"`, title
// "OpenClaw change", description "restart the Gateway").
//
// EVERYTHING HERE IS THE HARNESS'S OWN SHAPE, read off the pinned 2026.8.1 core
// rather than invented: `ApprovalPresentationSchema` (exec / plugin /
// system-agent), `SessionApprovalReplaySchema`
// (`{sessionKey, updatedAtMs, approvals, truncated}`), `ApprovalResolveParams`
// (`{id, kind, decision}`) and `ApprovalResolveResult`
// (`{applied, approval}` — "first-answer outcome plus the canonical recorded
// state returned to all contenders").

import { describe, expect, it } from "vitest";

import {
  APPROVAL_NO_DECISION_RECORDED,
  APPROVAL_SESSION_EVENT,
  approvalsAfterReplay,
  approvalsAfterResolve,
  approvalIsActionable,
  markApprovalBusy,
  mergeApprovalCard,
  readApproval,
  readApprovalReplay,
  sessionApprovalSubscribeParams,
  subscribeSessionApprovals,
} from "@/lib/gateway-approvals";

const NOW = 1_788_300_000_000;

function pendingExec(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    id: "exec:3f1c",
    urlPath: "/approve/exec%3A3f1c",
    createdAtMs: NOW - 1_000,
    expiresAtMs: NOW + 120_000,
    presentation: {
      kind: "exec",
      commandText: "systemctl restart clawbox-gateway",
      host: "local",
      nodeId: "node-1",
      warningText: "Restarts a service",
      allowedDecisions: ["allow-once", "deny"],
    },
    ...overrides,
  };
}

function pendingSystemAgent() {
  return {
    status: "pending",
    id: "system-agent:2e94af8f",
    urlPath: "/approve/system-agent%3A2e94af8f",
    createdAtMs: NOW - 5_000,
    expiresAtMs: NOW + 600_000,
    presentation: {
      kind: "system-agent",
      title: "OpenClaw change",
      description: "restart the Gateway",
      proposalHash: "0d05745037e3",
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}

describe("the subscription this rides on", () => {
  it("is the one the chat already makes, with the documented opt-in", () => {
    // `sessions.messages.subscribe` with `includeApprovals: true` is the whole
    // data path: the response carries the authoritative pending set and the
    // socket then carries `session.approval`. No poll, no second RPC, no
    // second credential — the chat already asks for `operator.approvals` and
    // already sends a paired device identity, which is what the opt-in needs.
    expect(sessionApprovalSubscribeParams("main")).toEqual({
      key: "main",
      includeApprovals: true,
    });
    expect(APPROVAL_SESSION_EVENT).toBe("session.approval");
  });
});

describe("the subscribe itself", () => {
  function replayResponse(approvals: unknown[], truncated = false) {
    return { approvalReplay: { sessionKey: "main", updatedAtMs: NOW, approvals, truncated } };
  }

  it("takes the authoritative pending set, once, on the call the chat already makes", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const seen: Array<{ ids: string[]; forKey: string }> = [];
    await subscribeSessionApprovals(
      async (method, params) => {
        calls.push({ method, params });
        return replayResponse([pendingExec()]);
      },
      "main",
      (replay, forKey) => seen.push({ ids: replay.cards.map((c) => c.id), forKey }),
    );
    expect(calls).toEqual([
      { method: "sessions.messages.subscribe", params: { key: "main", includeApprovals: true } },
    ]);
    expect(seen).toEqual([{ ids: ["exec:3f1c"], forKey: "main" }]);
  });

  it("hands the KEY back with the answer, because nothing cancels a slow one", () => {
    // The call is not cancelled when the owner switches conversation, so a
    // subscribe for the tab they left can resolve after the next one. The
    // caller needs to know which conversation the cards belong to.
    expect.assertions(1);
    return subscribeSessionApprovals(
      async () => replayResponse([pendingExec()]),
      "the-tab-they-left",
      (_replay, forKey) => expect(forKey).toBe("the-tab-they-left"),
    );
  });

  it("keeps the transcript subscription when the approval opt-in is refused", async () => {
    // The opt-in is not soft: the core refuses the WHOLE subscribe — and rolls
    // the message subscription back — when the client may not review approvals.
    // Losing the cards is a blemish; losing the pushes is a chat that silently
    // stops showing what lands in it.
    const calls: unknown[] = [];
    await subscribeSessionApprovals(
      async (_method, params) => {
        calls.push(params);
        if ((params as { includeApprovals?: unknown }).includeApprovals === true) {
          throw new Error("operator approvals not permitted");
        }
        return {};
      },
      "main",
      () => {},
    );
    expect(calls).toEqual([{ key: "main", includeApprovals: true }, { key: "main" }]);
  });

  it("takes the cards away when it is refused, and keeps what already happened", async () => {
    // This connection can no longer be told what became of them, so a live
    // button over one would be "waiting" over something already decided.
    const seen: Array<{ truncated: boolean; count: number }> = [];
    await subscribeSessionApprovals(
      async () => { throw new Error("nope"); },
      "main",
      (replay) => seen.push({ truncated: replay.truncated, count: replay.cards.length }),
    );
    // An AUTHORITATIVE empty replay: `approvalsAfterReplay` drops the pending
    // cards on it and keeps the terminal ones.
    expect(seen).toEqual([{ truncated: false, count: 0 }]);
    const before = [readApproval(pendingExec())!, readApproval({ ...pendingExec(), id: "exec:done", status: "denied", reason: "user" })!];
    expect(approvalsAfterReplay(before, { cards: [], truncated: false }).map((c) => c.id)).toEqual(["exec:done"]);
  });

  it("never throws, whatever the gateway does", async () => {
    await expect(
      subscribeSessionApprovals(async () => { throw new Error("gone"); }, "main", () => {}),
    ).resolves.toBeUndefined();
  });
});

describe("reading one approval", () => {
  it("reads an exec approval the way the reviewer needs to see it", () => {
    const card = readApproval(pendingExec());
    expect(card).toMatchObject({
      id: "exec:3f1c",
      kind: "exec",
      detail: "systemctl restart clawbox-gateway",
      status: "pending",
      decisions: ["allow-once", "deny"],
      expiresAtMs: NOW + 120_000,
    });
    expect(card?.context).toContain("local");
    expect(card?.context).toContain("node-1");
    // The warning is the headline; the command is never folded into it.
    expect(card?.headline).toBe("Restarts a service");
  });

  it("keeps the command in the detail even when the request states no warning", () => {
    // `warningText` is optional and usually absent, and folding the detail up
    // into an empty headline put the COMMAND in the prose line — rendered in
    // the UI font with its line breaks collapsed, on the one card whose whole
    // job is showing exactly what will run.
    const plain = pendingExec();
    delete (plain.presentation as Record<string, unknown>).warningText;
    const card = readApproval(plain);
    expect(card?.headline).toBe("");
    expect(card?.detail).toBe("systemctl restart clawbox-gateway");
  });

  it("reads the system-agent approval that TASK-612 watched expire", () => {
    expect(readApproval(pendingSystemAgent())).toMatchObject({
      id: "system-agent:2e94af8f",
      kind: "system-agent",
      headline: "OpenClaw change",
      detail: "restart the Gateway",
      decisions: ["allow-once", "deny"],
    });
  });

  it("reads a plugin approval, its severity and what it would touch", () => {
    const card = readApproval({
      status: "pending",
      id: "plugin:9ab",
      urlPath: "/approve/plugin%3A9ab",
      createdAtMs: NOW,
      expiresAtMs: NOW + 600_000,
      presentation: {
        kind: "plugin",
        title: "Send customer update",
        description: "Email three people outside the house",
        severity: "critical",
        pluginId: "mailer",
        toolName: "email_send",
        detail: "three addresses, none of them yours",
        scope: { kind: "message-send", target: "email", recipientCount: 3, audience: "external" },
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    });
    expect(card).toMatchObject({
      kind: "plugin",
      headline: "Send customer update",
      severity: "critical",
      decisions: ["allow-once", "allow-always", "deny"],
    });
    expect(card?.context.join(" ")).toContain("email");
    // `description` is required and `detail` is the extra specifics: both are
    // shown, because dropping the specific half of the text on the card the
    // owner authorises from is exactly the wrong half to lose.
    expect(card?.detail).toBe("Email three people outside the house");
    expect(card?.context).toContain("three addresses, none of them yours");
  });

  it("keeps an approval with no stated expiry open", () => {
    // No expiry stated is NO LOCAL EXPIRY. Falling back to the creation time
    // put the card instantly past its window — "nobody answered in time" over
    // an approval the gateway is still holding open.
    const open = pendingExec();
    delete (open as Record<string, unknown>).expiresAtMs;
    const card = readApproval(open)!;
    expect(approvalIsActionable(card, NOW + 86_400_000)).toBe(true);
  });

  it("keeps a terminal answer, so a card never sits unanswered", () => {
    // The failure that produced TASK-612 was a card with no end state. Every
    // status the harness can record has to come back as one.
    for (const [raw, expected] of [
      [{ status: "allowed", decision: "allow-once", reason: "user" }, "allowed"],
      [{ status: "denied", reason: "user" }, "denied"],
      [{ status: "expired", reason: "timeout" }, "expired"],
    ] as const) {
      const card = readApproval({ ...pendingExec(), ...raw });
      expect(card?.status).toBe(expected);
      expect(approvalIsActionable(card!, NOW)).toBe(false);
    }
  });

  it("answers nothing for a payload it cannot act on", () => {
    expect(readApproval(null)).toBeNull();
    expect(readApproval({ status: "pending", id: "", presentation: { kind: "exec" } })).toBeNull();
    // A kind this build does not know is not guessed at: a card offering
    // buttons it cannot name is worse than no card.
    expect(readApproval({ ...pendingExec(), presentation: { kind: "quantum", allowedDecisions: ["deny"] } })).toBeNull();
    // Pending with no offered decision is a card with nothing to press.
    expect(readApproval({ ...pendingExec(), presentation: { kind: "exec", commandText: "ls", allowedDecisions: [] } })).toBeNull();
  });

  it("refuses an approval whose window has already closed", () => {
    // Honest rather than hopeful: the button would be refused by the gateway,
    // and offering it invites the owner to press a thing that cannot work.
    const card = readApproval(pendingExec({ expiresAtMs: NOW - 1 }));
    expect(card?.status).toBe("pending");
    expect(approvalIsActionable(card!, NOW)).toBe(false);
    expect(approvalIsActionable(card!, NOW - 60_000)).toBe(true);
  });
});

describe("the authoritative pending set the subscribe answers with", () => {
  it("reads every approval and says whether it was the whole set", () => {
    const replay = readApprovalReplay({
      sessionKey: "main",
      updatedAtMs: NOW,
      approvals: [pendingExec(), pendingSystemAgent()],
      truncated: false,
    });
    expect(replay.cards.map((c) => c.id)).toEqual(["exec:3f1c", "system-agent:2e94af8f"]);
    expect(replay.truncated).toBe(false);
  });

  it("treats a missing or unreadable replay as no answer, not as an empty one", () => {
    // `truncated` is the harness's own word for "this is not the whole set".
    // Anything this cannot read has to say the same, or the chat would report
    // a quiet box as a box with nothing waiting.
    expect(readApprovalReplay(undefined)).toEqual({ cards: [], truncated: true });
    expect(readApprovalReplay({ approvals: "no" })).toEqual({ cards: [], truncated: true });
    expect(readApprovalReplay({ approvals: [pendingExec()], truncated: true }).truncated).toBe(true);
  });
});

describe("what an authoritative replay is allowed to do", () => {
  it("drops a pending card the whole set no longer mentions", () => {
    const before = [readApproval(pendingExec())!, readApproval(pendingSystemAgent())!];
    const after = approvalsAfterReplay(before, {
      cards: [readApproval(pendingSystemAgent())!],
      truncated: false,
    });
    expect(after.map((c) => c.id)).toEqual(["system-agent:2e94af8f"]);
  });

  it("removes nothing on a replay that says it is not the whole set", () => {
    // The gateway is the truth for what is GONE, and it says so through
    // `session.approval`. A truncated replay removing a card would make a
    // question vanish with no end state — the failure this whole card exists
    // to remove.
    const before = [readApproval(pendingExec())!, readApproval(pendingSystemAgent())!];
    const after = approvalsAfterReplay(before, { cards: [], truncated: true });
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
  });

  it("keeps what has already been answered, whatever the replay holds", () => {
    // A terminal card is what the owner READS to learn what happened; the
    // replay only ever carries pending rows.
    const denied = readApproval({ ...pendingExec(), status: "denied", reason: "user" })!;
    const after = approvalsAfterReplay([denied], { cards: [], truncated: false });
    expect(after.map((c) => c.id)).toEqual([denied.id]);
    expect(after[0].status).toBe("denied");
  });
});

describe("keeping the cards in step with the harness", () => {
  it("replaces a card by id and keeps the order it arrived in", () => {
    const first = readApproval(pendingExec())!;
    const second = readApproval(pendingSystemAgent())!;
    const cards = mergeApprovalCard(mergeApprovalCard([], first), second);
    expect(cards.map((c) => c.id)).toEqual([first.id, second.id]);

    const resolved = readApproval({ ...pendingExec(), status: "denied", reason: "user" })!;
    const after = mergeApprovalCard(cards, resolved);
    expect(after.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(after[0].status).toBe("denied");
  });

  it("marks the card the owner pressed, so it cannot be pressed twice", () => {
    const cards = mergeApprovalCard([], readApproval(pendingExec())!);
    const busy = markApprovalBusy(cards, "exec:3f1c", "allow-once");
    expect(busy[0].busy).toBe("allow-once");
    expect(approvalIsActionable(busy[0], NOW)).toBe(false);
  });
});

describe("what the gateway records is what the card shows", () => {
  it("shows the owner's own answer", () => {
    const cards = markApprovalBusy(
      mergeApprovalCard([], readApproval(pendingExec())!),
      "exec:3f1c",
      "allow-once",
    );
    const after = approvalsAfterResolve(cards, "exec:3f1c", {
      applied: true,
      approval: { status: "allowed", decision: "allow-once", reason: "user", resolvedAtMs: NOW },
    });
    expect(after[0]).toMatchObject({ status: "allowed", decision: "allow-once" });
    expect(after[0].busy).toBeUndefined();
  });

  it("shows the answer somebody ELSE gave first, and calls it no failure", () => {
    // `approval.resolve` is first-answer-wins and hands every contender the
    // canonical recorded state. The owner approving in the chat a moment after
    // approving it in Telegram must see "allowed", not an error — and the
    // approval must not be resolved twice, which the gateway guarantees and
    // this must not undo by retrying.
    const cards = markApprovalBusy(
      mergeApprovalCard([], readApproval(pendingExec())!),
      "exec:3f1c",
      "deny",
    );
    const after = approvalsAfterResolve(cards, "exec:3f1c", {
      applied: false,
      approval: { status: "allowed", decision: "allow-once", reason: "user", resolvedAtMs: NOW },
    });
    expect(after[0]).toMatchObject({ status: "allowed", decision: "allow-once" });
    expect(after[0].error).toBeUndefined();
  });

  it("says so when the call itself failed, and lets the owner try again", () => {
    const cards = markApprovalBusy(
      mergeApprovalCard([], readApproval(pendingExec())!),
      "exec:3f1c",
      "allow-once",
    );
    const after = approvalsAfterResolve(cards, "exec:3f1c", new Error("Not connected"));
    expect(after[0].status).toBe("pending");
    expect(after[0].busy).toBeUndefined();
    expect(after[0].error).toContain("Not connected");
    expect(approvalIsActionable(after[0], NOW)).toBe(true);
  });

  it("never reports a decision the gateway did not record", () => {
    // The false-success guard. An answer that is not the documented shape is
    // not read as "it worked".
    const cards = markApprovalBusy(
      mergeApprovalCard([], readApproval(pendingExec())!),
      "exec:3f1c",
      "allow-once",
    );
    for (const bad of [undefined, null, {}, { applied: true }, { applied: true, approval: {} }]) {
      const after = approvalsAfterResolve(cards, "exec:3f1c", bad);
      expect(after[0].status).toBe("pending");
      // A MARKER, not a sentence: `error` otherwise carries the gateway's own
      // words, and a line this module wrote would be the one English sentence
      // on a card whose every other word is in the owner's language.
      expect(after[0].error).toBe(APPROVAL_NO_DECISION_RECORDED);
    }
  });
});
