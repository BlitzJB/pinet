// Small fixed-window rate limiter (in-memory). One bucket per key, refilled
// each window. Used to blunt credential stuffing, device-flow polling floods,
// and enrollment spam.

export function createRateLimiter({ windowMs = 60_000, max = 120 } = {}) {
  const buckets = new Map();

  function check(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= max;
  }

  function prune() {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }

  function size() {
    return buckets.size;
  }

  return { check, prune, size };
}
