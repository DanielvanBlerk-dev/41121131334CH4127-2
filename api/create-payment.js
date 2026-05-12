import { Redis } from '@upstash/redis';
import { getIp, checkRateLimit, recordFailedAttempt, clearAttempts } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/* ─── VALIDATORS ──────────────────────────────────────────────────────────── */
function isValidString(str) { return typeof str === 'string' && str.trim().length > 0 && !/[<>]/.test(str); }
function isValidPhone(str)   { return !str || /^[0-9+\s\-]{6,20}$/.test(str); } // phone is optional
function isValidPostcode(str){ return /^[0-9]{4,10}$/.test(str); }
function isValidEmail(str)   { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str); }

/**
 * Computes the expected total in cents from the live artwork list in Redis.
 * This is the critical anti-tamper check — we NEVER trust the amount the
 * client sends. We calculate it ourselves from authoritative server data.
 */
async function computeExpectedAmount(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const artworks = (await redis.get('artworks')) || [];
  let total = 0;
  for (const item of items) {
    const art = artworks.find(a => Number(a.id) === Number(item.id));
    if (!art)       throw new Error(`Artwork ${item.id} not found`);
    if (art.sold)   throw new Error(`Artwork "${art.title}" is already sold`);
    total += art.price;
  }
  return Math.round(total * 100); // cents
}

/**
 * POST /api/create-payment
 *
 * Security properties:
 * - Rate-limited: 3 payment attempts per IP per 10 minutes
 * - Amount is computed server-side from Redis — client-sent amount is ignored
 * - Sold artworks are rejected before charging
 * - sourceId (Square token) is single-use; we never store it
 * - No card data ever passes through this function
 * - Idempotency key is generated fresh per request (UUID)
 * - Audit logged (IP, items, order ID — never card data)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getIp(req);

  // ── Rate limit: max 3 payment attempts per IP per 10 min ──────────────
  const { limited, retryAfterSecs } = await checkRateLimit(ip, 'payment');
  if (limited) {
    const mins = Math.ceil(retryAfterSecs / 60);
    await auditLog({ action: 'payment_rate_limited', ip });
    return res.status(429).json({
      success: false,
      error: `Too many payment attempts. Please wait ${mins} minute${mins !== 1 ? 's' : ''} before trying again.`,
    });
  }

  // ── Input validation ──────────────────────────────────────────────────
  const {
    sourceId, currency = 'AUD',
    email, firstName, lastName,
    address, city, postcode, phone,
    items = [],
  } = req.body || {};

  if (
    !isValidString(sourceId)   ||
    !isValidString(firstName)  ||
    !isValidString(lastName)   ||
    !isValidString(address)    ||
    !isValidString(city)       ||
    !isValidPostcode(postcode) ||
    !isValidPhone(phone)       ||
    !isValidEmail(email)       ||
    !Array.isArray(items)      ||
    items.length === 0
  ) {
    return res.status(400).json({ success: false, error: 'Invalid or incomplete form data' });
  }

  // ── Reject clearly invalid sourceId format ────────────────────────────
  // Square tokens start with specific prefixes. This blocks obviously garbage input.
  if (sourceId.length < 10 || sourceId.length > 512) {
    return res.status(400).json({ success: false, error: 'Invalid payment token' });
  }

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId  = process.env.SQUARE_LOCATION_ID;

  if (!accessToken || !locationId) {
    console.error('Square credentials not configured');
    return res.status(500).json({ success: false, error: 'Payment service misconfigured' });
  }

  // ── Compute amount server-side — never trust the client ───────────────
  let expectedAmountCents;
  try {
    expectedAmountCents = await computeExpectedAmount(items);
  } catch (err) {
    await auditLog({ action: 'payment_rejected', ip, detail: { reason: err.message } });
    return res.status(400).json({ success: false, error: err.message });
  }

  if (expectedAmountCents <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid order total' });
  }

  // ── Charge via Square ─────────────────────────────────────────────────
  try {
    const squareRes = await fetch('https://connect.squareup.com/v2/payments', {
      method: 'POST',
      headers: {
        'Square-Version': '2024-01-18',
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        source_id:           sourceId,
        idempotency_key:     crypto.randomUUID(),    // fresh per request — prevents double charge
        amount_money:        { amount: expectedAmountCents, currency },
        location_id:         locationId,
        buyer_email_address: email,
        // NOTE: We do NOT pass raw card data — only the Square-issued token.
        // Square handles all PCI-scoped data internally.
      }),
    });

    const data = await squareRes.json();

    if (!squareRes.ok) {
      // Record failed attempt for rate limiting
      await recordFailedAttempt(ip, 'payment');

      // Log failure without exposing Square's internal error to the client
      console.error('Square payment error:', JSON.stringify(data));
      await auditLog({
        action: 'payment_failed',
        ip,
        detail: {
          squareCode:    data.errors?.[0]?.code,
          squareCategory: data.errors?.[0]?.category,
          itemCount:     items.length,
          amountCents:   expectedAmountCents,
        },
      });

      // Return a generic message — never expose Square internals to the client
      return res.status(502).json({ success: false, error: 'Payment could not be processed. Please check your card details and try again.' });
    }

    // ── Payment succeeded ───────────────────────────────────────────────
    const orderId = data.payment.id;
    await clearAttempts(ip, 'payment');

    // Mark purchased artworks as sold in Redis
    const soldIds = new Set(items.map(i => Number(i.id)));
    let artworks  = (await redis.get('artworks')) || [];
    artworks = artworks.map(a => soldIds.has(Number(a.id)) ? { ...a, sold: true } : a);
    await redis.set('artworks', artworks);

    await auditLog({
      action:  'payment_success',
      ip,
      detail: {
        orderId,
        itemCount:   items.length,
        amountCents: expectedAmountCents,
        // Deliberately NOT logging: sourceId, email, name, address — minimise PII in logs
      },
    });

    return res.status(200).json({ success: true, orderId });

  } catch (err) {
    console.error('create-payment unexpected error:', err);
    await auditLog({ action: 'payment_error', ip, detail: { error: err.message } });
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again.' });
  }
}
