import { kv } from '@vercel/kv';
import { verifyAdmin } from './_verifyAdmin.js';

/**
 * PATCH /api/toggle-sold
 * Admin only (JWT required).
 * Body: { id }
 * Flips the `sold` boolean on the specified artwork.
 * Returns: { success: true, sold: <new value> }
 */
export default async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!verifyAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id } = req.body || {};
  if (!id) {
    return res.status(400).json({ success: false, error: 'Missing id' });
  }

  try {
    let artworks = (await kv.get('artworks')) || [];
    const numId  = Number(id);
    const idx    = artworks.findIndex(a => Number(a.id) === numId);

    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Artwork not found' });
    }

    artworks[idx].sold = !artworks[idx].sold;
    const newSold = artworks[idx].sold;

    await kv.set('artworks', artworks);
    return res.status(200).json({ success: true, sold: newSold });
  } catch (err) {
    console.error('toggle-sold error:', err);
    return res.status(500).json({ success: false });
  }
}
