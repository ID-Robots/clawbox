export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const OLLAMA_BASE = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

export async function POST(request: Request) {
  let body: { model?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const model = body.model || "llama3.2:3b";

  // Validate model name format (e.g. "llama3.2:3b", "mistral", "qwen2.5-coder:1.5b")
  if (!/^[a-z0-9._-]+(?::[a-zA-Z0-9._-]+)?$/i.test(model)) {
    return NextResponse.json(
      { error: "Invalid model name format" },
      { status: 400 },
    );
  }

  try {
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
            controller.enqueue(value);

            // Parse to check for errors in the stream
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split("\n")) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                if (parsed.error) {
                  controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: parsed.error }) + "\n"));
                  controller.close();
                  return;
                }
              } catch {
                // partial JSON, ignore
              }
            }
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
