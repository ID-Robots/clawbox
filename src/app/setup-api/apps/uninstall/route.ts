import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR, getAll as configGetAll, setMany as configSetMany } from "@/lib/config-store";
import { setPreferences } from "@/lib/preference-store";
import { clearSkillEntry, OpenclawConfigUnreadableError, openclawSkillRoot } from "@/lib/openclaw-config";
import { refreshSkillsCache } from "@/lib/openclaw-skill-info";
import { kvDelete } from "@/lib/kv-store";
import { WEBAPPS_DIR } from "@/lib/code-projects";

export const dynamic = "force-dynamic";

/**
 * Does the desktop know this id as a WEB APP?
 *
 * `webapp_create` and `code_project_build` register one in `installed_meta`
 * with a `webappUrl`; a store skill never has one. It decides whether this
 * uninstall has a skill half at all — and therefore whether OpenClaw's
 * configuration has anything to say about it.
 *
 * Cautious by construction: only a meta entry that NAMES a webappUrl answers
 * true. An id with no meta, or a preference file that could not be read, is
 * treated as something that may have a skill.
 */
async function isRegisteredWebapp(appId: string): Promise<boolean> {
  try {
    const meta = (await configGetAll())?.["pref:installed_meta"];
    if (!meta || typeof meta !== "object") return false;
    const entry = (meta as Record<string, unknown>)[appId];
    if (!entry || typeof entry !== "object") return false;
    const url = (entry as { webappUrl?: unknown }).webappUrl;
    return typeof url === "string" && url.length > 0;
  } catch (err) {
    console.warn("[uninstall] Could not read the installed-app meta:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function POST(req: Request) {
  // Hoisted so the OUTER catch can say what landed. By the time anything below
  // the skill removal can throw, that folder may already be gone, and a 500
  // saying only "Uninstall failed" withholds the one fact the owner and the
  // agent need to decide what to do next.
  let skillRemoved: boolean | null = null;
  try {
    // Parsed OUTSIDE the outer catch's contract. A body that is not JSON, or
    // one that is JSON but not an object, threw into that catch and was
    // answered `500 { code: "uninstall_failed", retryable: true }` — and
    // `mcp/tools/desktop.ts` turns that body into "Call app_uninstall once
    // more". A malformed body cannot succeed on retry however long the caller
    // waits, so that is both a client error reported as a server fault and a
    // retry instruction attached to a request that can never be satisfied.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { appId } = (body ?? {}) as { appId?: unknown };
    if (!appId || typeof appId !== "string" || !/^(?!-)[A-Za-z0-9_-]+$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }

    // Remove the skill directory (with path traversal guard).
    //
    // ONLY where there is an OpenClaw to have one. This route is deliberately
    // reachable on Hermes — openclaw-apps-server.ts records why: the MCP
    // `app_uninstall` tool posts here, so the agent can still remove a webapp
    // whose store the UI has hidden, and refusing would strand those apps in
    // the prefs with nothing able to delete them. What must not follow from
    // that is a delete under a path the edition does not have: `getSkillsDir()`
    // falls back to ~/clawd, and this line resolved <appId> under it and
    // answered {ok:true} for the removal it had not made.
    //
    // `null` is the hermes SKU alone. An openclaw.json that EXISTS and cannot
    // be read is a THROW, and it is answered here — before anything at all is
    // deleted — because the one thing worse than not removing the skill is
    // removing the tile, the preferences and the KV while the skill stays on
    // disk and loaded: the owner is then told the app is gone, and the entry
    // they would have retried from is gone with it. Nothing is touched, and
    // the answer says so. Retryable: the file is rewritten in place by
    // `openclaw config set`, so the next attempt a moment later reads it.
    //
    // Being a WEB APP decides whether that refusal is FATAL — never whether
    // the skill half runs. A registered webapp has no skill of its own, so an
    // openclaw.json this box cannot read has nothing to say about removing it:
    // without that exception, on a licensed `dual` box a config belonging to a
    // harness that is not even running would block the removal of the agent's
    // own web app, permanently if the file is invalid rather than half-written,
    // where beta removed it.
    //
    // What must NOT follow is skipping the removal. Nothing stops a webapp id
    // from also being a store slug — `webapp_create` REPLACES
    // `installed_meta[<id>]` for any id (webapp-registry.ts), with no collision
    // check, and `apps/install` writes meta only when there is none — so an id
    // with both would have kept its skill folder and its `skills.entries.<id>`
    // while the tile, the prefs, the KV and the icon went, and answered
    // `{ok:true}`. That is this route's own defect reached through the meta
    // instead of through the edition.
    const isWebapp = await isRegisteredWebapp(appId);
    let skillRoot: string | null = null;
    // Set only on the one branch that removes a web app WITHOUT having been
    // able to look at the skill half. `skillRemoved: null` cannot carry it:
    // that value means "there is no skill half here to report on", and the
    // whole reason this branch exists is that an id can be both a web app and
    // a store skill, which is precisely what an unreadable config makes
    // unknowable. Left unsaid, the answer is a bare `{ok:true}` over a skill
    // folder still on disk and still loaded, with the desktop entry the owner
    // would have retried from already gone — this route's own defect, one
    // condition narrower. Refusing instead is the worse trade (a `dual` box
    // with a permanently invalid openclaw.json could never remove the agent's
    // own web apps), so the route says what it could not check and lets the
    // caller relay it.
    let skillHalfChecked = true;
    try {
      skillRoot = openclawSkillRoot();
    } catch (err) {
      if (!(err instanceof OpenclawConfigUnreadableError)) throw err;
      console.warn("[uninstall] Could not resolve the skills root:", err.message);
      if (!isWebapp) {
        return NextResponse.json({
          ok: false,
          error: "The device's OpenClaw configuration could not be read, so nothing was removed. Try again in a moment.",
          code: err.code,
          retryable: true,
          appId,
        }, { status: 503 });
      }
      skillHalfChecked = false;
    }
    // What actually happened to the skill half, so the answer can say it.
    //   true  — a skill directory was there and is gone
    //   false — this box has a skills root and nothing of that name was in it
    //   null  — there is no skill half here to report on: the hermes SKU, or a
    //           web app, which never had a skill of its own — UNLESS
    //           `skillHalfChecked` is false above, the one answer where `null`
    //           means "could not look" instead
    // `{ok:true}` alone said the same thing for all three, which is the half of
    // the wrong-directory delete that a guard on its own does not close.
    if (skillRoot) {
      const skillDir = path.resolve(skillRoot, appId);
      if (!skillDir.startsWith(skillRoot + path.sep)) {
        return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
      }
      try {
        // No `force`, so the removal itself answers the question. A `stat`
        // ahead of a forced `rm` answered "could I stat it", not "was it
        // there": an EACCES on the parent or an EIO read as `false`, the one
        // value the MCP tool states out loud as "there was no skill of that
        // name on disk" — over a directory that is there and did not go.
        await fs.rm(skillDir, { recursive: true });
        skillRemoved = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          // `fs.rm` deletes as it WALKS and throws on the first entry it
          // cannot remove, so by here the folder is in an unknown state —
          // possibly part-deleted. The message says that rather than "nothing
          // was removed", which would be the same false report in the other
          // direction. The uninstall stops all the same (beta stopped too,
          // as an opaque 500): the desktop entry is what the owner retries
          // and reports from, and dropping it over a skill still on disk is
          // the failure this route exists to stop making.
          console.warn("[uninstall] Failed to remove the skill directory:", err instanceof Error ? err.message : err);
          // Part of the folder is probably gone, and `SKILL.md` is usually the
          // first casualty — so the gateway's watcher drops the skill on its
          // next scan while `apps/skill-info` keeps serving "installed and
          // enabled" from its cache. Rescan before answering: this is the one
          // path where the owner is actively looking for the truth. (Not on
          // the refusal above — nothing was touched there.)
          refreshSkillsCache();
          return NextResponse.json({
            ok: false,
            error: "The app's skill folder could not be fully removed, so the uninstall was stopped and part of the folder may already be gone. Try again; if it keeps failing, remove the folder from the Terminal.",
            code: "skill_remove_failed",
            retryable: true,
            appId,
          }, { status: 503 });
        }
        skillRemoved = false;
      }
    }

    // Remove the deployed webapp, if this app is one. `webapp_create`,
    // `webapp_update` and `code_project_build` all deploy to
    // data/webapps/<appId>/, and /setup-api/webapps serves straight off that
    // directory — so an uninstall that only dropped the preference left the
    // page live at /setup-api/webapps?app=<appId> for anyone who still had the
    // URL, while the desktop said the app was gone. code_project_delete's own
    // guidance ("any copy already installed on the desktop stays until it is
    // removed with app_uninstall") promises this removal.
    const webappRoot = path.resolve(WEBAPPS_DIR);
    const webappDir = path.resolve(webappRoot, appId);
    if (!webappDir.startsWith(webappRoot + path.sep)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }
    // Without `force`, so the removal itself says whether there was a webapp
    // here — the fact the report below needs. Every other failure still throws,
    // exactly as it did with `force`, which only ever swallowed ENOENT.
    let webappRemoved = false;
    try {
      await fs.rm(webappDir, { recursive: true });
      webappRemoved = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }

    // `false` is "this box has a skills root and nothing of that name was in
    // it", and `mcp/tools/desktop.ts` says that out loud: "there was no skill
    // of that name on disk". Over a WEB APP that is an absence report about
    // something that never existed, which a small model relays as a partial
    // failure — so a web app answers `null`, "no skill half to report on",
    // whichever way it was recognised: its `installed_meta.webappUrl`, or the
    // deployed directory this uninstall just removed (the meta can be missing,
    // or unreadable for a moment, and `isRegisteredWebapp` is deliberately
    // cautious there).
    if (skillRemoved === false && (isWebapp || webappRemoved)) skillRemoved = null;

    // Remove cached icon from the same location the install/icon routes use
    // (DATA_DIR/icons). The old hardcoded ~/clawbox/data/icons path diverged
    // whenever CLAWBOX_ROOT != $HOME/clawbox, orphaning the PNG on disk.
    const iconPath = path.join(DATA_DIR, "icons", `${appId}.png`);
    await fs.rm(iconPath, { force: true }).catch(() => {});

    // The skill's `skills.entries.<id>` in openclaw.json goes too, or a later
    // install under the same id silently inherits `enabled: false`. Best
    // effort, like the icon: the files are already gone. Same condition as the
    // directory above, and for the same reason it is not the WEBAPP condition:
    // an id that is both keeps its entry otherwise. Not because the call would
    // write anything on a box with no config (it returns early on a missing
    // entry, before `writeConfig` is reached), but because on the hermes SKU
    // there is no OpenClaw configuration for this route to own, and a leftover
    // ~/.openclaw/openclaw.json on that SKU is not ours to rewrite.
    if (skillRoot) {
      await clearSkillEntry(appId).catch((err) => {
        console.warn("[uninstall] Failed to clear the skill's openclaw.json entry:", err instanceof Error ? err.message : err);
      });
    }

    // Keep the desktop's `installed_apps` and `installed_meta` preferences
    // in sync — same reason as the install route: MCP / CLI uninstalls would
    // otherwise leave stale entries in the Store's Installed tab and a
    // phantom desktop icon until the next page mount. These routes are the
    // only writers of the two keys; the desktop reads them.
    try {
      const all = await configGetAll();
      const currentApps = all["pref:installed_apps"];
      const currentMeta = all["pref:installed_meta"];
      const updates: Record<string, unknown> = {};

      if (Array.isArray(currentApps)) {
        const next = (currentApps as string[]).filter((id) => id !== appId);
        if (next.length !== currentApps.length) {
          updates["pref:installed_apps"] = next;
        }
      }
      if (currentMeta && typeof currentMeta === "object" && appId in (currentMeta as Record<string, unknown>)) {
        const metaMap = { ...(currentMeta as Record<string, unknown>) };
        delete metaMap[appId];
        updates["pref:installed_meta"] = metaMap;
      }
      // setPreferences applies the preference rules — this does not go through
      // POST /setup-api/preferences, and removing one entry writes the rest of
      // the collection back out with it.
      await setPreferences(updates);
      // The window's saved form values. A delete, not a preference write, so
      // it goes straight to the store: setPreferences drops an undefined.
      const settingsKey = `pref:app_${appId}_settings`;
      if (settingsKey in all) await configSetMany({ [settingsKey]: undefined });
    } catch (err) {
      console.warn("[uninstall] Failed to update installed_apps/meta preferences:", err instanceof Error ? err.message : err);
    }

    // What the installed-app window kept in KV for this app: the form draft,
    // the enabled flag it used to mirror, and the window size. Left behind,
    // the flag made a reinstalled skill open as "Disabled".
    for (const key of [
      `clawbox-app-settings-${appId}`,
      `clawbox-skill-enabled-${appId}`,
      `clawbox-winsize-installed-${appId}`,
    ]) {
      try {
        kvDelete(key);
      } catch (err) {
        console.warn(`[uninstall] Failed to drop KV key ${key}:`, err instanceof Error ? err.message : err);
      }
    }

    // No gateway bounce: removing the skill directory is a change under a
    // watched skill root, so the agent drops the skill on its next turn. The
    // skill-info cache rescans behind this reply.
    refreshSkillsCache();
    // The field is present only when it is false, so an older MCP or desktop
    // reading `undefined` degrades to exactly today's answer.
    return NextResponse.json({
      ok: true,
      appId,
      skillRemoved,
      ...(skillHalfChecked ? {} : { skillHalfChecked: false }),
    });
  } catch (err) {
    console.error("[uninstall] Uninstall failed:", err instanceof Error ? err.message : err);
    // The same failure contract the two refusals above carry, and the same
    // rule: say what is true. Everything after the skill removal can still
    // throw — an EACCES under data/webapps, say — and by then the skill folder
    // may already be gone, so an opaque "Uninstall failed" hides the one fact
    // that decides what to do next. Retryable because the rest of the cleanup
    // is idempotent: a second attempt removes what is left.
    return NextResponse.json({
      ok: false,
      error: skillRemoved === true
        ? "The uninstall failed after the app's skill folder had already been removed, so the app is only partly gone. Try again."
        : "The uninstall failed. Try again in a moment.",
      code: "uninstall_failed",
      retryable: true,
      skillRemoved,
    }, { status: 500 });
  }
}
