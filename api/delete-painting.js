import { kv } from '@vercel/kv';
import { verifyAdmin } from './_verifyAdmin.js';

/**
 * DELETE /api/delete-painting
 * Admin only (JWT required).
 * Body: { id }
 * Returns: { success: true }
 */
export default async function handler(req, res) {
  if (req.method !== 'DELETE') {
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
    const before = artworks.length;

    artworks = artworks.filter(a => Number(a.id) !== numId);

    if (artworks.length === before) {
      return res.status(404).json({ success: false, error: 'Artwork not found' });
    }

    await kv.set('artworks', artworks);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('delete-painting error:', err);
    return res.status(500).json({ success: false });
  }
}
