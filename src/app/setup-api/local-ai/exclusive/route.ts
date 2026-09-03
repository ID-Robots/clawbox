export const dynamic = "force-dynamic";

import fs from "fs/promises";
import { listAgentIds, readSessionEntries, sessionStorePath } from "@/lib/openclaw-session-store";
import {
  isPatchableSession,
  patchSessionModels,
  sessionModelRef,
  type SessionPatchTarget,
} from "@/lib/openclaw-session-model";
import path from "path";
import { NextResponse } from "next/server";
import { get, set, setMany } from "@/lib/config-store";
import {
  callGatewayRpc,
  gatewayIsAbsent,
  readConfig,
  readConfigStrict,
  restartGateway,
  runOpenclawConfigSetBatch,
  type OpenclawConfigSetArgs,
} from "@/lib/openclaw-config";
import { enableProviderPluginOps, providerPluginSwitchedOnBy } from "@/lib/provider-plugin-ops";
import { notifyProviderSetChanged } from "@/app/setup-api/ai-models/catalog/route";
import { isClawboxAiImageModelRef } from "@/lib/clawbox-ai-models";

const SAVED_PRIMARY_KEY = "local_only_saved_primary";
const SAVED_FALLBACKS_KEY = "local_only_saved_fallbacks";
const SAVED_SESSION_OVERRIDES_KEY = "local_only_saved_session_overrides";
const MODE_KEY = "local_only_mode";

const AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR
  || path.join(
    process.env.CLAWBOX_OPENCLAW_HOME
    || process.env.OPENCLAW_HOME
    || path.join(process.env.HOME ?? "/home/clawbox", ".openclaw"),
    "agents",
  );

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

/**
 * The override fields a session carries right now, for the backup. Uses an
 * own-property check so "field explicitly set to null" stays distinct from
 * "field absent": on restore, absent fields are deleted rather than written
 * as null.
 */
function snapshotOverrides(session: Record<string, unknown>): SessionOverrideSnapshot {
  const snapshot: SessionOverrideSnapshot = {};
  for (const field of SESSION_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(session, field)) {
      snapshot[field] = session[field];
    }
  }
  return snapshot;
}

// Route OpenClaw config mutations through the shared retry-aware helper.
// The gateway reload + gateway-pre-start.sh write the same config file
// concurrently, so a bare `openclaw config set` here can fail with
// ConfigMutationConflictError mid-toggle — leaving the primary model
// flipped but fallbacks still populated, and local_only_mode unset.
// That half-applied state is visible in the UI as a failed toggle while
// the user's chat actually continues routing to the cloud fallback.
/**
 * One `config set --batch-json` for every model write of a toggle: the CLI
 * takes 10-12 s per invocation on a Jetson (so the helper's default timeout
 * stays), and a batch is applied to one snapshot and validated as a whole, so
 * the primary and the fallbacks land together or not at all — the half-applied
 * state the header above describes cannot come from here.
 */
async function setConfigBatch(ops: OpenclawConfigSetArgs[]) {
  await runOpenclawConfigSetBatch(ops);
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
 * Repoint every existing session to the Local-only target and return a
 * backup of the prior override values (per store or file, per session key)
 * so the toggle can be reversed later.
 *
 * OpenClaw 2 agents keep their sessions in a SQLite store the gateway alone
 * may write (see openclaw-session-store.ts), so they are switched through
 * `sessions.patchMany`; the backup key is the synthetic `sqlite:<agentId>`
 * and restore routes it back through the gateway. Legacy agents get the
 * `sessions.json` rewrite.
 *
 * Sessions that were already pointing at a local provider are still
 * recorded in the backup with their exact prior values, so flipping back
 * and forth preserves them.
 *
 * `sessionsSkipped` counts the sessions the gateway would not switch (each
 * one logged with its reason) and `agentsUnread` the agents whose store could
 * not even be listed (locked, unreadable). Either way those sessions still
 * route to their previous provider, which for Local-only is a privacy claim,
 * not a routing detail — so the caller says so.
 */
async function patchAllSessionOverrides(
  localProvider: string,
  localModelId: string,
): Promise<{ backup: FilesBackup; sessionsSkipped: number; agentsUnread: number }> {
  const filesBackup: FilesBackup = {};
  let sessionsSkipped = 0;
  let agentsUnread = 0;
  const localModel = `${localProvider}/${localModelId}`;
  // An agent with a store is served from it whatever else is on disk: its
  // leftover sessions.json is an archive the gateway no longer reads. Patching
  // that too would record the same agent twice, and a restore routed through
  // the store for the archive's entry would push pre-migration values over
  // live sessions.
  const migratedAgents = new Set<string>();
  for (const agentId of listAgentIds(AGENTS_DIR)) {
    if (!sessionStorePath(agentId, AGENTS_DIR)) continue;
    migratedAgents.add(agentId);
    const rows = readSessionEntries(agentId, AGENTS_DIR);
    if (!rows) {
      agentsUnread += 1;
      console.error(`[local-only] could not list the sessions of agent ${agentId}; they keep their previous model`);
      continue;
    }
    const snapshots: SessionsFileBackup = {};
    const targets: SessionPatchTarget[] = [];
    for (const { key, entry } of rows) {
      if (!isPatchableSession(entry)) continue;
      snapshots[key] = snapshotOverrides(entry);
      targets.push({ key, agentId });
    }
    if (targets.length === 0) continue;
    const fileBackup: SessionsFileBackup = {};
    for (const outcome of await patchSessionModels(targets, localModel, { call: callGatewayRpc })) {
      if (!outcome.ok) {
        sessionsSkipped += 1;
        console.error(
          `[local-only] session ${outcome.key} (agent ${agentId}) keeps its previous model:`,
          outcome.error,
        );
        continue;
      }
      // Only a session the gateway actually switched is recorded: restoring
      // a snapshot over one this pass never changed would write stale values.
      fileBackup[outcome.key] = snapshots[outcome.key];
    }
    if (Object.keys(fileBackup).length > 0) filesBackup[`sqlite:${agentId}`] = fileBackup;
  }
  const files = (await listSessionsFiles()).filter(
    (file) => !migratedAgents.has(path.basename(path.dirname(path.dirname(file)))),
  );
  for (const file of files) {
    const parsed = await readSessionsJson(file, "patch");
    if (!parsed) continue;

    const fileBackup: SessionsFileBackup = {};
    for (const [sessionKey, session] of Object.entries(parsed)) {
      if (!session || typeof session !== "object") continue;
      fileBackup[sessionKey] = snapshotOverrides(session);
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
  return { backup: filesBackup, sessionsSkipped, agentsUnread };
}

/**
 * Reverse the effect of {@link patchAllSessionOverrides}. For every
 * session recorded in the backup, restore each override field to its
 * prior value — or delete it entirely if it was absent before.
 *
 * Sessions that have appeared since the backup was taken are left alone
 * (no backup entry → nothing to restore → user's current state wins), and
 * so are sessions that have since been deleted (nothing left to restore —
 * and the core keeps a placeholder for a deleted key, which a patch would
 * turn back into a session).
 *
 * `complete` is false only for a failure worth retrying: a gateway that
 * refused for now, or a legacy file that could not be written. A refusal
 * that will not change is counted in `sessionsKept` — those sessions stay
 * on the local model, and the toggle still finishes, because a switch the
 * owner can never move off is worse than a chat they can reset.
 */
async function restoreSessionOverrides(
  backup: FilesBackup,
): Promise<{ complete: boolean; sessionsKept: number }> {
  let complete = true;
  let sessionsKept = 0;
  // Through the gateway, a session goes back to the `<provider>/<model>` its
  // snapshot pinned, or — when it had no pin — to the agent default (`model:
  // null`), which is the primary restored alongside. One patchMany per
  // distinct target keeps this to a couple of CLI calls, not one per session.
  const restoreIntoStore = async (agentId: string, sessions: SessionsFileBackup) => {
    const rows = readSessionEntries(agentId, AGENTS_DIR);
    if (!rows) {
      // Cannot tell which of these sessions still exist; patching blind could
      // recreate a deleted one. Keep the snapshot for a later attempt.
      complete = false;
      console.error(`[local-only] could not list the sessions of agent ${agentId}; its restore is deferred`);
      return;
    }
    const live = new Map(rows.map((row) => [row.key, row.entry]));
    const byModel = new Map<string | null, SessionPatchTarget[]>();
    for (const [key, snapshot] of Object.entries(sessions)) {
      const entry = live.get(key);
      if (!entry || !isPatchableSession(entry)) continue;
      const model = sessionModelRef(snapshot);
      const group = byModel.get(model);
      if (group) group.push({ key, agentId });
      else byModel.set(model, [{ key, agentId }]);
    }
    for (const [model, targets] of byModel) {
      for (const outcome of await patchSessionModels(targets, model, { call: callGatewayRpc })) {
        if (outcome.ok) continue;
        if (outcome.retryable) complete = false;
        else sessionsKept += 1;
        console.error(
          `[local-only] session ${outcome.key} (agent ${agentId}) could not be switched back${outcome.retryable ? " yet" : ""}:`,
          outcome.error,
        );
      }
    }
  };
  for (const [file, sessions] of Object.entries(backup)) {
    if (file.startsWith("sqlite:")) {
      await restoreIntoStore(file.slice("sqlite:".length), sessions);
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
        await restoreIntoStore(agentId, sessions);
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
      // A legacy write that failed is exactly as incomplete as a session the
      // gateway would not switch back yet: the caller must keep the snapshot
      // and the mode.
      complete = false;
      console.error(`[local-only] Failed to write restored sessions file ${file}:`, err);
    }
  }
  return { complete, sessionsKept };
}

// Local-only mode is built entirely out of OpenClaw CLI calls: it flips
// `agents.defaults.model.primary`, empties `fallbacks`, and repoints every
// session (gateway `sessions.patchMany`, or the legacy sessions.json). Hermes
// has none of those —
// `hermes-local-ai.ts` can install and remove a local provider but has no
// fallback chain to make exclusive, so there is nothing here to port.
//
// Ungated, every call reached `runOpenclawConfigSetBatch`, which throws
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
    const warnings: string[] = [];

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

      // 1. Flip the defaults so *new* sessions pick up local — both lists in
      //    one batch, so the primary can never land with the cloud fallbacks
      //    still in place.
      await setConfigBatch([
        ["agents.defaults.model.primary", JSON.stringify(localModel), "--json"],
        ["agents.defaults.model.fallbacks", "[]", "--json"],
      ]);

      // 2. Sweep every existing session's per-session override. Without
      //    this step the toggle only affects sessions born after the
      //    flip — any chat pane that was already open silently keeps
      //    routing to its previously-bound cloud provider, and users
      //    have no UI signal that Local-only isn't actually local.
      const { backup, sessionsSkipped, agentsUnread } = await patchAllSessionOverrides(
        parsedLocal.provider,
        parsedLocal.modelId,
      );
      await set(SAVED_SESSION_OVERRIDES_KEY, backup);
      if (sessionsSkipped > 0) {
        warnings.push(
          `${sessionsSkipped} open chat(s) could not be switched to the local model and still route to their previous provider — start a new chat to stay local.`,
        );
      }
      if (agentsUnread > 0) {
        warnings.push(
          `The sessions of ${agentsUnread} agent(s) could not be listed and still route to their previous provider — start a new chat to stay local.`,
        );
      }

      await set(MODE_KEY, true);
    } else {
      const savedPrimary = (await get(SAVED_PRIMARY_KEY)) as string | undefined;
      const savedFallbacks = (await get(SAVED_FALLBACKS_KEY)) as string[] | undefined;
      const savedSessionOverrides = (await get(SAVED_SESSION_OVERRIDES_KEY)) as FilesBackup | undefined;

      // The saved primary — and any saved fallback — can be Anthropic's, and a
      // provider save made while Local-only was on may have switched that
      // plugin off. OpenClaw 2 validates EVERY model reference the batch
      // touches (the primary and each fallback) against the enabled plugins'
      // catalogs, after applying the whole batch to one snapshot: so the
      // enables for every provider the restore names ride first, in the same
      // batch, and a refused batch leaves the flag and both lists as they were
      // (src/lib/provider-plugin-ops.ts).
      // The ClawBox AI image entry can never be a chat model, and this route is
      // the THIRD writer of agents.defaults.model.primary — the one that
      // passes through neither guarded door. A box mis-pinned to it that
      // toggles Local-only on, recovers, then toggles Local-only off was
      // re-pinned from this snapshot, silently undoing the repair. Dropped on
      // the way out rather than on the way in, so a snapshot already on disk
      // is covered too.
      const restorablePrimary = savedPrimary && !isClawboxAiImageModelRef(savedPrimary) ? savedPrimary : undefined;
      if (savedPrimary && !restorablePrimary) {
        // Dropping it is right; reporting the toggle as a plain success is
        // not. With no primary op the box stays on the local model while the
        // panel paints the switch off, and the owner believes cloud routing
        // is back — the same "claiming a state it does not have" this
        // handler's 503 branch below exists to avoid.
        warnings.push(
          "The saved provider could not be restored (it was the ClawBox AI image model, which cannot chat) — the box is still on the local model. Pick a chat model in Settings.",
        );
      }
      const keptFallbacks = Array.isArray(savedFallbacks)
        ? savedFallbacks.filter((ref) => !isClawboxAiImageModelRef(ref))
        : savedFallbacks;
      const restoreFallbacks = Array.isArray(keptFallbacks) && keptFallbacks.length > 0 ? keptFallbacks : null;
      // Read BEFORE the write, because what the catalogue needs to know is the
      // transition: the enables below can switch a plugin back ON, and a
      // provider whose plugin is off enumerates nothing.
      //
      // STRICT, and `null` when it fails, for the same reason the OFF half of
      // this gate reads strictly (`setProviderPlugins`): the decision is about
      // ABSENCE, and plain `readConfig` answers `{}` to an EACCES or a file
      // caught half-written exactly as it does to a box that has no config at
      // all. Those two need opposite answers — an absent flag IS enabled, so
      // `{}` means no transition, while "could not read" means unknown, and
      // silence there would cost six hours of a catalogue serving a list the
      // box has stopped agreeing with.
      const configBeforeRestore = await readConfigStrict().catch(() => null);
      const restoreOps: OpenclawConfigSetArgs[] = [
        ...enableProviderPluginOps([restorablePrimary, ...(restoreFallbacks ?? [])]),
        ...(restorablePrimary
          ? [["agents.defaults.model.primary", JSON.stringify(restorablePrimary), "--json"] as OpenclawConfigSetArgs]
          : []),
        ...(restoreFallbacks
          ? [["agents.defaults.model.fallbacks", JSON.stringify(restoreFallbacks), "--json"] as OpenclawConfigSetArgs]
          : []),
      ];
      if (restoreOps.length > 0) {
        await setConfigBatch(restoreOps);
        // The third site that switches a provider plugin on, and the third
        // that has to count it: this restore is what makes that provider
        // listable again, and nothing else will tell the catalogue. After the
        // batch, because a refused one leaves the flag exactly as it was —
        // `setConfigBatch` throws rather than swallowing, so reaching this line
        // means the write landed.
        const pluginSwitchedOn = providerPluginSwitchedOnBy(
          [restorablePrimary, ...(restoreFallbacks ?? [])],
          configBeforeRestore,
        );
        if (pluginSwitchedOn) notifyProviderSetChanged(pluginSwitchedOn);
      }
      const restore = savedSessionOverrides
        ? await restoreSessionOverrides(savedSessionOverrides)
        : { complete: true, sessionsKept: 0 };

      if (!restore.complete) {
        // The mode stays ON: the snapshot is the ONLY copy of the pre-Local-only
        // overrides, and a restore that could not complete yet (the gateway
        // was not reachable, or refused for now) must be retried from it —
        // clearing the mode would make that retry an early no-op, and an
        // enable-then-disable cycle would overwrite the snapshot with local
        // values. Nothing saved is cleared either, so the retry starts over.
        //
        // The primary and fallbacks were already written back to the cloud
        // values above, and a box that says Local-only while every new
        // session after the next gateway start would go to the cloud is a
        // box claiming a state it does not have. Put them back where the
        // mode says they are.
        const localModel = (await get("local_ai_model")) as string | undefined;
        if (localModel) {
          await setConfigBatch([
            ["agents.defaults.model.primary", JSON.stringify(localModel), "--json"],
            ["agents.defaults.model.fallbacks", "[]", "--json"],
          ]);
        } else {
          console.error("[local-only] restore incomplete and no local model recorded; the primary stays on the saved provider");
        }
        // Not a 2xx: the panel reads `res.ok` as "the switch moved" and would
        // paint the toggle OFF over a box that is still in Local-only. A
        // failure status keeps the switch where the server is and shows why.
        return NextResponse.json(
          {
            enabled: true,
            restoreIncomplete: true,
            error:
              "Some sessions could not be switched back yet (the gateway did not accept the change). Local-only stays on — try turning it off again in a moment.",
          },
          { status: 503 },
        );
      }
      await setMany({
        [SAVED_PRIMARY_KEY]: undefined,
        [SAVED_FALLBACKS_KEY]: undefined,
        [SAVED_SESSION_OVERRIDES_KEY]: undefined,
        [MODE_KEY]: undefined,
      });
      if (restore.sessionsKept > 0) {
        warnings.push(
          `${restore.sessionsKept} chat(s) could not be switched back and stay on the local model — reset those chats to use the restored provider.`,
        );
      }
    }

    try {
      await restartGateway();
    } catch (err) {
      warnings.push(`Gateway restart failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("Failed to restart gateway after exclusive config change:", err);
    }

    return NextResponse.json({
      enabled: body.enabled,
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to toggle local-only mode" },
      { status: 500 },
    );
  }
}
