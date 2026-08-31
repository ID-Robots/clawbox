export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ensureLocalAiReady, getOllamaBaseUrl } from "@/lib/local-ai-runtime";

const OLLAMA_URL = getOllamaBaseUrl();
const MODEL_RE = /^[a-zA-Z0-9._:/-]+$/;

/**
 * Ollama answers a refusal as `{"error":"model 'x' not found"}`. Forwarding
 * that body verbatim as our own `error` string handed the owner the escaped
 * JSON; the pull route already unwraps the same shape from its stream.
 */
function ollamaErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch {
    // a plain-text body is its own message
  }
  return text.trim();
}

export async function POST(request: Request) {
  try {
    const { model } = await request.json();
    if (!model || typeof model !== "string" || !MODEL_RE.test(model) || model.includes("..")) {
      return NextResponse.json({ error: "Invalid model name" }, { status: 400 });
    }

    await ensureLocalAiReady("ollama");

    const res = await fetch(`${OLLAMA_URL}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: ollamaErrorMessage(text) || `Ollama returned ${res.status}` },
        { status: res.status },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete model" },
      { status: 500 },
    );
  }
}
