import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getIp, checkRateLimit, recordFailedAttempt, clearAttempts } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';

/**
 * POST /api/login
 * Body: { password: string }
 *
 * Rate-limited: 5 failed attempts → 15-minute lockout per IP.
 * Logs every attempt (success and failure) to the audit log.
 *
 * Required Vercel env vars:
 *   ADMIN_PASSWORD_HASH  — bcrypt hash of your admin password
 *   ADMIN_JWT_SECRET     — long random secret string
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIp(req);

  // ── Body size limit ───────────────────────────────────────────────────
  const size = checkBodySize(req, '1kb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  // ── CSRF check ────────────────────────────────────────────────────────
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'login', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ── Rate limit check ──────────────────────────────────────────────────
  const { limited, retryAfterSecs } = await checkRateLimit(ip, 'login');
  if (limited) {
    const mins = Math.ceil(retryAfterSecs / 60);
    await auditLog({ action: 'login_blocked', ip });
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
    });
  }

  // ── Input validation ──────────────────────────────────────────────────
  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Missing password' });
  }

  const hash      = process.env.ADMIN_PASSWORD_HASH;
  const jwtSecret = process.env.ADMIN_JWT_SECRET;

  if (!hash || !jwtSecret) {
    console.error('ADMIN_PASSWORD_HASH or ADMIN_JWT_SECRET not configured');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // ── Password check ────────────────────────────────────────────────────
  const valid = await bcrypt.compare(password, hash);

  if (!valid) {
    const result = await recordFailedAttempt(ip, 'login');
    await auditLog({ action: 'login_failed', ip, detail: { locked: result.locked } });

    if (result.locked) {
      return res.status(429).json({
        error: 'Too many failed attempts. Your IP has been locked out for 15 minutes.',
      });
    }

    return res.status(401).json({
      error: `Invalid password. ${result.attemptsRemaining} attempt${result.attemptsRemaining !== 1 ? 's' : ''} remaining before lockout.`,
    });
  }

  // ── Success ───────────────────────────────────────────────────────────
  await clearAttempts(ip, 'login');
  await auditLog({ action: 'login_success', ip });

  const token = jwt.sign(
    { role: 'admin' },
    jwtSecret,
    { expiresIn: '12h' }
  );

  return res.status(200).json({ token });
}
