import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClawBox Setup",
  description: "ClawBox setup wizard and dashboard",
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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
<body className="font-body min-h-screen flex flex-col">
        {children}
      </body>
    </html>
  );
}
