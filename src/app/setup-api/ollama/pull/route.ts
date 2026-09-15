export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { DATA_DIR } from "@/lib/config-store";
import { checkInstallDisk } from "@/lib/install-disk";
import { ensureLocalAiReady, getOllamaBaseUrl } from "@/lib/local-ai-runtime";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

const OLLAMA_BASE = getOllamaBaseUrl();

export async function POST(request: Request) {
  // A bodyless POST used to default to pulling llama3.2:3b, so an anonymous
  // caller on the setup AP could fill the disk one multi-GB pull at a time.
  // Local Models is a desktop/AIModelsStep surface and both are authenticated
  // by the time they run, so it fails closed. TASK-443.
  //
  // OWNER ONLY since Settings -> Local AI became the place models are
  // installed from. `requireSession` here admitted the MCP BEARER as well as
  // the owner's cookie — middleware hands it to every /setup-api route — so
  // the agent could pull models onto the owner's disk with no click behind it.
  // The owner's decision of 2026-09-14 is that a local model arrives when
  // somebody asks for it, which means this is the person's verb, exactly like
  // the voice and memory-model installs beside it. Same origin too: a
  // multi-gigabyte download started by another site's page is the same spend.
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Downloading a model needs a signed-in browser session.", code: "owner_only" },
      { status: 403 },
    );
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "Downloading a model only works from this ClawBox's own pages.", code: "cross_origin" },
      { status: 403 },
    );
  }

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

    // Stream the progress back to the client, line by line rather than chunk
    // by chunk. Two reasons, and the second is the whole point: a chunk can cut
    // a JSON object in half, and the DISK CHECK below has to read the objects.
    //
    // Ollama is the one install here whose size cannot be known before it
    // starts — the registry manifest is not something to resolve by hand — so
    // the check is made on the FIRST `total` the pull reports, which arrives
    // within the first few lines and long before the bytes do. A model that
    // will not fit is stopped there, with the same `disk_full` shape every
    // other install route refuses with, instead of filling the disk and taking
    // the box's own update build with it.
    const reader = ollamaRes.body?.getReader();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        if (!reader) {
          controller.close();
          return;
        }
        const decoder = new TextDecoder();
        let buffered = "";
        let checkedDisk = false;
        const send = (payload: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));

        /** Answers a refusal to emit, or null to carry on. */
        const inspect = async (line: string): Promise<Record<string, unknown> | null> => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
          if (typeof parsed.error === "string") return { error: parsed.error };
          if (checkedDisk) return null;
          const total = parsed.total;
          if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
          checkedDisk = true;
          // What is already downloaded does not have to be found again, so the
          // requirement is what is LEFT — otherwise a resumed pull of a model
          // mostly on disk is refused for room it does not need.
          const done = typeof parsed.completed === "number" && parsed.completed > 0 ? parsed.completed : 0;
          const verdict = await checkInstallDisk(DATA_DIR, Math.max(0, total - done));
          if (verdict.ok) return null;
          return {
            error: "There is not enough room on this box for that model.",
            code: "disk_full",
            requiredBytes: verdict.requiredBytes,
            freeBytes: verdict.freeBytes,
            reserveBytes: verdict.reserveBytes,
            shortfallBytes: verdict.shortfallBytes,
          };
        };

        try {
          for (;;) {
            const { done, value } = await reader.read();
            buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let newline = buffered.indexOf("\n");
            while (newline >= 0) {
              const line = buffered.slice(0, newline).trim();
              buffered = buffered.slice(newline + 1);
              newline = buffered.indexOf("\n");
              if (!line) continue;
              const refusal = await inspect(line);
              if (refusal) {
                send(refusal);
                // Let the single `finally` close the controller — closing here
                // too would double-close and reject the stream.
                return;
              }
              controller.enqueue(encoder.encode(`${line}\n`));
            }
            if (done) {
              // A terminal line without its newline still decides the pull.
              const last = buffered.trim();
              if (last) {
                const refusal = await inspect(last);
                if (refusal) {
                  send(refusal);
                  return;
                }
                controller.enqueue(encoder.encode(`${last}\n`));
              }
              break;
            }
          }
        } catch (err) {
          // A cancelled request rejects the read; nobody is listening for an
          // error line then, and enqueueing on a cancelled controller throws.
          if (request.signal.aborted) return;
          const msg = err instanceof Error ? err.message : "Stream error";
          try { send({ error: msg }); } catch { /* client gone */ }
        } finally {
          // The pull is dropped with the reader: whatever this refused, Ollama
          // must not go on downloading it with nothing watching.
          reader.cancel().catch(() => {});
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
