import { Redis } from '@upstash/redis';
import { verifyAdmin } from './_verifyAdmin.js';
import { sanitizeString } from './_sanitize.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function isValidString(str) {
  return typeof str === 'string' && str.trim().length > 0 && !/[<>]/.test(str);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { title, medium, price, sold = false, imgData = null } = req.body || {};

  if (!isValidString(title) || !isValidString(medium) || typeof price !== 'number' || price < 0) {
    return res.status(400).json({ success: false, error: 'Invalid artwork data' });
  }

  try {
    const artworks = (await redis.get('artworks')) || [];
    const id = Date.now();
    artworks.push({
      id,
      title:   sanitizeString(title),
      medium:  sanitizeString(medium),
      price,
      sold:    Boolean(sold),
      imgData: imgData || null,
      svg:     null,
    });
    await redis.set('artworks', artworks);
    return res.status(200).json({ success: true, id });
  } catch (err) {
    console.error('add-painting error:', err);
    return res.status(500).json({ success: false });
  }
}
