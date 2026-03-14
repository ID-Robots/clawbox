export const dynamic = "force-dynamic";

const CODE_SERVER_PORT = process.env.CODE_SERVER_PORT || "8080";

export async function GET() {
  try {
    const res = await fetch(`http://127.0.0.1:${CODE_SERVER_PORT}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel();
    return Response.json({ available: true, port: Number(CODE_SERVER_PORT) });
  } catch {
    // Try root path as fallback (older code-server versions)
    try {
      const res = await fetch(`http://127.0.0.1:${CODE_SERVER_PORT}`, {
        signal: AbortSignal.timeout(3000),
      });
      const available = res.ok || res.status === 302;
      await res.body?.cancel();
      if (available) {
        return Response.json({ available: true, port: Number(CODE_SERVER_PORT) });
      }
    } catch {}
    return Response.json({ available: false, port: Number(CODE_SERVER_PORT) });
  }
}
