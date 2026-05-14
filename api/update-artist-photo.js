import { Redis } from '@upstash/redis';
import { verifyAdmin } from './_verifyAdmin.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';
import { validateImage } from './_imageValidator.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * POST /api/update-artist-photo
 * Admin only.
 * Body: { imgData } — base64 data URI of the artist photo.
 * Stores the photo in Redis under 'artist-photo'.
 *
 * DELETE /api/update-artist-photo
 * Admin only. Removes the artist photo, reverting to placeholder.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIp(req);

  const size = checkBodySize(req, '5mb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'update-artist-photo', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) {
    await auditLog({ action: 'unauthorised', ip, detail: { endpoint: 'update-artist-photo' } });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── DELETE — remove photo ─────────────────────────────────────────────
  if (req.method === 'DELETE') {
    await redis.del('artist-photo');
    await auditLog({ action: 'artist_photo_removed', ip });
    return res.status(200).json({ success: true });
  }

  // ── POST — update photo ───────────────────────────────────────────────
  const { imgData } = req.body || {};

  if (!imgData) {
    return res.status(400).json({ success: false, error: 'No image provided.' });
  }

  const imgCheck = validateImage(imgData);
  if (!imgCheck.ok) {
    await auditLog({ action: 'image_rejected', ip, detail: { endpoint: 'update-artist-photo', reason: imgCheck.error } });
    return res.status(400).json({ success: false, error: imgCheck.error });
  }

  try {
    await redis.set('artist-photo', imgData);
    await auditLog({ action: 'artist_photo_updated', ip });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('update-artist-photo error:', err);
    return res.status(500).json({ success: false, error: 'Failed to save photo.' });
  }
}
