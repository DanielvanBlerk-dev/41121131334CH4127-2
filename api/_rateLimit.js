import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/* ─── PER-ACTION LIMITS ───────────────────────────────────────────────────── */
const LIMITS = {
  login: {
    maxAttempts:  5,
    cooldownSecs: 15 * 60,   // 15 minutes
    windowSecs:   60 * 60,   // 1 hour sliding window
  },
  payment: {
    maxAttempts:  3,
    cooldownSecs: 10 * 60,   // 10 minutes
    windowSecs:   10 * 60,   // 10 minute window
  },
};

/**
 * Returns the client IP from Vercel / common proxy headers.
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
 * Checks whether this IP is currently locked out for the given action.
 * Returns { limited: true, retryAfterSecs } or { limited: false }.
 */
export async function checkRateLimit(ip, action = 'login') {
  const lockKey = `rl:lock:${action}:${ip}`;
  const locked  = await redis.get(lockKey);
  if (locked) {
    const ttl = await redis.ttl(lockKey);
    return { limited: true, retryAfterSecs: Math.max(ttl, 0) };
  }
  return { limited: false };
}

/**
 * Records a failed attempt for this IP + action.
 * Triggers a lockout once maxAttempts is reached.
 * Returns { locked: true } if lockout was just triggered,
 *         { locked: false, attemptsRemaining: N } otherwise.
 */
export async function recordFailedAttempt(ip, action = 'login') {
  const cfg = LIMITS[action] || LIMITS.login;
  const attemptsKey = `rl:attempts:${action}:${ip}`;
  const lockKey     = `rl:lock:${action}:${ip}`;

  const attempts = await redis.incr(attemptsKey);
  if (attempts === 1) {
    await redis.expire(attemptsKey, cfg.windowSecs);
  }

  if (attempts >= cfg.maxAttempts) {
    await redis.set(lockKey, '1', { ex: cfg.cooldownSecs });
    await redis.del(attemptsKey);
    return { locked: true };
  }

  return { locked: false, attemptsRemaining: cfg.maxAttempts - attempts };
}

/**
 * Clears the attempt counter for this IP + action on success.
 */
export async function clearAttempts(ip, action = 'login') {
  await redis.del(`rl:attempts:${action}:${ip}`);
}
