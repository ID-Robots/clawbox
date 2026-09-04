/**
 * The CDP page handles /setup-api/browser hands out, and who opened each one.
 *
 * It lived inside the route as a bare Map. That was enough while every caller
 * was the assistant driving the desktop's own Chromium, and wrong as soon as a
 * delegated coding run started driving it too:
 *
 *   - the route reused `context.pages().at(-1)`, so a run steered the tab the
 *     owner was reading, and the ten-minute idle sweep then CLOSED that tab;
 *   - nothing recorded which run a page belonged to, so a run that never
 *     called browser_close left its page on the last file:// it rendered until
 *     the sweep got to it — and the sweep could not tell whose page it was.
 *
 * So a session now carries the run that opened it (null for the assistant or
 * the owner), the runner closes exactly its own pages when a run settles
 * (`closeSessionsForRun`), and the route opens a NEW page for a run instead of
 * borrowing the last one. SERVER ONLY: it holds live Playwright handles.
 *
 * In memory on purpose, like the page handles themselves: a web-server restart
 * takes the CDP connection with it, so there is nothing for a persisted record
 * to refer to.
 */

/** The little of a Playwright Page this module needs — see the route for the rest. */
export interface SessionPage {
  close(): Promise<void>;
}

export interface BrowserSession<P extends SessionPage = SessionPage> {
  page: P;
  lastActivity: number;
  /** The coding run that opened this page, or null for the owner/assistant. */
  runId: string | null;
}

const sessions = new Map<string, BrowserSession>();
let sessionCounter = 0;

/**
 * Close the page (not the shared Browser) after ten minutes of inactivity, so
 * a stale cleanup does not tear the CDP connection out from under the next
 * tool call.
 */
export const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/** Register a page and answer the id every later action names it by. */
export function openSession<P extends SessionPage>(page: P, runId: string | null): string {
  const id = `browser-${++sessionCounter}`;
  sessions.set(id, { page, lastActivity: Date.now(), runId });
  return id;
}

/** The live session for an id, or null. Does NOT stamp the activity clock. */
export function getSession<P extends SessionPage = SessionPage>(id: string): BrowserSession<P> | null {
  return (sessions.get(id) as BrowserSession<P> | undefined) ?? null;
}

/** Note that this session did something, so the idle sweep leaves it alone. */
export function touchSession(id: string): void {
  const session = sessions.get(id);
  if (session) session.lastActivity = Date.now();
}

/** Close one session's page and forget it. Answers whether there was one. */
export async function closeSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  await session.page.close().catch(() => {});
  return true;
}

/**
 * Close every page a run opened, and answer how many.
 *
 * Called when a run settles or is stopped. It can close nothing at all — a run
 * that used browser_close itself, or never opened a page — and that is the
 * normal case rather than a failure.
 */
export async function closeSessionsForRun(runId: string): Promise<number> {
  const mine = [...sessions.entries()].filter(([, session]) => session.runId === runId);
  for (const [id] of mine) sessions.delete(id);
  await Promise.all(mine.map(([, session]) => session.page.close().catch(() => {})));
  return mine.length;
}

/** Close the sessions nobody has touched in SESSION_TIMEOUT_MS; answers their ids. */
export function sweepIdle(now = Date.now()): string[] {
  const stale: string[] = [];
  for (const [id, session] of sessions) {
    if (now - session.lastActivity <= SESSION_TIMEOUT_MS) continue;
    stale.push(id);
    sessions.delete(id);
    void session.page.close().catch(() => {});
  }
  return stale;
}

/** How many pages are open. The owned headless Chromium is closed at zero. */
export function sessionCount(): number {
  return sessions.size;
}

/** Test hook: forget every session without touching the (mocked) pages. */
export function _resetBrowserSessionsForTests(): void {
  sessions.clear();
  sessionCounter = 0;
}
