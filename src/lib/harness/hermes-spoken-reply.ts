import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import {
  chatSpokenReplyDir,
  pruneMediaDir,
  resolveInMediaRoot,
  SPOKEN_REPLY_RETENTION,
} from "@/lib/harness/media-root";
import { speakWithHermes } from "@/lib/hermes-tts";

/**
 * Speaking a Hermes reply aloud, the way the OpenClaw gateway already does.
 *
 * SERVER ONLY.
 *
 * On OpenClaw the gateway speaks the finished reply itself and pushes a second
 * message carrying the audio as an attachment part; the chat merges the two
 * and renders one bubble with a player. Hermes has the voice (`POST
 * /api/audio/speak`, resolving the same `tts.provider` the Voice tab writes)
 * but never speaks unbidden, so the box asks — and then hands the chat the
 * SAME shape, a browser-reachable media URL on the reply, so one renderer
 * serves both editions and neither grew an edition of its own.
 *
 * FAIL-SOFT, always. A reply that could not be spoken is still a reply: the
 * bubble renders, silent, exactly as it did before. Losing the answer because
 * the voice was busy would be a far worse trade than losing the audio.
 */

/** The longest reply worth speaking. */
const MAX_SPOKEN_CHARS = 4000;

/** Owner-only, matching the sibling media directories. */
const DIR_MODE = 0o700;

/**
 * How long the TURN may wait for its own audio.
 *
 * Much tighter than the Settings audition's budget, and for a reason the
 * audition does not have: this synthesis is SERIALISED INTO THE REPLY. The
 * customer has already read the answer (the streaming path delivered it token
 * by token); everything spent here is the composer staying disabled after they
 * finished reading. A cold Kokoro can take 13-17 s on an Orin Nano, and a turn
 * that hangs that long to attach a clip nobody is waiting for is a worse
 * product than a turn with no clip — so the clip is what gives way.
 *
 * If the box proves slower than this in practice, the fix is not a bigger
 * number: it is to move the ask to the composer, which is what
 * `spokenReplyTrigger: 'box'` already describes and what Hermes image
 * generation already does.
 */
const REPLY_SPEECH_TIMEOUT_MS = 12_000;

/**
 * Speak `text` and return the clip's absolute PATH, or null.
 *
 * Null for every failure and for every reason not to try, so the caller has
 * exactly one thing to check. The clip is written under the chat media root
 * because that is the one subtree `/setup-api/chat/media` will serve from, and
 * the destination is re-checked with `resolveInMediaRoot` the way every other
 * writer into that tree is.
 *
 * A PATH and not a URL, because the caller announces it as a `MEDIA:` line and
 * `isAudioMedia` decides what is audio by the extension BEFORE any query
 * string. A ready-made `/setup-api/chat/media?path=…` reads as having no
 * extension at all and would be dropped from the reply silently — the caption
 * would render and the player would never appear. `mediaUrl` builds the URL
 * from this on the way out, exactly as it does for a generated picture.
 */
export async function speakHermesReply(text: string): Promise<string | null> {
  const trimmed = text.trim();
  // Nothing to say, or too much of it. A four-thousand-character reply spoken
  // in full is minutes of audio nobody asked for and a synthesis long enough
  // to outlive the turn.
  if (!trimmed || trimmed.length > MAX_SPOKEN_CHARS) return null;

  // ONE deadline over the whole thing, not just the synthesis. `dashboardFetch`
  // logs in before it applies its own timeout (8 s), and retries once on a 401
  // with a second login behind it — so a dashboard that restarted mid-chat used
  // to cost login + speak + login + speak on top of this constant, ~50 s of the
  // composer sitting disabled after the customer had already read the answer.
  // The signal bounds all of it, so the number below means what it says.
  const spoken = await speakWithHermes(trimmed, {
    timeoutMs: REPLY_SPEECH_TIMEOUT_MS,
    signal: AbortSignal.timeout(REPLY_SPEECH_TIMEOUT_MS),
  });
  if (!spoken.ok) {
    // Named, not swallowed silently: a box whose voice is configured and
    // refusing is worth one line in the journal. Never the text.
    console.warn("[hermes/spoken-reply] could not speak the reply:", spoken.code);
    return null;
  }

  try {
    const dir = await chatSpokenReplyDir();
    // 0700 and an explicit chmod, like both sibling media directories:
    // `mkdir`'s mode is ignored for a directory that already exists, so a tree
    // created earlier at the umask default would keep leaking its listing —
    // the timing, count and size of every reply the box spoke.
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await fsp.chmod(dir, DIR_MODE).catch(() => {});
    // Both parts are ours: the directory comes from `chatSpokenReplyDir` and
    // the name is a uuid. Nothing the model or the customer influenced reaches
    // this path, which is why it can be written before it is checked.
    const target = path.join(dir, `${randomUUID()}${extensionFor(spoken.mime)}`);
    await fsp.writeFile(target, spoken.audio, { mode: 0o600 });
    // Checked AFTER the write, because `resolveInMediaRoot` resolves symlinks
    // and therefore needs the file to exist — it is the reader's guard, and
    // running it on a path that is not there yet always answers null. What it
    // proves here is that the clip really did land inside the one subtree
    // `/setup-api/chat/media` will serve from, even if some component of the
    // path is a symlink out of it. A clip that did not is removed rather than
    // announced.
    const safe = await resolveInMediaRoot(target);
    if (!safe) {
      await fsp.unlink(target).catch(() => {});
      return null;
    }
    // After the write, so a prune can never race the file it just made: the
    // retention floor already refuses to touch anything this young, and
    // pruning first would leave the newest clip unaccounted for if the write
    // then failed.
    await pruneMediaDir(dir, SPOKEN_REPLY_RETENTION).catch(() => {});
    return safe;
  } catch (err) {
    console.warn(
      "[hermes/spoken-reply] could not store the clip:",
      err instanceof Error ? err.message : "unknown error",
    );
    return null;
  }
}

/**
 * The extension `/setup-api/chat/media` will serve this clip under.
 *
 * Every arm has to be an extension BOTH allowlists claim — `AUDIO_EXT_RE` in
 * chat-media.ts, which decides whether a `MEDIA:` line is audio at all, and
 * `CONTENT_TYPES` in the media route, which decides what it is served as. A
 * clip written under an extension only one of them knows is stored, announced,
 * matched by neither `isImageMedia` nor `isAudioMedia`, and dropped from the
 * reply in silence — the bubble renders with no player and nothing is logged.
 *
 * `.weba`, not `.webm`, for exactly that reason: the media route says in as
 * many words that `isAudioMedia` "deliberately does NOT claim" `.webm`, so a
 * WebM clip named that way would vanish on every reply.
 */
function extensionFor(mime: string): string {
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (mime.includes("ogg") || mime.includes("opus")) return ".ogg";
  if (mime.includes("webm")) return ".weba";
  if (mime.includes("mp4") || mime.includes("m4a")) return ".m4a";
  if (mime.includes("aac")) return ".aac";
  if (mime.includes("flac")) return ".flac";
  return ".wav";
}
