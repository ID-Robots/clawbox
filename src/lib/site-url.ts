const FALLBACK_SITE_URL = "https://openclawhardware.dev";

function normalizeSiteUrl(raw: string | undefined): string {
  if (!raw) {
    return FALLBACK_SITE_URL;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return FALLBACK_SITE_URL;
    }
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return FALLBACK_SITE_URL;
  }
}

export function getSiteUrl(): string {
  return normalizeSiteUrl(
    process.env.CANONICAL_ORIGIN
    || process.env.NEXT_PUBLIC_SITE_URL
    || process.env.SITE_URL
  );
}

export function getMetadataBase(): URL {
  return new URL(`${getSiteUrl()}/`);
}
