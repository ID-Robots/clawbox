import { useState } from "react";

// ── The model's thinking, under the answer and out of the way ────────────────
//
// WHAT THIS REPLACES. On a Hermes box the agent's internal monologue used to be
// pasted into the reply bubble as plain text — on the live box, twice — because
// the chat route read the CLI's whole console output as "the answer". The
// monologue is now carried separately (`ChatMessage.reasoning`), and this is
// where it surfaces: collapsed by default, one click from being read.
//
// COLLAPSED IS THE POINT. Reasoning is context for a reply, not the reply, and
// a chat that opens every turn with a paragraph of the model talking to itself
// is unreadable — which is exactly the bug being fixed. So the default is shut,
// and it is deliberately NOT remembered across turns: "show me why" is a
// question about one answer, not a mode to be left switched on.
//
// State lives in this component rather than in ChatPopup's message list. Each
// bubble owns whether it is open, so expanding one cannot reflow the others and
// appending a turn cannot reshuffle which one was open.

/** Dim enough to read as an aside, bright enough to read as a control. */
const TRIGGER_FG = "rgba(255,255,255,0.55)";
const BODY_FG = "rgba(255,255,255,0.62)";
const BODY_BORDER = "rgba(255,255,255,0.12)";

export function ReasoningDisclosure({ reasoning, label }: { reasoning: string; label: string }) {
  const [open, setOpen] = useState(false);
  if (!reasoning) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        data-testid="chat-reasoning-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: 0,
          border: "none",
          background: "none",
          color: TRIGGER_FG,
          fontSize: 12,
          fontWeight: 500,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span
          className="material-symbols-rounded"
          aria-hidden="true"
          style={{
            fontSize: 16,
            transition: "transform 120ms ease",
            transform: open ? "rotate(180deg)" : "none",
          }}
        >
          expand_more
        </span>
        <span>{label}</span>
      </button>
      {open ? (
        <div
          data-testid="chat-reasoning-body"
          style={{
            marginTop: 6,
            paddingLeft: 8,
            borderLeft: `2px solid ${BODY_BORDER}`,
            color: BODY_FG,
            fontSize: 12.5,
            lineHeight: 1.45,
            // The monologue is prose the model wrote for itself: it arrives with
            // its own line breaks and no markdown worth trusting, so it is shown
            // as written rather than rendered.
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {reasoning}
        </div>
      ) : null}
    </div>
  );
}
