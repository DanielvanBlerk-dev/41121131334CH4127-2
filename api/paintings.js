import { Redis } from '@upstash/redis';
import { put, del } from '@vercel/blob';
import { verifyAdmin } from './_verifyAdmin.js';
import { sanitizeString, capFields } from './_sanitize.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';
import { validateImage } from './_imageValidator.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function isValidString(str) {
  return typeof str === 'string' && str.trim().length > 0 && !/[<>]/.test(str);
}

/**
 * Uploads a validated base64 image to Vercel Blob.
 * Returns the public CDN URL.
 * Throws on failure.
 *
 * @param {string} imgData   base64 data URI (e.g. "data:image/jpeg;base64,...")
 * @param {string} filename  e.g. "paintings/painting-1234567890-0.jpg"
 * @returns {Promise<string>} public CDN URL
 */
async function uploadToBlob(imgData, filename) {
  const base64  = imgData.includes(',') ? imgData.split(',')[1] : imgData;
  const buffer  = Buffer.from(base64, 'base64');
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
 * Deletes a single blob URL from Vercel Blob storage.
 * Silent on failure — stale blobs are harmless.
 */
async function deleteBlob(url) {
  if (!url || !url.includes('blob.vercel-storage.com')) return;
  try { await del(url); } catch (e) { console.warn('blob delete failed:', e.message); }
}

/**
 * Deletes all blob URLs in an images array.
 */
async function deleteAllBlobs(images = []) {
  await Promise.all(images.map(url => deleteBlob(url)));
}

/**
 * Validates and uploads an array of base64 image strings to Vercel Blob.
 * Returns an array of CDN URLs in the same order.
 * Throws with { error, index } on the first validation failure.
 * Throws on Blob upload failure.
 *
 * @param {string[]} imgDataArray  Array of base64 data URIs
 * @param {number}   artworkId     Used to build filenames
 * @param {number}   [startIndex]  Index offset for filenames when appending
 * @returns {Promise<string[]>}    Array of CDN URLs
 */
async function validateAndUploadImages(imgDataArray, artworkId, startIndex = 0) {
  const urls = [];

  for (let i = 0; i < imgDataArray.length; i++) {
    const imgData  = imgDataArray[i];
    const imgCheck = validateImage(imgData);

    if (!imgCheck.ok) {
      throw { validationError: true, error: imgCheck.error, index: i };
    }

    const ext      = imgCheck.format.split('/')[1] || 'jpg';
    const filename = `paintings/painting-${artworkId}-${startIndex + i}.${ext}`;

    const url = await uploadToBlob(imgData, filename);
    urls.push(url);
  }

  return urls;
}

/**
 * /api/paintings — consolidated paintings management endpoint
 *
 * POST   → add a new painting    (images[] → Vercel Blob CDN)
 * PUT    → update a painting     (add new images, remove specified old ones)
 * DELETE → delete a painting     (also deletes all blobs from CDN)
 * PATCH  → toggle sold status
 *
 * Multi-image data model:
 *   artwork.images = string[]   — ordered array of CDN URLs
 *
 * Legacy single-image records (artwork.imgUrl) are handled transparently
 * by get-artworks.js which normalises them to images: [imgUrl].
 * paintings.js always writes the new images[] shape.
 */
export default async function handler(req, res) {
  const ip = getIp(req);

  // ── Shared: body size limit ───────────────────────────────────────────
  const maxSize = req.method === 'POST' || req.method === 'PUT' ? '4mb' : '1kb';
  const size    = checkBodySize(req, maxSize);
  if (!size.ok) return res.status(413).json({ error: size.error });

  // ── Shared: auth ──────────────────────────────────────────────────────
  const admin = await verifyAdmin(req);
  if (!admin) {
    await auditLog({ action: 'unauthorised', ip, detail: { endpoint: 'paintings', method: req.method } });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Shared: CSRF ──────────────────────────────────────────────────────
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'paintings', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ── Route by method ───────────────────────────────────────────────────
  switch (req.method) {

    // ── POST — add painting ─────────────────────────────────────────────
    case 'POST': {
      const {
        title, medium, price, sold = false,
        imgDataArray = [],          // NEW: array of base64 data URIs
        category = 'seascape',
        weight, length, width, height,
      } = req.body || {};

      // ── Validate text fields ──────────────────────────────────────────
      if (!isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data' });
      }
      if (!['seascape', 'figurative'].includes(category)) {
        return res.status(400).json({ success: false, error: 'Invalid category. Must be seascape or figurative.' });
      }
      for (const [key, val] of Object.entries({ weight, length, width, height })) {
        if (isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
          return res.status(400).json({ success: false, error: `Shipping ${key} is required and must be a positive number.` });
        }
      }
      const caps = capFields([['Title', title, 200], ['Medium', medium, 300]]);
      if (!caps.ok) return res.status(400).json({ success: false, error: caps.error });

      // ── Validate imgDataArray ─────────────────────────────────────────
      if (!Array.isArray(imgDataArray)) {
        return res.status(400).json({ success: false, error: 'imgDataArray must be an array.' });
      }
      if (imgDataArray.length > 10) {
        return res.status(400).json({ success: false, error: 'Maximum 10 images per painting.' });
      }

      const id = Date.now();

      // ── Upload images to Blob ─────────────────────────────────────────
      let images = [];
      if (imgDataArray.length > 0) {
        try {
          images = await validateAndUploadImages(imgDataArray, id, 0);
        } catch (err) {
          if (err.validationError) {
            await auditLog({ action: 'image_rejected', ip, detail: { endpoint: 'paintings:POST', reason: err.error, index: err.index } });
            return res.status(400).json({ success: false, error: `Image ${err.index + 1}: ${err.error}` });
          }
          console.error('Blob upload failed:', err);
          return res.status(500).json({ success: false, error: 'Image upload failed. Please try again.' });
        }
      }

      // ── Save to Redis ─────────────────────────────────────────────────
      const artworks = (await redis.get('artworks')) || [];
      artworks.push({
        id,
        category,
        title:   sanitizeString(title),
        medium:  sanitizeString(medium),
        price,
        sold:    Boolean(sold),
        images,          // array of CDN URLs (may be empty if no images uploaded)
        imgUrl:  null,   // legacy field — always null on new records
        imgData: null,   // never store base64 in Redis
        svg:     null,
        shipping: {
          weight: parseFloat(weight),
          length: parseFloat(length),
          width:  parseFloat(width),
          height: parseFloat(height),
        },
      });
      await redis.set('artworks', artworks);
      await auditLog({ action: 'add_painting', ip, detail: { id, title: sanitizeString(title), price, imageCount: images.length } });
      return res.status(200).json({ success: true, id });
    }

    // ── PUT — update painting ───────────────────────────────────────────
    case 'PUT': {
      const {
        id, title, medium, price, sold,
        imgDataArray   = [],    // NEW: additional images to upload and append
        removeImageUrls = [],   // NEW: existing CDN URLs to delete
        weight, length, width, height,
      } = req.body || {};

      // ── Validate text fields ──────────────────────────────────────────
      if (!id || !isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data' });
      }
      for (const [key, val] of Object.entries({ weight, length, width, height })) {
        if (isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
          return res.status(400).json({ success: false, error: `Shipping ${key} is required and must be a positive number.` });
        }
      }
      const caps = capFields([['Title', title, 200], ['Medium', medium, 300]]);
      if (!caps.ok) return res.status(400).json({ success: false, error: caps.error });

      // ── Validate array inputs ─────────────────────────────────────────
      if (!Array.isArray(imgDataArray)) {
        return res.status(400).json({ success: false, error: 'imgDataArray must be an array.' });
      }
      if (!Array.isArray(removeImageUrls)) {
        return res.status(400).json({ success: false, error: 'removeImageUrls must be an array.' });
      }

      // ── Fetch existing artwork ────────────────────────────────────────
      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const idx    = artworks.findIndex(a => Number(a.id) === numId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found' });

      // ── Build current images list (normalise legacy imgUrl) ───────────
      const existing = artworks[idx];
      let currentImages = Array.isArray(existing.images) && existing.images.length > 0
        ? [...existing.images]
        : (existing.imgUrl ? [existing.imgUrl] : []);

      // ── Remove images flagged for deletion ────────────────────────────
      // Only delete blobs that actually belong to this artwork (security)
      const safeToRemove = removeImageUrls.filter(url =>
        typeof url === 'string' &&
        url.includes('blob.vercel-storage.com') &&
        currentImages.includes(url)
      );
      await Promise.all(safeToRemove.map(url => deleteBlob(url)));
      currentImages = currentImages.filter(url => !safeToRemove.includes(url));

      // ── Upload and append new images ──────────────────────────────────
      const totalAfterAdd = currentImages.length + imgDataArray.length;
      if (totalAfterAdd > 10) {
        return res.status(400).json({ success: false, error: `Too many images. Maximum is 10 (currently ${currentImages.length}, adding ${imgDataArray.length}).` });
      }

      if (imgDataArray.length > 0) {
        try {
          // Use timestamp suffix to avoid filename collision with existing blobs
          const startIndex = Date.now();
          const newUrls    = await validateAndUploadImages(imgDataArray, numId, startIndex);
          currentImages    = [...currentImages, ...newUrls];
        } catch (err) {
          if (err.validationError) {
            await auditLog({ action: 'image_rejected', ip, detail: { endpoint: 'paintings:PUT', reason: err.error, index: err.index } });
            return res.status(400).json({ success: false, error: `Image ${err.index + 1}: ${err.error}` });
          }
          console.error('Blob upload failed:', err);
          return res.status(500).json({ success: false, error: 'Image upload failed. Please try again.' });
        }
      }

      // ── Save updated record ───────────────────────────────────────────
      artworks[idx] = {
        ...existing,
        title:   sanitizeString(title),
        medium:  sanitizeString(medium),
        price,
        sold:    Boolean(sold),
        images:  currentImages,
        imgUrl:  null,   // clear any legacy single-image field
        imgData: null,
        shipping: {
          weight: parseFloat(weight),
          length: parseFloat(length),
          width:  parseFloat(width),
          height: parseFloat(height),
        },
      };

      await redis.set('artworks', artworks);
      await auditLog({ action: 'update_painting', ip, detail: { id: numId, title: sanitizeString(title), price, imageCount: currentImages.length } });
      return res.status(200).json({ success: true });
    }

    // ── DELETE — remove painting ────────────────────────────────────────
    case 'DELETE': {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: 'Missing id' });

      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const target = artworks.find(a => Number(a.id) === numId);
      if (!target) return res.status(404).json({ success: false, error: 'Artwork not found' });

      // Delete all associated blobs before removing from Redis.
      // Handle both new images[] shape and legacy imgUrl.
      const blobsToDelete = Array.isArray(target.images) && target.images.length > 0
        ? target.images
        : (target.imgUrl ? [target.imgUrl] : []);
      await deleteAllBlobs(blobsToDelete);

      artworks = artworks.filter(a => Number(a.id) !== numId);
      await redis.set('artworks', artworks);
      await auditLog({ action: 'delete_painting', ip, detail: { id: numId, title: target.title } });
      return res.status(200).json({ success: true });
    }

    // ── PATCH — toggle sold ─────────────────────────────────────────────
    case 'PATCH': {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: 'Missing id' });

      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const idx    = artworks.findIndex(a => Number(a.id) === numId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found' });

      artworks[idx].sold = !artworks[idx].sold;
      const newSold = artworks[idx].sold;
      await redis.set('artworks', artworks);
      await auditLog({ action: 'toggle_sold', ip, detail: { id: numId, title: artworks[idx].title, sold: newSold } });
      return res.status(200).json({ success: true, sold: newSold });
    }

    default:
      return res.status(405).json({ error: 'Method not allowed' });
  }
}
