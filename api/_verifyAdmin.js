import jwt from 'jsonwebtoken';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TOKEN_VERSION_KEY = 'admin:tokenVersion';

/**
 * Returns the current token version from Redis.
 * Defaults to 0 on first use.
 */
export async function getTokenVersion() {
  try {
    const v = await redis.get(TOKEN_VERSION_KEY);
    return v === null ? 0 : Number(v);
  } catch {
    return 0;
  }
}

/**
 * Increments the token version in Redis, immediately invalidating
 * all previously issued JWTs. Called on admin logout.
 */
export async function rotateTokenVersion() {
  try {
    return await redis.incr(TOKEN_VERSION_KEY);
  } catch (err) {
    console.error('rotateTokenVersion error:', err);
    throw err;
  }
}

/**
 * Verifies that the incoming request carries a valid admin JWT
 * AND that its embedded tokenVersion matches the current Redis value.
 *
 * Token must be sent as:  Authorization: Bearer <token>
 *
 * Returns the decoded payload on success, or null on any failure.
 * Callers must treat null as unauthorised.
 */
export async function verifyAdmin(req) {
  try {
    const header = req.headers.authorization;
    if (!header) return null;

    const token  = header.replace('Bearer ', '').trim();
    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) throw new Error('ADMIN_JWT_SECRET not set');

    // Step 1 — cryptographic verification (signature + expiry)
    const decoded = jwt.verify(token, secret);
    if (decoded.role !== 'admin') return null;

    // Step 2 — version check against Redis
    // If the admin has logged out since this token was issued,
    // the stored version will be higher and the token is rejected.
    const currentVersion = await getTokenVersion();
    if (decoded.tokenVersion !== currentVersion) return null;

    return decoded;
  } catch {
    // jwt.verify throws on expired or tampered tokens — treat as null
    return null;
  }
}
