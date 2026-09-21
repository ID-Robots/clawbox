import { describe, expect, it } from "vitest";
import {
  splitMediaDirectives,
  splitAssistantMedia,
  isImageMedia,
  mediaUrl,
  mediaFileName,
  isAudioMedia,
  extractAudioAttachments,
  extractFileAttachments,
  boundedFiles,
  formatFileSize,
  mediaDownloadUrl,
  mediaDisplayName,
  mediaFileSize,
  acceptableSource,
} from "@/lib/chat-media";

// The exact reply shape the image tool produced on the device: a caption, a
// blank line, then the directive naming the file it wrote.
const REAL_REPLY =
  "Here's your cat! \u{1F431}\n\nMEDIA:/home/clawbox/.openclaw/media/tool-image-generation/image-1---84d24458-84ba-4d45-b90f-de4476c32c31.png";
const REAL_PATH =
  "/home/clawbox/.openclaw/media/tool-image-generation/image-1---84d24458-84ba-4d45-b90f-de4476c32c31.png";

// The URL OpenClaw handed the desktop for a file the agent sent (TASK-892,
// board 1791626120943): ROOT-RELATIVE, into the gateway's own media tree, and
// ending in a variant rather than a name. The session key's colons arrive
// percent-encoded — the broken card's href double-encoded them as `%253A`.
const GATEWAY_URL =
  "/api/chat/media/outgoing/agent%3Amain%3Amain/7c9e6679-7425-40de-944b-e07fc1f90ae7/full";

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

    it("passes a root-relative gateway media URL through — it is a URL, not a path", () => {
      // Wrapped as `/setup-api/chat/media?path=/api/chat/media/…` it 404'd:
      // that route opens files under the media root and the workspace, and a
      // URL path is neither.
      expect(mediaUrl(GATEWAY_URL)).toBe(GATEWAY_URL);
      expect(mediaUrl(GATEWAY_URL, "text/csv")).toBe(GATEWAY_URL);
      expect(mediaUrl(`${GATEWAY_URL}?v=2`)).toBe(`${GATEWAY_URL}?v=2`);
    });

    it("normalises a gateway URL, and wraps one whose dot-segments leave the media tree", () => {
      expect(mediaUrl("/api/chat/media/outgoing/x/../y/full")).toBe("/api/chat/media/outgoing/y/full");
      for (const escape of [
        "/api/chat/media/../../setup-api/files",
        "/api/chat/media/%2e%2e/%2E%2E/setup-api/files",
        "/api/chat/media/x\\..\\..\\..\\setup-api/files",
      ]) {
        // Never handed to the browser as a same-origin URL; as a path, the
        // media route refuses it like any other file outside its roots.
        expect(mediaUrl(escape), escape).toBe(
          `/setup-api/chat/media?path=${encodeURIComponent(escape)}`,
        );
      }
    });

    it("passes through only the media tree, not the rest of the gateway API", () => {
      expect(mediaUrl("/api/chat/media/")).toBe(
        `/setup-api/chat/media?path=${encodeURIComponent("/api/chat/media/")}`,
      );
      expect(mediaUrl("/api/sessions/x")).toBe(
        `/setup-api/chat/media?path=${encodeURIComponent("/api/sessions/x")}`,
      );
    });
  });

  describe("acceptableSource", () => {
    it("accepts a gateway media URL, a local path, https and file://", () => {
      for (const source of [
        GATEWAY_URL,
        "/home/clawbox/.openclaw/workspace/report.csv",
        "report.csv",
        "https://example.com/a.pdf",
        "file:///w/a.pdf",
      ]) {
        expect(acceptableSource(source), source).toBe(true);
      }
    });

    it("refuses a gateway API URL that is not a file in its media tree", () => {
      for (const source of [
        "/api/sessions/list",
        "/api/chat/media/",
        "/api/chat/media/../../setup-api/files",
        "/api/chat/media/%2e%2e/%2e%2e/setup-api/files",
      ]) {
        expect(acceptableSource(source), source).toBe(false);
      }
    });

    it("still refuses non-https schemes and nothing at all", () => {
      for (const source of ["javascript:alert(1)", "http://10.0.0.1/x.pdf", "data:text/html,hi", ""]) {
        expect(acceptableSource(source), source).toBe(false);
      }
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

    it("recovers a run screenshot's own name from the coding agent's artifact route", () => {
      // The pill hands this URL to the chat's preview; its download button
      // must not save the picture as a file called "artifacts".
      expect(mediaFileName("/setup-api/coding-agent/artifacts?runId=run-k3x9q2ab&file=after.png"))
        .toBe("after.png");
      expect(mediaFileName("/setup-api/coding-agent/artifacts?runId=run-abcdefgh&file=shot%201.png"))
        .toBe("shot 1.png");
    });

    it("falls back for a data URL, which has no name", () => {
      expect(mediaFileName("data:image/png;base64,AAAA")).toBe("image.png");
    });

    it("falls back rather than yielding an empty name", () => {
      expect(mediaFileName("/setup-api/chat/media?path=%2F")).toBe("image.png");
      expect(mediaFileName("")).toBe("image.png");
    });

    it("never names a gateway file after its variant segment", () => {
      // The card read "full" — the last segment of the URL, not a name.
      expect(mediaFileName(GATEWAY_URL)).toBe("image.png");
      expect(mediaDisplayName(GATEWAY_URL)).toBe("file");
      // A gateway URL whose last segment plainly is a name keeps it.
      expect(mediaFileName("/api/chat/media/outgoing/s/7c9e/cat.png")).toBe("cat.png");
    });

    it("uses the name the attachment payload carried, over anything the URL says", () => {
      expect(mediaFileName(`${GATEWAY_URL}#name=report.csv&size=2048`)).toBe("report.csv");
      expect(mediaFileName(`${mediaUrl("/w/7c9e-report.csv")}#name=report.csv`)).toBe("report.csv");
      expect(mediaFileName(`${GATEWAY_URL}#name=Q3+report+%C3%A9t%C3%A9.csv`)).toBe("Q3 report été.csv");
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

    it("hands every other file over as a download card", () => {
      const { text, images, audio, files } = splitAssistantMedia("Report:\nMEDIA:/a/x.mp4\nMEDIA:/a/report.pdf");
      expect(text).toBe("Report:");
      expect(images).toEqual([]);
      expect(audio).toEqual([]);
      expect(files).toEqual([
        `/setup-api/chat/media?path=${encodeURIComponent("/a/x.mp4")}`,
        `/setup-api/chat/media?path=${encodeURIComponent("/a/report.pdf")}`,
      ]);
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
      })).toEqual([
        "/setup-api/chat/media?path=%2Fa%2Fb&mime=audio%2Fmpeg",
      ]);
    });

    it("uses the MIME essence for an extensionless codec-qualified attachment", () => {
      expect(extractAudioAttachments({
        content: [{
          type: "attachment",
          attachment: { url: "/a/b", mimeType: "audio/webm; codecs=opus" },
        }],
      })).toEqual([
        "/setup-api/chat/media?path=%2Fa%2Fb&mime=audio%2Fwebm",
      ]);
    });

    it("does not turn a non-audio MIME type into a media-route override", () => {
      expect(extractAudioAttachments({
        content: [{
          type: "attachment",
          attachment: { url: "/a/b", kind: "audio", mimeType: "text/html" },
        }],
      })).toEqual([
        "/setup-api/chat/media?path=%2Fa%2Fb",
      ]);
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

  describe("extractFileAttachments", () => {
    const route = (p: string) => `/setup-api/chat/media?path=${encodeURIComponent(p)}`;

    it("reads non-audio attachment parts and mediaUrl fields", () => {
      const msg = {
        role: "assistant",
        mediaUrl: "/w/a.zip",
        mediaUrls: ["/w/b.csv", "https://example.com/c.png"],
        content: [
          { type: "text", text: "here" },
          { type: "attachment", attachment: { url: "/w/doc.pdf", kind: "document", mimeType: "application/pdf" } },
          { type: "attachment", attachment: { url: "/w/voice.wav", kind: "audio" } },
          { type: "attachment", attachment: { url: "/w/pic.jpg" } },
        ],
      };
      const { images, files } = extractFileAttachments(msg);
      expect(images).toEqual(["https://example.com/c.png", route("/w/pic.jpg")]);
      expect(files).toEqual([route("/w/a.zip"), route("/w/b.csv"), route("/w/doc.pdf")]);
    });

    it("skips audio by MIME type and refuses non-https schemes", () => {
      const msg = {
        mediaUrls: ["javascript:alert(1)", "http://10.0.0.1/x.pdf", "data:text/html,hi"],
        content: [{ type: "attachment", attachment: { url: "/w/rec", mimeType: "audio/ogg" } }],
      };
      expect(extractFileAttachments(msg)).toEqual({ images: [], files: [] });
    });

    it("survives anything that is not a message", () => {
      for (const v of [null, undefined, 3, "x", { content: "nope" }]) {
        expect(extractFileAttachments(v)).toEqual({ images: [], files: [] });
      }
    });

    it("caps and de-duplicates", () => {
      const urls = Array.from({ length: 20 }, (_, i) => `/w/f${i % 12}.bin`);
      expect(extractFileAttachments({ mediaUrls: urls }).files).toHaveLength(8);
      expect(boundedFiles(["a", "a", "b"])).toEqual(["a", "b"]);
    });

    it("keeps a gateway file downloadable, with the name and size its part carried", () => {
      const msg = {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the report." },
          {
            type: "attachment",
            attachment: { url: GATEWAY_URL, kind: "document", mimeType: "text/csv", label: "report.csv", size: 2048 },
          },
        ],
      };
      const { images, files } = extractFileAttachments(msg);
      expect(images).toEqual([]);
      expect(files).toEqual([`${GATEWAY_URL}#name=report.csv&size=2048`]);
      expect(mediaDisplayName(files[0])).toBe("report.csv");
      expect(mediaFileSize(files[0])).toBe(2048);
      // The href the browser follows: the gateway URL itself, same-origin via
      // the /api proxy — not the media route, which answered 404.
      expect(mediaDownloadUrl(files[0])).toBe(GATEWAY_URL);
    });

    it("reads the name and size a provider spells differently, and cleans them", () => {
      const part = (attachment: Record<string, unknown>) => ({
        content: [{ type: "attachment", attachment: { url: GATEWAY_URL, ...attachment } }],
      });
      const one = (attachment: Record<string, unknown>) => extractFileAttachments(part(attachment)).files[0];
      // The most specific field wins; a label that is a path keeps its leaf.
      expect(mediaDisplayName(one({ fileName: "a.csv", label: "Quarterly" }))).toBe("a.csv");
      expect(mediaDisplayName(one({ label: "/tmp/run/out/summary.pdf" }))).toBe("summary.pdf");
      expect(mediaDisplayName(one({ label: "C:\\out\\summary.pdf" }))).toBe("summary.pdf");
      expect(mediaDisplayName(one({ name: "bad\u0000name\n.txt" }))).toBe("badname.txt");
      expect(mediaFileSize(one({ sizeBytes: "4096" }))).toBe(4096);
      // Nothing usable: no fragment at all, and the card falls back cleanly.
      for (const junk of [{ size: -1 }, { size: 1.5 }, { size: "12kb" }, { label: ".." }, { label: "  " }, { name: 7 }]) {
        expect(one(junk), JSON.stringify(junk)).toBe(GATEWAY_URL);
      }
      expect(mediaDisplayName(GATEWAY_URL)).toBe("file");
    });

    it("draws one card when a file is named both bare and by its attachment part", () => {
      const named = `${GATEWAY_URL}#name=report.csv&size=2048`;
      const msg = {
        mediaUrls: [GATEWAY_URL, "/w/other.zip"],
        content: [{ type: "attachment", attachment: { url: GATEWAY_URL, label: "report.csv", size: 2048 } }],
      };
      expect(extractFileAttachments(msg).files).toEqual([named, route("/w/other.zip")]);
      // The same merge the chat runs over directive files and structured ones.
      expect(boundedFiles([GATEWAY_URL, "/b"], [named])).toEqual([named, "/b"]);
      expect(boundedFiles([named], [GATEWAY_URL])).toEqual([named]);
    });

    it("drops a gateway API URL that is not a file", () => {
      const msg = { mediaUrls: ["/api/sessions/list", "/api/chat/media/../../setup-api/files"] };
      expect(extractFileAttachments(msg)).toEqual({ images: [], files: [] });
    });
  });

  describe("file card helpers", () => {
    it("formats sizes", () => {
      expect(formatFileSize(0)).toBe("0 B");
      expect(formatFileSize(1536)).toBe("1.5 KB");
      expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
      expect(formatFileSize(-1)).toBe("");
    });

    it("asks the media route for a download and names the file", () => {
      const url = mediaUrl("/w/report final.pdf");
      expect(mediaDownloadUrl(url)).toBe(`${url}&download=1`);
      expect(mediaDownloadUrl(mediaDownloadUrl(url))).toBe(`${url}&download=1`);
      expect(mediaDownloadUrl("https://example.com/a.pdf")).toBe("https://example.com/a.pdf");
      expect(mediaDisplayName(url)).toBe("report final.pdf");
    });

    it("keeps download=1 in the query when the ref carries a name", () => {
      const url = mediaUrl("/w/7c9e-report.pdf");
      expect(mediaDownloadUrl(`${url}#name=report.pdf&size=10`)).toBe(`${url}&download=1`);
      expect(mediaDownloadUrl(`${GATEWAY_URL}#name=report.pdf`)).toBe(GATEWAY_URL);
    });

    it("reads no size from a ref that carries none", () => {
      expect(mediaFileSize(mediaUrl("/w/a.pdf"))).toBeNull();
      expect(mediaFileSize(GATEWAY_URL)).toBeNull();
      expect(mediaFileSize(`${GATEWAY_URL}#size=abc`)).toBeNull();
    });
  });
});
