// Transport-level sentinels the gateway/LLM emits as standalone chat replies.
// They have no signal for the user. Two consumers handle them differently:
//
//   - ChatPopup (mascot mini-chat) drops them entirely — silent keep-alives.
//   - ChatApp (full Control UI) swaps them for a friendly mascot line via
//     `prettifyAssistantText`, so the chat doesn't go quiet for ~10s when a
//     model echoes back HEARTBEAT_OK.
//
// `SENTINEL_RE` matches NO_REPLY plus any HEARTBEAT_* variant
// (HEARTBEAT_OK, HEARTBEAT_PONG, …). Earlier versions also matched bare
// tokens like "OK"/"DONE"/"ACK", which corrupted real chat history when a
// model legitimately replied with one of those words.

export const SENTINEL_RE = /^\s*(NO_REPLY|HEARTBEAT(?:_[A-Z]+)?)\s*$/;

export function isSentinel(text: string | null | undefined): boolean {
  return !!text && SENTINEL_RE.test(text);
}

const PROTOCOL_SENTINEL_REPLIES = [
  "still here, scuttling around 🦀",
  "all good, boss",
  "pulse normal — claws warm",
  "*waves a claw*",
  "standing by 👂",
  "reporting for duty",
  "mhm. carry on.",
  "box secured. crab secured.",
  "I exist and I'm vibing ✨",
  "crab.exe responded successfully",
  "you got it 👍",
  "check, check — mic still works",
  "*nods sagely*",
  "I heard that, by the way 🦀",
  "OK but make it cooler:",
  "roger that 🛰️",
  "yep, alive. promise.",
  "system: somewhat caffeinated ☕",
];

export function prettifyAssistantText(text: string): string {
  if (!isSentinel(text)) return text;
  return PROTOCOL_SENTINEL_REPLIES[Math.floor(Math.random() * PROTOCOL_SENTINEL_REPLIES.length)];
}
