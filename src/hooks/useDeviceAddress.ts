"use client";

import { useEffect, useState } from "react";

const DEFAULT_LOCAL_URL = "http://clawbox.local";

export interface DeviceAddress {
  /** `http://<hostname>.local` — always present (best-effort fallback). */
  localUrl: string;
  /** Best URL to show users: the IP when known, otherwise the `.local` name. */
  primaryUrl: string;
}

const INITIAL: DeviceAddress = {
  localUrl: DEFAULT_LOCAL_URL,
  primaryUrl: DEFAULT_LOCAL_URL,
};

/**
 * Returns the device's reachable URLs. The IP-based URL is the reliable
 * primary: on many home networks the access point drops wired→Wi-Fi mDNS
 * multicast, so `<hostname>.local` resolution is unreliable. `.local` is kept
 * as a best-effort fallback.
 */
export function useDeviceAddress(): DeviceAddress {
  const [address, setAddress] = useState<DeviceAddress>(INITIAL);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/setup-api/system/hostname", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (controller.signal.aborted || !data) return;
        const fqdn =
          typeof data.fqdn === "string" &&
          data.fqdn.trim() !== "" &&
          /^[a-zA-Z0-9.-]+$/.test(data.fqdn)
            ? data.fqdn
            : null;
        const ip =
          typeof data.ipv4 === "string" &&
          /^\d{1,3}(\.\d{1,3}){3}$/.test(data.ipv4)
            ? data.ipv4
            : null;
        const localUrl = fqdn ? `http://${fqdn}` : DEFAULT_LOCAL_URL;
        const ipUrl = ip ? `http://${ip}` : "";
        setAddress({ localUrl, primaryUrl: ipUrl || localUrl });
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return address;
}
