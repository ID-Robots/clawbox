// DOM test environment: a happy-dom Browser whose network is replaced by the
// HTML fixtures, so pages and their iframes load with real origins and real
// window/parent relationships, without any network access.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Browser } from "happy-dom";

const FIXTURES = join(import.meta.dir, "../fixtures");

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

export interface DomPage {
  browser: Browser;
  /** Windows of the top frame (frameId 0) and its child frames (1, 2, ...). */
  frames: Window[];
  top: Window;
  close(): Promise<void>;
}

/** Open `url` with `routes` mapping URLs to fixture files. */
export async function openPage(url: string, routes: Record<string, string>): Promise<DomPage> {
  const browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
      navigator: { userAgent: "Mozilla/5.0 (test) HappyDOM" },
      fetch: {
        interceptor: {
          beforeAsyncRequest: async ({ request, window }) => {
            const file = routes[request.url];
            return new window.Response(file ? fixture(file) : "not found", {
              status: file ? 200 : 404,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
          },
        },
      },
    },
  });
  const page = browser.newPage();
  // Set URL + content in place (no navigation), so window.top of the main
  // frame is the main frame itself, as in a browser.
  const top = routes[url];
  if (!top) throw new Error(`no fixture routed for ${url}`);
  page.mainFrame.url = url;
  page.mainFrame.content = fixture(top);
  await page.waitUntilComplete();
  const windows = [page.mainFrame.window, ...page.mainFrame.childFrames.map((f) => f.window)] as unknown as Window[];
  return { browser, frames: windows, top: windows[0]!, close: () => browser.close() };
}
