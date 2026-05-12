import { kv } from '@vercel/kv';

function isValidString(str) {
  return typeof str === 'string' && str.trim().length > 0 && !/[<>]/.test(str);
}
function isValidPhone(str) {
  return /^[0-9+\s\-]{6,20}$/.test(str);
}
function isValidPostcode(str) {
  return /^[0-9]{4}$/.test(str);
}

/**
 * POST /api/create-payment
 * Public (Square token is already single-use and amount is validated here).
 * Body: { sourceId, amount, currency, firstName, lastName, address, city, postcode, phone, items }
 *
 * Required Vercel env vars:
 *   SQUARE_ACCESS_TOKEN  — from Square Developer Dashboard (keep secret!)
 *   SQUARE_LOCATION_ID   — from Square Dashboard → Locations
 *
 * On success, marks the purchased artwork IDs as sold in Vercel KV.
 * Returns: { success: true, orderId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    sourceId,
    amount,
    currency = 'AUD',
    firstName,
    lastName,
    address,
    city,
    postcode,
    phone,
    items = [],
  } = req.body || {};

  // Validate required fields
  if (
    !isValidString(sourceId)   ||
    !isValidString(firstName)  ||
    !isValidString(lastName)   ||
    !isValidString(address)    ||
    !isValidString(city)       ||
    !isValidPostcode(postcode) ||
    !isValidPhone(phone)       ||
    typeof amount !== 'number' ||
    amount <= 0
  ) {
    return res.status(400).json({ success: false, error: 'Invalid form data' });
  }

  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId  = process.env.SQUARE_LOCATION_ID;

  if (!accessToken || !locationId) {
    console.error('Square credentials not configured');
    return res.status(500).json({ success: false, error: 'Payment service misconfigured' });
  }

  try {
    const squareRes = await fetch('https://connect.squareup.com/v2/payments', {
      method: 'POST',
      headers: {
        'Square-Version':  '2023-12-13',
        'Content-Type':    'application/json',
        'Authorization':   `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        source_id:        sourceId,
        idempotency_key:  crypto.randomUUID(),
        amount_money:     { amount, currency },
        location_id:      locationId,
        buyer_email_address: req.body.email || undefined,
      }),
    });

    const data = await squareRes.json();

    if (!squareRes.ok) {
      console.error('Square error:', data);
      return res.status(502).json({ success: false, error: 'Payment failed' });
    }

    // Mark purchased artworks as sold in KV
    if (Array.isArray(items) && items.length > 0) {
      const soldIds = new Set(items.map(i => Number(i.id)));
      let artworks  = (await kv.get('artworks')) || [];
      artworks = artworks.map(a =>
        soldIds.has(Number(a.id)) ? { ...a, sold: true } : a
      );
      await kv.set('artworks', artworks);
    }

    return res.status(200).json({
      success: true,
      orderId: data.payment.id,
    });
  } catch (err) {
    console.error('create-payment error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
