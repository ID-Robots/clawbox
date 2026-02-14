import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PORTAL_URL = process.env.PORTAL_URL || "http://10.42.0.1/";

const REDIRECT_PATHS = new Set([
  "/generate_204", // Android
  "/gen_204", // Android
  "/connecttest.txt", // Windows NCSI
  "/redirect", // Windows NCSI
  "/ncsi.txt", // Windows NCSI
  "/canonical.html", // Firefox
  "/success.txt", // Firefox
]);

const APPLE_PATHS = new Set([
  "/hotspot-detect.html",
  "/library/test/success.html",
]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (REDIRECT_PATHS.has(pathname)) {
    return NextResponse.redirect(PORTAL_URL, 302);
  }

  if (APPLE_PATHS.has(pathname)) {
    return new NextResponse(
      "<HTML><HEAD><TITLE>ClawBox Setup</TITLE></HEAD><BODY>Please complete setup.</BODY></HTML>",
      {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/generate_204",
    "/gen_204",
    "/hotspot-detect.html",
    "/library/test/success.html",
    "/connecttest.txt",
    "/redirect",
    "/ncsi.txt",
    "/canonical.html",
    "/success.txt",
  ],
};
