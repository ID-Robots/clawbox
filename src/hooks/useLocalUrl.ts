"use client";

import { useEffect, useState } from "react";

const DEFAULT_LOCAL_URL = "http://clawbox.local";

/**
 * Returns the device's local-network URL — `http://<configured-hostname>.local`.
 * Falls back to "http://clawbox.local" until the configured hostname is loaded
 * (or if the hostname API is unavailable).
 */
export function useLocalUrl(): string {
  const [url, setUrl] = useState<string>(DEFAULT_LOCAL_URL);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/system/hostname", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (
          !controller.signal.aborted &&
          typeof data?.fqdn === "string" &&
          data.fqdn.trim() !== "" &&
          /^[a-zA-Z0-9.-]+$/.test(data.fqdn)
        ) {
          setUrl(`http://${data.fqdn}`);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return url;
}
