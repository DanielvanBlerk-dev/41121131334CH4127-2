import { checkBodySize } from './_bodyLimit.js';
import { checkCsrf } from './_csrf.js';
import { getIp } from './_rateLimit.js';
import { auditLog } from './_auditLog.js';

const ORIGIN_POSTCODE = '4802'; // Airlie Beach, QLD
const AUSPOST_BASE    = 'https://digitalapi.auspost.com.au';

/**
 * POST /api/postage
 * Public — no auth required.
 * Body: { toPostcode, length, width, height, weight }
 *
 * Uses the Australia Post PAC API two-step process:
 *   Step 1: GET /postage/parcel/domestic/service.json — fetch available services
 *   Step 2: GET /postage/parcel/domestic/calculate.json — calculate price per service
 *
 * Returns: { services: [ { name, price, deliveryTime }, ... ] }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = getIp(req);

  const size = checkBodySize(req, '1kb');
  if (!size.ok) return res.status(413).json({ error: size.error });

  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    await auditLog({ action: 'csrf_rejected', ip, detail: { endpoint: 'postage', reason: csrf.reason } });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { toPostcode, length, width, height, weight } = req.body || {};

  if (!toPostcode || !/^[0-9]{4}$/.test(String(toPostcode))) {
    return res.status(400).json({ error: 'Please enter a valid 4-digit Australian postcode.' });
  }

  for (const [key, val] of Object.entries({ length, width, height, weight })) {
    if (isNaN(parseFloat(val)) || parseFloat(val) <= 0) {
      return res.status(400).json({ error: `Invalid ${key} value.` });
    }
  }

  const apiKey = process.env.AUSPOST_API_KEY;
  if (!apiKey) {
    console.error('AUSPOST_API_KEY not configured');
    return res.status(500).json({ error: 'Postage service not configured.' });
  }

  const dimParams = new URLSearchParams({
    from_postcode: ORIGIN_POSTCODE,
    to_postcode:   String(toPostcode),
    length:        String(parseFloat(length)),
    width:         String(parseFloat(width)),
    height:        String(parseFloat(height)),
    weight:        String(parseFloat(weight)),
  });

  const headers = { 'AUTH-KEY': apiKey };

  try {
    // ── Step 1: get available services ───────────────────────────────────
    const servicesRes = await fetch(
      `${AUSPOST_BASE}/postage/parcel/domestic/service.json?${dimParams}`,
      { headers }
    );

    if (!servicesRes.ok) {
      const text = await servicesRes.text();
      console.error('AusPost services error:', servicesRes.status, text);
      return res.status(502).json({
        error: 'Postage service is temporarily unavailable. Please contact Michael directly for a shipping quote.',
      });
    }

    const servicesData = await servicesRes.json();
    const rawServices  = servicesData.services?.service;
    if (!rawServices) {
      return res.status(200).json({
        services: [],
        message:  'No postage options found for this postcode. Please contact Michael for a quote.',
      });
    }

    const serviceList = Array.isArray(rawServices) ? rawServices : [rawServices];

    // ── Step 2: calculate price for each service ──────────────────────────
    const priceResults = await Promise.all(
      serviceList.map(async svc => {
        try {
          const calcParams = new URLSearchParams(dimParams);
          calcParams.set('service_code', svc.code);

          const calcRes  = await fetch(
            `${AUSPOST_BASE}/postage/parcel/domestic/calculate.json?${calcParams}`,
            { headers }
          );
          if (!calcRes.ok) return null;

          const calcData = await calcRes.json();
          const result   = calcData.postage_result;
          if (!result?.total_cost) return null;

          return {
            name:         svc.name,
            price:        parseFloat(result.total_cost),
            deliveryTime: result.delivery_time || null,
          };
        } catch {
          return null;
        }
      })
    );

    const services = priceResults
      .filter(Boolean)
      .sort((a, b) => a.price - b.price);

    if (services.length === 0) {
      return res.status(200).json({
        services: [],
        message:  'No postage options available for this postcode. Please contact Michael for a quote.',
      });
    }

    return res.status(200).json({ services });

  } catch (err) {
    console.error('postage error:', err);
    return res.status(500).json({
      error: 'Could not reach the postage service. Please contact Michael directly for a shipping quote.',
    });
  }
}
