import type { Metadata, Viewport } from "next";
import { getMetadataBase } from "@/lib/site-url";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: "resizes-content",
  viewportFit: "cover",
  themeColor: "#0a0f1a",
};

export const metadata: Metadata = {
  metadataBase: getMetadataBase(),
  applicationName: "ClawBox",
  title: {
    default: "ClawBox | Private Local AI Assistant OS",
    template: "%s | ClawBox",
  },
  description:
    "ClawBox is a private AI assistant OS for NVIDIA Jetson and x64 desktops, with local setup, OpenClaw integration, browser automation, and on-device AI fallbacks.",
  manifest: "/manifest.json",
  keywords: [
    "ClawBox",
    "OpenClaw",
    "private AI assistant",
    "local AI device",
    "NVIDIA Jetson AI",
    "AI desktop OS",
    "browser automation",
    "MCP tools",
  ],
  alternates: {
    canonical: "/",
  },
  robots: {
    index: false,
    follow: false,
  },
  openGraph: {
    title: "ClawBox | Private Local AI Assistant OS",
    description:
      "Private AI assistant OS with browser-based setup, OpenClaw integration, browser automation, and local AI fallbacks.",
    url: "/",
    siteName: "ClawBox",
    type: "website",
    images: [
      {
        url: "/clawbox-box.png",
        width: 1200,
        height: 630,
        alt: "ClawBox private AI assistant device",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ClawBox | Private Local AI Assistant OS",
    description:
      "Private AI assistant OS with browser-based setup, OpenClaw integration, browser automation, and local AI fallbacks.",
    images: ["/clawbox-box.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ClawBox",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="font-body flex flex-col bg-stars bg-nebula relative" style={{ minHeight: '100dvh', height: '100dvh', overflow: 'hidden' }}>
        {children}
      </body>
    </html>
  );
}
