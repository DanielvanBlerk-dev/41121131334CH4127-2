import { kv } from '@vercel/kv';

/**
 * GET /api/get-artworks
 * Public — no auth required.
 * Returns the full artwork list from Vercel KV.
 * Falls back to an empty array if the key doesn't exist yet.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let artworks = await kv.get('artworks');
    if (!artworks) {
      artworks = [];
      await kv.set('artworks', artworks);
    }
    return res.status(200).json({ artworks });
  } catch (err) {
    console.error('get-artworks error:', err);
    return res.status(500).json({ artworks: [] });
  }
}
