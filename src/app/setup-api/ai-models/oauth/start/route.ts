import { NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs/promises";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers";
const STATE_PATH = "/tmp/clawbox-oauth-state.json";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function POST() {
  try {
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(
      crypto.createHash("sha256").update(codeVerifier).digest()
    );
    const state = base64url(crypto.randomBytes(32));

    await fs.writeFile(
      STATE_PATH,
      JSON.stringify({ codeVerifier, state, createdAt: Date.now() }),
      { mode: 0o600 }
    );

    const params = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    return NextResponse.json({
      url: `https://claude.ai/oauth/authorize?${params.toString()}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start OAuth" },
      { status: 500 }
    );
  }
}
