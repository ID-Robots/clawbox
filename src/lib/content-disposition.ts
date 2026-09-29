/**
 * RFC 5987: quoted ASCII fallback + filename* for Unicode/spaces. Shared by
 * both halves of the Files API — a single download and a selection's ZIP.
 */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  // The ASCII fallback strips anything outside the printable-ASCII range (and
  // quotes/backslashes) so the quoted-string stays valid.
  const asciiName = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
