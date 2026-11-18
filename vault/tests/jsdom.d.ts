// jsdom ships no types and @types/jsdom is not a dependency: the one class the
// desktop-app test (ui.test.ts) uses, as it uses it.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; pretendToBeVisual?: boolean });
    readonly window: Window & typeof globalThis;
  }
}
