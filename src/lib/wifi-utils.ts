export interface WifiNetwork {
  ssid: string;
  signal: number;
  security: string;
  freq: string;
}

/** Convert signal strength (0-100) to 1-4 bar level. */
export function signalToLevel(signal: number): number {
  if (signal >= 75) return 4;
  if (signal >= 50) return 3;
  if (signal >= 25) return 2;
  return 1;
}
