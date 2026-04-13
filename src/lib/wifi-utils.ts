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

export function dbmToLevel(dbm: number): number {
  if (dbm >= -55) return 4;
  if (dbm >= -65) return 3;
  if (dbm >= -75) return 2;
  if (dbm >= -85) return 1;
  return 0;
}
