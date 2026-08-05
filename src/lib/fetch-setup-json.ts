export const SETUP_AUTH_EXPIRED_MESSAGE =
  "Your ClawBox session has expired. Refresh the page and sign in again.";

export type SetupFetchResult<T> =
  | { kind: "ok"; data: T; response: Response }
  | { kind: "auth-expired"; response: Response }
  | { kind: "error"; data: unknown; response: Response };

function redirectedToLogin(response: Response): boolean {
  if (!response.redirected || !response.url) return false;
  try {
    return new URL(response.url, "https://example.invalid").pathname.endsWith("/login");
  } catch {
    return false;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Fetch a protected setup endpoint without following an expired session into
 * a misleading HTML/405 failure. The Accept header makes middleware return a
 * JSON 401; the final-URL check also covers already-followed login redirects.
 */
export async function fetchSetupJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<SetupFetchResult<T>> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401 || redirectedToLogin(response)) {
    return { kind: "auth-expired", response };
  }

  const data = await readJson(response);
  if (!response.ok || data === undefined) {
    return { kind: "error", data, response };
  }

  return { kind: "ok", data: data as T, response };
}
