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
  applyThinkingToChatBody,
  isChatCompletionsPath,
  MAX_REWRITABLE_BODY_BYTES,
} from "@/lib/local-ai-thinking";

/**
 * Read a request body, giving up past `maxBytes` rather than holding an
 * unbounded buffer on a device that has ~3.7 GB free with the model loaded.
 * Returns null when the cap is exceeded.
 */
async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  // Trust the declared length when there is one — it lets an oversized body be
  // refused before a single chunk is read.
  const declared = Number(request.headers.get("content-length") || "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
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
      // Chat completions are the only path with a chat template to influence,
      // so they are the only one we buffer — everything else keeps streaming.
      // See src/lib/local-ai-thinking.ts for why the rewrite exists at all
      // (llama.cpp ignores `reasoning_effort`; `chat_template_kwargs` is the
      // field it actually reads).
      const rewritable = provider === "llamacpp"
        && request.method === "POST"
        && isChatCompletionsPath(pathSegments);

      let rewritten: string | null = null;
      if (rewritable) {
        const raw = await readBoundedBody(request, MAX_REWRITABLE_BODY_BYTES);
        if (raw === null) {
          // Over the cap. Nothing is buffered, but the stream has been partly
          // consumed, so it can no longer be forwarded — fail explicitly rather
          // than silently sending a truncated request to the model.
          endLocalAiUse(provider);
          return NextResponse.json(
            { error: "Request body too large for the on-device model" },
            { status: 413 },
          );
        }
        rewritten = applyThinkingToChatBody(raw);
      }

      if (rewritten !== null) {
        init.body = rewritten;
        // The body is a string now, so the upstream length differs from the
        // one we stripped in forwardHeaders. fetch sets it from the body.
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
