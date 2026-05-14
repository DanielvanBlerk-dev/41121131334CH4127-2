import { Redis } from '@upstash/redis';
import { put, del } from '@vercel/blob';
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
 *
 * Image is validated server-side, uploaded to Vercel Blob CDN,
 * and the resulting URL stored in Redis under 'artist-photo-url'.
 * The old blob is deleted before the new one is uploaded.
 *
 * DELETE /api/update-artist-photo
 * Admin only. Deletes the blob and removes the URL from Redis.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIp(req);

  const size = checkBodySize(req, '4mb');
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
    // Delete from Blob CDN if URL exists
    const existingUrl = await redis.get('artist-photo-url');
    if (existingUrl && typeof existingUrl === 'string' && existingUrl.includes('blob.vercel-storage.com')) {
      try { await del(existingUrl); } catch (e) { console.warn('blob delete failed:', e.message); }
    }
    await redis.del('artist-photo-url');
    await redis.del('artist-photo'); // clear any legacy base64 key too
    await auditLog({ action: 'artist_photo_removed', ip });
    return res.status(200).json({ success: true });
  }

  // ── POST — update photo ───────────────────────────────────────────────
  const { imgData } = req.body || {};

  if (!imgData) {
    return res.status(400).json({ success: false, error: 'No image provided.' });
  }

  // Validate before touching Blob — only JPEG, PNG, WEBP, GIF allowed
  const imgCheck = validateImage(imgData);
  if (!imgCheck.ok) {
    await auditLog({ action: 'image_rejected', ip, detail: { endpoint: 'update-artist-photo', reason: imgCheck.error } });
    return res.status(400).json({ success: false, error: imgCheck.error });
  }

  try {
    // Delete existing blob before uploading new one
    const existingUrl = await redis.get('artist-photo-url');
    if (existingUrl && typeof existingUrl === 'string' && existingUrl.includes('blob.vercel-storage.com')) {
      try { await del(existingUrl); } catch (e) { console.warn('old blob delete failed:', e.message); }
    }

    // Upload to Vercel Blob
    const ext      = imgCheck.format.split('/')[1] || 'jpg';
    const base64   = imgData.includes(',') ? imgData.split(',')[1] : imgData;
    const buffer   = Buffer.from(base64, 'base64');
    const mimeMatch = imgData.match(/^data:([^;]+);base64,/);
    const mimeType  = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    const blob = await put(`artist/photo.${ext}`, buffer, {
      access:          'public',
      contentType:     mimeType,
      addRandomSuffix: true, // ensures cache busting when photo is updated
    });

    // Store only the CDN URL in Redis — no base64 ever stored
    await redis.set('artist-photo-url', blob.url);
    await redis.del('artist-photo'); // clear any legacy base64

    await auditLog({ action: 'artist_photo_updated', ip, detail: { url: blob.url } });
    return res.status(200).json({ success: true, imgUrl: blob.url });

  } catch (err) {
    console.error('update-artist-photo error:', err);
    return res.status(500).json({ success: false, error: 'Failed to save photo. Please try again.' });
  }
}
