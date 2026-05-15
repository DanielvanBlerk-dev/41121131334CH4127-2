import { Redis } from '@upstash/redis';
import { del } from '@vercel/blob';
import { verifyAdmin } from './_verifyAdmin.js';
import { sanitizeString, capFields } from './_sanitize.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function isValidString(str) {
  return typeof str === 'string' && str.trim().length > 0 && !/[<>]/.test(str);
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
 * /api/paintings — consolidated paintings management endpoint
 *
 * POST   → create a new painting record (no images — client uploads images
 *           separately via POST /api/upload-image after receiving the new ID)
 * PUT    → update painting metadata + optionally remove specific images
 *           (adding new images is also done via /api/upload-image)
 * DELETE → delete a painting and all its associated blobs from CDN
 * PATCH  → toggle sold status
 *
 * Image upload flow (POST):
 *   1. Client calls POST /api/paintings with metadata only → receives { id }
 *   2. Client calls POST /api/upload-image once per image, passing the id
 *   3. Each upload-image call validates, uploads to Blob, appends URL to
 *      artwork's images[] in Redis independently
 *
 *   This design means each request body is always one image (≤4MB decoded),
 *   so Vercel's hard ~4.5MB request body limit is never a constraint regardless
 *   of how many images a painting has.
 *
 * Image removal flow (PUT):
 *   Client sends removeImageUrls: string[] — existing CDN URLs to delete.
 *   Server verifies each URL belongs to this artwork before deleting.
 *   Adding new images after a PUT is done via /api/upload-image as above.
 */
export default async function handler(req, res) {
  const ip = getIp(req);

  // ── Shared: body size limit ───────────────────────────────────────────
  // POST and PUT carry only text metadata now (no images) so 10kb is ample.
  // DELETE and PATCH carry just an id, so 1kb.
  const maxSize = req.method === 'POST' || req.method === 'PUT' ? '10kb' : '1kb';
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

    // ── POST — create painting record ───────────────────────────────────
    // Images are NOT accepted here. The client uploads images separately
    // via /api/upload-image after receiving the artwork ID from this response.
    case 'POST': {
      const {
        title, medium, price, sold = false,
        category = 'seascape',
        weight, length, width, height,
      } = req.body || {};

      // ── Validate text fields ────────────────────────────────────────
      if (!isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data.' });
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

      // ── Save record with empty images[] ────────────────────────────
      const id       = Date.now();
      const artworks = (await redis.get('artworks')) || [];
      artworks.push({
        id,
        category,
        title:   sanitizeString(title),
        medium:  sanitizeString(medium),
        price,
        sold:    Boolean(sold),
        images:  [],     // populated by subsequent /api/upload-image calls
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
      await auditLog({ action: 'add_painting', ip, detail: { id, title: sanitizeString(title), price } });

      // Return the new ID so the client can attach images to it
      return res.status(200).json({ success: true, id });
    }

    // ── PUT — update painting metadata ──────────────────────────────────
    // To REMOVE existing images: pass removeImageUrls (CDN URLs to delete).
    // To ADD new images: call /api/upload-image after this request completes.
    case 'PUT': {
      const {
        id, title, medium, price, sold,
        removeImageUrls = [],   // existing CDN URLs to delete from this painting
        weight, length, width, height,
      } = req.body || {};

      // ── Validate text fields ────────────────────────────────────────
      if (!id || !isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data.' });
      }
      for (const [key, val] of Object.entries({ weight, length, width, height })) {
        if (isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
          return res.status(400).json({ success: false, error: `Shipping ${key} is required and must be a positive number.` });
        }
      }
      const caps = capFields([['Title', title, 200], ['Medium', medium, 300]]);
      if (!caps.ok) return res.status(400).json({ success: false, error: caps.error });

      if (!Array.isArray(removeImageUrls)) {
        return res.status(400).json({ success: false, error: 'removeImageUrls must be an array.' });
      }

      // ── Fetch existing artwork ──────────────────────────────────────
      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const idx    = artworks.findIndex(a => Number(a.id) === numId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found.' });

      // ── Normalise images[] (handle legacy imgUrl shape) ────────────
      const existing     = artworks[idx];
      let currentImages  = Array.isArray(existing.images) && existing.images.length > 0
        ? [...existing.images]
        : (existing.imgUrl ? [existing.imgUrl] : []);

      // ── Remove flagged images ───────────────────────────────────────
      // Only delete blobs that actually belong to this artwork (prevents
      // a malicious removeImageUrls from deleting another painting's blobs).
      const safeToRemove = removeImageUrls.filter(url =>
        typeof url === 'string' &&
        url.includes('blob.vercel-storage.com') &&
        currentImages.includes(url)
      );
      await Promise.all(safeToRemove.map(url => deleteBlob(url)));
      currentImages = currentImages.filter(url => !safeToRemove.includes(url));

      // ── Save updated record ─────────────────────────────────────────
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

    // ── DELETE — remove painting and all its blobs ──────────────────────
    case 'DELETE': {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: 'Missing id.' });

      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const target = artworks.find(a => Number(a.id) === numId);
      if (!target) return res.status(404).json({ success: false, error: 'Artwork not found.' });

      // Delete all associated blobs — handle both new images[] and legacy imgUrl
      const blobsToDelete = Array.isArray(target.images) && target.images.length > 0
        ? target.images
        : (target.imgUrl ? [target.imgUrl] : []);
      await deleteAllBlobs(blobsToDelete);

      artworks = artworks.filter(a => Number(a.id) !== numId);
      await redis.set('artworks', artworks);
      await auditLog({ action: 'delete_painting', ip, detail: { id: numId, title: target.title } });
      return res.status(200).json({ success: true });
    }

    // ── PATCH — toggle sold status ──────────────────────────────────────
    case 'PATCH': {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: 'Missing id.' });

      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const idx    = artworks.findIndex(a => Number(a.id) === numId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found.' });

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
