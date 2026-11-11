export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { parseExternalApiKey, validateExternalEngineInput } from "@/lib/external-engine-shared";
import { NO_KEY_PLACEHOLDER, probeExternalEngine, readExternalEngine, readExternalEngineKey } from "@/lib/external-engine";

/**
 * The Test button of Settings → Local AI → External engine (TASK-2376), owner
 * only: `GET {base}/models` with the key, bounded, nothing written. Answers
 * 200 with `ok: false` and a `code` (`unreachable`, `unauthorized`,
 * `model_not_listed`, `bad_response`) when the endpoint is not usable — the
 * request itself worked — and 400 for fields that are not valid at all.
 *
 * With no key typed, the stored key is used, but only for the address it was
 * saved for: a changed host must never be sent the key of another.
 */
export async function POST(request: Request) {
  const unauthorized = await requireSession(request, { ownerOnly: true });
  if (unauthorized) return unauthorized;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const valid = validateExternalEngineInput(body);
  if (!valid.ok) return NextResponse.json({ error: valid.error, code: valid.code, field: valid.field }, { status: 400 });
  const typed = parseExternalApiKey(body.apiKey);
  if (!typed.ok) return NextResponse.json({ error: typed.error, code: "invalid_api_key", field: "apiKey" }, { status: 400 });

  let apiKey = typed.key;
  if (!apiKey && body.clearApiKey !== true) {
    const saved = await readExternalEngine();
    if (saved && new URL(saved.baseUrl).origin === new URL(valid.value.baseUrl).origin) {
      const stored = readExternalEngineKey();
      apiKey = stored && stored !== NO_KEY_PLACEHOLDER ? stored : null;
    }
  }
  const probe = await probeExternalEngine({ baseUrl: valid.value.baseUrl, apiKey, modelId: valid.value.modelId });
  return NextResponse.json(probe, { headers: { "Cache-Control": "no-store" } });
}
