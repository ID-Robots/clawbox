import { NextRequest, NextResponse } from "next/server";

import {
  ClawKeepError,
  clearPassphrase,
  isEncryptionConfigured,
  setPassphrase,
} from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

// /setup-api/clawkeep/encryption
//
// Manages the device-local backup-encryption passphrase. The password
// itself never leaves the device — the runner uses it to AES-CBC the
// openclaw archive *before* uploading to the portal-issued S3 prefix,
// and the same passphrase is required to decrypt during restore. We
// (the portal operator) have no way to recover backups when the user
// loses their passphrase; that's the entire point of the feature.
//
//   GET    → { configured: boolean }
//   POST   { passphrase: "...", confirm: "..." } → { ok: true }
//   DELETE → { ok: true, removed: boolean }       (removes the stored copy)

const NO_STORE = { "Cache-Control": "no-store" } as const;

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

export async function GET() {
  try {
    return NextResponse.json(
      { configured: await isEncryptionConfigured() },
      { headers: NO_STORE },
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : "encryption status failed", 500);
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail("invalid JSON body", 400);
  }

  const passphrase = body.passphrase;
  const confirm = body.confirm;
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    return fail("'passphrase' is required and must be a non-empty string", 400);
  }
  // Reject leading/trailing whitespace outright rather than silently
  // trimming — a passphrase with a stray space at either end almost
  // always means the user pasted from a clipboard that picked up a
  // newline, and storing the trimmed version would later cause a
  // confusing "wrong password" when they type the visible characters
  // back in. Better to surface the validation now.
  if (passphrase !== passphrase.trim()) {
    return fail("passphrase must not have leading or trailing whitespace", 400);
  }
  // Mismatched confirm is a UX-side guardrail — the user types the
  // password twice in the modal and we only accept exact equality. We
  // could let the UI handle this on the client and pass only one field,
  // but keeping the check server-side too means a misbehaving client
  // can't slip past it (e.g. browser autofill forging the second field).
  if (typeof confirm !== "string" || confirm !== passphrase) {
    return fail("passphrase and confirmation do not match", 400);
  }
  if (passphrase.length < 8) {
    // Aim is mostly to nudge the user away from "1234" rather than
    // enforce a strong-password policy — PBKDF2-HMAC-SHA256 with 600k
    // iters already burns enough CPU that even 8-char human passphrases
    // need real money to brute-force. Pick a low floor so the modal
    // isn't user-hostile.
    return fail("passphrase must be at least 8 characters", 400);
  }

  try {
    await setPassphrase(passphrase);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return fail(err instanceof Error ? err.message : "set-passphrase failed", status);
  }
}

export async function DELETE() {
  try {
    const result = await clearPassphrase();
    return NextResponse.json(
      { ok: true, removed: result.removed },
      { headers: NO_STORE },
    );
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return fail(err instanceof Error ? err.message : "clear-passphrase failed", status);
  }
}
