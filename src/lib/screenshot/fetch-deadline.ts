// A fetch whose time limit covers the BODY as well as the headers.
//
// The capture inlines every stylesheet, font and picture it needs before it
// can draw, so one request that never finishes would leave the capture — and
// with it every later capture, which waits its turn — hanging for good. A
// timer cleared as soon as the headers arrive does not prevent that: a server
// can send its headers and then stall the body. Here the abort stays armed
// until `read` has finished, and the wait itself is raced against it, so a
// body reader that ignores the abort still cannot hold the caller up.

/** As much of `fetch` as this needs — so a test can stand a plain function in for it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The answer of `read`, or null when the request failed, was not ok, or ran past `ms`. */
export async function fetchWithin<T>(
  url: string,
  ms: number,
  read: (response: Response) => Promise<T>,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<T | null> {
  const controller = new AbortController();
  const timedOut = new Promise<null>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), ms);
  const work = (async (): Promise<T | null> => {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return read(response);
  })().catch(() => null);
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** `work`, or a rejection with `onTimeout()` once `ms` have passed — a backstop for a chain of awaits. */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
