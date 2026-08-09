export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ensureLocalAiReady, getOllamaBaseUrl } from "@/lib/local-ai-runtime";

const OLLAMA_BASE = getOllamaBaseUrl();

export async function POST(request: Request) {
  let body: { model?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const model = body.model || "llama3.2:3b";

  // Validate model name format. Mirrors the delete route's MODEL_RE so
  // namespaced refs ("user/model:tag", "hf.co/...") that Ollama accepts
  // aren't rejected here. Reject any ".." segment: the broadened charset
  // permits it, but a traversal-looking ref is never a legitimate model.
  if (!/^[a-zA-Z0-9._:/-]+$/.test(model) || model.includes("..")) {
    return NextResponse.json(
      { error: "Invalid model name format" },
      { status: 400 },
    );
  }

  try {
    await ensureLocalAiReady("ollama");

    const ollamaRes = await fetch(`${OLLAMA_BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => "");
      return NextResponse.json(
        { error: `Ollama pull failed: ${errText || ollamaRes.statusText}` },
        { status: 502 },
      );
    }

    // Stream the progress back to the client
    const stream = new ReadableStream({
      async start(controller) {
        const reader = ollamaRes.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Decode and check for errors before forwarding
            const text = decoder.decode(value, { stream: true });
            let hasError = false;
            for (const line of text.split("\n")) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                if (parsed.error) {
                  controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: parsed.error }) + "\n"));
                  hasError = true;
                  // Let the single `finally` close the controller — closing
                  // here too would double-close and reject the stream with
                  // "Controller is already closed".
                  return;
                }
              } catch {
                // partial JSON, ignore
              }
            }
            if (!hasError) controller.enqueue(value);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Stream error";
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: msg }) + "\n"));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to connect to Ollama" },
      { status: 502 },
    );
  }
}
