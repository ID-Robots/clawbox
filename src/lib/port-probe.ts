import net from "net";

/**
 * Resolves true if a TCP connection to `host:port` completes within
 * `timeoutMs`. The kernel handles the 3-way handshake without involving
 * the target process's event loop, so this answers "is the listener
 * bound?" cleanly even when the target is blocked on long synchronous
 * work (e.g. OpenClaw gateway during agent prep).
 */
export function isPortOpen(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
    socket.connect(port, host);
  });
}
