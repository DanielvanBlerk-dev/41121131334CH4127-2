import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_ATTEMPTS  = 5;           // failed attempts before lockout
const COOLDOWN_SECS = 15 * 60;    // 15 minutes in seconds
const WINDOW_SECS   = 60 * 60;    // sliding window to track attempts (1 hour)

/**
 * Returns the client IP from common Vercel / proxy headers.
 */
export function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * Checks whether this IP is currently locked out.
 * Returns { limited: true, retryAfterSecs } if locked, or { limited: false }.
 */
export async function checkRateLimit(ip, action = 'login') {
  const lockKey = `rl:lock:${action}:${ip}`;
  const locked  = await redis.get(lockKey);

  if (locked) {
    const ttl = await redis.ttl(lockKey);
    return { limited: true, retryAfterSecs: ttl };
  }

  return { limited: false };
}

/**
 * Records a failed attempt for this IP.
 * If MAX_ATTEMPTS is reached, sets a cooldown lock and resets the counter.
 * Returns { locked: true } if this attempt triggered a lockout.
 */
export async function recordFailedAttempt(ip, action = 'login') {
  const attemptsKey = `rl:attempts:${action}:${ip}`;
  const lockKey     = `rl:lock:${action}:${ip}`;

  // Increment attempt counter; set expiry on first write
  const attempts = await redis.incr(attemptsKey);
  if (attempts === 1) {
    await redis.expire(attemptsKey, WINDOW_SECS);
  }

  if (attempts >= MAX_ATTEMPTS) {
    // Lock this IP for the cooldown period
    await redis.set(lockKey, '1', { ex: COOLDOWN_SECS });
    await redis.del(attemptsKey);
    return { locked: true };
  }

  return { locked: false, attemptsRemaining: MAX_ATTEMPTS - attempts };
}

/**
 * Clears the attempt counter for this IP on successful auth.
 */
export async function clearAttempts(ip, action = 'login') {
  await redis.del(`rl:attempts:${action}:${ip}`);
}
