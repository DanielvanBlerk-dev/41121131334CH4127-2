import { Redis } from '@upstash/redis';
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
 * /api/paintings — consolidated paintings management endpoint
 *
 * POST   → add a new painting
 * PUT    → update an existing painting
 * DELETE → delete a painting
 * PATCH  → toggle sold status
 *
 * All methods require a valid admin JWT.
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

      if (imgData) {
        const imgCheck = validateImage(imgData);
        if (!imgCheck.ok) {
          await auditLog({ action: 'image_rejected', ip, detail: { endpoint: 'paintings:POST', reason: imgCheck.error } });
          return res.status(400).json({ success: false, error: imgCheck.error });
        }
      }

      try {
        const artworks = (await redis.get('artworks')) || [];
        const id = Date.now();
        artworks.push({
          id, category,
          title:   sanitizeString(title),
          medium:  sanitizeString(medium),
          price, sold: Boolean(sold),
          imgData: imgData || null, svg: null,
          shipping: {
            weight: parseFloat(weight), length: parseFloat(length),
            width:  parseFloat(width),  height: parseFloat(height),
          },
        });
        await redis.set('artworks', artworks);
        await auditLog({ action: 'add_painting', ip, detail: { id, title: sanitizeString(title), price } });
        return res.status(200).json({ success: true, id });
      } catch (err) {
        console.error('paintings POST error:', err);
        return res.status(500).json({ success: false });
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

      if (imgData !== undefined && imgData !== null) {
        const imgCheck = validateImage(imgData);
        if (!imgCheck.ok) {
          await auditLog({ action: 'image_rejected', ip, detail: { endpoint: 'paintings:PUT', reason: imgCheck.error } });
          return res.status(400).json({ success: false, error: imgCheck.error });
        }
      }

      try {
        let artworks = (await redis.get('artworks')) || [];
        const numId = Number(id);
        const idx   = artworks.findIndex(a => Number(a.id) === numId);
        if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found' });

        artworks[idx] = {
          ...artworks[idx],
          title:   sanitizeString(title),
          medium:  sanitizeString(medium),
          price, sold: Boolean(sold),
          imgData: imgData !== undefined ? imgData : artworks[idx].imgData,
          shipping: {
            weight: parseFloat(weight), length: parseFloat(length),
            width:  parseFloat(width),  height: parseFloat(height),
          },
        };
        await redis.set('artworks', artworks);
        await auditLog({ action: 'update_painting', ip, detail: { id: numId, title: sanitizeString(title), price } });
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('paintings PUT error:', err);
        return res.status(500).json({ success: false });
      }
    }

    // ── DELETE — remove painting ────────────────────────────────────────
    case 'DELETE': {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: 'Missing id' });

      try {
        let artworks = (await redis.get('artworks')) || [];
        const numId  = Number(id);
        const target = artworks.find(a => Number(a.id) === numId);
        if (!target) return res.status(404).json({ success: false, error: 'Artwork not found' });

        artworks = artworks.filter(a => Number(a.id) !== numId);
        await redis.set('artworks', artworks);
        await auditLog({ action: 'delete_painting', ip, detail: { id: numId, title: target.title } });
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error('paintings DELETE error:', err);
        return res.status(500).json({ success: false });
      }
    }

    // ── PATCH — toggle sold ─────────────────────────────────────────────
    case 'PATCH': {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: 'Missing id' });

      try {
        let artworks = (await redis.get('artworks')) || [];
        const numId  = Number(id);
        const idx    = artworks.findIndex(a => Number(a.id) === numId);
        if (idx === -1) return res.status(404).json({ success: false, error: 'Artwork not found' });

        artworks[idx].sold = !artworks[idx].sold;
        const newSold = artworks[idx].sold;
        await redis.set('artworks', artworks);
        await auditLog({ action: 'toggle_sold', ip, detail: { id: numId, title: artworks[idx].title, sold: newSold } });
        return res.status(200).json({ success: true, sold: newSold });
      } catch (err) {
        console.error('paintings PATCH error:', err);
        return res.status(500).json({ success: false });
      }
    }

    default:
      return res.status(405).json({ error: 'Method not allowed' });
  }
}
