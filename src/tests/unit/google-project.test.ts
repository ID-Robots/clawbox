import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("google-project", () => {
  let discoverGoogleProject: (accessToken: string) => Promise<string | undefined>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function loadModule() {
    const mod = await import("@/lib/google-project");
    discoverGoogleProject = mod.discoverGoogleProject;
  }

  describe("discoverGoogleProject", () => {
    it("returns project string when already onboarded", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          currentTier: { id: "free-tier" },
          cloudaicompanionProject: "my-project-123",
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();
      const result = await discoverGoogleProject("test-token");

      expect(result).toBe("my-project-123");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        })
      );
    });

    it("returns project id object when already onboarded", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          currentTier: { id: "free-tier" },
          cloudaicompanionProject: { id: "project-from-object" },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();
      const result = await discoverGoogleProject("test-token");

      expect(result).toBe("project-from-object");
    });

    it("returns undefined when currentTier exists but no project", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          currentTier: { id: "free-tier" },
          // No cloudaicompanionProject
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();
      const result = await discoverGoogleProject("test-token");

      expect(result).toBeUndefined();
    });

    it("throws when loadCodeAssist fails", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();

      await expect(discoverGoogleProject("bad-token")).rejects.toThrow("loadCodeAssist failed: 401");
    });

    it("onboards user when no currentTier", async () => {
      const mockFetch = vi.fn()
        // First call: loadCodeAssist returns no currentTier
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          }),
        })
        // Second call: onboardUser succeeds immediately
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: true,
            response: {
              cloudaicompanionProject: { id: "new-project-456" },
            },
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();
      const result = await discoverGoogleProject("test-token");

      expect(result).toBe("new-project-456");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenLastCalledWith(
        "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("free-tier"),
        })
      );
    });

    it("uses free-tier when no default tier", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            allowedTiers: [{ id: "some-tier" }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: true,
            response: {
              cloudaicompanionProject: { id: "project" },
            },
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();
      const result = await discoverGoogleProject("test-token");

      expect(result).toBe("project");
      // Should use free-tier as default
      expect(mockFetch.mock.calls[1][1].body).toContain("free-tier");
    });

    it("returns undefined for non-free tier without project", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          allowedTiers: [{ id: "enterprise-tier", isDefault: true }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();
      const result = await discoverGoogleProject("test-token");

      expect(result).toBeUndefined();
      // Should not call onboardUser for non-free tier
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws when onboardUser fails", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Server error"),
        });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();

      await expect(discoverGoogleProject("test-token")).rejects.toThrow("onboardUser failed: 500");
    });

    it("polls LRO when onboard not immediately done", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: false,
            name: "operations/123",
          }),
        })
        // First poll - not done
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: false,
            name: "operations/123",
          }),
        })
        // Second poll - done
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: true,
            response: {
              cloudaicompanionProject: { id: "polled-project" },
            },
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();

      const resultPromise = discoverGoogleProject("test-token");

      // Advance time for polling intervals
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;

      expect(result).toBe("polled-project");
      expect(mockFetch).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });

    it("continues polling on poll failure", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: false,
            name: "operations/123",
          }),
        })
        // First poll fails
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
        })
        // Second poll succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: true,
            response: {
              cloudaicompanionProject: { id: "recovered-project" },
            },
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();

      const resultPromise = discoverGoogleProject("test-token");

      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;

      expect(result).toBe("recovered-project");

      vi.useRealTimers();
    });

    it("returns undefined when LRO completes without project", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: true,
            response: {},
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();

      const result = await discoverGoogleProject("test-token");

      expect(result).toBeUndefined();

      vi.useRealTimers();
    });

    it("handles legacy-tier", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            allowedTiers: [{ id: "legacy-tier", isDefault: true }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: true,
            response: {
              cloudaicompanionProject: { id: "legacy-project" },
            },
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();
      const result = await discoverGoogleProject("test-token");

      expect(result).toBe("legacy-project");
    });

    it("handles poll error thrown", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: false,
            name: "operations/123",
          }),
        })
        // Poll throws error
        .mockRejectedValueOnce(new Error("Network error"))
        // Next poll succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            done: true,
            response: {
              cloudaicompanionProject: { id: "after-error-project" },
            },
          }),
        });
      vi.stubGlobal("fetch", mockFetch);

      await loadModule();

      const resultPromise = discoverGoogleProject("test-token");

      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;

      expect(result).toBe("after-error-project");

      vi.useRealTimers();
    });
  });
});
