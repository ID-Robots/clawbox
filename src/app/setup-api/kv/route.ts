import { NextResponse } from "next/server";
import { kvGet, kvSet, kvDelete, kvGetAll, kvSetMany } from "@/lib/kv-store";
import { pushPendingAction } from "@/lib/pending-actions";

export const dynamic = "force-dynamic";

const SAFE_KEY = /^[\w.:-]{1,256}$/;
// The MCP tools and `clawbox notify` post the desktop's pending action under
// the old single-slot key; it is folded into the owner-notice ring
// (src/lib/pending-actions.ts) so every open desktop sees it and the slot
// itself is never stored.
const LEGACY_PENDING_ACTION_KEY = "ui:pending-action";
// Reserved/dunder names slip through SAFE_KEY (all `\w`) but corrupt the plain
// object backing the store — e.g. `data["__proto__"] = "x"` is a silent no-op
// that reports success yet stores nothing, and a read returns Object.prototype.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Bound each value and the batch size so a caller can't grow data/kv.json
// without limit (disk-exhaustion DoS — the whole file is rewritten per set).
const MAX_VALUE_BYTES = 256 * 1024; // 256 KB per value
const MAX_ENTRIES = 500;

function isValidKey(key: string): boolean {
  return SAFE_KEY.test(key) && !RESERVED_KEYS.has(key);
}

function isValidValue(v: unknown): v is string {
  return typeof v === "string" && Buffer.byteLength(v, "utf8") <= MAX_VALUE_BYTES;
}

/** The legacy slot's value, when it is what the ring can hold: a JSON object. */
function parseLegacyAction(value: string): Record<string, unknown> | null {
  let action: unknown;
  try {
    action = JSON.parse(value);
  } catch {
    return null;
  }
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  return action as Record<string, unknown>;
}

// GET /setup-api/kv?key=foo        → single key
// GET /setup-api/kv?prefix=clawbox → all keys with prefix
// GET /setup-api/kv                → all keys
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (key) {
    if (!isValidKey(key)) return NextResponse.json({ error: "Invalid key" }, { status: 400 });
    return NextResponse.json({ key, value: kvGet(key) });
  }
  const prefix = url.searchParams.get("prefix") ?? undefined;
  if (prefix !== undefined && !isValidKey(prefix)) {
    return NextResponse.json({ error: "Invalid prefix" }, { status: 400 });
  }
  return NextResponse.json(kvGetAll(prefix));
}

// POST /setup-api/kv  { key: "foo", value: "bar" }
// POST /setup-api/kv  { entries: { "foo": "bar", "baz": "qux" } }
// POST /setup-api/kv  { delete: "foo" }
export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (typeof body.delete === "string") {
      if (!isValidKey(body.delete)) return NextResponse.json({ error: "Invalid key" }, { status: 400 });
      kvDelete(body.delete);
      return NextResponse.json({ ok: true });
    }
    if (body.entries && typeof body.entries === "object") {
      const rawKeys = Object.keys(body.entries);
      if (rawKeys.length > MAX_ENTRIES) {
        return NextResponse.json({ error: `Too many entries (max ${MAX_ENTRIES})` }, { status: 413 });
      }
      const entries: Record<string, string> = {};
      let legacyAction: Record<string, unknown> | null = null;
      for (const [k, v] of Object.entries(body.entries)) {
        if (!isValidKey(k) || !isValidValue(v)) continue;
        // The retired single-slot key is folded into the ring here too — it
        // must never be persisted as a plain entry, where no desktop would
        // see it. The batch stays as lenient as its other entries: a value
        // that is not a JSON object is dropped like an invalid key.
        if (k === LEGACY_PENDING_ACTION_KEY) {
          legacyAction = parseLegacyAction(v);
          continue;
        }
        entries[k] = v;
      }
      if (Object.keys(entries).length > 0) kvSetMany(entries);
      if (legacyAction) await pushPendingAction(legacyAction);
      return NextResponse.json({ ok: true });
    }
    if (typeof body.key === "string" && typeof body.value === "string") {
      if (!isValidKey(body.key)) return NextResponse.json({ error: "Invalid key" }, { status: 400 });
      if (!isValidValue(body.value)) {
        return NextResponse.json({ error: `Value too large (max ${MAX_VALUE_BYTES} bytes)` }, { status: 413 });
      }
      if (body.key === LEGACY_PENDING_ACTION_KEY) {
        const action = parseLegacyAction(body.value);
        if (!action) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
        await pushPendingAction(action);
        return NextResponse.json({ ok: true });
      }
      kvSet(body.key, body.value);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}
