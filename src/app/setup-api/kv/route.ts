import { NextResponse } from "next/server";
import { kvGet, kvSet, kvDelete, kvGetAll, kvSetMany } from "@/lib/kv-store";

export const dynamic = "force-dynamic";

const SAFE_KEY = /^[\w.:-]{1,256}$/;

function isValidKey(key: string): boolean {
  return SAFE_KEY.test(key);
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
      const entries: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.entries)) {
        if (isValidKey(k) && typeof v === "string") entries[k] = v;
      }
      if (Object.keys(entries).length > 0) kvSetMany(entries);
      return NextResponse.json({ ok: true });
    }
    if (typeof body.key === "string" && typeof body.value === "string") {
      if (!isValidKey(body.key)) return NextResponse.json({ error: "Invalid key" }, { status: 400 });
      kvSet(body.key, body.value);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}
