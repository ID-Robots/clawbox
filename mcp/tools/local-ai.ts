// Local AI: which of the box's own engines are here and what each is doing —
// Kokoro (speaks replies), Whisper (transcribes), the embedding model behind
// Memory Shard, and the llama.cpp language model.
//
// READ ONLY, and that is the design rather than a gap. Since 2026-09-15 an
// install or an update puts no engine or model on a box but llama.cpp and
// Gemma 4 (the owner's ruling), so Settings → Local AI's Install button is the
// ONE way Kokoro, Whisper or the embedding model reaches a box — and every one
// of those install routes answers the MCP bearer 403 `owner_only`
// (`tts/install`, `whisper`, `embed/install`): installing software as root,
// downloading gigabytes onto the owner's disk, is the person's decision. A tool
// that could only ever be refused is a tool Hermes' per-server circuit breaker
// counts against every ClawBox tool, so there is no install tool; this one
// says what is missing and where the owner installs it.
//
// BOTH EDITIONS. Every engine here is ClawBox's own (Kokoro installs and then
// registers with whichever harness the box runs), and the inventory route
// reports "not on this edition" itself for anything a SKU does not ship.

import { apiGet, apiTry } from "../lib/api";
import { json, type Registrar } from "../lib/register";
import { zEnumOf } from "../lib/schema";

/** The engines the inventory can name (`ENGINE_IDS` in src/lib/local-models.ts). */
const ENGINES = ["all", "kokoro", "whisper", "embeddings", "llamacpp"] as const;

/** One row of GET /setup-api/local-models (`LocalModelEntry`). */
interface LocalModelRow {
  id?: string;
  name?: string;
  kind?: string;
  runtime?: string;
  installed?: boolean;
  enabled?: boolean | null;
  running?: string;
  diskBytes?: number | null;
  memoryBytes?: number | null;
  control?: string;
  detail?: string;
}

interface InventoryBody {
  models?: LocalModelRow[];
  unavailable?: string[];
}

/** GET /setup-api/tts — only the fields that say which voice answers. */
interface VoiceBody {
  choice?: string;
  activeEngine?: string | null;
  language?: string;
}

/** GET /setup-api/stt. */
interface TranscriptionBody {
  primary?: string;
  chain?: string[];
}

/** GET /setup-api/whisper. */
interface WhisperBody {
  installed?: boolean;
  active?: string | null;
  sizes?: { id?: string; cached?: boolean }[];
  freeBytes?: number;
}

/** GET /setup-api/embed/status. */
interface EmbedBody {
  installed?: boolean;
  modelAvailable?: boolean;
  model?: string;
  unit?: { present?: boolean; active?: boolean; failed?: boolean };
}

const KIND_WORDS: Record<string, string> = {
  tts: "speaks replies aloud",
  stt: "turns speech into text",
  embedding: "indexes documents for Memory Shard",
  llm: "answers chat on the box",
};

function megabytes(bytes: number | null | undefined): number | null {
  return typeof bytes === "number" && bytes > 0 ? Math.round(bytes / (1024 * 1024)) : null;
}

function engineRow(m: LocalModelRow): Record<string, unknown> {
  const disk = megabytes(m.diskBytes);
  const memory = megabytes(m.memoryBytes);
  return {
    id: m.id ?? "unknown",
    name: m.name ?? m.id ?? "unknown",
    ...(m.kind && KIND_WORDS[m.kind] ? { does: KIND_WORDS[m.kind] } : {}),
    installed: m.installed === true,
    state: m.running ?? "unknown",
    ...(typeof m.enabled === "boolean" ? { enabled: m.enabled } : {}),
    ...(disk !== null ? { disk_mb: disk } : {}),
    ...(memory !== null ? { memory_mb: memory } : {}),
    // The device's own line, written for the owner: "never a command line,
    // never a path" is the inventory's rule for it.
    ...(m.detail ? { detail: m.detail.slice(0, 200) } : {}),
  };
}

export function registerLocalAiTools(reg: Registrar): void {
  reg.tool(
    "local_ai_status",
    "Report the AI engines that run ON this ClawBox rather than in the cloud: Kokoro (speaks replies), Whisper (transcribes speech), the embedding model behind Memory Shard, and the llama.cpp language model — for each, whether it is installed, running, idle or started on demand, and what it uses. Also which voice and which transcription engine the box uses now (on the box or the ClawBox cloud). Use it when the user asks what runs locally, why voice or transcription goes to the cloud, or what they could install. It changes nothing: installing or removing an engine is the owner's, in Settings → Local AI.",
    {
      engine: zEnumOf(ENGINES, "One engine, or \"all\".").default("all"),
    },
    { editions: ["openclaw", "hermes"], readOnly: true, maxChars: 5_000 },
    async ({ engine: asked }: { engine?: (typeof ENGINES)[number] }) => {
      const engine = asked ?? "all";
      const wants = (id: string) => engine === "all" || engine === id;
      // Independent legs with independent timeouts, the device_status shape:
      // the inventory is the answer, the rest say which engine is in use, and
      // one that does not answer costs only its own line.
      const [inventory, voice, transcription, whisper, embed] = await Promise.all([
        apiGet<InventoryBody>("/setup-api/local-models", { timeoutMs: 15_000 }),
        wants("kokoro") ? apiTry<VoiceBody>("/setup-api/tts", { timeoutMs: 10_000 }) : Promise.resolve(null),
        wants("whisper") ? apiTry<TranscriptionBody>("/setup-api/stt", { timeoutMs: 10_000 }) : Promise.resolve(null),
        engine === "whisper" ? apiTry<WhisperBody>("/setup-api/whisper", { timeoutMs: 10_000 }) : Promise.resolve(null),
        engine === "embeddings" ? apiTry<EmbedBody>("/setup-api/embed/status", { timeoutMs: 10_000 }) : Promise.resolve(null),
      ]);
      const rows = (Array.isArray(inventory.models) ? inventory.models : [])
        .filter((m) => m && (engine === "all" || m.id === engine))
        .map(engineRow);
      const missing = rows.filter((r) => r.installed === false && r.state !== "not-on-this-edition").map((r) => r.name);
      const unreadable = (inventory.unavailable ?? []).filter((id) => engine === "all" || id === engine);
      // The inventory leaves the embeddings row OUT until the device has asked
      // the memory index once (a cold peek answers nothing, and the Local AI tab
      // simply polls). Neither failed nor absent — an agent reading an empty row
      // set as "there is no embedding model" would tell the user something false.
      const embeddingsPending = wants("embeddings")
        && !rows.some((r) => r.id === "embeddings")
        && !unreadable.includes("embeddings");
      return json({
        engines: rows,
        ...(unreadable.length ? { could_not_read: unreadable } : {}),
        ...(embeddingsPending ? { not_read_yet: "embeddings — the device is still reading the memory index; ask again in a moment" } : {}),
        ...(voice
          ? {
            voice: {
              // "auto" prefers the box's own voice when it is there.
              chosen: voice.choice ?? "unknown",
              speaking_with: voice.activeEngine === "local" ? "the box's own voice (Kokoro)" : voice.activeEngine === "cloud" ? "the ClawBox cloud voice" : "nothing yet",
              ...(voice.language ? { language: voice.language } : {}),
            },
          }
          : {}),
        ...(transcription
          ? {
            transcription: {
              first_choice: transcription.primary === "local" ? "on the box (Whisper)" : transcription.primary === "cloud" ? "the ClawBox cloud" : "unknown",
              tried_in_order: Array.isArray(transcription.chain) ? transcription.chain : [],
            },
          }
          : {}),
        ...(whisper
          ? {
            whisper_sizes: (whisper.sizes ?? []).map((s) => `${s.id}${s.cached ? " (downloaded)" : ""}${whisper.active === s.id ? " — in use" : ""}`),
            ...(typeof whisper.freeBytes === "number" ? { free_disk_gb: Math.round((whisper.freeBytes / 1024 ** 3) * 10) / 10 } : {}),
          }
          : {}),
        ...(embed
          ? { embedding_service: embed.unit?.failed ? "failed" : embed.unit?.active ? "running" : embed.unit?.present ? "stopped" : "not set up", ...(embed.model ? { embedding_model: embed.model } : {}) }
          : {}),
        guidance: missing.length
          ? `Not installed here: ${missing.join(", ")}. The owner installs an engine with Install in Settings → Local AI — it runs as root and downloads the model, so the ClawBox takes it only from them and there is no tool for it. Tell them what it would give them and where the button is.`
          : "Installing, removing or switching engines is the owner's, in Settings → Local AI; there is no tool for it.",
      });
    },
  );
}
