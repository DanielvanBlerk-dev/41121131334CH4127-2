import { Redis } from '@upstash/redis';
import { put, del } from '@vercel/blob';
import { verifyAdmin } from './_verifyAdmin.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';
import { validateImage } from './_imageValidator.js';
import { getImageSettings } from './_imageSettings.js';
import { compressImage } from './_imageCompress.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Decodes a base64 data URI to a Buffer + mime type, with no resizing or
 * re-encoding — the pre-compression-feature behaviour. Used as the upload
 * path when compression is switched off in the admin panel, and as the
 * fallback if compressImage() itself fails for some reason (a corrupt or
 * unusual file sharp can't parse, say) — an upload should never be blocked
 * by a compression bug, it should just fall back to storing the original.
 */
function bufferFromImgData(imgData) {
  const base64    = imgData.includes(',') ? imgData.split(',')[1] : imgData;
  const buffer    = Buffer.from(base64, 'base64');
  const mimeMatch = imgData.match(/^data:([^;]+);base64,/);
  const mimeType  = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  return { buffer, mimeType };
}

/**
 * Uploads an already-decoded buffer to Vercel Blob. Returns the public
 * CDN URL.
 */
async function putBufferToBlob(buffer, mimeType, filename) {
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
 * Compression (new):
 *   Before the image is stored, it's run through compressImage() (see
 *   _imageCompress.js) using the admin's current settings from
 *   _imageSettings.js — resized down to a max dimension and re-encoded at
 *   a set quality. This is what keeps Vercel Blob's "Data Transfer" usage
 *   under control: that quota bills the bytes actually served to visitors,
 *   so a smaller stored file directly means less usage every time someone
 *   views the gallery. The admin can adjust or switch this off entirely
 *   from the Image Settings panel — see paintings.js's GET/PATCH
 *   'image-settings' handling and the admin UI in script.js.
 *   If compression is switched off, or if it fails for any reason, the
 *   original file is stored untouched — a compression bug should never be
 *   able to block an upload.
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
 *   { success: true, imgUrl: string, originalBytes: number, finalBytes: number }
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

  // ── Compress (or pass through) ─────────────────────────────────────────
  const settings = await getImageSettings();
  let uploadBuffer, uploadMime, uploadExt, originalBytes, finalBytes, compressionNote = null;

  if (settings.enabled) {
    const compressed = await compressImage(imgData, settings);
    if (compressed.ok) {
      uploadBuffer  = compressed.buffer;
      uploadMime    = compressed.mimeType;
      uploadExt     = compressed.ext;
      originalBytes = compressed.originalBytes;
      finalBytes    = compressed.finalBytes;
      compressionNote = compressed.skipped || null;
    } else {
      // Never let a compression failure block the upload — store the
      // original instead, and note why in the audit log.
      console.error('Compression failed for artwork', numId, '— storing original:', compressed.error);
      const fallback = bufferFromImgData(imgData);
      uploadBuffer  = fallback.buffer;
      uploadMime    = fallback.mimeType;
      uploadExt     = imgCheck.format.split('/')[1] || 'jpg';
      originalBytes = fallback.buffer.length;
      finalBytes    = fallback.buffer.length;
      compressionNote = `compression failed, stored original: ${compressed.error}`;
    }
  } else {
    const fallback = bufferFromImgData(imgData);
    uploadBuffer  = fallback.buffer;
    uploadMime    = fallback.mimeType;
    uploadExt     = imgCheck.format.split('/')[1] || 'jpg';
    originalBytes = fallback.buffer.length;
    finalBytes    = fallback.buffer.length;
  }

  // ── Upload to Vercel Blob ─────────────────────────────────────────────
  // Filename: paintings/painting-{artworkId}-{timestamp}-{index}.{ext}
  // Using Date.now() in the filename ensures no collision even if the
  // client sends multiple images with the same index value. The extension
  // reflects whatever format the image was actually stored as, which may
  // differ from the upload's original format (e.g. a flattened PNG stored
  // as .jpg) — see _imageCompress.js.
  const filename = `paintings/painting-${numId}-${Date.now()}-${index}.${uploadExt}`;

  let imgUrl;
  try {
    imgUrl = await putBufferToBlob(uploadBuffer, uploadMime, filename);
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
  await auditLog({
    action: 'image_uploaded',
    ip,
    detail: {
      artworkId: numId, imgUrl, totalImages: freshArtworks[freshIdx].images.length,
      compressed: settings.enabled, originalBytes, finalBytes, compressionNote,
    },
  });

  return res.status(200).json({ success: true, imgUrl, originalBytes, finalBytes });
}
