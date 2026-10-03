import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/chat-history-cache";
import {
  TRANSCRIPT_RECONCILE_DELAY_MS,
  cancelTranscriptReconcile,
  carryLocalNotes,
  finalAlreadyShownWithMedia,
  isAckOnlyReply,
  mergeRestoredTranscript,
  pushedSpokenReply,
  readLiveReply,
  scheduleTranscriptReconcile,
  sessionMessagePush,
  withAssistantReply,
  withPushedSpokenReply,
  type ReconcileTimer,
} from "@/lib/chat-transcript-reconcile";
import { subscribeSessionMessages } from "@/lib/gateway-approvals";
import { mediaUrl } from "@/lib/chat-media";

/**
 * TASK-1372 — the rules both chats run when a live reply and the stored
 * transcript disagree about its attachment. The component suite
 * (chat-live-attachment.test.tsx) drives the same sequences through both
 * surfaces; these pin each rule on its own.
 */

const FILE_PATH = "/tmp/clawbox-outbox/weekly-report.pdf";
const FILE_URL = mediaUrl(FILE_PATH);
const REPLY = "Here is the weekly report you asked for.";

const user = (text: string, timestamp: number, idempotencyKey?: string): ChatMessage =>
  ({ role: "user", text, timestamp, ...(idempotencyKey ? { idempotencyKey } : {}) });
const assistant = (text: string, timestamp: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ role: "assistant", text, timestamp, images: [], audio: [], ...extra });
const note = (text: string, timestamp: number): ChatMessage => ({ role: "system", text, timestamp });

/** A live final's text-only bubble, as a chat appends it (browser clock). */
const liveBubble = (timestamp = 9_000_000) => assistant(REPLY, timestamp);
/** The same reply as `chat.history` projects it (device clock, file intact). */
const storedBubble = () => assistant(REPLY, 1_001, { files: [FILE_URL] });

describe("reading a live final", () => {
  it("lifts a MEDIA: line into a file and keeps the caption", () => {
    const reply = readLiveReply({ role: "assistant", content: [{ type: "text", text: `${REPLY}\n\nMEDIA:${FILE_PATH}` }] });
    expect(reply.text).toBe(REPLY);
    expect(reply.files).toEqual([FILE_URL]);
    expect(reply.images).toEqual([]);
    expect(reply.raw).toContain("MEDIA:");
  });

  it("reads a structured attachment as a file too", () => {
    const reply = readLiveReply({
      role: "assistant",
      content: [
        { type: "text", text: REPLY },
        { type: "attachment", attachment: { url: FILE_PATH, kind: "document", mimeType: "application/pdf" } },
      ],
    });
    expect(reply.files).toHaveLength(1);
    expect(reply.files[0]).toContain(encodeURIComponent(FILE_PATH));
  });

  it("returns the words alone when the frame carries no media — the case on the box", () => {
    expect(readLiveReply({ role: "assistant", content: [{ type: "text", text: REPLY }] }))
      .toEqual({ raw: REPLY, text: REPLY, images: [], audio: [], files: [] });
  });
});

describe("which finals are only acks", () => {
  const empty = { images: [], audio: [], files: [] };
  it("an empty final, a bare 'Sent.' and a protocol sentinel", () => {
    expect(isAckOnlyReply({ text: "", ...empty })).toBe(true);
    expect(isAckOnlyReply({ text: "  Sent. ", ...empty })).toBe(true);
    expect(isAckOnlyReply({ text: "NO_REPLY", ...empty })).toBe(true);
  });

  it("never a reply that is only a file, a picture or a clip", () => {
    expect(isAckOnlyReply({ text: "", ...empty, files: [FILE_URL] })).toBe(false);
    expect(isAckOnlyReply({ text: "", ...empty, images: ["/p.png"] })).toBe(false);
    expect(isAckOnlyReply({ text: "", ...empty, audio: ["/a.wav"] })).toBe(false);
    expect(isAckOnlyReply({ text: REPLY, ...empty })).toBe(false);
  });
});

describe("the duplicate guard", () => {
  const textOnly = { text: REPLY, images: [], audio: [], files: [] };

  it("recognises a stripped final repeating the bubble the re-read painted with its file", () => {
    expect(finalAlreadyShownWithMedia(storedBubble(), textOnly)).toBe(true);
    expect(finalAlreadyShownWithMedia(assistant(REPLY, 1, { images: ["/p.png"] }), textOnly)).toBe(true);
    expect(finalAlreadyShownWithMedia(assistant(REPLY, 1, { audio: ["/a.wav"] }), textOnly)).toBe(true);
  });

  it("lets everything else through", () => {
    // The newest bubble has no media: nothing to be a stripped copy of.
    expect(finalAlreadyShownWithMedia(liveBubble(), textOnly)).toBe(false);
    // Different words, or not the agent's.
    expect(finalAlreadyShownWithMedia(assistant("Something else.", 1, { files: [FILE_URL] }), textOnly)).toBe(false);
    expect(finalAlreadyShownWithMedia(user(REPLY, 1), textOnly)).toBe(false);
    expect(finalAlreadyShownWithMedia(undefined, textOnly)).toBe(false);
    // A final carrying media of its own is not a stripped copy.
    expect(finalAlreadyShownWithMedia(storedBubble(), { ...textOnly, files: [FILE_URL] })).toBe(false);
    // An empty caption matches nothing.
    expect(finalAlreadyShownWithMedia(assistant("", 1, { files: [FILE_URL] }), { ...textOnly, text: "" })).toBe(false);
  });
});

describe("a file sent by the agent, through both orders", () => {
  const turn = user("send me the weekly report", 9_000_000, "run-1");
  const before = [assistant("Ready when you are.", 900), turn];
  const fromServer = [assistant("Ready when you are.", 900), user("send me the weekly report", 1_000, "run-1:user"), storedBubble()];

  it("final without the file, then the re-read with it: one bubble, with its card", () => {
    const afterFinal = withAssistantReply(before, liveBubble());
    expect(afterFinal.filter((m) => m.text === REPLY)).toHaveLength(1);
    expect(afterFinal.at(-1)?.files).toBeUndefined();

    const afterRead = mergeRestoredTranscript(afterFinal, fromServer);
    expect(afterRead.filter((m) => m.text === REPLY)).toEqual([storedBubble()]);
    // The optimistic user turn is matched by run id, though the clocks disagree.
    expect(afterRead.filter((m) => m.role === "user" && m.text === turn.text)).toHaveLength(1);
  });

  it("the re-read first, then the stripped final: the final adds nothing", () => {
    const afterRead = mergeRestoredTranscript(before, fromServer);
    expect(afterRead.at(-1)).toEqual(storedBubble());

    const afterFinal = withAssistantReply(afterRead, liveBubble());
    expect(afterFinal).toBe(afterRead);
  });

  it("a final that does carry the file, then the re-read: still one bubble", () => {
    const afterFinal = withAssistantReply(before, assistant(REPLY, 9_000_001, { files: [FILE_URL] }));
    const afterRead = mergeRestoredTranscript(afterFinal, fromServer);
    expect(afterRead.filter((m) => m.text === REPLY)).toHaveLength(1);
    expect(afterRead.at(-1)?.files).toEqual([FILE_URL]);
  });

  it("the re-read first, then a final that DOES carry the same file: still one bubble", () => {
    const afterRead = mergeRestoredTranscript(before, fromServer);
    const afterFinal = withAssistantReply(afterRead, assistant(REPLY, 9_000_001, { files: [FILE_URL] }));
    expect(afterFinal).toBe(afterRead);
  });

  it("a final carrying a file the bubble above does not have is a new reply", () => {
    const afterRead = mergeRestoredTranscript(before, fromServer);
    const other = mediaUrl("/tmp/clawbox-outbox/other.pdf");
    const afterFinal = withAssistantReply(afterRead, assistant(REPLY, 9_000_001, { files: [other] }));
    expect(afterFinal).toHaveLength(afterRead.length + 1);
  });

  it("the same words in the NEXT turn are a new reply, not a duplicate", () => {
    const shown = [...fromServer, user("again please", 9_000_100, "run-2")];
    const next = withAssistantReply(shown, liveBubble(9_000_200));
    expect(next).toHaveLength(shown.length + 1);
  });
});

describe("appending a finished reply", () => {
  it("folds a spoken half into the bubble it repeats, once", () => {
    const shown = [user("hi", 1), assistant("Sure.", 2)];
    const withVoice = withAssistantReply(shown, assistant("Sure.", 3, { audio: ["/a.wav"] }));
    expect(withVoice).toHaveLength(2);
    expect(withVoice[1].audio).toEqual(["/a.wav"]);
    expect(withAssistantReply(withVoice, assistant("Sure.", 4, { audio: ["/a.wav"] }))).toBe(withVoice);
  });

  it("appends anything else", () => {
    const shown = [user("hi", 1)];
    expect(withAssistantReply(shown, assistant("Hello!", 2))).toEqual([...shown, assistant("Hello!", 2)]);
  });
});

describe("a session.message push", () => {
  it("is this chat's when it names this session or none", () => {
    const message = { role: "assistant", content: "x" };
    expect(sessionMessagePush({ sessionKey: "agent:main:main", message }, "agent:main:main")).toEqual({ message });
    expect(sessionMessagePush({ message }, "agent:main:main")).toEqual({ message });
  });

  it("is ignored when it names another session, or carries nothing", () => {
    expect(sessionMessagePush({ sessionKey: "agent:main:other", message: {} }, "agent:main:main")).toBeNull();
    expect(sessionMessagePush(undefined, "agent:main:main")).toBeNull();
    expect(sessionMessagePush("nope", "agent:main:main")).toBeNull();
  });
});

describe("a pushed spoken reply", () => {
  const spokenMessage = (text: string, timestamp?: number) => ({
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "attachment", attachment: { url: "/v/voice.wav", kind: "audio", mimeType: "audio/wav" } },
    ],
    ...(timestamp !== undefined ? { timestamp } : {}),
  });

  it("is read only off an assistant message that carries audio", () => {
    expect(pushedSpokenReply({ role: "assistant", content: [{ type: "text", text: "Sure." }] })).toBeNull();
    expect(pushedSpokenReply({ ...spokenMessage("Sure."), role: "user" })).toBeNull();
    const spoken = pushedSpokenReply(spokenMessage("Sure.", 42));
    expect(spoken?.text).toBe("Sure.");
    expect(spoken?.timestamp).toBe(42);
    expect(spoken?.audio).toHaveLength(1);
  });

  it("gives its clip to the matching bubble of THIS turn, once", () => {
    const spoken = pushedSpokenReply(spokenMessage("Sure."))!;
    const shown = [user("first", 1), assistant("Sure.", 2), user("second", 3), assistant("Sure.", 4)];
    const next = withPushedSpokenReply(shown, spoken);
    expect(next[1].audio).toEqual([]);
    expect(next[3].audio).toEqual(spoken.audio);
    expect(withPushedSpokenReply(next, spoken)).toBe(next);
  });

  it("waits for a caption it cannot find, and appends a reply that has none", () => {
    const shown = [user("first", 1)];
    expect(withPushedSpokenReply(shown, pushedSpokenReply(spokenMessage("Sure."))!)).toBe(shown);
    const audioOnly = withPushedSpokenReply(shown, pushedSpokenReply(spokenMessage("", 7))!);
    expect(audioOnly).toHaveLength(2);
    expect(audioOnly[1]).toMatchObject({ role: "assistant", text: "", timestamp: 7 });
  });
});

describe("the coalesced re-read", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("runs once for a burst of pushes, after the burst settles", () => {
    vi.useFakeTimers();
    const timer: ReconcileTimer = { current: null };
    const run = vi.fn();
    scheduleTranscriptReconcile(timer, run);
    vi.advanceTimersByTime(TRANSCRIPT_RECONCILE_DELAY_MS - 1);
    scheduleTranscriptReconcile(timer, run);
    scheduleTranscriptReconcile(timer, run);
    vi.advanceTimersByTime(TRANSCRIPT_RECONCILE_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(timer.current).toBeNull();
  });

  it("is called off by cancel", () => {
    vi.useFakeTimers();
    const timer: ReconcileTimer = { current: null };
    const run = vi.fn();
    scheduleTranscriptReconcile(timer, run);
    cancelTranscriptReconcile(timer);
    vi.advanceTimersByTime(TRANSCRIPT_RECONCILE_DELAY_MS * 2);
    expect(run).not.toHaveBeenCalled();
    expect(timer.current).toBeNull();
  });
});

describe("merging a history read", () => {
  it("takes the server's list on a first read", () => {
    const server = [assistant("Hello", 1)];
    expect(mergeRestoredTranscript([], server)).toBe(server);
  });

  it("hands back the list on screen when the read changed nothing", () => {
    const shown = [user("hi", 1, "r:user"), assistant("Hello", 2)];
    expect(mergeRestoredTranscript(shown, shown.map((m) => ({ ...m })))).toBe(shown);
  });

  it("keeps a turn the server has not stored yet", () => {
    const shown = [assistant("Hello", 1), user("are you there?", 9_000_000, "run-9")];
    const next = mergeRestoredTranscript(shown, [assistant("Hello", 1)]);
    expect(next.map((m) => m.text)).toEqual(["Hello", "are you there?"]);
  });

  it("drops notes unless asked to keep them", () => {
    const shown = [user("hi", 9_000_000, "r1"), note("That did not work.", 9_000_001)];
    const server = [user("hi", 1, "r1:user")];
    expect(mergeRestoredTranscript(shown, server).some((m) => m.role === "system")).toBe(false);
    expect(mergeRestoredTranscript(shown, server, { keepLocalNotes: true }).map((m) => m.text))
      .toEqual(["hi", "That did not work."]);
  });
});

describe("carrying the chat's own notes", () => {
  it("returns the read untouched when there are no notes", () => {
    const next = [assistant("a", 1)];
    expect(carryLocalNotes([assistant("a", 5)], next)).toBe(next);
  });

  it("keeps a note right after the message it followed", () => {
    const shown = [user("q1", 10), assistant("a1", 11), note("Another model answered.", 12), user("q2", 13)];
    const server = [user("q1", 1), assistant("a1", 2), user("q2", 3), assistant("a2", 4)];
    expect(carryLocalNotes(shown, server).map((m) => m.text)).toEqual(["q1", "a1", "Another model answered.", "q2", "a2"]);
  });

  it("puts a note after a reply the box has not stored yet at the end", () => {
    const shown = [user("q1", 10), assistant("live only", 11), note("Another model answered.", 12)];
    const server = [user("q1", 1)];
    expect(carryLocalNotes(shown, server).map((m) => m.text)).toEqual(["q1", "Another model answered."]);
  });

  it("places a note before the next stored message when the one it followed changed", () => {
    const shown = [user("q1", 10), assistant("live words", 11), note("n", 12), user("q2", 13)];
    const server = [user("q1", 1), assistant("stored words", 2), user("q2", 3)];
    expect(carryLocalNotes(shown, server).map((m) => m.text)).toEqual(["q1", "stored words", "n", "q2"]);
  });

  it("aligns in order, so a repeated 'Sure.' the window dropped does not drag a note forward", () => {
    const shown = [assistant("Sure.", 1), note("old note", 2), user("q", 3), assistant("Sure.", 4), note("new note", 5)];
    const server = [user("q", 30), assistant("Sure.", 40)];
    expect(carryLocalNotes(shown, server).map((m) => m.text)).toEqual(["old note", "q", "Sure.", "new note"]);
  });

  it("keeps several notes in their order, and does not double a note the harness stored", () => {
    const shown = [user("q", 1), note("first", 2), note("second", 3)];
    expect(carryLocalNotes(shown, [user("q", 10)]).map((m) => m.text)).toEqual(["q", "first", "second"]);
    expect(carryLocalNotes(shown, [user("q", 10), note("first", 11)]).map((m) => m.text)).toEqual(["q", "first", "second"]);
  });
});

describe("subscribing to a session's transcript", () => {
  it("sends the plain frame and says it was taken", async () => {
    const request = vi.fn(async () => ({}));
    await expect(subscribeSessionMessages(request, "agent:main:main")).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("sessions.messages.subscribe", { key: "agent:main:main" });
  });

  it("never throws on a gateway that refuses it", async () => {
    await expect(subscribeSessionMessages(async () => { throw new Error("unknown method"); }, "k")).resolves.toBe(false);
  });
});
