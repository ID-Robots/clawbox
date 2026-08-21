import { describe, expect, it } from "vitest";
import { splitUserAttachments } from "@/lib/chat-media";

/**
 * The customer's own attachments, as the gateway stores them.
 *
 * A picture the user sends carries no `MEDIA:` line: the composer stages it on
 * the box and names it in the prompt as `[Attached file: /abs/path]`. The
 * transcript used to reduce that to its caption with one anchored, non-global
 * bracket strip, which lost the image (TASK-436) and — with two attachments —
 * printed the second one's absolute path instead.
 */
describe("splitUserAttachments", () => {
  const PNG = "/home/clawbox/.openclaw/media/chat-attachments/paste-1.png";
  const JPG = "/home/clawbox/.openclaw/media/chat-attachments/photo.jpg";
  const PDF = "/home/clawbox/.openclaw/media/chat-attachments/report.pdf";

  it("turns an attached image into a media URL and keeps the caption", () => {
    const out = splitUserAttachments(`[Attached file: ${PNG}]\nWhat is this ?`);
    expect(out.text).toBe("What is this ?");
    expect(out.images).toEqual([`/setup-api/chat/media?path=${encodeURIComponent(PNG)}`]);
    expect(out.files).toEqual([]);
  });

  it("removes EVERY attachment line, not just the first", () => {
    // The regression this exists for: `^\[[^\]]+\]\s*` is anchored and not
    // global, so the second path stayed on screen verbatim after a refresh.
    const out = splitUserAttachments(`[Attached file: ${PNG}]\n[Attached file: ${JPG}]\ncompare these`);
    expect(out.text).toBe("compare these");
    expect(out.images).toHaveLength(2);
    expect(out.text).not.toContain("/home/clawbox");
  });

  it("never leaves an absolute path in the text, whatever the mix", () => {
    const out = splitUserAttachments(
      `[Attached file: ${PDF}]\n[Attached file: ${PNG}]\n[Attached file: ${JPG}]\nsummarise`,
    );
    expect(out.text).toBe("summarise");
    expect(out.text).not.toContain("/home/clawbox");
    expect(out.images).toHaveLength(2);
    // A document cannot be rendered, so its BASENAME comes back for the caller
    // to label — the name is the only part the customer ever chose.
    expect(out.files).toEqual(["report.pdf"]);
  });

  it("reports an attachment sent with no caption at all", () => {
    // This turn used to vanish from history entirely: nothing survived the
    // strip, so the whole user message was skipped and the answer was left
    // replying to a question that was not on screen.
    const out = splitUserAttachments(`[Attached file: ${PNG}]`);
    expect(out.text).toBe("");
    expect(out.images).toHaveLength(1);
  });

  it("leaves a turn that has no attachments completely alone", () => {
    expect(splitUserAttachments("just a question")).toEqual({
      text: "just a question", images: [], files: [],
    });
    // Other bracketed prefixes are somebody else's job — the caller still runs
    // its own `[System: …]` strip on what comes back, and this must not eat it.
    const sys = splitUserAttachments("[System: note]\nhello");
    expect(sys.text).toBe("[System: note]\nhello");
  });

  it("does not treat prose that mentions the syntax as an attachment", () => {
    // The line has to BE the directive, not contain it.
    const out = splitUserAttachments("the box writes [Attached file: /x.png] into the prompt");
    expect(out.images).toEqual([]);
    expect(out.text).toBe("the box writes [Attached file: /x.png] into the prompt");
  });

  it("routes the image through the box's own media route, not a raw path", () => {
    // An <img src="/home/clawbox/…"> is a broken image: the desktop cannot read
    // the filesystem. The session-gated route is what makes the same URL work
    // live, after a refresh and after a reboot.
    const [url] = splitUserAttachments(`[Attached file: ${PNG}]\nx`).images;
    expect(url.startsWith("/setup-api/chat/media?")).toBe(true);
    expect(url).not.toMatch(/^blob:/);
  });
});
