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
 * POST   → create a new painting record
 * PUT    → update painting metadata + optionally remove specific images
 * DELETE → delete a painting and all its associated blobs from CDN
 * PATCH  → toggle sold status
 *
 * Oversized paintings:
 *   When oversized: true is passed, shipping dimension validation is skipped
 *   entirely. The painting is stored with oversized: true and shipping: null.
 *   Oversized paintings cannot be added to the cart — they show a
 *   "Contact Artist" button instead of "Add to selection".
 *
 * Image upload flow (POST):
 *   1. Client calls POST /api/paintings with metadata only → receives { id }
 *   2. Client calls POST /api/upload-image once per image, passing the id
 */
export default async function handler(req, res) {
  const ip = getIp(req);

  // ── Shared: body size limit ───────────────────────────────────────────
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

  switch (req.method) {

    // ── POST — create painting record ───────────────────────────────────
    case 'POST': {
      const {
        title, medium, price, sold = false,
        category  = 'seascape',
        oversized = false,
        weight, length, width, height,
      } = req.body || {};

      // ── Validate text fields ──────────────────────────────────────────
      if (!isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data.' });
      }
      if (!['seascape', 'figurative'].includes(category)) {
        return res.status(400).json({ success: false, error: 'Invalid category. Must be seascape or figurative.' });
      }

      const caps = capFields([['Title', title, 200], ['Medium', medium, 300]]);
      if (!caps.ok) return res.status(400).json({ success: false, error: caps.error });

      // ── Shipping dimensions — only required for non-oversized ─────────
      let shipping = null;
      if (!oversized) {
        for (const [key, val] of Object.entries({ weight, length, width, height })) {
          if (isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
            return res.status(400).json({ success: false, error: `Shipping ${key} is required and must be a positive number.` });
          }
        }
        shipping = {
          weight: parseFloat(weight),
          length: parseFloat(length),
          width:  parseFloat(width),
          height: parseFloat(height),
        };
      }

      // ── Save record ───────────────────────────────────────────────────
      const id       = Date.now();
      const artworks = (await redis.get('artworks')) || [];
      artworks.push({
        id,
        category,
        title:    sanitizeString(title),
        medium:   sanitizeString(medium),
        price,
        sold:     Boolean(sold),
        oversized: Boolean(oversized),
        images:   [],
        imgUrl:   null,
        imgData:  null,
        svg:      null,
        shipping,
      });
      await redis.set('artworks', artworks);
      await auditLog({ action: 'add_painting', ip, detail: { id, title: sanitizeString(title), price, oversized: Boolean(oversized) } });
      return res.status(200).json({ success: true, id });
    }

    // ── PUT — update painting metadata ──────────────────────────────────
    case 'PUT': {
      const {
        id, title, medium, price, sold,
        oversized,
        removeImageUrls = [],
        weight, length, width, height,
      } = req.body || {};

      // ── Validate text fields ──────────────────────────────────────────
      if (!id || !isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
        return res.status(400).json({ success: false, error: 'Invalid artwork data.' });
      }

      const caps = capFields([['Title', title, 200], ['Medium', medium, 300]]);
      if (!caps.ok) return res.status(400).json({ success: false, error: caps.error });

      if (!Array.isArray(removeImageUrls)) {
        return res.status(400).json({ success: false, error: 'removeImageUrls must be an array.' });
      }

      // ── Shipping dimensions — only required for non-oversized ─────────
      let shipping = null;
      if (!oversized) {
        for (const [key, val] of Object.entries({ weight, length, width, height })) {
          if (isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
            return res.status(400).json({ success: false, error: `Shipping ${key} is required and must be a positive number.` });
          }
        }
        shipping = {
          weight: parseFloat(weight),
          length: parseFloat(length),
          width:  parseFloat(width),
          height: parseFloat(height),
        };
      }

      // ── Fetch existing artwork ────────────────────────────────────────
      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const idx    = artworks.findIndex(a => Number(a.id) === numId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found.' });

      // ── Normalise images[] ────────────────────────────────────────────
      const existing    = artworks[idx];
      let currentImages = Array.isArray(existing.images) && existing.images.length > 0
        ? [...existing.images]
        : (existing.imgUrl ? [existing.imgUrl] : []);

      // ── Remove flagged images ─────────────────────────────────────────
      const safeToRemove = removeImageUrls.filter(url =>
        typeof url === 'string' &&
        url.includes('blob.vercel-storage.com') &&
        currentImages.includes(url)
      );
      await Promise.all(safeToRemove.map(url => deleteBlob(url)));
      currentImages = currentImages.filter(url => !safeToRemove.includes(url));

      // ── Save updated record ───────────────────────────────────────────
      artworks[idx] = {
        ...existing,
        title:     sanitizeString(title),
        medium:    sanitizeString(medium),
        price,
        sold:      Boolean(sold),
        oversized: Boolean(oversized),
        images:    currentImages,
        imgUrl:    null,
        imgData:   null,
        shipping,
      };

      await redis.set('artworks', artworks);
      await auditLog({ action: 'update_painting', ip, detail: { id: numId, title: sanitizeString(title), price, oversized: Boolean(oversized) } });
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
