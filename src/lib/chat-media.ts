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
 * The name to save a media URL under. Our own routes carry the real name in a
 * query parameter — `path` on the chat media route, `file` on the coding
 * agent's artifact route — so the saved file keeps the name the harness gave
 * it rather than becoming "media", "artifacts" or "route.png" in the downloads
 * folder. The pathname is the last resort, for a URL that names its file the
 * ordinary way.
 */
export function mediaFileName(url: string): string {
  const FALLBACK = "image.png";
  // A data: URL has no meaningful name, and its "pathname" is the payload.
  if (url.startsWith("data:")) return FALLBACK;
  try {
    // The base only matters for the relative URLs this app builds; it is never
    // used for anything but parsing.
    const parsed = new URL(url, "http://localhost");
    const source = parsed.searchParams.get("path")
      ?? parsed.searchParams.get("file")
      ?? parsed.pathname;
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

/** Spoken replies kept per message. */
const MAX_AUDIO_PER_MESSAGE = 4;

/**
 * De-duplicate and cap the spoken-reply refs attached to one message.
 *
 * Edition-neutral, which is why it lives here rather than beside the gateway
 * adapter: every transcript path caps the same way, including the Hermes reply
 * and the history merge, and importing it from the OpenClaw adapter made the
 * Hermes path depend on a module it has nothing else to do with.
 */
export function boundedAudio(...groups: string[][]): string[] {
  return [...new Set(groups.flat())].slice(0, MAX_AUDIO_PER_MESSAGE);
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

// ── The user's own attachments ──────────────────────────────────────────────
//
// A picture the CUSTOMER sent travels differently from one the assistant
// produced. There is no `MEDIA:` line: the composer stages the file on the box
// and names it in the prompt as `[Attached file: /abs/path]` (see
// `dispatchSend`), which is what the agent reads and what the gateway stores.
//
// The transcript then threw all of it away. The stored turn was reduced to its
// caption by one anchored, non-global bracket strip, so the image never came
// back on reload — and the live bubble never had it in the first place, which
// together is TASK-436: vision answered correctly about a photo that appeared
// nowhere in the conversation.

/** `[Attached file: /path]` as the composer writes it, one per line. */
const ATTACHED_FILE_LINE_RE = /^\[Attached file:\s*([^\]]+)\]$/;

/**
 * The display name for an attachment, from the path it was stored under.
 *
 * The staging route writes `<uuid>-<sanitised leaf>` so two files uploaded in
 * the same millisecond cannot collide, and answers with the bare leaf as
 * `name`. The live composer shows that `name`; only a replay has to recover it
 * from the path. Without stripping the prefix the SAME attachment reads
 * `report.pdf` while it is being sent and
 * `4f1c…-report.pdf` after a reload — the label changing under a customer who
 * did nothing but refresh.
 *
 * The prefix is matched exactly — 8-4-4-4-12 hex followed by a hyphen — so a
 * file the customer actually named something UUID-shaped is left alone unless
 * it matches the whole shape, and any other name is untouched.
 */
const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;

function displayName(source: string): string {
  const leaf = source.replace(/\/+$/, "").split("/").pop() || source;
  const stripped = leaf.replace(UUID_PREFIX_RE, "");
  // A file whose whole name was the prefix would otherwise become "".
  return stripped || leaf;
}

/**
 * A stored user turn split into what to show and what to render.
 *
 * EVERY `[Attached file: …]` line is removed, not just the first. The strip
 * this replaces was `^\[[^\]]+\]\s*` — anchored and non-global — so a turn
 * carrying two attachments kept the second one's ABSOLUTE PATH on screen after
 * a refresh. Lines are matched wherever they appear rather than only at the
 * top, because the only thing guaranteeing they lead is the composer that
 * wrote them, and a leaked path is not worth making conditional on that.
 *
 * Images resolve through `mediaUrl`, the same session-gated route the
 * assistant's own pictures already use — deliberately not an object URL, which
 * dies on the first refresh and so could never satisfy "still there after a
 * reboot".
 *
 * A non-image attachment has nothing to render, so its BASENAME comes back
 * separately for the caller to show the way the live composer does. Dropping
 * the line outright would leave a caption like "summarise this" pointing at
 * nothing; keeping the line would print the absolute path.
 */
export function splitUserAttachments(
  raw: string,
): { text: string; images: string[]; files: string[] } {
  if (!raw.includes("[Attached file:")) return { text: raw, images: [], files: [] };
  const images: string[] = [];
  const files: string[] = [];
  const kept: string[] = [];
  for (const line of raw.split("\n")) {
    const match = ATTACHED_FILE_LINE_RE.exec(line.trim());
    const source = match ? match[1].trim() : "";
    if (!source) {
      kept.push(line);
      continue;
    }
    if (isImageMedia(source)) images.push(mediaUrl(source));
    else files.push(displayName(source));
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, images, files };
}
