import { Redis } from '@upstash/redis';
import { verifyAdmin } from './_verifyAdmin.js';
import { getIp } from './_rateLimit.js';
import { checkCsrf } from './_csrf.js';
import { checkBodySize } from './_bodyLimit.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * /api/track — lightweight funnel event counters.
 *
 *   POST (public) { event } → increments one running total in the Redis hash
 *                             'analytics:events'. Only the five browser-side
 *                             events below are accepted.
 *   GET  (admin)            → returns every total, for the admin Analytics panel.
 *
 * 'purchase_confirmed' is deliberately NOT accepted from the browser — it is
 * incremented server-side inside create-payment.js, only after Square has
 * actually taken the payment, so it can't be inflated by a client.
 *
 * Totals are plain counts of events (not unique visitors) and carry no
 * personal data: no IP, cookie, or identifier is stored — the IP is used only
 * for a short-lived per-minute rate limit counter.
 */
const HASH_KEY = 'analytics:events';

// Order = funnel order, shown top-to-bottom in the admin panel.
const FUNNEL_EVENTS = [
  'listing_click',       // 1 — a listing opened
  'size_select',         // 2 — a print size chosen on a multi-size listing
  'add_to_cart',         // 3 — "Add to selection" clicked
  'shipping_calc',       // 4 — shipping calculated (postcode entered)
  'checkout_start',      // 5 — checkout stage entered
  'purchase_confirmed',  // 6 — payment succeeded (server-side only)
];
const BROWSER_EVENTS = new Set(FUNNEL_EVENTS.filter(e => e !== 'purchase_confirmed'));

const RATE_LIMIT_PER_MIN = 120;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const admin = await verifyAdmin(req);
    if (!admin) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const raw = (await redis.hgetall(HASH_KEY)) || {};
      const totals = {};
      FUNNEL_EVENTS.forEach(e => { totals[e] = Number(raw[e]) || 0; });
      return res.status(200).json({ success: true, totals });
    } catch (err) {
      console.error('track GET failed:', err);
      return res.status(500).json({ error: 'Could not load analytics.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const size = checkBodySize(req, '1kb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  const csrf = checkCsrf(req);
  if (!csrf.ok) return res.status(403).json({ error: 'Forbidden' });

  const { event } = req.body || {};
  if (typeof event !== 'string' || !BROWSER_EVENTS.has(event)) {
    return res.status(400).json({ error: 'Unknown event.' });
  }

  try {
    const rlKey = `track-rl:${getIp(req)}:${Math.floor(Date.now() / 60000)}`;
    const hits  = await redis.incr(rlKey);
    if (hits === 1) await redis.expire(rlKey, 90);
    if (hits > RATE_LIMIT_PER_MIN) return res.status(429).json({ error: 'Too many events.' });

    await redis.hincrby(HASH_KEY, event, 1);
    return res.status(200).json({ success: true });
  } catch (err) {
    // Tracking must never break the site — fail quietly.
    console.error('track POST failed:', err);
    return res.status(200).json({ success: false });
  }
}
