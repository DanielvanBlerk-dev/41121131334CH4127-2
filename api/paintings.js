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
 * Security: image is validated by _imageValidator.js before this
 * is called — only JPEG, PNG, WEBP, GIF reach here.
 *
 * @param {string} imgData   base64 data URI (e.g. "data:image/jpeg;base64,...")
 * @param {string} filename  e.g. "painting-1234567890.jpg"
 * @returns {Promise<string>} public CDN URL
 */
async function uploadToBlob(imgData, filename) {
  // Strip data URI prefix to get raw base64
  const base64 = imgData.includes(',') ? imgData.split(',')[1] : imgData;
  const buffer = Buffer.from(base64, 'base64');

  // Extract MIME type from data URI prefix
  const mimeMatch = imgData.match(/^data:([^;]+);base64,/);
  const mimeType  = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  const blob = await put(filename, buffer, {
    access:      'public',   // served directly from CDN — no server round-trip
    contentType: mimeType,
    addRandomSuffix: false,  // filename already contains unique ID
  });

  return blob.url;
}

/**
 * Deletes a blob from Vercel Blob storage by URL.
 * Silent on failure — stale blobs are harmless.
 */
async function deleteBlob(url) {
  if (!url || !url.includes('blob.vercel-storage.com')) return;
  try { await del(url); } catch (e) { console.warn('blob delete failed:', e.message); }
}

/**
 * /api/paintings — consolidated paintings management endpoint
 *
 * POST   → add a new painting    (images → Vercel Blob CDN)
 * PUT    → update a painting     (images → Vercel Blob CDN)
 * DELETE → delete a painting     (also deletes blob from CDN)
 * PATCH  → toggle sold status
 *
 * All methods require a valid admin JWT.
 * Image validation runs server-side before any Blob upload.
 * The BLOB_READ_WRITE_TOKEN env var is used automatically by @vercel/blob.
 */
export default async function handler(req, res) {
  const ip = getIp(req);

  // ── Shared: body size limit ───────────────────────────────────────────
  const maxSize = req.method === 'POST' || req.method === 'PUT' ? '4mb' : '1kb';
  const size = checkBodySize(req, maxSize);
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
      const { title, medium, price, sold = false, imgData = null,
              category = 'seascape', weight, length, width, height } = req.body || {};

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

      // ── Image: validate then upload to Blob ───────────────────────────
      let imgUrl = null;
      if (imgData) {
        const imgCheck = validateImage(imgData);
        if (!imgCheck.ok) {
          await auditLog({ action: 'image_rejected', ip, detail: { endpoint: 'paintings:POST', reason: imgCheck.error } });
          return res.status(400).json({ success: false, error: imgCheck.error });
        }

        const ext      = imgCheck.format.split('/')[1] || 'jpg';
        const id       = Date.now();
        const filename = `paintings/painting-${id}.${ext}`;

        try {
          imgUrl = await uploadToBlob(imgData, filename);
        } catch (blobErr) {
          console.error('Blob upload failed:', blobErr);
          return res.status(500).json({ success: false, error: 'Image upload failed. Please try again.' });
        }

        const artworks = (await redis.get('artworks')) || [];
        artworks.push({
          id, category,
          title:   sanitizeString(title),
          medium:  sanitizeString(medium),
          price, sold: Boolean(sold),
          imgUrl,          // CDN URL — replaces base64 imgData
          imgData: null,   // never store base64 in Redis anymore
          svg:     null,
          shipping: {
            weight: parseFloat(weight), length: parseFloat(length),
            width:  parseFloat(width),  height: parseFloat(height),
          },
        });
        await redis.set('artworks', artworks);
        await auditLog({ action: 'add_painting', ip, detail: { id, title: sanitizeString(title), price, imgUrl } });
        return res.status(200).json({ success: true, id });

      } else {
        // No image provided — store without image
        const artworks = (await redis.get('artworks')) || [];
        const id = Date.now();
        artworks.push({
          id, category,
          title:   sanitizeString(title),
          medium:  sanitizeString(medium),
          price, sold: Boolean(sold),
          imgUrl:  null,
          imgData: null,
          svg:     null,
          shipping: {
            weight: parseFloat(weight), length: parseFloat(length),
            width:  parseFloat(width),  height: parseFloat(height),
          },
        });
        await redis.set('artworks', artworks);
        await auditLog({ action: 'add_painting', ip, detail: { id, title: sanitizeString(title), price } });
        return res.status(200).json({ success: true, id });
      }
    }

    // ── PUT — update painting ───────────────────────────────────────────
    case 'PUT': {
      const { id, title, medium, price, sold, imgData,
              weight, length, width, height } = req.body || {};

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

      let artworks = (await redis.get('artworks')) || [];
      const numId  = Number(id);
      const idx    = artworks.findIndex(a => Number(a.id) === numId);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found' });

      // ── Image: validate + upload new image if provided ────────────────
      let newImgUrl = artworks[idx].imgUrl || null; // keep existing by default

      if (imgData !== undefined && imgData !== null) {
        const imgCheck = validateImage(imgData);
        if (!imgCheck.ok) {
          await auditLog({ action: 'image_rejected', ip, detail: { endpoint: 'paintings:PUT', reason: imgCheck.error } });
          return res.status(400).json({ success: false, error: imgCheck.error });
        }

        const ext      = imgCheck.format.split('/')[1] || 'jpg';
        const filename = `paintings/painting-${numId}.${ext}`;

        try {
          // Delete old blob first if it exists
          await deleteBlob(artworks[idx].imgUrl);
          newImgUrl = await uploadToBlob(imgData, filename);
        } catch (blobErr) {
          console.error('Blob upload failed:', blobErr);
          return res.status(500).json({ success: false, error: 'Image upload failed. Please try again.' });
        }
      }

      artworks[idx] = {
        ...artworks[idx],
        title:   sanitizeString(title),
        medium:  sanitizeString(medium),
        price, sold: Boolean(sold),
        imgUrl:  newImgUrl,
        imgData: null,  // clear any legacy base64
        shipping: {
          weight: parseFloat(weight), length: parseFloat(length),
          width:  parseFloat(width),  height: parseFloat(height),
        },
      };

      await redis.set('artworks', artworks);
      await auditLog({ action: 'update_painting', ip, detail: { id: numId, title: sanitizeString(title), price } });
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

      // Delete from Blob CDN before removing from Redis
      await deleteBlob(target.imgUrl);

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
