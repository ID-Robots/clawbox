export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ensureLocalAiReady, getOllamaBaseUrl } from "@/lib/local-ai-runtime";
import { requireSession } from "@/lib/route-auth";

const OLLAMA_BASE = getOllamaBaseUrl();

export async function POST(request: Request) {
  // A bodyless POST used to default to pulling llama3.2:3b, so an anonymous
  // caller on the setup AP could fill the disk one multi-GB pull at a time.
  // Local Models is a desktop/AIModelsStep surface and both are authenticated
  // by the time they run, so it fails closed. TASK-443.
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

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

    // Tied to the client's request: when the owner cancels (or the tab goes
    // away) the upstream connection is dropped too, and Ollama stops the
    // download instead of finishing it in the background with nothing in
    // the UI showing it. Ollama keeps the partial blobs, so a retry resumes.
    const ollamaRes = await fetch(`${OLLAMA_BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
      signal: request.signal,
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => "");
      // Ollama's refusal is a JSON `{error}` body; nest it and the owner
      // reads escaped JSON.
      let message = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed && typeof parsed.error === "string") message = parsed.error;
      } catch { /* plain text is its own message */ }
      return NextResponse.json(
        { error: `Ollama pull failed: ${message || ollamaRes.statusText}` },
        { status: 502 },
      );
    }

    // Stream the progress back to the client
    const reader = ollamaRes.body?.getReader();
    const stream = new ReadableStream({
      async start(controller) {
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
          // A cancelled request rejects the read; nobody is listening for an
          // error line then, and enqueueing on a cancelled controller throws.
          if (request.signal.aborted) return;
          const msg = err instanceof Error ? err.message : "Stream error";
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: msg }) + "\n"));
        } finally {
          try {
            controller.close();
          } catch {
            // already cancelled by the client
          }
        }
      },
      cancel(reason) {
        // Next cancels the response stream when the client disconnects; release
        // the Ollama socket rather than hold it until the pull ends.
        reader?.cancel?.(reason)?.catch(() => {});
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
