import { describe, expect, it } from "vitest";
import {
  splitMediaDirectives,
  splitAssistantMedia,
  isImageMedia,
  mediaUrl,
  mediaFileName,
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

    it("drops media the bubbles cannot render", () => {
      const { text, images } = splitAssistantMedia("Listen:\nMEDIA:/a/x.mp3");
      expect(text).toBe("Listen:");
      expect(images).toEqual([]);
    });

    it("yields an image with an empty caption when the reply is only a directive", () => {
      const { text, images } = splitAssistantMedia("MEDIA:/a/x.png");
      expect(text).toBe("");
      expect(images).toHaveLength(1);
    });
  });
});
