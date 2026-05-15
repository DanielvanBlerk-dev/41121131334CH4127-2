import { Redis } from '@upstash/redis';
import { put, del } from '@vercel/blob';
import { verifyAdmin } from './_verifyAdmin.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';
import { validateImage } from './_imageValidator.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Uploads a validated base64 image to Vercel Blob.
 * Returns the public CDN URL.
 */
async function uploadToBlob(imgData, filename) {
  const base64    = imgData.includes(',') ? imgData.split(',')[1] : imgData;
  const buffer    = Buffer.from(base64, 'base64');
  const mimeMatch = imgData.match(/^data:([^;]+);base64,/);
  const mimeType  = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  const blob = await put(filename, buffer, {
    access:          'public',
    contentType:     mimeType,
    addRandomSuffix: false,
  });

  return blob.url;
}

/**
 * Deletes a blob URL from Vercel Blob storage.
 * Silent on failure.
 */
async function deleteBlob(url) {
  if (!url || !url.includes('blob.vercel-storage.com')) return;
  try { await del(url); } catch (e) { console.warn('blob delete failed:', e.message); }
}

/**
 * POST /api/upload-image
 *
 * Accepts a single image for an existing artwork and appends it to that
 * artwork's images[] array in Redis.
 *
 * Why a separate endpoint instead of bundling all images in one request:
 *   Vercel serverless functions have a hard ~4.5MB request body limit.
 *   Sending multiple base64 images in one payload hits this ceiling quickly.
 *   By uploading one image per request, each call is always a single image,
 *   the 4MB per-image limit applies cleanly, and there is no total-payload
 *   problem regardless of how many images a painting has.
 *
 * Request body:
 *   {
 *     artworkId: number,   — ID of the existing artwork to attach the image to
 *     imgData:   string,   — base64 data URI of the image
 *     index:     number,   — 0-based position of this image in the upload batch
 *                            (used to build a unique filename — does not affect
 *                            array order, which is determined by arrival order)
 *   }
 *
 * Response (success):
 *   { success: true, imgUrl: string }
 *
 * Response (error):
 *   { success: false, error: string }
 *
 * Security:
 *   - Admin JWT required
 *   - CSRF header required
 *   - Body capped at 4MB (one image max per request)
 *   - Image validated by _imageValidator.js (magic bytes, SVG block, size)
 *   - artworkId verified to exist in Redis before appending
 *   - 10-image cap enforced server-side
 *   - Blob URL only appended after successful Vercel Blob upload
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIp(req);

  // ── Body size: one image at a time, max 4MB ───────────────────────────
  const size = checkBodySize(req, '4mb');
  if (!size.ok) return res.status(413).json({ success: false, error: size.error });

  // ── Auth ──────────────────────────────────────────────────────────────
  const admin = await verifyAdmin(req);
  if (!admin) {
    await auditLog({ action: 'unauthorised', ip, detail: { endpoint: 'upload-image' } });
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // ── CSRF ──────────────────────────────────────────────────────────────
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'upload-image', reason: csrf.reason } });
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  const { artworkId, imgData, index = 0 } = req.body || {};

  // ── Validate inputs ───────────────────────────────────────────────────
  if (!artworkId || typeof artworkId !== 'number') {
    return res.status(400).json({ success: false, error: 'artworkId is required and must be a number.' });
  }
  if (!imgData || typeof imgData !== 'string') {
    return res.status(400).json({ success: false, error: 'imgData is required.' });
  }

  // ── Validate image (magic bytes, SVG block, 4MB decoded size) ────────
  const imgCheck = validateImage(imgData);
  if (!imgCheck.ok) {
    await auditLog({ action: 'image_rejected', ip, detail: { endpoint: 'upload-image', reason: imgCheck.error, artworkId } });
    return res.status(400).json({ success: false, error: imgCheck.error });
  }

  // ── Fetch artworks and locate the target ──────────────────────────────
  const artworks = (await redis.get('artworks')) || [];
  const numId    = Number(artworkId);
  const idx      = artworks.findIndex(a => Number(a.id) === numId);

  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'Artwork not found.' });
  }

  // ── Enforce 10-image cap ──────────────────────────────────────────────
  const currentImages = Array.isArray(artworks[idx].images) ? artworks[idx].images : [];
  if (currentImages.length >= 10) {
    return res.status(400).json({ success: false, error: 'Maximum of 10 images per painting reached.' });
  }

  // ── Upload to Vercel Blob ─────────────────────────────────────────────
  // Filename: paintings/painting-{artworkId}-{timestamp}-{index}.{ext}
  // Using Date.now() in the filename ensures no collision even if the
  // client sends multiple images with the same index value.
  const ext      = imgCheck.format.split('/')[1] || 'jpg';
  const filename = `paintings/painting-${numId}-${Date.now()}-${index}.${ext}`;

  let imgUrl;
  try {
    imgUrl = await uploadToBlob(imgData, filename);
  } catch (blobErr) {
    console.error('Blob upload failed:', blobErr);
    return res.status(500).json({ success: false, error: 'Image upload failed. Please try again.' });
  }

  // ── Append URL to artwork's images[] in Redis ─────────────────────────
  // Re-fetch artworks inside the write path to reduce (but not eliminate)
  // the race window if two uploads arrive nearly simultaneously.
  const freshArtworks = (await redis.get('artworks')) || [];
  const freshIdx      = freshArtworks.findIndex(a => Number(a.id) === numId);

  if (freshIdx === -1) {
    // Artwork was deleted between our two reads — clean up the orphaned blob
    await deleteBlob(imgUrl);
    return res.status(404).json({ success: false, error: 'Artwork was deleted before image could be saved.' });
  }

  const freshImages = Array.isArray(freshArtworks[freshIdx].images)
    ? freshArtworks[freshIdx].images
    : [];

  if (freshImages.length >= 10) {
    // Cap reached between our two reads (unlikely but possible)
    await deleteBlob(imgUrl);
    return res.status(400).json({ success: false, error: 'Maximum of 10 images per painting reached.' });
  }

  freshArtworks[freshIdx].images = [...freshImages, imgUrl];
  freshArtworks[freshIdx].imgUrl  = null;  // clear legacy single-image field
  freshArtworks[freshIdx].imgData = null;  // never store base64

  await redis.set('artworks', freshArtworks);
  await auditLog({ action: 'image_uploaded', ip, detail: { artworkId: numId, imgUrl, totalImages: freshArtworks[freshIdx].images.length } });

  return res.status(200).json({ success: true, imgUrl });
}
