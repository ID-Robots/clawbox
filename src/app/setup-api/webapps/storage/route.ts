export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { APP_ID_RE } from "@/lib/code-projects";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  importLegacyBrowserStorage,
  legacyBrowserImportPlan,
  legacyKvRequest,
  readLegacyStorageRecord,
  writeLegacyLocalStorage,
} from "@/lib/webapp-legacy-storage";
import { isReservedAppId } from "@/lib/webapp-registry";

/**
 * The desktop's end of the webapp legacy-storage layer (TASK-1150; see
 * src/lib/webapp-legacy-storage-rules.ts).
 *
 * A framed webapp never reaches this route: its origin is opaque, so it has no
 * session and its `Origin: null` is refused below. The DESKTOP calls it, from
 * the KV bridge (src/lib/webapp-kv-bridge.ts) on a frame's behalf — naming the
 * app by the frame the message came from, never by anything the app said —
 * and from the browser import before a legacy app's frame is loaded. Every
 * operation is confined to the one app named here; the owner's session (or the
 * MCP bearer, which can already read and write the whole store through
 * /setup-api/kv) is what the middleware demands in front of it.
 *
 * GET  ?app=<id>                                   → { migrated, plan: { tokens, imported } | null }
 * POST { app, op: "kv", request: { method, search, body } }   → { status, body } — v3.9's /setup-api/kv answer
 * POST { app, op: "localStorage", write: { clear, set, remove } } → { dropped }
 * POST { app, op: "importBrowser", entries }       → { copied, kept, refused }
 */

/** A localStorage flush or a browser import is at most this much JSON. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function appIdOf(raw: unknown): string | null {
  return typeof raw === "string" && APP_ID_RE.test(raw) && !isReservedAppId(raw) ? raw : null;
}

function storeFailure(err: unknown): NextResponse {
  console.error("[webapps/storage]", err instanceof Error ? err.message : err);
  return NextResponse.json(
    { error: "The app's storage could not be read, so nothing was changed", code: "store_unreadable" },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  const appId = appIdOf(request.nextUrl.searchParams.get("app"));
  if (!appId) return NextResponse.json({ error: "Invalid app ID", code: "invalid_app_id" }, { status: 400 });
  return NextResponse.json(
    { migrated: readLegacyStorageRecord() !== null, plan: legacyBrowserImportPlan(appId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin request refused", code: "cross_origin" }, { status: 403 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request too large", code: "too_large" }, { status: 413 });
  }
  let body: { app?: unknown; op?: unknown; request?: unknown; write?: unknown; entries?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }
  const appId = appIdOf(body.app);
  if (!appId) return NextResponse.json({ error: "Invalid app ID", code: "invalid_app_id" }, { status: 400 });

  try {
    if (body.op === "kv") {
      const req = (body.request && typeof body.request === "object" ? body.request : {}) as Record<string, unknown>;
      if (typeof req.method !== "string") {
        return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
      }
      const answer = legacyKvRequest(appId, {
        method: req.method,
        search: typeof req.search === "string" ? req.search : "",
        body: typeof req.body === "string" ? req.body : "",
      });
      return NextResponse.json(answer);
    }
    if (body.op === "localStorage") {
      const write = (body.write && typeof body.write === "object" ? body.write : {}) as Record<string, unknown>;
      const result = writeLegacyLocalStorage(appId, {
        clear: write.clear === true,
        set: write.set && typeof write.set === "object" ? (write.set as Record<string, unknown>) : {},
        remove: Array.isArray(write.remove) ? write.remove : [],
      });
      return NextResponse.json(result);
    }
    if (body.op === "importBrowser") {
      if (!body.entries || typeof body.entries !== "object" || Array.isArray(body.entries)) {
        return NextResponse.json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
      }
      return NextResponse.json(importLegacyBrowserStorage(appId, body.entries as Record<string, unknown>));
    }
  } catch (err) {
    return storeFailure(err);
  }
  return NextResponse.json({ error: "Unknown operation", code: "unknown_op" }, { status: 400 });
}
