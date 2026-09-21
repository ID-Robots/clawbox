import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatFileCard from "@/components/ChatFileCard";
import { extractFileAttachments, mediaUrl } from "@/lib/chat-media";

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

  // TASK-892: the card read "full", showed no size and its download 404'd.
  it("names, sizes and downloads a file the gateway hosts", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const gatewayUrl = "/api/chat/media/outgoing/agent%3Amain%3Amain/7c9e6679-7425-40de-944b-e07fc1f90ae7/full";
    const [src] = extractFileAttachments({
      content: [{
        type: "attachment",
        attachment: { url: gatewayUrl, mimeType: "text/csv", label: "report.csv", size: 2048 },
      }],
    }).files;
    render(<ChatFileCard src={src} />);

    expect(screen.getByText("report.csv")).toBeInTheDocument();
    expect(screen.queryByText("full")).toBeNull();
    expect(screen.getByTestId("chat-file-size")).toHaveTextContent("2.0 KB");
    // The /api proxy forwards no Content-Length, so there is nothing to probe.
    expect(fetchMock).not.toHaveBeenCalled();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", gatewayUrl);
    expect(link).toHaveAttribute("download", "report.csv");
    expect(link).not.toHaveAttribute("target");
  });

  it("prefers the size on disk to the one the payload carried", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "Content-Length": "4096" }),
    })));
    const src = `${mediaUrl("/home/clawbox/.openclaw/workspace/report.csv")}#name=report.csv&size=10`;
    render(<ChatFileCard src={src} />);
    expect(screen.getByTestId("chat-file-size")).toHaveTextContent("10 B");
    await waitFor(() => expect(screen.getByTestId("chat-file-size")).toHaveTextContent("4.0 KB"));
  });

  it("claims no size for a file the probe found gone, whatever the payload said", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, headers: new Headers() })));
    const src = `${mediaUrl("/home/clawbox/.openclaw/workspace/gone.pdf")}#name=gone.pdf&size=52000`;
    render(<ChatFileCard src={src} />);
    await waitFor(() => expect(screen.getByTestId("chat-file-card")).toHaveStyle({ opacity: "0.55" }));
    expect(screen.queryByTestId("chat-file-size")).toBeNull();
    expect(screen.getByText("gone.pdf")).toBeInTheDocument();
  });
});
