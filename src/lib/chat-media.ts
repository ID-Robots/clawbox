// ── Generated-media directives in assistant replies ─────────────────────────
//
// When the agent generates a picture, the harness does NOT deliver it as a
// structured attachment. The image lands on disk and the reply names it with a
// `MEDIA:<path>` line embedded in the message text:
//
//   Here's your cat! 🐱
//   MEDIA:/home/clawbox/.openclaw/media/tool-image-generation/image-1---….png
//
// Every client is expected to run this split itself — OpenClaw's own Control UI
// does exactly that client-side before rendering. ClawBox had no such pass, so
// the mascot chat showed the caption and dropped the picture on the floor.

/** A directive line: `MEDIA:` at the very start of the (trimmed) line. */
const MEDIA_LINE_RE = /^media:\s*(.*)$/i;

/** Opening or closing marker of a fenced code block. */
const FENCE_RE = /^(?:```|~~~)/;

// Extensions rendered inline. `.svg` is deliberately absent: an SVG is a
// scriptable document and these paths come from model output.
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;

export interface SplitMedia {
  /** The reply with its directive lines removed — what the bubble shows. */
  text: string;
  /** Sources the directives named, in the order they appeared. */
  media: string[];
}

/**
 * Splits `MEDIA:` directives out of assistant text.
 *
 * A directive is recognised only at the start of a line (after leading
 * whitespace) and never inside a fenced code block, so a reply that *explains*
 * the syntax still renders it as text.
 *
 * The payload is taken whole rather than split on whitespace: the harness emits
 * one source per line, and treating a space as a separator would break every
 * filename that contains one.
 */
export function splitMediaDirectives(raw: string): SplitMedia {
  // Cheap bail-out — the overwhelming majority of replies carry no directive.
  // Also covers the empty string, whose split is itself.
  if (!/media:/i.test(raw)) return { text: raw, media: [] };

  const media: string[] = [];
  const kept: string[] = [];
  let inFence = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    const match = inFence ? null : MEDIA_LINE_RE.exec(trimmed);
    const payload = match ? unwrapQuoted(match[1].trim()) : "";
    // A bare `MEDIA:` with nothing after it names nothing; keep it as text
    // rather than silently swallowing the line.
    if (!payload) {
      kept.push(line);
      continue;
    }
    media.push(payload);
  }

  // Removing a line from the middle of a reply can leave a hole; collapse the
  // run of blank lines it left behind so the caption keeps its shape.
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, media };
}

/** Strips one layer of the quoting a model tends to wrap a path in. */
function unwrapQuoted(value: string): string {
  for (const quote of ["`", '"', "'"]) {
    if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/** True if `source` names something this chat can render with an `<img>`. */
export function isImageMedia(source: string): boolean {
  // A remote URL may carry a query or fragment; the extension test precedes it.
  const bare = source.split(/[?#]/, 1)[0];
  return IMAGE_EXT_RE.test(bare);
}

/**
 * Browser-reachable URL for a media source.
 *
 * A local absolute path goes through ClawBox's own media route: the desktop
 * cannot read the filesystem, and the gateway's `/__openclaw__/assistant-media`
 * endpoint refuses this tree as "Outside allowed folders". Anything the browser
 * can already address is passed straight through.
 */
export function mediaUrl(source: string, mimeType?: string): string {
  if (/^(?:https?:|data:)/i.test(source)) return source;
  const local = source.startsWith("file://")
    ? source.slice("file://".length)
    : source;
  const query = new URLSearchParams({ path: local });
  // A structured attachment may be identified only by its MIME type and have
  // no extension at all. Carry only an audio hint; the server checks it against
  // its own allowlist before using it, so this never becomes a generic content-
  // type override for arbitrary files.
  const mimeEssence = typeof mimeType === "string"
    ? mimeType.split(";", 1)[0].trim().toLowerCase()
    : "";
  if (mimeEssence.startsWith("audio/")) {
    query.set("mime", mimeEssence);
  }
  return `/setup-api/chat/media?${query.toString()}`;
}

/**
 * The name to save a media URL under. Our own route carries the real path in a
 * query parameter, so the generated file keeps the name the harness gave it
 * rather than becoming "media" or "route.png" in the downloads folder.
 */
export function mediaFileName(url: string): string {
  const FALLBACK = "image.png";
  // A data: URL has no meaningful name, and its "pathname" is the payload.
  if (url.startsWith("data:")) return FALLBACK;
  try {
    // The base only matters for the relative URLs this app builds; it is never
    // used for anything but parsing.
    const parsed = new URL(url, "http://localhost");
    const source = parsed.searchParams.get("path") ?? parsed.pathname;
    // Trailing separators would otherwise yield an empty final segment.
    const base = source.replace(/\/+$/, "").split("/").pop() ?? "";
    return base || FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/**
 * Convenience for the chat components: caption plus the ready-to-render image
 * and audio URLs the reply named. Video and documents are still dropped — the
 * bubbles have nowhere to put them yet.
 */
export function splitAssistantMedia(raw: string): { text: string; images: string[]; audio: string[] } {
  const { text, media } = splitMediaDirectives(raw);
  return {
    text,
    images: media.filter(isImageMedia).map(source => mediaUrl(source)),
    audio: media.filter(isAudioMedia).map(source => mediaUrl(source)),
  };
}

// ── Spoken replies ──────────────────────────────────────────────────────────
//
// TTS does NOT arrive the way a generated picture does. Measured on a real box
// (TASK-381): the harness appends a second assistant message whose content
// carries a structured part —
//
//   { type: "attachment",
//     attachment: { url: "/home/clawbox/.openclaw/media/outbound/voice-….wav",
//                   kind: "audio", mimeType: "audio/wav", label: "voice-….wav" } }
//
// — and no MEDIA: line at all. `extractText` reads text parts and nothing else,
// so before this the spoken half of a reply was simply dropped: the box did the
// work, wrote the file, and the chat showed a caption with no way to hear it.
//
// Both shapes are read anyway. The directive form costs one filter and covers a
// provider that names its output the way image generation does.

/** Extensions rendered with an `<audio>` element. */
const AUDIO_EXT_RE = /\.(?:mp3|wav|ogg|oga|opus|m4a|aac|flac|weba)$/i;

/** True if `source` names something this chat can play. */
export function isAudioMedia(source: string): boolean {
  const bare = source.split(/[?#]/, 1)[0];
  return AUDIO_EXT_RE.test(bare);
}

/**
 * Playable URLs for the audio attachments on one gateway message.
 *
 * Both `kind` and `mimeType` are consulted: the local TTS provider sets both,
 * but neither is guaranteed by anything stronger than convention, and a reply
 * whose audio silently vanishes is the failure this exists to prevent. The
 * extension is the last resort rather than the first test, because a URL is
 * allowed not to have one.
 */
export function extractAudioAttachments(msg: unknown): string[] {
  if (!msg || typeof msg !== "object") return [];
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const urls: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; attachment?: unknown };
    if (b.type !== "attachment" || !b.attachment || typeof b.attachment !== "object") continue;
    const a = b.attachment as { url?: unknown; kind?: unknown; mimeType?: unknown };
    if (typeof a.url !== "string" || !a.url) continue;
    const isAudio = a.kind === "audio"
      || (typeof a.mimeType === "string" && a.mimeType.toLowerCase().startsWith("audio/"))
      || isAudioMedia(a.url);
    if (isAudio) {
      const mime = !isAudioMedia(a.url) && typeof a.mimeType === "string"
        ? a.mimeType
        : undefined;
      urls.push(mediaUrl(a.url, mime));
    }
  }
  return urls;
}
