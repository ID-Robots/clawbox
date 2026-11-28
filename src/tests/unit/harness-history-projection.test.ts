import { describe, expect, it } from "vitest";
import { projectGatewayHistory } from "@/lib/harness/openclaw-gateway-adapter";

/**
 * The golden fixture for the history projection.
 *
 * The projection is not one rule; it is about six independent shipped fixes
 * living in one loop, each written against a real customer report. This file
 * exists so that moving it — now, or the next time someone is tempted to tidy
 * it — is a diff-is-empty check rather than an act of faith.
 *
 * Every case below names the failure it prevents.
 */

const assistant = (text: string, timestamp: number, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp,
  ...extra,
});
const user = (text: string, timestamp: number, extra: Record<string, unknown> = {}) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
  ...extra,
});

/**
 * A real image-generation failure, in the shape the gateway actually sends it:
 * a background-job result routed back as `role: "user"` with inter-session
 * provenance. Both predicates read it, which is precisely why the ORDER of the
 * two checks in the projection matters.
 */
const failureNotice = (timestamp: number) => ({
  role: "user",
  content: [
    {
      type: "text",
      text: [
        "A background task failed",
        "session_key: agent:sub:1",
        "sourceTool: image_generate",
        "status: failed",
      ].join("\n"),
    },
  ],
  timestamp,
  provenance: { kind: "inter_session" },
});

describe("projectGatewayHistory", () => {
  it("keeps ordinary turns, and only ordinary turns", () => {
    const { messages } = projectGatewayHistory(
      [user("what is the weather", 100), assistant("Sunny.", 200), { role: "tool", text: "x" }],
      null,
    );
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "what is the weather"],
      ["assistant", "Sunny."],
    ]);
  });

  it("strips gateway wrapper tags rather than rendering them", () => {
    const { messages } = projectGatewayHistory([assistant("<final>Done.</final>", 100)], null);
    expect(messages[0].text).toBe("Done.");
  });

  it("drops the leading bracket prefix off a user turn but keeps its picture", () => {
    // A picture sent with no caption used to disappear from history entirely,
    // taking the answer's context with it and leaving a reply to a question
    // that was not there.
    const { messages } = projectGatewayHistory(
      [user("[Attached file: /var/media/cat.png]", 100), assistant("A cat.", 200)],
      null,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].images?.length).toBe(1);
  });

  it("drops an inter-session envelope WHOLE, media line and all", () => {
    // Checked before the media split on purpose. Splitting first would let an
    // envelope survive as a bare picture — machinery addressed to the agent,
    // rendered to the customer as a photo.
    //
    // Recognised by its TEXT here, not by provenance: a message carrying
    // `provenance.kind` never reaches this branch, because the routing check
    // above claims it first.
    const envelope = [
      "[Inter-session message] sourceTool=image_generate isUser=false",
      "MEDIA:/home/clawbox/.openclaw/media/leak.png",
    ].join("\n");
    const { messages } = projectGatewayHistory(
      [assistant(envelope, 100), assistant("Real answer.", 200)],
      null,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Real answer.");
  });

  it("folds a spoken reply into the bubble it repeats instead of showing it twice", () => {
    const { messages } = projectGatewayHistory(
      [
        assistant("Sure.", 100),
        {
          role: "assistant",
          timestamp: 150,
          content: [
            { type: "text", text: "Sure." },
            { type: "attachment", attachment: { url: "/var/media/a.mp3", kind: "audio" } },
          ],
        },
      ],
      null,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Sure.");
    expect(messages[0].audio?.length).toBe(1);
  });

  it("merges the durable spoken-history supplement onto the turn it belongs to", () => {
    // Older supported gateways do not put TTS records in chat.history at all;
    // the device route is what makes a spoken reply survive a reboot.
    const { messages } = projectGatewayHistory(
      [assistant("Spoken answer.", 400)],
      { items: [{ targetTimestamp: 400, audio: ["/setup-api/chat/media?path=b.mp3"] }] },
    );
    expect(messages[0].audio).toEqual(["/setup-api/chat/media?path=b.mp3"]);
  });

  it("ignores a spoken supplement with a timestamp nothing on screen has", () => {
    const { messages } = projectGatewayHistory(
      [assistant("Spoken answer.", 400)],
      { items: [{ targetTimestamp: 999, audio: ["/setup-api/chat/media?path=b.mp3"] }] },
    );
    expect(messages[0].audio ?? []).toEqual([]);
  });

  it("survives a malformed spoken-history payload without losing the transcript", () => {
    for (const payload of [null, {}, { items: "nope" }, { items: [null, 7, {}] }]) {
      const { messages } = projectGatewayHistory([assistant("Still here.", 400)], payload);
      expect(messages[0].text).toBe("Still here.");
    }
  });

  it("caps the spoken refs it attaches to one message", () => {
    const many = Array.from({ length: 9 }, (_, i) => `/setup-api/chat/media?path=${i}.mp3`);
    const { messages } = projectGatewayHistory(
      [assistant("Long one.", 400)],
      { items: [{ targetTimestamp: 400, audio: many }] },
    );
    expect(messages[0].audio?.length).toBe(4);
  });

  it("reports an image failure only from INSIDE the wait window", () => {
    // Every read returns the last 50 messages, so an older failure notice is
    // still in the page. Treating it as this job's answer ended the wait ~400ms
    // after it started and the banner never showed at all.
    const older = failureNotice(100);
    const newer = failureNotice(900);

    expect(projectGatewayHistory([older], null, { imageWaitFrom: 500 }).imageGenerationFailed)
      .toBe(false);
    expect(projectGatewayHistory([newer], null, { imageWaitFrom: 500 }).imageGenerationFailed)
      .toBe(true);
  });

  it("reports no image failure at all when nothing is being waited on", () => {
    const notice = failureNotice(900);
    expect(projectGatewayHistory([notice], null).imageGenerationFailed).toBe(false);
    expect(projectGatewayHistory([notice], null, { imageWaitFrom: null }).imageGenerationFailed)
      .toBe(false);
  });

  it("never attributes a routing message to the person who did not type it", () => {
    const routed = failureNotice(900);
    const { messages } = projectGatewayHistory([routed, assistant("Here it is.", 950)], null, {
      imageWaitFrom: 500,
    });
    expect(messages.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("carries the idempotency key through, so a reconcile can recognise its own turn", () => {
    const { messages } = projectGatewayHistory(
      [user("hello", 100, { idempotencyKey: "run-1:user" })],
      null,
    );
    expect(messages[0].idempotencyKey).toBe("run-1:user");
  });

  it("returns an empty page for a fresh chat rather than throwing", () => {
    expect(projectGatewayHistory([], null)).toEqual({ messages: [], imageGenerationFailed: false });
  });
});

describe("a provider's refusal stored as the assistant's row (TASK-2261)", () => {
  it("reads back as the chat's own failure line, tagged with its run — never the gateway's copy of the error", async () => {
    const { projectGatewayHistory: project } = await import("@/lib/harness/openclaw-gateway-adapter");
    const page = project([
      { role: "user", content: "[Attached file: /home/clawbox/.openclaw/media/chat-attachments/abc-shot.png]\nwhat is this?", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "LLM request rejected: Failed to deserialize … unknown variant \\`image\\_url\\`" }],
        stopReason: "error",
        errorMessage: "400 Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text`",
        timestamp: 2,
        __openclaw: { runId: "run-7" },
      },
    ], null);
    const failure = page.messages.find((m) => m.role !== "user");
    expect(failure).toMatchObject({ role: "system", failedRun: "run-7" });
    expect(failure?.text).toMatch(/cannot look at pictures right now/);
    expect(JSON.stringify(page.messages)).not.toContain("image_url");
  });

  it("reads the gateway's escaped copy the same way when the row carries no errorMessage", async () => {
    const { projectGatewayHistory: project } = await import("@/lib/harness/openclaw-gateway-adapter");
    const page = project([{
      role: "assistant",
      content: [{ type: "text", text: "LLM request rejected: messages\\[0\\]\\: unknown variant \\`image\\_url\\`, expected \\`text\\`" }],
      stopReason: "error",
      timestamp: 3,
    }], null);
    expect(page.messages).toEqual([expect.objectContaining({ role: "system" })]);
    expect(page.messages[0].text).toMatch(/cannot look at pictures right now/);
  });
});
