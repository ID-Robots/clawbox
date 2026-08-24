import { NextResponse } from "next/server";
import { getLlamaCppBaseUrl } from "@/lib/llamacpp";
import { verifyLocalAiBearer } from "@/lib/local-ai-token";
import {
  beginLocalAiUse,
  endLocalAiUse,
  ensureLocalAiReady,
  getOllamaBaseUrl,
  type LocalAiProvider,
} from "@/lib/local-ai-runtime";
import {
  applyOllamaThinkingToChatBody,
  applyThinkingToChatBody,
  chatBodyModelId,
  isChatCompletionsPath,
  MAX_REWRITABLE_BODY_BYTES,
} from "@/lib/local-ai-thinking";
import { ollamaModelCanThink } from "@/lib/ollama-capabilities";

/** True when Content-Length already says the body is too big to buffer. */
function declaredOverCap(request: Request, maxBytes: number): boolean {
  const declared = Number(request.headers.get("content-length") || "");
  return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * Read a request body, giving up past `maxBytes` rather than holding an
 * unbounded buffer on a device that has ~3.7 GB free with the model loaded.
 * Returns null when the cap is exceeded mid-stream — at which point the body
 * has been partly consumed and can no longer be forwarded either.
 *
 * Callers check `declaredOverCap` first, so a body that announces its size gets
 * streamed through untouched instead of reaching here at all.
 */
async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  // A loopback POST usually arrives whole; skip the concat copy when it did.
  // `total` is already known, so the multi-chunk path doesn't re-walk either.
  if (chunks.length === 1) return Buffer.from(chunks[0]).toString("utf-8");
  return Buffer.concat(chunks, total).toString("utf-8");
}

function buildUpstreamUrl(provider: LocalAiProvider, pathSegments: string[], search: string): string {
  const baseUrl = provider === "llamacpp" ? getLlamaCppBaseUrl() : getOllamaBaseUrl();
  const suffix = pathSegments.map((segment) => encodeURIComponent(segment)).join("/");
  return `${baseUrl.replace(/\/+$/, "")}/${suffix}${search}`;
}

function forwardHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  // The Bearer is the ClawBox↔openclaw service token (verified above by
  // verifyLocalAiBearer). Don't forward it to llama.cpp / Ollama —
  // those backends shouldn't see our internal token, and a user-
  // configured `llama-server --api-key` would 401 it back to us.
  headers.delete("authorization");
  return headers;
}

function trackResponseBody(body: ReadableStream<Uint8Array> | null, provider: LocalAiProvider) {
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    endLocalAiUse(provider);
  };

  if (!body) {
    finish();
    return null;
  }

  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Translate a buffered chat-completions body for whichever backend will serve
 * it. Both translations are in src/lib/local-ai-thinking.ts; this is only the
 * part that has to reach the network.
 */
async function rewriteChatBody(provider: LocalAiProvider, raw: string): Promise<string> {
  if (provider === "llamacpp") return applyThinkingToChatBody(raw);
  // No field, nothing to decide — and, more importantly, no reason to spend a
  // round trip on the capability probe. Most turns take this branch.
  if (!raw.includes('"reasoning_effort"')) return raw;
  // Cached per model, so a warm conversation pays for the probe once a minute
  // at most; a failed probe answers null and the body is forwarded verbatim.
  const canThink = await ollamaModelCanThink(chatBodyModelId(raw));
  return applyOllamaThinkingToChatBody(raw, canThink);
}

export async function proxyLocalAiRequest(
  request: Request,
  provider: LocalAiProvider,
  pathSegments: string[],
): Promise<Response> {
  if (pathSegments.length === 0) {
    return NextResponse.json({ error: "Missing local AI proxy path" }, { status: 400 });
  }

  // Service-to-service auth: openclaw is the only intended caller. middleware.ts
  // exempts /setup-api/local-ai/<provider>/ so openclaw (which has no session
  // cookie) can reach this route; the bearer check enforces auth here instead.
  if (!verifyLocalAiBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "local-ai bearer token required" }, { status: 401 });
  }

  try {
    await ensureLocalAiReady(provider);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : `Failed to start ${provider}` },
      { status: 502 },
    );
  }

  beginLocalAiUse(provider);

  try {
    const search = new URL(request.url).search;
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: forwardHeaders(request),
      cache: "no-store",
      redirect: "manual",
    };

    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      // Chat completions are the only path whose thinking we can influence, so
      // they are the only one we buffer — everything else keeps streaming.
      // See src/lib/local-ai-thinking.ts for what each backend needs: llama.cpp
      // ignores `reasoning_effort` and reads `chat_template_kwargs`, while
      // Ollama reads `reasoning_effort` and 400s every value but `none` on a
      // model that cannot think.
      // An oversized body is forwarded untouched rather than refused: a turn
      // that runs with the server's default thinking setting beats no turn.
      const rewritable = request.method === "POST"
        && isChatCompletionsPath(pathSegments)
        && !declaredOverCap(request, MAX_REWRITABLE_BODY_BYTES);

      if (rewritable) {
        const raw = await readBoundedBody(request, MAX_REWRITABLE_BODY_BYTES);
        if (raw === null) {
          // Only reachable when the body lied about (or omitted) its length and
          // then ran past the cap. The stream is already partly consumed, so it
          // cannot be forwarded — fail explicitly rather than send the model a
          // truncated request.
          endLocalAiUse(provider);
          return NextResponse.json(
            { error: "Request body too large for the on-device model" },
            { status: 413 },
          );
        }
        // A string body — fetch sets Content-Length from it, replacing the
        // client's header that forwardHeaders stripped.
        init.body = await rewriteChatBody(provider, raw);
      } else {
        init.body = request.body;
        init.duplex = "half";
      }
    }

    const upstreamResponse = await fetch(buildUpstreamUrl(provider, pathSegments, search), init);
    const headers = new Headers(upstreamResponse.headers);
    headers.delete("content-length");
    headers.set("Cache-Control", "no-store");

    return new Response(trackResponseBody(upstreamResponse.body, provider), {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  } catch (err) {
    endLocalAiUse(provider);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : `Failed to proxy ${provider}` },
      { status: 502 },
    );
  }
}
