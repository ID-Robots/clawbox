import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { set } from "@/lib/config-store";

export async function POST(request: Request) {
  try {
    let body: { password?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON" },
        { status: 400 }
      );
    }

    const { password } = body;
    if (!password) {
      return NextResponse.json(
        { error: "Password is required" },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    // Use chpasswd via stdin to safely set password without shell injection
    await new Promise<void>((resolve, reject) => {
      const child = spawn("chpasswd", [], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `chpasswd exited with code ${code}`));
      });
      child.stdin.write(`clawbox:${password}\n`);
      child.stdin.end();
    });

    await set("password_configured", true);
    await set("password_configured_at", new Date().toISOString());

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set password" },
      { status: 500 }
    );
  }
}
