import { Redis } from '@upstash/redis';
import { verifyAdmin } from './_verifyAdmin.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * GET /api/get-orders
 * Admin only (JWT required).
 * Returns the most recent orders stored in Redis, newest first.
 * Query param: ?limit=N (default 50, max 200)
 *
 * Each order contains:
 *   orderId, ts, grandTotal, artworkTotal, postageName, postagePrice,
 *   items [{ id, title, price }],
 *   customer { firstName, lastName, email, phone },
 *   shipping { address, city, state, postcode, country }
 *
 * Orders are retained for 90 days from the date of purchase.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) {
    await auditLog({ action: 'unauthorised', ip: getIp(req), detail: { endpoint: 'get-orders' } });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  try {
    // Fetch the order ID index (newest first — lpush prepends)
    const orderIds = await redis.lrange('order-index', 0, limit - 1);

    if (!orderIds || orderIds.length === 0) {
      return res.status(200).json({ orders: [] });
    }

    // Fetch each order record in parallel
    const rawOrders = await Promise.all(
      orderIds.map(id => redis.get(`order:${id}`))
    );

    // Parse and filter out any expired/missing records
    const orders = rawOrders
      .map(raw => {
        if (!raw) return null;
        try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch { return null; }
      })
      .filter(Boolean);

    return res.status(200).json({ orders, total: orders.length });

  } catch (err) {
    console.error('get-orders error:', err);
    return res.status(500).json({ error: 'Could not retrieve orders.' });
  }
}
