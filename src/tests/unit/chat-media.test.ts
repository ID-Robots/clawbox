import { describe, expect, it } from "vitest";
import {
  splitMediaDirectives,
  splitAssistantMedia,
  isImageMedia,
  mediaUrl,
  mediaFileName,
  isAudioMedia,
  extractAudioAttachments,
} from "@/lib/chat-media";

// The exact reply shape the image tool produced on the device: a caption, a
// blank line, then the directive naming the file it wrote.
const REAL_REPLY =
  "Here's your cat! \u{1F431}\n\nMEDIA:/home/clawbox/.openclaw/media/tool-image-generation/image-1---84d24458-84ba-4d45-b90f-de4476c32c31.png";
const REAL_PATH =
  "/home/clawbox/.openclaw/media/tool-image-generation/image-1---84d24458-84ba-4d45-b90f-de4476c32c31.png";

describe("chat-media", () => {
  describe("splitMediaDirectives", () => {
    it("splits the caption from the media the harness named", () => {
      const { text, media } = splitMediaDirectives(REAL_REPLY);
      expect(text).toBe("Here's your cat! \u{1F431}");
      expect(media).toEqual([REAL_PATH]);
    });

    it("leaves a reply with no directive untouched", () => {
      const raw = "Just a normal answer.\nWith two lines.";
      expect(splitMediaDirectives(raw)).toEqual({ text: raw, media: [] });
    });

    it("returns empty for empty input", () => {
      expect(splitMediaDirectives("")).toEqual({ text: "", media: [] });
    });

    it("keeps every directive in order", () => {
      const { text, media } = splitMediaDirectives(
        "Two pictures:\nMEDIA:/a/one.png\nMEDIA:/a/two.png",
      );
      expect(text).toBe("Two pictures:");
      expect(media).toEqual(["/a/one.png", "/a/two.png"]);
    });

    it("matches the directive case-insensitively and past leading whitespace", () => {
      expect(splitMediaDirectives("  media: /a/x.png").media).toEqual(["/a/x.png"]);
      expect(splitMediaDirectives("Media:/a/y.png").media).toEqual(["/a/y.png"]);
    });

    it("unwraps backticks and quotes the model adds around a path", () => {
      expect(splitMediaDirectives("MEDIA:`/a/x.png`").media).toEqual(["/a/x.png"]);
      expect(splitMediaDirectives('MEDIA:"/a/x.png"').media).toEqual(["/a/x.png"]);
      expect(splitMediaDirectives("MEDIA:'/a/x.png'").media).toEqual(["/a/x.png"]);
    });

    it("keeps a path that contains spaces whole", () => {
      expect(splitMediaDirectives("MEDIA:/a/my cat.png").media).toEqual([
        "/a/my cat.png",
      ]);
    });

    it("ignores a directive inside a fenced code block", () => {
      const raw = "How it works:\n```\nMEDIA:/a/x.png\n```\nThat's the syntax.";
      const { text, media } = splitMediaDirectives(raw);
      expect(media).toEqual([]);
      expect(text).toContain("MEDIA:/a/x.png");
    });

    it("does not treat a mid-line mention as a directive", () => {
      const raw = "Write MEDIA:/path to attach a file.";
      expect(splitMediaDirectives(raw)).toEqual({ text: raw, media: [] });
    });

    it("keeps a bare MEDIA: line as text — it names nothing", () => {
      const { text, media } = splitMediaDirectives("MEDIA:");
      expect(media).toEqual([]);
      expect(text).toBe("MEDIA:");
    });

    it("collapses the gap a removed directive leaves mid-reply", () => {
      const { text } = splitMediaDirectives("Before\n\nMEDIA:/a/x.png\n\nAfter");
      expect(text).toBe("Before\n\nAfter");
    });
  });

  describe("isImageMedia", () => {
    it("accepts the raster formats the chat can render", () => {
      for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"]) {
        expect(isImageMedia(`/a/x.${ext}`)).toBe(true);
      }
      expect(isImageMedia("/a/X.PNG")).toBe(true);
    });

    it("rejects svg — a scriptable document from model output", () => {
      expect(isImageMedia("/a/x.svg")).toBe(false);
    });

    it("rejects non-images", () => {
      expect(isImageMedia("/a/x.mp3")).toBe(false);
      expect(isImageMedia("/a/x.pdf")).toBe(false);
      expect(isImageMedia("/a/noext")).toBe(false);
    });

    it("ignores a query string or fragment on a remote URL", () => {
      expect(isImageMedia("https://e.com/x.png?v=2")).toBe(true);
      expect(isImageMedia("https://e.com/x.png#a")).toBe(true);
    });
  });

  describe("mediaUrl", () => {
    it("routes a local path through the ClawBox media reader", () => {
      expect(mediaUrl(REAL_PATH)).toBe(
        `/setup-api/chat/media?path=${encodeURIComponent(REAL_PATH)}`,
      );
    });

    it("strips a file:// scheme before handing the path over", () => {
      expect(mediaUrl("file:///a/x.png")).toBe(
        `/setup-api/chat/media?path=${encodeURIComponent("/a/x.png")}`,
      );
    });

    it("passes through what the browser can already address", () => {
      expect(mediaUrl("https://e.com/x.png")).toBe("https://e.com/x.png");
      expect(mediaUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    });

    it("encodes a path so a query character cannot split the URL", () => {
      expect(mediaUrl("/a/b?c=1.png")).toBe(
        "/setup-api/chat/media?path=%2Fa%2Fb%3Fc%3D1.png",
      );
    });
  });

  describe("mediaFileName", () => {
    it("recovers the harness' own filename from a media route URL", () => {
      expect(mediaFileName(mediaUrl(REAL_PATH))).toBe(
        "image-1---84d24458-84ba-4d45-b90f-de4476c32c31.png",
      );
    });

    it("takes the last segment of a remote URL, without its query", () => {
      expect(mediaFileName("https://e.com/pics/cat.png?v=2")).toBe("cat.png");
    });

    it("falls back for a data URL, which has no name", () => {
      expect(mediaFileName("data:image/png;base64,AAAA")).toBe("image.png");
    });

    it("falls back rather than yielding an empty name", () => {
      expect(mediaFileName("/setup-api/chat/media?path=%2F")).toBe("image.png");
      expect(mediaFileName("")).toBe("image.png");
    });
  });

  describe("splitAssistantMedia", () => {
    it("hands the chat a caption and a ready-to-render image URL", () => {
      const { text, images } = splitAssistantMedia(REAL_REPLY);
      expect(text).toBe("Here's your cat! \u{1F431}");
      expect(images).toEqual([
        `/setup-api/chat/media?path=${encodeURIComponent(REAL_PATH)}`,
      ]);
    });

    it("keeps audio out of the image list", () => {
      // The two go to different elements. Before audio was rendered at all this
      // asserted the sound was dropped; now it must be routed, not merged —
      // an <img> pointed at a .wav renders a broken-image icon.
      const { text, images, audio } = splitAssistantMedia("Listen:\nMEDIA:/a/x.mp3");
      expect(text).toBe("Listen:");
      expect(images).toEqual([]);
      expect(audio).toEqual([`/setup-api/chat/media?path=${encodeURIComponent("/a/x.mp3")}`]);
    });

    it("still drops media no bubble can render", () => {
      const { text, images, audio } = splitAssistantMedia("Clip:\nMEDIA:/a/x.mp4");
      expect(text).toBe("Clip:");
      expect(images).toEqual([]);
      expect(audio).toEqual([]);
    });

    it("yields an image with an empty caption when the reply is only a directive", () => {
      const { text, images } = splitAssistantMedia("MEDIA:/a/x.png");
      expect(text).toBe("");
      expect(images).toHaveLength(1);
    });
  });

  // ── Spoken replies ────────────────────────────────────────────────────────
  //
  // Every fixture below is the shape a real box produced, copied out of
  // ~/.openclaw/agents/main/sessions/*.jsonl after asking the mascot chat on
  // .65 to speak a line. TTS does not use MEDIA: at all — it appends a second
  // assistant message with a structured attachment part — which is why the
  // spoken half of every reply was silently discarded before TASK-381.

  describe("isAudioMedia", () => {
    it("recognises what the box actually writes", () => {
      expect(isAudioMedia("/home/clawbox/.openclaw/media/outbound/voice-1---a.wav")).toBe(true);
    });

    it("covers the other formats a provider swap could produce", () => {
      for (const ext of ["mp3", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba"]) {
        expect(isAudioMedia(`/a/clip.${ext}`), ext).toBe(true);
      }
    });

    it("ignores a query string when reading the extension", () => {
      expect(isAudioMedia("https://example.com/a.mp3?token=1")).toBe(true);
    });

    it("does not claim an image or a video", () => {
      expect(isAudioMedia("/a/cat.png")).toBe(false);
      expect(isAudioMedia("/a/clip.mp4")).toBe(false);
      expect(isAudioMedia("/a/notes.wavefront")).toBe(false);
    });
  });

  describe("extractAudioAttachments", () => {
    const spoken = {
      role: "assistant",
      content: [
        { type: "text", text: "The lantern is green." },
        {
          type: "attachment",
          attachment: {
            url: "/home/clawbox/.openclaw/media/outbound/voice-1787291821763---93f78bf1.wav",
            kind: "audio",
            label: "voice-1787291821763---93f78bf1.wav",
            mimeType: "audio/wav",
          },
        },
      ],
    };

    it("returns a playable URL for the attachment the harness sends", () => {
      expect(extractAudioAttachments(spoken)).toEqual([
        `/setup-api/chat/media?path=${encodeURIComponent("/home/clawbox/.openclaw/media/outbound/voice-1787291821763---93f78bf1.wav")}`,
      ]);
    });

    it("accepts an attachment identified only by its MIME type", () => {
      // `kind` is a convention, not a contract. A reply whose audio vanishes
      // because a provider labelled it differently is the whole failure here.
      expect(extractAudioAttachments({
        content: [{ type: "attachment", attachment: { url: "/a/b", mimeType: "AUDIO/MPEG" } }],
      })).toHaveLength(1);
    });

    it("accepts an attachment identified only by its extension", () => {
      expect(extractAudioAttachments({
        content: [{ type: "attachment", attachment: { url: "/a/b.opus" } }],
      })).toHaveLength(1);
    });

    it("ignores image attachments and plain text", () => {
      expect(extractAudioAttachments({
        content: [
          { type: "text", text: "hi" },
          { type: "attachment", attachment: { url: "/a/cat.png", kind: "image", mimeType: "image/png" } },
        ],
      })).toEqual([]);
    });

    it("survives anything that is not a message", () => {
      for (const junk of [null, undefined, "text", 7, {}, { content: "text" }, { content: [null, 1] }]) {
        expect(extractAudioAttachments(junk)).toEqual([]);
      }
    });

    it("skips an attachment with no url", () => {
      expect(extractAudioAttachments({
        content: [{ type: "attachment", attachment: { kind: "audio", mimeType: "audio/wav" } }],
      })).toEqual([]);
    });
  });
});
