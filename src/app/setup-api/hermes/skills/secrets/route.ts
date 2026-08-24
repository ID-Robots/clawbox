export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hermesSkillsGuard } from "@/lib/hermes-skills-server";
import {
  clearHermesSecret,
  hermesSecretsPresent,
  isValidEnvKey,
  isValidEnvValue,
  setHermesSecret,
} from "@/lib/hermes-skill-secrets";

// TASK-452 — the missing half of "this skill needs an API key".
//
// `/skills/inspect` has always returned each declared secret's label, the
// environment variable it must be stored under, and the provider page that
// issues it, and the detail view has always rendered all three. There was
// simply nowhere to put the key: no route in this family wrote one, and the
// only thing in the product that touches ~/.hermes/.env is the Telegram
// integration. A customer following the store's own instructions reached a page
// that said "create a token at …" and then stopped.
//
// GET  ?keys=A,B   → { secrets: { A: true, B: false } } — SET or NOT, never the
//                    value. There is deliberately no read path: a stored key is
//                    write-only from the browser's point of view.
// POST { key, value }        → store it
// POST { key, value: "" }    → clear it
//
// The store is a Hermes surface, so the same 404-off-Hermes guard the rest of
// the family uses applies here first.

const MAX_KEYS = 24;

export async function GET(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  const raw = new URL(request.url).searchParams.get("keys") || "";
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, MAX_KEYS);
  // An unparseable key is not an error — it is a key that cannot be set, and
  // reporting it as "not set" is both true and what the UI needs to render.
  const invalid = keys.filter((k) => !isValidEnvKey(k));
  if (invalid.length) {
    return NextResponse.json({ error: "Invalid secret name" }, { status: 400 });
  }
  try {
    return NextResponse.json({ secrets: await hermesSecretsPresent(keys) });
  } catch {
    return NextResponse.json({ error: "Could not read stored keys" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  let body: { key?: unknown; value?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  // Not trimmed: a leading or trailing space can be part of a secret, and
  // silently altering a credential is worse than storing an odd one.
  const value = typeof body.value === "string" ? body.value : "";

  if (!isValidEnvKey(key)) {
    return NextResponse.json({ error: "Invalid secret name" }, { status: 400 });
  }
  if (!isValidEnvValue(value)) {
    return NextResponse.json({ error: "Invalid value" }, { status: 400 });
  }

  try {
    if (!value) {
      await clearHermesSecret(key);
      return NextResponse.json({ ok: true, key, set: false });
    }
    const stored = await setHermesSecret(key, value);
    if (!stored) return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    return NextResponse.json({ ok: true, key, set: true });
  } catch (err) {
    // The message could name the .env path; log it, answer generically.
    console.error("[hermes skills secrets] write failed", err);
    return NextResponse.json({ error: "Could not save the key" }, { status: 500 });
  }
}
