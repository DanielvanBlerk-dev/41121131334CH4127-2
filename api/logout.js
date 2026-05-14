import { verifyAdmin, rotateTokenVersion } from './_verifyAdmin.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';

/**
 * POST /api/logout
 * Admin only (JWT required).
 *
 * Increments the token version in Redis, immediately invalidating
 * all currently issued admin JWTs — including the one used to make
 * this request. The client should discard its token after calling this.
 *
 * Even if a token was stolen, it becomes useless the moment
 * the legitimate admin logs out.
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
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'logout', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ── Auth check ────────────────────────────────────────────────────────
  const admin = await verifyAdmin(req);
  if (!admin) {
    // Still rotate if possible — if someone is calling logout with a bad
    // token they may be attempting token fixation. Rotating is cheap.
    try { await rotateTokenVersion(); } catch {}
    await auditLog({ action: 'logout_unauth', ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Rotate token version ──────────────────────────────────────────────
  // This increments the version stored in Redis. Any JWT carrying the
  // old version number will now fail _verifyAdmin's version check,
  // regardless of whether it has expired yet.
  try {
    const newVersion = await rotateTokenVersion();
    await auditLog({ action: 'logout_success', ip, detail: { newTokenVersion: newVersion } });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('logout rotation error:', err);
    await auditLog({ action: 'logout_error', ip, detail: { error: err.message } });
    return res.status(500).json({ error: 'Logout failed. Please try again.' });
  }
}
