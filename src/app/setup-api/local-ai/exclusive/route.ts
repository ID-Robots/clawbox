export const dynamic = "force-dynamic";

import fs from "fs/promises";
import { listAgentIds, sessionStorePath, sweepSessionEntries } from "@/lib/openclaw-session-store";
import path from "path";
import { NextResponse } from "next/server";
import { get, set, setMany } from "@/lib/config-store";
import {
  gatewayIsAbsent,
  readConfig,
  restartGateway,
  runOpenclawConfigSet,
} from "@/lib/openclaw-config";

const SAVED_PRIMARY_KEY = "local_only_saved_primary";
const SAVED_FALLBACKS_KEY = "local_only_saved_fallbacks";
const SAVED_SESSION_OVERRIDES_KEY = "local_only_saved_session_overrides";
const MODE_KEY = "local_only_mode";

const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || "/home/clawbox/.openclaw/agents";

// Fields on each entry of `<agent>/sessions/sessions.json` that OpenClaw
// reads to pick which provider/model the ongoing session is bound to.
// They are independent of `agents.defaults.model.primary` — the latter
// only seeds *new* sessions; existing sessions use whichever values are
// baked into this per-session record at the moment they were opened.
const SESSION_OVERRIDE_FIELDS = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "authProfileOverride",
  "authProfileOverrideSource",
  "modelProvider",
  "model",
] as const;

type SessionOverrideField = (typeof SESSION_OVERRIDE_FIELDS)[number];
type SessionOverrideSnapshot = Partial<Record<SessionOverrideField, unknown>>;
type SessionsFileBackup = Record<string, SessionOverrideSnapshot>;
type FilesBackup = Record<string, SessionsFileBackup>;

// Route OpenClaw config mutations through the shared retry-aware helper.
// The gateway reload + gateway-pre-start.sh write the same config file
// concurrently, so a bare `openclaw config set` here can fail with
// ConfigMutationConflictError mid-toggle — leaving the primary model
// flipped but fallbacks still populated, and local_only_mode unset.
// That half-applied state is visible in the UI as a failed toggle while
// the user's chat actually continues routing to the cloud fallback.
async function setConfig(key: string, valueJson: string) {
  // Leave timeoutMs on the helper's default — the OpenClaw CLI takes
  // 10-12 s per invocation on Jetson, so tighter bounds here produced
  // spurious "timed out" errors that made Local-only mode fail to toggle.
  await runOpenclawConfigSet([key, valueJson, "--json"]);
}

/** Parse "llamacpp/gemma4-e2b-it-q4_0" into {provider, modelId}. */
function parseLocalModel(fq: string): { provider: string; modelId: string } | null {
  const idx = fq.indexOf("/");
  if (idx <= 0 || idx === fq.length - 1) return null;
  return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
}

/** Enumerate every `sessions/sessions.json` under the agents directory. */
async function listSessionsFiles(): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(AGENTS_DIR);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const candidate = path.join(AGENTS_DIR, entry, "sessions", "sessions.json");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) results.push(candidate);
    } catch {
      // No sessions for this agent yet — skip.
    }
  }
  return results;
}

/**
 * Atomically rewrite a sessions.json file. Uses the standard temp+rename
 * pattern so a crash mid-write can't leave a half-written file where
 * OpenClaw would refuse to resume the session.
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

/**
 * Read + parse a sessions.json file, returning null (and logging) if the
 * file is missing, unreadable, or not a JSON object. Centralises the
 * parse-and-narrow logic so both the patch and restore passes treat
 * malformed files the same way.
 */
async function readSessionsJson(
  file: string,
  phase: "patch" | "restore",
): Promise<Record<string, Record<string, unknown>> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf-8"));
  } catch (err) {
    console.error(`[local-only] Skipping unreadable sessions file on ${phase} ${file}:`, err);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, Record<string, unknown>>;
}

/**
 * For every entry in every `sessions.json` on disk, replace the model
 * and provider override fields with the Local-only target, and return
 * a backup of the prior values (per file, per session key) so the
 * toggle can be reversed later.
 *
 * Sessions that were already pointing at a local provider are left
 * untouched but still recorded in the backup with their exact prior
 * values, so flipping back and forth preserves them.
 */
async function patchAllSessionOverrides(
  localProvider: string,
  localModelId: string,
): Promise<FilesBackup> {
  const filesBackup: FilesBackup = {};
  // OpenClaw 2 agents keep their sessions in SQLite. The sweep and its
  // backup work exactly as for the legacy files; the backup key is the
  // synthetic `sqlite:<agentId>` and restore routes it back to the store.
  for (const agentId of listAgentIds(AGENTS_DIR)) {
    if (!sessionStorePath(agentId, AGENTS_DIR)) continue;
    const fileBackup: SessionsFileBackup = {};
    const swept = sweepSessionEntries(agentId, (sessionKey, session) => {
      const snapshot: SessionOverrideSnapshot = {};
      for (const field of SESSION_OVERRIDE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(session, field)) {
          snapshot[field] = session[field];
        }
      }
      fileBackup[sessionKey] = snapshot;
      session.providerOverride = localProvider;
      session.modelOverride = localModelId;
      session.modelOverrideSource = "manual";
      session.authProfileOverride = `${localProvider}:default`;
      session.authProfileOverrideSource = "manual";
      session.modelProvider = localProvider;
      session.model = localModelId;
      return true;
    }, AGENTS_DIR);
    // A failed sweep wrote nothing (single transaction) - recording its
    // backup would let a later restore write stale values over sessions
    // this pass never touched.
    if (swept?.ok) filesBackup[`sqlite:${agentId}`] = fileBackup;
  }
  const files = await listSessionsFiles();
  for (const file of files) {
    const parsed = await readSessionsJson(file, "patch");
    if (!parsed) continue;

    const fileBackup: SessionsFileBackup = {};
    for (const [sessionKey, session] of Object.entries(parsed)) {
      if (!session || typeof session !== "object") continue;

      const snapshot: SessionOverrideSnapshot = {};
      for (const field of SESSION_OVERRIDE_FIELDS) {
        // Use Object.prototype.hasOwnProperty-style check so we can tell
        // "field explicitly set to null" apart from "field absent". On
        // restore, absent fields are deleted rather than written as null.
        if (Object.prototype.hasOwnProperty.call(session, field)) {
          snapshot[field] = session[field];
        }
      }
      fileBackup[sessionKey] = snapshot;

      session.providerOverride = localProvider;
      session.modelOverride = localModelId;
      session.modelOverrideSource = "manual";
      session.authProfileOverride = `${localProvider}:default`;
      session.authProfileOverrideSource = "manual";
      session.modelProvider = localProvider;
      session.model = localModelId;
    }
    filesBackup[file] = fileBackup;

    try {
      await atomicWriteJson(file, parsed);
    } catch (err) {
      console.error(`[local-only] Failed to write patched sessions file ${file}:`, err);
    }
  }
  return filesBackup;
}

/**
 * Reverse the effect of {@link patchAllSessionOverrides}. For every
 * session recorded in the backup, restore each override field to its
 * prior value — or delete it entirely if it was absent before.
 *
 * Sessions that have appeared since the backup was taken are left alone
 * (no backup entry → nothing to restore → user's current state wins).
 */
async function restoreSessionOverrides(backup: FilesBackup): Promise<boolean> {
  let allOk = true;
  const restoreIntoStore = (agentId: string, sessions: SessionsFileBackup) => {
    const swept = sweepSessionEntries(agentId, (sessionKey, session) => {
      const snapshot = sessions[sessionKey];
      if (!snapshot) return false;
      for (const field of SESSION_OVERRIDE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(snapshot, field)) {
          session[field] = snapshot[field];
        } else {
          delete session[field];
        }
      }
      return true;
    }, AGENTS_DIR);
    if (!swept?.ok) {
      allOk = false;
      console.error(`[local-only] SQLite restore did not complete for agent ${agentId}`);
    }
  };
  for (const [file, sessions] of Object.entries(backup)) {
    if (file.startsWith("sqlite:")) {
      restoreIntoStore(file.slice("sqlite:".length), sessions);
      continue;
    }
    const parsed = await readSessionsJson(file, "restore");
    if (!parsed) {
      // Local-only switched on BEFORE the OpenClaw 2 migration, switched
      // off after: the backup names a sessions.json the doctor has since
      // folded into the agent SQLite store. The snapshots still apply -
      // same keys, same entries - so route them into the store instead of
      // silently leaving every session pinned to the local model.
      const agentId = path.basename(path.dirname(path.dirname(file)));
      if (agentId && sessionStorePath(agentId, AGENTS_DIR)) {
        restoreIntoStore(agentId, sessions);
      }
      continue;
    }

    for (const [sessionKey, snapshot] of Object.entries(sessions)) {
      const session = parsed[sessionKey];
      if (!session || typeof session !== "object") continue;
      for (const field of SESSION_OVERRIDE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(snapshot, field)) {
          session[field] = snapshot[field];
        } else {
          delete session[field];
        }
      }
    }

    try {
      await atomicWriteJson(file, parsed);
    } catch (err) {
      // A legacy write that failed is exactly as incomplete as a refused
      // SQLite sweep: the caller must keep the snapshot and the mode.
      allOk = false;
      console.error(`[local-only] Failed to write restored sessions file ${file}:`, err);
    }
  }
  return allOk;
}

// Local-only mode is built entirely out of OpenClaw CLI calls: it flips
// `agents.defaults.model.primary`, empties `fallbacks`, and sweeps
// `~/.openclaw/agents/*/sessions/sessions.json`. Hermes has none of those —
// `hermes-local-ai.ts` can install and remove a local provider but has no
// fallback chain to make exclusive, so there is nothing here to port.
//
// Ungated, every call reached `runOpenclawConfigSet`, which throws
// `OpenclawUnavailableError`, which the catch-all turned into a 500 whose body
// SettingsApp painted verbatim into a red banner: "The OpenClaw CLI is not
// available on this edition." That is the product telling a Hermes owner about
// our internals, in an error colour, for a control we chose to show them.
//
// Refusing with `supported: false` lets the UI hide the card instead — and the
// refusal is stated the same way `whatsapp/configure` states its own.
const UNSUPPORTED = {
  error: "Local-only mode is an OpenClaw feature; this edition does not have it.",
  supported: false,
} as const;

export async function GET() {
  if (gatewayIsAbsent()) {
    return NextResponse.json({ enabled: false, ...UNSUPPORTED });
  }
  const enabled = !!(await get(MODE_KEY));
  return NextResponse.json({ enabled });
}

export async function POST(request: Request) {
  if (gatewayIsAbsent()) {
    return NextResponse.json(UNSUPPORTED, { status: 501 });
  }
  let body: { enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
  }

  try {
    const currentMode = !!(await get(MODE_KEY));
    if (currentMode === body.enabled) {
      return NextResponse.json({ enabled: body.enabled });
    }

    if (body.enabled) {
      const localModel = (await get("local_ai_model")) as string | undefined;
      if (!localModel) {
        return NextResponse.json({ error: "Local AI is not configured" }, { status: 400 });
      }
      const parsedLocal = parseLocalModel(localModel);
      if (!parsedLocal) {
        return NextResponse.json(
          { error: `local_ai_model is malformed: ${localModel}` },
          { status: 400 },
        );
      }

      const config = await readConfig();
      const currentPrimary = config.agents?.defaults?.model?.primary ?? null;
      const currentFallbacks = config.agents?.defaults?.model?.fallbacks ?? [];
      if (currentPrimary && !currentPrimary.startsWith("llamacpp/") && !currentPrimary.startsWith("ollama/")) {
        await set(SAVED_PRIMARY_KEY, currentPrimary);
      }
      if (Array.isArray(currentFallbacks) && currentFallbacks.length > 0) {
        await set(SAVED_FALLBACKS_KEY, currentFallbacks);
      }

      // 1. Flip the defaults so *new* sessions pick up local.
      await setConfig("agents.defaults.model.primary", JSON.stringify(localModel));
      await setConfig("agents.defaults.model.fallbacks", "[]");

      // 2. Sweep every existing session's per-session override. Without
      //    this step the toggle only affects sessions born after the
      //    flip — any chat pane that was already open silently keeps
      //    routing to its previously-bound cloud provider, and users
      //    have no UI signal that Local-only isn't actually local.
      const sessionBackup = await patchAllSessionOverrides(
        parsedLocal.provider,
        parsedLocal.modelId,
      );
      await set(SAVED_SESSION_OVERRIDES_KEY, sessionBackup);

      await set(MODE_KEY, true);
    } else {
      const savedPrimary = (await get(SAVED_PRIMARY_KEY)) as string | undefined;
      const savedFallbacks = (await get(SAVED_FALLBACKS_KEY)) as string[] | undefined;
      const savedSessionOverrides = (await get(SAVED_SESSION_OVERRIDES_KEY)) as FilesBackup | undefined;

      if (savedPrimary) {
        await setConfig("agents.defaults.model.primary", JSON.stringify(savedPrimary));
      }
      if (Array.isArray(savedFallbacks) && savedFallbacks.length > 0) {
        await setConfig("agents.defaults.model.fallbacks", JSON.stringify(savedFallbacks));
      }
      let restoreOk = true;
      if (savedSessionOverrides) {
        restoreOk = await restoreSessionOverrides(savedSessionOverrides);
      }

      await setMany({
        [SAVED_PRIMARY_KEY]: undefined,
        [SAVED_FALLBACKS_KEY]: undefined,
        // The snapshot is the ONLY copy of the pre-Local-only overrides. A
        // restore that could not complete (contended or corrupt store) keeps
        // it, so the next toggle-off can finish the job instead of stranding
        // every session on the local model for ever.
        [SAVED_SESSION_OVERRIDES_KEY]: restoreOk ? undefined : savedSessionOverrides,
        // The mode stays ON while the restore is incomplete: clearing it
        // would make the next disable return early as a no-op, and an
        // enable-then-disable cycle would overwrite the kept snapshot with
        // local values. The owner retries the same toggle instead.
        [MODE_KEY]: restoreOk ? undefined : true,
      });
      if (!restoreOk) {
        return NextResponse.json({
          enabled: true,
          restoreIncomplete: true,
          warning:
            "Some sessions could not be switched back yet (the session store was busy). Local-only stays on — try turning it off again in a moment.",
        });
      }
    }

    let restartWarning: string | undefined;
    try {
      await restartGateway();
    } catch (err) {
      restartWarning = err instanceof Error ? err.message : String(err);
      console.error("Failed to restart gateway after exclusive config change:", err);
    }

    return NextResponse.json({
      enabled: body.enabled,
      ...(restartWarning ? { warning: `Gateway restart failed: ${restartWarning}` } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to toggle local-only mode" },
      { status: 500 },
    );
  }
}
