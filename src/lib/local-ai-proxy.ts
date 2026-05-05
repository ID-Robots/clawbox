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
      init.body = request.body;
      init.duplex = "half";
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
