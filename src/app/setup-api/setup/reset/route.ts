import { NextResponse } from "next/server";
import { resetConfig } from "@/lib/config-store";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body.confirm) {
      return NextResponse.json(
        { error: "Missing confirmation. Send { \"confirm\": true } to reset." },
        { status: 400 }
      );
    }

    await resetConfig();
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to reset",
      },
      { status: 500 }
    );
  }
}
