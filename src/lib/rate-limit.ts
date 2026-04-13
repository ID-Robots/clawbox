/**
 * In-memory IP rate limiter. Buckets are independent windows; share a bucket
 * across endpoints that should consume the same budget (e.g., password verify
 * + password change should both pull from `"password"`).
 */

const buckets = new Map<string, Map<string, { count: number; firstAttempt: number }>>();

/**
 * The box runs Next.js directly on port 80 with no reverse proxy in front,
 * so x-forwarded-for is client-controlled. On a single-tenant LAN device
 * this is acceptable: there's no isolation between users to defend, and
 * worst case an attacker spoofs headers to consume their own bucket. If
 * this ever moves behind a real proxy, switch to the connection remote IP.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

function sweepExpired(map: Map<string, { count: number; firstAttempt: number }>, windowMs: number, now: number): void {
  for (const [ip, record] of map) {
    if (now - record.firstAttempt > windowMs) map.delete(ip);
  }
}

export function checkRateLimit(bucket: string, ip: string, opts: { windowMs: number; max: number }): boolean {
  if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
    throw new RangeError(`rate-limit: opts.windowMs must be a positive number, got ${opts.windowMs}`);
  }
  if (!Number.isFinite(opts.max) || opts.max <= 0) {
    throw new RangeError(`rate-limit: opts.max must be a positive number, got ${opts.max}`);
  }
  let map = buckets.get(bucket);
  if (!map) { map = new Map(); buckets.set(bucket, map); }
  const now = Date.now();
  // Lazy sweep on every check — O(n) over the bucket, but n stays tiny on a
  // single-tenant LAN device. Keeps memory bounded without a setInterval.
  sweepExpired(map, opts.windowMs, now);
  const record = map.get(ip);
  if (!record) {
    map.set(ip, { count: 1, firstAttempt: now });
    return true;
  }
  record.count++;
  return record.count <= opts.max;
}

export function resetRateLimit(bucket: string, ip: string): void {
  buckets.get(bucket)?.delete(ip);
}
