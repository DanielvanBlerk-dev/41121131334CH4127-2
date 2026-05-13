import { Redis } from '@upstash/redis';
import { verifyAdmin } from './_verifyAdmin.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  // ── Body size limit ───────────────────────────────────────────────────
  const size = checkBodySize(req, '1kb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  const admin = verifyAdmin(req);
  if (!admin) {
    await auditLog({ action: 'unauthorised', ip: getIp(req), detail: { endpoint: 'toggle-sold' } });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip: getIp(req), detail: { endpoint: 'toggle-sold', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

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

    await auditLog({
      action: 'toggle_sold',
      ip:     getIp(req),
      detail: { id: numId, title: artworks[idx].title, sold: newSold },
    });

    return res.status(200).json({ success: true, sold: newSold });
  } catch (err) {
    console.error('toggle-sold error:', err);
    return res.status(500).json({ success: false });
  }
}
