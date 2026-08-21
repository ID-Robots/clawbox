import { createHash } from "crypto";
import { constants, type BigIntStats } from "fs";
import fs, { type FileHandle } from "fs/promises";
import path from "path";
import { extractAudioAttachments } from "@/lib/chat-media";
import { OPENCLAW_HOME } from "@/lib/openclaw-config";

// OpenClaw persists a TTS reply as a second assistant transcript record. The
// live `session.message` push carries that record, but older gateways omit it
// from `chat.history`. Reading the bounded tail of the canonical transcript is
// therefore the only way a fresh browser can recover the player after a page
// refresh, gateway restart, or device reboot.

// The index is one JSON object for every session, and active boxes can exceed
// 4 MiB without anything being wrong. Keep the read bounded for Nano memory,
// but leave realistic headroom for a long-lived device.
const MAX_SESSIONS_INDEX_BYTES = 16 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_RESULTS = 100;
const MAX_AUDIO_PER_REPLY = 4;
const MAX_MEDIA_URL_CHARS = 4096;

export interface SpokenHistoryItem {
  /** Timestamp of the ordinary assistant reply the recording belongs to. */
  targetTimestamp: number;
  /** Browser-reachable, session-gated media URLs. */
  audio: string[];
}

interface LoadOptions {
  openclawHome?: string;
  maxTailBytes?: number;
}

interface AssistantTarget {
  text: string;
  timestamp: number;
  runPrefix?: string;
}

// History reconcile runs repeatedly while a response arrives. The canonical
// transcript normally has not changed between those reads, so retain only the
// last bounded result and skip reallocating/decoding an 8 MiB tail. The key is
// descriptor identity plus content metadata, not the caller-controlled path.
let cachedHistory: { key: string; items: SpokenHistoryItem[] } | null = null;

function cloneHistory(items: SpokenHistoryItem[]): SpokenHistoryItem[] {
  return items.map((item) => ({ targetTimestamp: item.targetTimestamp, audio: [...item.audio] }));
}

function relativeChild(base: string, candidate: string): string | null {
  const rel = path.relative(base, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

function isMissingFile(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err
    && (err as { code?: unknown }).code === "ENOENT");
}

async function realpathIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.realpath(file);
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) {
    return typeof message.text === "string" ? message.text.trim() : "";
  }
  return message.content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n")
    .trim();
}

function messageTimestamp(message: Record<string, unknown>, record: Record<string, unknown>): number {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) {
    return record.timestamp;
  }
  if (typeof record.timestamp === "string") {
    const parsed = Date.parse(record.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function ttsMarker(message: Record<string, unknown>): { textSha256?: string; spokenText?: string } | null {
  const raw = message.openclawTtsSupplement;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  const textSha256 = typeof marker.textSha256 === "string" && marker.textSha256.trim()
    ? marker.textSha256.trim()
    : undefined;
  const spokenText = typeof marker.spokenText === "string" && marker.spokenText.trim()
    ? marker.spokenText.trim()
    : undefined;
  return textSha256 || spokenText ? { textSha256, spokenText } : null;
}

function markerMatches(marker: NonNullable<ReturnType<typeof ttsMarker>>, target: AssistantTarget): boolean {
  if (marker.textSha256) {
    const digest = createHash("sha256").update(target.text.trim()).digest("hex");
    if (digest === marker.textSha256) return true;
  }
  return Boolean(marker.spokenText && marker.spokenText === target.text.trim());
}

function idempotencyRunPrefix(message: Record<string, unknown>, suffix: ":user" | ":assistant-media"): string | undefined {
  const value = typeof message.idempotencyKey === "string" ? message.idempotencyKey.trim() : "";
  return value.endsWith(suffix) && value.length > suffix.length
    ? value.slice(0, -suffix.length)
    : undefined;
}

function localAudioUrls(message: Record<string, unknown>): string[] {
  const safe: string[] = [];
  for (const source of extractAudioAttachments(message)) {
    if (source.length > MAX_MEDIA_URL_CHARS || !source.startsWith("/setup-api/chat/media?")) continue;
    try {
      const parsed = new URL(source, "http://clawbox.local");
      const requested = parsed.searchParams.get("path");
      if (parsed.pathname !== "/setup-api/chat/media" || !requested || !path.isAbsolute(requested)) continue;
      safe.push(source);
      if (safe.length === MAX_AUDIO_PER_REPLY) break;
    } catch {
      // Malformed transcript attachments do not belong in a browser response.
    }
  }
  return safe;
}

async function boundedJsonFile(file: string, maxBytes: number): Promise<unknown> {
  // Open once and validate/read through the same descriptor. A path-level
  // stat followed by readFile lets another process replace the index between
  // those calls, defeating both the type and size checks.
  let handle: FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const result = await handle.read(buffer, read, buffer.length - read, read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    return JSON.parse(buffer.subarray(0, read).toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function resolveTranscript(sessionKey: string, home: string): Promise<FileHandle | null> {
  const agentMatch = /^agent:([A-Za-z0-9_-]+):/.exec(sessionKey);
  const agentId = agentMatch?.[1] ?? "main";
  const sessionsDir = path.join(home, "agents", agentId, "sessions");
  const sessionsIndex = path.join(sessionsDir, "sessions.json");
  const parsed = await boundedJsonFile(sessionsIndex, MAX_SESSIONS_INDEX_BYTES);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const sessions = parsed as Record<string, unknown>;
  const entryRaw = sessions[sessionKey]
    ?? (sessionKey === "main" ? sessions["agent:main:main"] : undefined);
  if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) return null;
  const entry = entryRaw as Record<string, unknown>;
  const namedFile = typeof entry.sessionFile === "string" && entry.sessionFile.trim()
    ? entry.sessionFile.trim()
    : typeof entry.sessionId === "string" && entry.sessionId.trim()
      ? `${entry.sessionId.trim()}.jsonl`
      : "";
  if (!namedFile) return null;

  const realSessionsDir = await realpathIfPresent(sessionsDir);
  if (!realSessionsDir) return null;
  const requested = path.isAbsolute(namedFile)
    ? path.resolve(namedFile)
    : path.resolve(sessionsDir, namedFile);
  // Shared-identity installs expose the same transcript through both a logical
  // ~/.openclaw path and its resolved target. Accept either spelling, then
  // rebuild the filesystem path from the trusted real root.
  const rel = relativeChild(sessionsDir, requested)
    ?? relativeChild(realSessionsDir, requested);
  if (rel === null) return null;
  const realFile = await realpathIfPresent(path.join(realSessionsDir, rel));
  if (!realFile) return null;
  if (relativeChild(realSessionsDir, realFile) === null) return null;
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    // Re-check containment on what was actually opened, not on the pathname
    // from before open(). This closes the rename/symlink race between realpath
    // and use; the ClawBox runtime is Linux, where procfs exposes the pinned
    // descriptor target without reopening the caller-controlled path.
    const openedFile = await realpathIfPresent(`/proc/self/fd/${handle.fd}`);
    if (!openedFile) {
      await handle.close();
      return null;
    }
    if (relativeChild(realSessionsDir, openedFile) === null) {
      await handle.close();
      return null;
    }
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return null;
    }
    return handle;
  } catch (err) {
    await handle?.close().catch(() => {});
    if (isMissingFile(err)) return null;
    throw err;
  }
}

async function readTail(handle: FileHandle, maxBytes: number, fileSize: number): Promise<string> {
  try {
    const length = Math.min(fileSize, maxBytes);
    const offset = fileSize - length;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    // The bounded window can begin halfway through a JSON record. Throw away
    // only that fragment; every complete line after it is still canonical.
    if (offset > 0) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * Recover the spoken half of recent assistant replies from the raw transcript.
 * No message text or session id is returned to the browser; media stays behind
 * the same session-gated URL the live chat already uses.
 */
export async function loadSpokenHistory(
  sessionKey: string,
  options: LoadOptions = {},
): Promise<SpokenHistoryItem[]> {
  if (!sessionKey || sessionKey.length > 512 || /[\u0000-\u001f\u007f]/.test(sessionKey)) return [];
  const home = options.openclawHome ?? OPENCLAW_HOME;
  const maxTailBytes = options.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  const transcriptHandle = await resolveTranscript(sessionKey, home);
  if (!transcriptHandle) return [];

  let identity: BigIntStats;
  try {
    identity = await transcriptHandle.stat({ bigint: true });
  } catch (err) {
    await transcriptHandle.close().catch(() => {});
    if (isMissingFile(err)) return [];
    throw err;
  }
  const cacheKey = [
    home,
    sessionKey,
    maxTailBytes,
    identity.dev,
    identity.ino,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
  ].join("\u0000");
  if (cachedHistory?.key === cacheKey) {
    await transcriptHandle.close();
    return cloneHistory(cachedHistory.items);
  }

  const raw = await readTail(transcriptHandle, maxTailBytes, Number(identity.size));
  const targets: AssistantTarget[] = [];
  const recovered = new Map<number, string[]>();
  let currentRunPrefix: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "message" || !record.message || typeof record.message !== "object"
        || Array.isArray(record.message)) continue;
    const message = record.message as Record<string, unknown>;
    const role = String(message.role ?? "").toLowerCase();
    if (role === "user") {
      currentRunPrefix = idempotencyRunPrefix(message, ":user");
      continue;
    }
    if (role !== "assistant") continue;

    const timestamp = messageTimestamp(message, record);
    const text = messageText(message);
    const audio = localAudioUrls(message);
    const marker = ttsMarker(message);

    if (audio.length > 0) {
      let target: AssistantTarget | undefined;
      const supplementRunPrefix = idempotencyRunPrefix(message, ":assistant-media");
      const sameRun = supplementRunPrefix
        ? [...targets].reverse().filter((candidate) => candidate.runPrefix === supplementRunPrefix)
        : [];
      if (marker) {
        target = sameRun.find((candidate) => markerMatches(marker, candidate))
          ?? sameRun[0]
          ?? [...targets].reverse().find((candidate) => markerMatches(marker, candidate));
        // The gateway hashes projected display text, while this bounded reader
        // sees the raw transcript. Reply/control tags can therefore make a
        // valid marker miss even though the supplement immediately follows
        // its target. A marked record is unambiguously a supplement, so the
        // nearest preceding ordinary assistant is the safe legacy fallback;
        // using the supplement's own timestamp would never match chat.history
        // and would silently lose the player after refresh.
        target ??= targets.at(-1);
      } else if (text) {
        // Older OpenClaw builds did not write the marker, but did repeat the
        // spoken text. Its user/media idempotency prefix binds delayed output
        // to the originating turn even if a newer reply repeats the words.
        target = sameRun.find((candidate) => candidate.text === text)
          ?? [...targets].reverse().find((candidate) => candidate.text === text);
      }
      const targetTimestamp = target?.timestamp ?? timestamp;
      if (targetTimestamp > 0) {
        const prior = recovered.get(targetTimestamp) ?? [];
        recovered.set(targetTimestamp, [...new Set([...prior, ...audio])].slice(0, MAX_AUDIO_PER_REPLY));
      }
      // A marked or repeated media record supplements an earlier answer; it is
      // not another candidate for a later identical reply.
      if (marker || target) continue;
    }

    if (text && timestamp > 0) targets.push({ text, timestamp, runPrefix: currentRunPrefix });
  }

  const items = [...recovered.entries()]
    .slice(-MAX_RESULTS)
    .map(([targetTimestamp, audio]) => ({ targetTimestamp, audio }));
  cachedHistory = { key: cacheKey, items: cloneHistory(items) };
  return items;
}
