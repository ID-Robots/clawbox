export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hermesSkillsGuard } from "@/lib/hermes-skills-server";
import {
  HermesEnvUnreadableError,
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
  // A key that cannot name a Hermes environment variable is a caller bug, not a
  // key that happens to be unset, so it is refused rather than reported false.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // `null`, an array and a bare string are all valid JSON, and reading .key off
  // the first of them throws. Establish that this is an object before anything
  // else looks at it.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { key: rawKey, value: rawValue } = body as { key?: unknown; value?: unknown };

  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!isValidEnvKey(key)) {
    return NextResponse.json({ error: "Invalid secret name" }, { status: 400 });
  }

  // Deleting a stored credential is destructive, so it has to be asked for. A
  // request that omits `value`, or sends null or a number, is a malformed
  // request and is refused — coercing it to "" would have made a typo in the
  // caller silently remove the customer's API key. Only an explicit empty
  // string means remove.
  if (typeof rawValue !== "string") {
    return NextResponse.json({ error: "Invalid value" }, { status: 400 });
  }
  // Not trimmed: a leading or trailing space can be part of a secret, and
  // silently altering a credential is worse than storing an odd one.
  const value = rawValue;

  try {
    // The empty string is the "remove this key" request, not a secret to store,
    // so it is answered before the value alphabet is checked — the alphabet
    // describes what a stored secret may contain, and nothing is being stored.
    if (value === "") {
      await clearHermesSecret(key);
      return NextResponse.json({ ok: true, key, set: false });
    }
    if (!isValidEnvValue(value)) {
      return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    }
    const stored = await setHermesSecret(key, value);
    if (!stored) return NextResponse.json({ error: "Invalid value" }, { status: 400 });
    return NextResponse.json({ ok: true, key, set: true });
  } catch (err) {
    // The message could name the .env path; log it, answer generically.
    console.error("[hermes skills secrets] write failed", err);
    // One failure the customer can act on, and the one that must never be
    // mistaken for a save: the device's environment file is there but could not
    // be read, so it was left exactly as it was rather than replaced by a file
    // built from nothing.
    if (err instanceof HermesEnvUnreadableError) {
      return NextResponse.json(
        {
          error: "The device's environment file could not be read, so nothing was changed.",
          code: "env_unreadable",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: "Could not save the key" }, { status: 500 });
  }
}
