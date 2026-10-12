/**
 * The format a spoken REPLY travels in, and how to tell one clip from another.
 *
 * Both engines used to answer a reply as WAV: 16-bit PCM at 24 kHz, about
 * 48 KB for every second of speech. A typical fifteen-second answer was 720 KB
 * — at least ten times what it needs to be, and paid for in full on every
 * reply over the Remote Access tunnel, where it is the slowest part of the
 * whole turn. So a reply is now compressed:
 *
 *  - MP3 is the default, because there is no browser that cannot decode it;
 *  - Ogg Opus only where the browser SAID it can play it (`playableReplyFormats`
 *    sends what `canPlayType` answered with the request). Opus is the smaller
 *    of the two at the same intelligibility, but Safari before 17 cannot play
 *    it at all, and a reply the player refuses is a reply nobody hears.
 *
 * WAV stays for the Voice tab's audition (src/lib/voice-speak.ts says why) and
 * is what a reply falls back to when the box has no ffmpeg to compress with:
 * a larger clip is always better than no clip.
 *
 * No Node imports: the chat reads `playableReplyFormats` in the browser.
 */

export type ReplyAudioFormat = "opus" | "mp3" | "wav";

/** The Content-Type each format is served as. Opus travels in an Ogg container. */
export const REPLY_FORMAT_MIME: Readonly<Record<ReplyAudioFormat, string>> = Object.freeze({
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
});

/** What a reply is spoken in when the asker said nothing about it. */
export const DEFAULT_REPLY_FORMAT: ReplyAudioFormat = "mp3";

/**
 * The formats this browser can play, best first — sent with every reply the
 * chat asks for. Opus is offered only on a confident "probably": the codec is
 * named in the query, so a browser that really decodes it has no reason to
 * hedge, and a "maybe" is the one answer that has played nothing in practice.
 * MP3 is always on the list, whatever `canPlayType` says about it: it is the
 * floor every browser meets, and a test DOM that answers "" to everything
 * must still be offered a clip.
 */
export function playableReplyFormats(canPlayType?: (type: string) => string): ReplyAudioFormat[] {
  let ask = canPlayType;
  if (!ask) {
    if (typeof document === "undefined") return ["mp3"];
    const probe = document.createElement("audio");
    ask = (type) => probe.canPlayType(type);
  }
  let opus = false;
  try {
    opus = ask('audio/ogg; codecs="opus"') === "probably";
  } catch {
    // A browser that throws from canPlayType does not know the type.
  }
  return opus ? ["opus", "mp3"] : ["mp3"];
}

/**
 * The format to speak a reply in, from what the request stated it can play.
 *
 * Opus when it is on the list, MP3 otherwise — including for a request that
 * stated nothing or something unreadable (an older page, curl), because MP3 is
 * the one compressed format nobody has to ask for. WAV only for a list that
 * names WAV and neither compressed format.
 */
export function pickReplyFormat(stated: unknown): ReplyAudioFormat {
  if (!Array.isArray(stated)) return DEFAULT_REPLY_FORMAT;
  const named = new Set(stated.filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase()));
  if (named.has("opus")) return "opus";
  if (named.has("mp3")) return "mp3";
  if (named.has("wav")) return "wav";
  return DEFAULT_REPLY_FORMAT;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * What the bytes ARE, by their magic, or null when they are none of the
 * formats a voice answers in.
 *
 * An engine's own label is not evidence: Hermes names whatever its provider
 * wrote, a cloud proxy may ignore the format it was asked for, and the chat's
 * player is handed whatever Content-Type the route set. The first bytes
 * cannot be wrong about themselves.
 */
export function sniffAudioMime(bytes: Uint8Array): string | null {
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
  if (ascii(bytes, 0, "OggS")) return "audio/ogg";
  if (ascii(bytes, 0, "ID3")) return "audio/mpeg";
  if (ascii(bytes, 0, "fLaC")) return "audio/flac";
  if (ascii(bytes, 4, "ftyp")) return "audio/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  // An MPEG audio frame: eleven sync bits. A layer field of 00 is ADTS AAC,
  // which shares the sync; any other layer is MPEG audio.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return (bytes[1] & 0x06) === 0 ? "audio/aac" : "audio/mpeg";
  }
  return null;
}

/**
 * Below this a WAV is a header and nothing else — `clawbox-tts.sh`'s own
 * floor. 1024 bytes of 24 kHz PCM is 21 ms.
 */
export const MIN_WAV_BYTES = 1024;

/**
 * The same floor for a compressed clip. 1024 bytes of Opus at 32 kb/s is a
 * quarter of a second, which a one-word answer ("Yes.") can come close to; an
 * Ogg or MP3 stream with no audio in it at all is a few hundred bytes of
 * headers, which this still refuses.
 */
export const MIN_COMPRESSED_BYTES = 512;

/** The smallest clip of this type that can hold any speech. */
export function minAudioBytesFor(mime: string | null | undefined): number {
  const type = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (!type || type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return MIN_WAV_BYTES;
  return MIN_COMPRESSED_BYTES;
}

/**
 * The file extension a clip of this type is stored and downloaded under.
 *
 * Every arm is one `/setup-api/chat/media` serves AND `isAudioMedia` claims
 * (see `extensionFor` in src/lib/harness/hermes-spoken-reply.ts for why both
 * must): `.weba`, not `.webm`; `.ogg` for Opus. An unrecognised type keeps
 * the WAV extension, which is what every engine's raw output is.
 */
export function audioExtensionFor(mime: string): string {
  const type = mime.toLowerCase();
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("ogg") || type.includes("opus")) return ".ogg";
  if (type.includes("webm")) return ".weba";
  if (type.includes("mp4") || type.includes("m4a")) return ".m4a";
  if (type.includes("aac")) return ".aac";
  if (type.includes("flac")) return ".flac";
  return ".wav";
}
