import { describe, expect, it, vi } from "vitest";
import { tryCloseOAuthWindow, parseAuthInput } from "@/lib/oauth-utils";
import type { MutableRefObject } from "react";

describe("oauth-utils", () => {
  describe("tryCloseOAuthWindow", () => {
    it("returns tabClosed true when ref is null", () => {
      const ref: MutableRefObject<Window | null> = { current: null };

      const result = tryCloseOAuthWindow(ref);

      expect(result.tabClosed).toBe(true);
      expect(result.closeHint).toBe("");
      expect(ref.current).toBeNull();
    });

    it("returns tabClosed true when window is already closed", () => {
      const mockWindow = { closed: true, close: vi.fn() } as unknown as Window;
      const ref: MutableRefObject<Window | null> = { current: mockWindow };

      const result = tryCloseOAuthWindow(ref);

      expect(result.tabClosed).toBe(true);
      expect(result.closeHint).toBe("");
      expect(mockWindow.close).not.toHaveBeenCalled();
      expect(ref.current).toBeNull();
    });

    it("closes window and returns tabClosed true when close succeeds", () => {
      const popupState = { closed: false };
      const mockWindow = {
        get closed() {
          return popupState.closed;
        },
        close: vi.fn(() => {
          popupState.closed = true;
        }),
      } as unknown as Window;
      const ref: MutableRefObject<Window | null> = { current: mockWindow };

      const result = tryCloseOAuthWindow(ref);

      expect(mockWindow.close).toHaveBeenCalled();
      expect(result.tabClosed).toBe(true);
      expect(result.closeHint).toBe("");
      expect(ref.current).toBeNull();
    });

    it("returns tabClosed false with hint when close fails", () => {
      const mockWindow = {
        closed: false,
        close: vi.fn(), // close() doesn't change .closed
      } as unknown as Window;
      const ref: MutableRefObject<Window | null> = { current: mockWindow };

      const result = tryCloseOAuthWindow(ref);

      expect(mockWindow.close).toHaveBeenCalled();
      expect(result.tabClosed).toBe(false);
      expect(result.closeHint).toBe(" You can close the authorization tab.");
      expect(ref.current).toBeNull();
    });

    it("handles cross-origin errors gracefully", () => {
      const mockWindow = {
        closed: false,
        close: vi.fn(() => {
          throw new Error("cross-origin");
        }),
      } as unknown as Window;
      const ref: MutableRefObject<Window | null> = { current: mockWindow };

      const result = tryCloseOAuthWindow(ref);

      expect(mockWindow.close).toHaveBeenCalled();
      expect(result.tabClosed).toBe(false);
      expect(result.closeHint).toBe(" You can close the authorization tab.");
      expect(ref.current).toBeNull();
    });
  });

  describe("parseAuthInput", () => {
    it("returns trimmed raw code when not a URL", () => {
      const result = parseAuthInput("  abc123  ");
      expect(result).toBe("abc123");
    });

    it("extracts code from http URL", () => {
      const result = parseAuthInput("http://localhost/callback?code=mycode123");
      expect(result).toBe("mycode123");
    });

    it("extracts code from https URL", () => {
      const result = parseAuthInput("https://example.com/callback?code=secureCode");
      expect(result).toBe("secureCode");
    });

    it("extracts code and state from URL and combines with hash", () => {
      const result = parseAuthInput("https://example.com/callback?code=abc&state=xyz");
      expect(result).toBe("abc#xyz");
    });

    it("returns code only when no state in URL", () => {
      const result = parseAuthInput("https://example.com/callback?code=onlycode");
      expect(result).toBe("onlycode");
    });

    it("returns trimmed URL when no code param present", () => {
      const result = parseAuthInput("https://example.com/callback?other=value");
      expect(result).toBe("https://example.com/callback?other=value");
    });

    it("returns trimmed input for invalid URL", () => {
      const result = parseAuthInput("http://[invalid");
      expect(result).toBe("http://[invalid");
    });

    it("handles URL with empty code param", () => {
      const result = parseAuthInput("https://example.com/callback?code=");
      // Empty string is falsy, so returns the trimmed input
      expect(result).toBe("https://example.com/callback?code=");
    });

    it("handles whitespace around URL", () => {
      const result = parseAuthInput("  https://example.com/callback?code=trimmed  ");
      expect(result).toBe("trimmed");
    });

    it("handles state without code returns trimmed URL", () => {
      const result = parseAuthInput("https://example.com/callback?state=onlystate");
      expect(result).toBe("https://example.com/callback?state=onlystate");
    });
  });
});
