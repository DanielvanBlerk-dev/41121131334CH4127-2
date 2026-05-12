import { kv } from '@vercel/kv';
import { verifyAdmin } from './_verifyAdmin.js';
import { sanitizeString } from './_sanitize.js';

function isValidString(str) {
  return typeof str === 'string' && str.trim().length > 0 && !/[<>]/.test(str);
}

/**
 * PUT /api/update-painting
 * Admin only (JWT required).
 * Body: { id, title, medium, price, sold, imgData? }
 * Returns: { success: true }
 */
export default async function handler(req, res) {
  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, title, medium, price, sold, imgData } = req.body || {};

  if (
    !id                    ||
    !isValidString(title)  ||
    !isValidString(medium) ||
    typeof price !== 'number' ||
    price < 0
  ) {
    return res.status(400).json({ success: false, error: 'Invalid artwork data' });
  }

  try {
    let artworks = (await kv.get('artworks')) || [];

    const numId = Number(id);
    const idx   = artworks.findIndex(a => Number(a.id) === numId);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Artwork not found' });
    }

    artworks[idx] = {
      ...artworks[idx],
      title:   sanitizeString(title),
      medium:  sanitizeString(medium),
      price,
      sold:    Boolean(sold),
      imgData: imgData !== undefined ? imgData : artworks[idx].imgData,
    };

    await kv.set('artworks', artworks);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('update-painting error:', err);
    return res.status(500).json({ success: false });
  }
}
