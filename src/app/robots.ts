import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl();

  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/portal",
          "/portal/subscribe",
          "/manifest.json",
          "/favicon.ico",
          "/favicon-16x16.png",
          "/favicon-32x32.png",
          "/apple-touch-icon.png",
          "/icon-192.png",
          "/icon-512.png",
        ],
        disallow: [
          "/",
          "/app/",
          "/chat",
          "/login",
          "/sessions",
          "/setup",
          "/setup-api/",
          "/logs",
          "/api/",
        ],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
