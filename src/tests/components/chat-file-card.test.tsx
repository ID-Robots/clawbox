import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatFileCard from "@/components/ChatFileCard";
import { mediaUrl } from "@/lib/chat-media";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatFileCard", () => {
  it("shows the name, probes the size with HEAD and offers a download", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "Content-Length": String(3 * 1024 * 1024) }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const src = mediaUrl("/home/clawbox/.openclaw/media/outbound/data.csv");
    render(<ChatFileCard src={src} />);

    expect(screen.getByText("data.csv")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("chat-file-size")).toHaveTextContent("3.0 MB"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${src}&download=1`);
    expect(init.method).toBe("HEAD");
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", `${src}&download=1`);
    expect(link).toHaveAttribute("download", "data.csv");
  });

  it("does not probe a remote URL and opens it in a new tab", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatFileCard src="https://example.com/files/spec.pdf" />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("spec.pdf")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByTestId("chat-file-size")).toBeNull();
  });
});
