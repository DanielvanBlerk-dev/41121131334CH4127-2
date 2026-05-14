import { checkBodySize } from './_bodyLimit.js';
import { checkCsrf } from './_csrf.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';

const ORIGIN_POSTCODE = '4802'; // Airlie Beach, QLD

/**
 * POST /api/postage
 * Public — no auth required.
 * Body: { toPostcode, length, width, height, weight }
 *
 * Calls Australia Post Domestic Parcel Calculator API server-side
 * so the API key is never exposed to the browser.
 *
 * Required Vercel env var:
 *   AUSPOST_API_KEY — from developers.auspost.com.au
 *
 * Returns: { services: [ { name, price, deliveryTime }, ... ] }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIp(req);

  // ── Body size limit ───────────────────────────────────────────────────
  const size = checkBodySize(req, '1kb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  // ── CSRF check ────────────────────────────────────────────────────────
  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'postage', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ── Input validation ──────────────────────────────────────────────────
  const { toPostcode, length, width, height, weight } = req.body || {};

  if (!toPostcode || !/^[0-9]{4}$/.test(String(toPostcode))) {
    return res.status(400).json({ error: 'Please enter a valid 4-digit Australian postcode.' });
  }

  const dims = { length, width, height, weight };
  for (const [key, val] of Object.entries(dims)) {
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) {
      return res.status(400).json({ error: `Invalid ${key} value.` });
    }
  }

  const apiKey = process.env.AUSPOST_API_KEY;
  if (!apiKey) {
    console.error('AUSPOST_API_KEY not configured');
    return res.status(500).json({ error: 'Postage service not configured.' });
  }

  // ── Australia Post API call ───────────────────────────────────────────
  // Dimensions are in cm, weight in kg per Australia Post API spec.
  const params = new URLSearchParams({
    from_postcode: ORIGIN_POSTCODE,
    to_postcode:   String(toPostcode),
    length:        String(parseFloat(length)),
    width:         String(parseFloat(width)),
    height:        String(parseFloat(height)),
    weight:        String(parseFloat(weight)),
  });

  try {
    const auspostRes = await fetch(
      `https://digitalapi.auspost.com.au/postage/parcel/domestic/calculate.json?${params}`,
      {
        method:  'GET',
        headers: {
          'AUTH-KEY':    apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!auspostRes.ok) {
      const errText = await auspostRes.text();
      console.error('Australia Post API error:', auspostRes.status, errText);

      // Return a friendly message — don't expose AusPost internals
      if (auspostRes.status === 400) {
        return res.status(400).json({ error: 'Could not calculate postage for that postcode. Please check it and try again.' });
      }
      return res.status(502).json({ error: 'Postage service is temporarily unavailable. Please contact Michael directly for a shipping quote.' });
    }

    const data = await auspostRes.json();

    // Australia Post returns services in data.postage_result
    // It may be a single object or an array depending on how many services match
    const raw = data.postage_result;
    const results = Array.isArray(raw) ? raw : [raw];

    // Shape into a clean response — only expose what the front-end needs
    const services = results
      .filter(s => s && s.total_cost)
      .map(s => ({
        name:         s.service_name || 'Standard Parcel Post',
        price:        parseFloat(s.total_cost),
        deliveryTime: s.delivery_time || null,
      }))
      .sort((a, b) => a.price - b.price);

    if (services.length === 0) {
      return res.status(200).json({ services: [], message: 'No standard postage options available for this postcode. Please contact Michael for a shipping quote.' });
    }

    return res.status(200).json({ services });

  } catch (err) {
    console.error('postage fetch error:', err);
    return res.status(500).json({ error: 'Could not reach the postage service. Please contact Michael directly for a shipping quote.' });
  }
}
